/**
 * CronAgent Runner (v2)
 *
 * Runs an independent Agent loop when a cron job fires.
 * Supports agent_id binding, cron_runs persistence, delivery routing, and concurrency control.
 *
 * Flow:
 *   cron:fired (main→renderer)
 *     → cronEvents.emit({type:'fired', ...})
 *     → runCronAgent(options)
 *       → resolve agent definition (agentId or fallback CronAgent)
 *       → create cron_runs record
 *       → runAgentLoop(...)
 *       → update cron_runs on finish
 *       → deliver result (desktop / session / none)
 */

import { nanoid } from 'nanoid'
import { runAgentLoop } from '../agent/agent-loop'
import { toolRegistry } from '../agent/tool-registry'
import { subAgentRegistry } from '../agent/sub-agents/registry'
import { registerPluginTools, isPluginToolsRegistered } from '../plugins/plugin-tools'
import { useSettingsStore } from '../../stores/settings-store'
import { useProviderStore } from '../../stores/provider-store'
import { ensureProviderAuthReady } from '../auth/provider-auth'
import { usePluginStore } from '../../stores/plugin-store'
import { useCronStore } from '../../stores/cron-store'
import { useChatStore } from '../../stores/chat-store'
import { cronEvents } from './cron-events'
import { ipcClient } from '../ipc/ipc-client'
import { IPC } from '../ipc/channels'
import type { UnifiedMessage, ProviderConfig } from '../api/types'
import type { AgentLoopConfig } from '../agent/types'
import type { ToolContext } from './tool-types'

const DEFAULT_AGENT = 'CronAgent'

/** Fallback definition used when CronAgent is not found in the sub-agent registry */
const FALLBACK_CRON_AGENT = {
  name: DEFAULT_AGENT,
  description: 'Scheduled task agent for cron jobs',
  allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Shell', 'Bash', 'Notify', 'AskUserQuestion'],
  maxIterations: 15,
  model: undefined as string | undefined,
  temperature: undefined as number | undefined,
  systemPrompt:
    'You are CronAgent, a scheduled task assistant. You execute tasks autonomously on a timer. ' +
    'Be concise and action-oriented. Complete the task, then deliver results as instructed.',
}

/** Active cron agent runs keyed by jobId — prevents duplicate concurrent runs */
const activeRuns = new Map<string, AbortController>()

function getProviderConfig(providerId?: string | null, modelOverride?: string | null): ProviderConfig | null {
  const s = useSettingsStore.getState()
  const store = useProviderStore.getState()

  // If a specific provider+model is bound, use that provider directly
  if (providerId && modelOverride) {
    const overrideConfig = store.getProviderConfigById(providerId, modelOverride)
    if (overrideConfig?.apiKey) {
      return {
        ...overrideConfig,
        maxTokens: store.getEffectiveMaxTokens(s.maxTokens, modelOverride),
        temperature: s.temperature,
      }
    }
  }

  const fastConfig = store.getFastProviderConfig()
  if (fastConfig?.apiKey) {
    return {
      ...fastConfig,
      model: modelOverride || fastConfig.model,
      maxTokens: store.getEffectiveMaxTokens(s.maxTokens, modelOverride || fastConfig.model),
      temperature: s.temperature,
    }
  }

  if (!s.apiKey) return null

  const model = modelOverride || s.fastModel || s.model
  return {
    type: s.provider,
    apiKey: s.apiKey,
    baseUrl: s.baseUrl || undefined,
    model,
    maxTokens: store.getEffectiveMaxTokens(s.maxTokens, model),
    temperature: s.temperature,
  }
}

export interface CronAgentRunOptions {
  jobId: string
  name?: string
  sessionId?: string | null
  prompt: string
  agentId?: string | null
  model?: string | null
  workingFolder?: string | null
  deliveryMode?: string
  deliveryTarget?: string | null
  maxIterations?: number
  pluginId?: string | null
  pluginChatId?: string | null
}

/**
 * Run an Agent for a fired cron job.
 * Returns immediately — the agent runs in the background.
 */
export function runCronAgent(options: CronAgentRunOptions): void {
  const { jobId } = options

  // Prevent duplicate concurrent runs for the same job
  if (activeRuns.has(jobId)) {
    console.warn(`[CronAgent] Job ${jobId} is already running, skipping duplicate trigger`)
    return
  }

  const ac = new AbortController()
  activeRuns.set(jobId, ac)

  // Clear previous logs and mark execution started
  useCronStore.getState().clearAgentLogs(jobId)
  useCronStore.getState().setExecutionStarted(jobId)

  void _runCronAgentAsync(options, ac).finally(() => {
    activeRuns.delete(jobId)
    useCronStore.getState().clearExecutionState(jobId)
    // Notify main process so it can clear the concurrency lock
    ipcClient.invoke(IPC.CRON_RUN_FINISHED, { jobId }).catch(() => {})
  })
}

/**
 * Abort a running CronAgent for a specific job.
 */
export function abortCronAgent(jobId: string): void {
  const ac = activeRuns.get(jobId)
  if (ac) {
    ac.abort()
    activeRuns.delete(jobId)
  }
}

async function _runCronAgentAsync(
  options: CronAgentRunOptions,
  ac: AbortController
): Promise<void> {
  const {
    jobId,
    name,
    sessionId,
    prompt,
    agentId,
    model: modelOverride,
    workingFolder,
    deliveryMode: _deliveryMode = 'desktop',
    deliveryTarget,
    maxIterations: maxIter,
    pluginId,
    pluginChatId,
  } = options

  // Resolve source session config (model, provider, working folder)
  const sourceSession = sessionId
    ? useChatStore.getState().sessions.find((s) => s.id === sessionId)
    : null
  const effectiveModel = modelOverride || sourceSession?.modelId || null
  const effectiveWorkingFolder = workingFolder || sourceSession?.workingFolder || null

  // Resolve provider config — use plugin's bound provider, then source session's, then global
  let resolvedProviderId: string | null = null
  if (pluginId) {
    const pluginMeta = usePluginStore.getState().plugins.find((p) => p.id === pluginId)
    if (pluginMeta?.providerId) resolvedProviderId = pluginMeta.providerId
  }
  const effectiveProviderId = resolvedProviderId || sourceSession?.providerId || null
  if (effectiveProviderId) {
    const ready = await ensureProviderAuthReady(effectiveProviderId)
    if (!ready) {
      console.error(`[CronAgent] Provider auth missing for job ${jobId}`)
      logAndRecord(jobId, 'Provider authentication missing')
      return
    }
  }
  const providerConfig = getProviderConfig(effectiveProviderId, effectiveModel)
  if (!providerConfig) {
    console.error(`[CronAgent] No provider config available for job ${jobId}`)
    logAndRecord(jobId, 'No AI provider configured')
    return
  }

  // Resolve agent definition — try agentId first, fall back to CronAgent, then hardcoded fallback
  const agentName = agentId || DEFAULT_AGENT
  const definition = subAgentRegistry.get(agentName)
    ?? subAgentRegistry.get(DEFAULT_AGENT)
    ?? FALLBACK_CRON_AGENT

  // Create a cron_runs record
  const runId = `run-${nanoid(8)}`
  try {
    await ipcClient.invoke(IPC.CRON_RUNS, { __create: true, runId, jobId })
  } catch {
    // Non-critical — runs table insert handled below via direct IPC
  }

  cronEvents.emit({ type: 'run_started', jobId, runId })

  // Build tool context
  const toolCtx: ToolContext = {
    sessionId: deliveryTarget ?? undefined,
    workingFolder: effectiveWorkingFolder ?? undefined,
    signal: ac.signal,
    ipc: ipcClient,
    currentToolUseId: undefined,
    callerAgent: agentName,
    pluginId: pluginId ?? undefined,
    pluginChatId: pluginChatId ?? undefined,
    sharedState: { deliveryUsed: false },
  }

  // Always register plugin tools for cron agents
  if (!isPluginToolsRegistered()) {
    registerPluginTools()
  }

  // Build allowed tools — always include plugin tools
  const PLUGIN_TOOL_NAMES = [
    'PluginSendMessage',
    'PluginReplyMessage',
    'PluginGetGroupMessages',
    'PluginListGroups',
    'PluginSummarizeGroup',
    'PluginGetCurrentChatMessages',
    'FeishuSendImage',
    'FeishuSendFile',
    'FeishuListChatMembers',
    'FeishuAtMember',
    'FeishuSendUrgent',
    'FeishuBitableListApps',
    'FeishuBitableListTables',
    'FeishuBitableListFields',
    'FeishuBitableGetRecords',
    'FeishuBitableCreateRecords',
    'FeishuBitableUpdateRecords',
    'FeishuBitableDeleteRecords',
  ]
  const allDefs = toolRegistry.getDefinitions()
  const allowedSet = new Set([...definition.allowedTools, 'Notify', 'Skill', ...PLUGIN_TOOL_NAMES])
  const innerTools = allDefs.filter((t) => allowedSet.has(t.name))

  // Build provider config with agent's system prompt
  const innerProvider: ProviderConfig = {
    ...providerConfig,
    systemPrompt: definition.systemPrompt,
    model: effectiveModel || definition.model || providerConfig.model,
    temperature: definition.temperature ?? providerConfig.temperature,
  }

  // Build plugin context for cron agent
  let pluginInfo = ''
  if (pluginId && pluginChatId) {
    // This cron job was created from a plugin session — inject routing info
    const pluginMeta = usePluginStore.getState().plugins.find((p) => p.id === pluginId)
    const pluginName = pluginMeta?.name ?? pluginId
    pluginInfo = `\n## Plugin Reply Channel\nThis cron job was created from plugin **${pluginName}** (plugin_id: \`${pluginId}\`).\nChat ID: \`${pluginChatId}\`\nWhen you have results to report, use **PluginSendMessage** with plugin_id="${pluginId}" and chat_id="${pluginChatId}" to send the results back to the user through the original plugin channel.\n`
  } else {
    // List all configured plugins (not just active) for cron agents
    const allPlugins = usePluginStore.getState().plugins
    if (allPlugins.length > 0) {
      const pluginLines = allPlugins.map((p) =>
        `- **${p.name}** (plugin_id: \`${p.id}\`, type: ${p.type})`
      )
      pluginInfo = `\n## Available Messaging Plugins\n${pluginLines.join('\n')}\nYou can send messages via these plugins using PluginSendMessage (requires plugin_id and chat_id).\nFor Feishu plugins, you can also use FeishuSendImage and FeishuSendFile to send media.\n`
    }
  }

  // Build initial user message — delivery instructions depend on whether plugin context exists
  const hasPluginChannel = !!(pluginId && pluginChatId)
  const deliveryInstructions = hasPluginChannel
    ? `When finished, use **PluginSendMessage** with plugin_id="${pluginId}" and chat_id="${pluginChatId}" to send a friendly summary back through the plugin channel. Do NOT use Notify or desktop notifications. Call PluginSendMessage EXACTLY ONCE as your very last action, then STOP.`
    : `When finished, call **Notify** EXACTLY ONCE with action="desktop" to send a friendly result summary. Do NOT call Notify more than once. Do NOT use action="session" or action="all". After calling Notify, STOP.`

  const cronContext = `You are a scheduled task assistant running cron job (ID: ${jobId}).
Agent: ${agentName}
${deliveryTarget ? `Target session: ${deliveryTarget}` : ''}
${pluginInfo}
## Your Task
${prompt}

## Delivery Instructions
${deliveryInstructions}

Match the language of the task prompt in your delivery message (Chinese task → Chinese reply, English task → English reply). Be warm and friendly.

Begin working on this task now.`

  const userMessage: UnifiedMessage = {
    id: nanoid(),
    role: 'user',
    content: cronContext,
    createdAt: Date.now(),
  }

  const loopConfig: AgentLoopConfig = {
    maxIterations: maxIter ?? definition.maxIterations,
    provider: innerProvider,
    tools: innerTools,
    systemPrompt: definition.systemPrompt,
    workingFolder: effectiveWorkingFolder ?? undefined,
    signal: ac.signal,
  }

  let output = ''
  let toolCallCount = 0
  let iterationCount = 0
  let error: string | undefined
  const startedAt = Date.now()

  const log = (type: 'start' | 'text' | 'tool_call' | 'tool_result' | 'error' | 'end', content: string): void => {
    useCronStore.getState().appendAgentLog({
      jobId,
      timestamp: Date.now(),
      type,
      content,
    })
  }

  const emitProgress = (currentStep?: string): void => {
    const elapsed = Date.now() - startedAt
    useCronStore.getState().updateExecutionProgress(jobId, {
      iteration: iterationCount,
      toolCalls: toolCallCount,
      currentStep,
    })
    cronEvents.emit({
      type: 'run_progress',
      jobId,
      runId,
      iteration: iterationCount,
      toolCalls: toolCallCount,
      elapsed,
      currentStep,
    })
  }

  try {
    console.log(`[CronAgent] Starting job ${jobId} (agent=${agentName}): ${prompt.slice(0, 80)}...`)
    log('start', prompt.slice(0, 200))
    emitProgress('initializing')

    const loop = runAgentLoop([userMessage], loopConfig, toolCtx, async () => {
      // Auto-approve all tools — cron agents run unattended
      return true
    })

    for await (const event of loop) {
      if (ac.signal.aborted) break

      switch (event.type) {
        case 'text_delta':
          output += event.text
          break
        case 'thinking_delta':
          // Count iteration boundary: each new thinking block = new iteration
          iterationCount++
          emitProgress('thinking')
          break
        case 'tool_use_generated':
          log('tool_call', `${event.toolUseBlock.name}(${JSON.stringify(event.toolUseBlock.input).slice(0, 200)})`)
          emitProgress(event.toolUseBlock.name)
          break
        case 'tool_call_result':
          toolCallCount++
          log('tool_result', `${event.toolCall.name}: ${event.toolCall.error ?? event.toolCall.output?.slice(0, 200) ?? 'ok'}`)
          emitProgress(event.toolCall.name)
          break
        case 'error':
          error = event.error.message
          log('error', error)
          break
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
    console.error(`[CronAgent] Job ${jobId} failed:`, err)
  }

  const finishedAt = Date.now()
  const elapsed = finishedAt - startedAt
  const status = ac.signal.aborted ? 'aborted' : error ? 'error' : 'success'
  const outputSummary = output.slice(0, 2000)

  // Record in store
  useCronStore.getState().recordRun({
    id: runId,
    jobId,
    startedAt,
    finishedAt,
    status,
    toolCallCount,
    outputSummary: outputSummary || null,
    error: error ?? null,
  })

  // Emit event
  cronEvents.emit({
    type: 'run_finished',
    jobId,
    runId,
    status,
    toolCallCount,
    jobName: name,
    sessionId: sessionId ?? null,
    deliveryMode: _deliveryMode,
    deliveryTarget: deliveryTarget ?? null,
    outputSummary,
    error,
  })

  // Log completion
  const elapsedLabel = elapsed < 60_000 ? `${Math.round(elapsed / 1000)}s` : `${(elapsed / 60_000).toFixed(1)}m`
  if (error) {
    console.error(`[CronAgent] Job ${jobId} completed with error (${elapsedLabel}): ${error}`)
    log('end', `Failed (${elapsedLabel}): ${error}`)
  } else {
    console.log(`[CronAgent] Job ${jobId} completed (${elapsedLabel}). ${toolCallCount} tool calls`)
    log('end', `Completed (${elapsedLabel}): ${toolCallCount} tool calls`)
  }

}

/** Helper: log error and record a failed run */
function logAndRecord(jobId: string, errorMsg: string): void {
  useCronStore.getState().appendAgentLog({
    jobId,
    timestamp: Date.now(),
    type: 'error',
    content: errorMsg,
  })
  useCronStore.getState().recordRun({
    id: `run-${nanoid(8)}`,
    jobId,
    startedAt: Date.now(),
    finishedAt: Date.now(),
    status: 'error',
    toolCallCount: 0,
    outputSummary: null,
    error: errorMsg,
  })
}
