/**
 * CronAgent Runner (v2)
 *
 * Runs an independent Agent loop when a cron job fires.
 * Supports agent_id binding, cron_runs persistence, delivery routing, and concurrency control.
 */

import { nanoid } from 'nanoid'
import { runAgentLoop } from '../agent/agent-loop'
import { toolRegistry } from '../agent/tool-registry'
import { subAgentRegistry } from '../agent/sub-agents/registry'
import { registerPluginTools, isPluginToolsRegistered } from '../channel/plugin-tools'
import { useSettingsStore } from '../../stores/settings-store'
import { useProviderStore } from '../../stores/provider-store'
import { ensureProviderAuthReady } from '../auth/provider-auth'
import { useChannelStore } from '../../stores/channel-store'
import { useCronStore, type CronRunEntry } from '../../stores/cron-store'
import { useChatStore } from '../../stores/chat-store'
import { cronEvents } from './cron-events'
import { ipcClient } from '../ipc/ipc-client'
import { IPC } from '../ipc/channels'
import type {
  UnifiedMessage,
  ProviderConfig,
  ContentBlock,
  TextBlock,
  ThinkingBlock,
  ToolUseBlock,
  ToolResultBlock,
  ToolResultContent,
  ImageBlock,
  ImageErrorBlock,
} from '../api/types'
import type { AgentLoopConfig } from '../agent/types'
import type { ToolContext } from './tool-types'

const DEFAULT_AGENT = 'CronAgent'

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

const activeRuns = new Map<string, AbortController>()

function getProviderConfig(providerId?: string | null, modelOverride?: string | null): ProviderConfig | null {
  const s = useSettingsStore.getState()
  const store = useProviderStore.getState()

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
  firedAt?: number
  deliveryMode?: string
  deliveryTarget?: string | null
  maxIterations?: number
  pluginId?: string | null
  pluginChatId?: string | null
}

function ensureAssistantMessage(messages: UnifiedMessage[]): UnifiedMessage {
  const last = messages[messages.length - 1]
  if (last?.role === 'assistant') {
    if (typeof last.content === 'string') {
      last.content = last.content ? [{ type: 'text', text: last.content }] : []
    }
    return last
  }
  const message: UnifiedMessage = {
    id: nanoid(),
    role: 'assistant',
    content: [],
    createdAt: Date.now(),
  }
  messages.push(message)
  return message
}

function getAssistantBlocks(message: UnifiedMessage): ContentBlock[] {
  if (typeof message.content === 'string') {
    message.content = message.content ? [{ type: 'text', text: message.content }] : []
  }
  return message.content
}

function appendText(messages: UnifiedMessage[], text: string): void {
  const message = ensureAssistantMessage(messages)
  const blocks = getAssistantBlocks(message)
  const last = blocks[blocks.length - 1]
  if (last?.type === 'text') {
    ;(last as TextBlock).text += text
    return
  }
  blocks.push({ type: 'text', text })
}

function appendThinking(messages: UnifiedMessage[], thinking: string): void {
  const message = ensureAssistantMessage(messages)
  const blocks = getAssistantBlocks(message)
  const last = blocks[blocks.length - 1]
  if (last?.type === 'thinking' && !last.completedAt) {
    ;(last as ThinkingBlock).thinking += thinking
    return
  }
  blocks.push({ type: 'thinking', thinking, startedAt: Date.now() })
}

function completeThinking(messages: UnifiedMessage[]): void {
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'assistant') return
  const blocks = getAssistantBlocks(last)
  const thinking = [...blocks].reverse().find((block) => block.type === 'thinking' && !block.completedAt)
  if (thinking?.type === 'thinking') {
    thinking.completedAt = Date.now()
  }
}

function appendToolUse(messages: UnifiedMessage[], toolUse: ToolUseBlock): void {
  const message = ensureAssistantMessage(messages)
  const blocks = getAssistantBlocks(message)
  blocks.push(toolUse)
}

function appendToolResult(messages: UnifiedMessage[], toolUseId: string, content: ToolResultContent, isError?: boolean): void {
  const resultMessage: UnifiedMessage = {
    id: nanoid(),
    role: 'user',
    content: [
      {
        type: 'tool_result',
        toolUseId,
        content,
        ...(isError ? { isError: true } : {}),
      } satisfies ToolResultBlock,
    ],
    createdAt: Date.now(),
  }
  messages.push(resultMessage)
}

function appendImageBlock(messages: UnifiedMessage[], block: ImageBlock | ImageErrorBlock): void {
  const message = ensureAssistantMessage(messages)
  const blocks = getAssistantBlocks(message)
  blocks.push(block)
}

function toPersistedMessages(messages: UnifiedMessage[]): Array<{
  id: string
  role: string
  content: unknown
  usage?: unknown
  source?: string | null
  createdAt: number
}> {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    usage: message.usage,
    source: message.source ?? null,
    createdAt: message.createdAt,
  }))
}

export function runCronAgent(options: CronAgentRunOptions): void {
  const { jobId } = options

  if (activeRuns.has(jobId)) {
    console.warn(`[CronAgent] Job ${jobId} is already running, skipping duplicate trigger`)
    return
  }

  const ac = new AbortController()
  activeRuns.set(jobId, ac)

  useCronStore.getState().clearAgentLogs(jobId)
  useCronStore.getState().setExecutionStarted(jobId)

  void _runCronAgentAsync(options, ac).finally(() => {
    activeRuns.delete(jobId)
    useCronStore.getState().clearExecutionState(jobId)
    ipcClient.invoke(IPC.CRON_RUN_FINISHED, { jobId }).catch(() => {})
  })
}

export function abortCronAgent(jobId: string): void {
  const ac = activeRuns.get(jobId)
  if (ac) {
    ac.abort()
    activeRuns.delete(jobId)
  }
}

async function _runCronAgentAsync(options: CronAgentRunOptions, ac: AbortController): Promise<void> {
  const {
    jobId,
    name,
    sessionId,
    prompt,
    agentId,
    model: modelOverride,
    workingFolder,
    firedAt,
    deliveryMode: _deliveryMode = 'desktop',
    deliveryTarget,
    maxIterations: maxIter,
    pluginId: channelsId,
    pluginChatId: channelsChatId,
  } = options

  const runId = `run-${nanoid(8)}`
  const startedAt = Date.now()
  const sourceSession = sessionId
    ? useChatStore.getState().sessions.find((s) => s.id === sessionId)
    : null
  const sourceProject = sourceSession?.projectId
    ? useChatStore.getState().projects.find((p) => p.id === sourceSession.projectId)
    : null
  const effectiveModel = modelOverride || sourceSession?.modelId || null
  const effectiveWorkingFolder = workingFolder || sourceSession?.workingFolder || null

  let resolvedProviderId: string | null = null
  if (channelsId) {
    const channelMeta = useChannelStore.getState().channels.find((p) => p.id === channelsId)
    if (channelMeta?.providerId) resolvedProviderId = channelMeta.providerId
  }
  const effectiveProviderId = resolvedProviderId || sourceSession?.providerId || null

  const sourceSessionTitle = sourceSession?.title ?? null
  const sourceProjectId = sourceProject?.id ?? sourceSession?.projectId ?? null
  const sourceProjectName = sourceProject?.name ?? null

  const persistRunCreate = async (): Promise<void> => {
    await ipcClient.invoke(IPC.CRON_RUN_CREATE, {
      runId,
      jobId,
      startedAt,
      scheduledFor: firedAt ?? null,
      jobNameSnapshot: name ?? null,
      promptSnapshot: prompt,
      sourceSessionIdSnapshot: sessionId ?? null,
      sourceSessionTitleSnapshot: sourceSessionTitle,
      sourceProjectIdSnapshot: sourceProjectId,
      sourceProjectNameSnapshot: sourceProjectName,
      sourceProviderIdSnapshot: effectiveProviderId,
      modelSnapshot: effectiveModel,
      workingFolderSnapshot: effectiveWorkingFolder,
      deliveryModeSnapshot: _deliveryMode,
      deliveryTargetSnapshot: deliveryTarget ?? null,
    })
  }

  try {
    await persistRunCreate()
  } catch (err) {
    console.error('[CronAgent] Failed to create cron run record:', err)
  }

  if (effectiveProviderId) {
    const ready = await ensureProviderAuthReady(effectiveProviderId)
    if (!ready) {
      await logAndRecord(jobId, runId, 'Provider authentication missing', {
        startedAt,
        firedAt,
        name,
        prompt,
        sessionId,
        sourceSessionTitle,
        sourceProjectId,
        sourceProjectName,
        sourceProviderId: effectiveProviderId,
        model: effectiveModel,
        workingFolder: effectiveWorkingFolder,
        deliveryMode: _deliveryMode,
        deliveryTarget,
      })
      return
    }
  }

  const providerConfig = getProviderConfig(effectiveProviderId, effectiveModel)
  if (!providerConfig) {
    await logAndRecord(jobId, runId, 'No AI provider configured', {
      startedAt,
      firedAt,
      name,
      prompt,
      sessionId,
      sourceSessionTitle,
      sourceProjectId,
      sourceProjectName,
      sourceProviderId: effectiveProviderId,
      model: effectiveModel,
      workingFolder: effectiveWorkingFolder,
      deliveryMode: _deliveryMode,
      deliveryTarget,
    })
    return
  }

  const agentName = agentId || DEFAULT_AGENT
  const definition =
    subAgentRegistry.get(agentName) ?? subAgentRegistry.get(DEFAULT_AGENT) ?? FALLBACK_CRON_AGENT

  const toolCtx: ToolContext = {
    sessionId: deliveryTarget ?? undefined,
    workingFolder: effectiveWorkingFolder ?? undefined,
    signal: ac.signal,
    ipc: ipcClient,
    currentToolUseId: undefined,
    callerAgent: agentName,
    pluginId: channelsId ?? undefined,
    pluginChatId: channelsChatId ?? undefined,
    sharedState: { deliveryUsed: false },
  }

  if (!isPluginToolsRegistered()) {
    registerPluginTools()
  }

  const CHANNEL_TOOL_NAMES = [
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
  const allowedSet = new Set([...definition.allowedTools, 'Notify', 'Skill', ...CHANNEL_TOOL_NAMES])
  const innerTools = allDefs.filter((t) => allowedSet.has(t.name))

  const innerProvider: ProviderConfig = {
    ...providerConfig,
    systemPrompt: definition.systemPrompt,
    model: effectiveModel || definition.model || providerConfig.model,
    temperature: definition.temperature ?? providerConfig.temperature,
  }

  let channelInfo = ''
  if (channelsId && channelsChatId) {
    const channelMeta = useChannelStore.getState().channels.find((p) => p.id === channelsId)
    const channelName = channelMeta?.name ?? channelsId
    channelInfo = `\n## Channel Reply Routing\nThis cron job was created from channel **${channelName}** (channel_id: \`${channelsId}\`).\nChat ID: \`${channelsChatId}\`\nWhen you have results to report, use **PluginSendMessage** with plugin_id="${channelsId}" and chat_id="${channelsChatId}" to send the results back to the user through the original channel.\n`
  } else {
    const allChannels = useChannelStore.getState().channels
    if (allChannels.length > 0) {
      const channelLines = allChannels.map(
        (c) => `- **${c.name}** (channel_id: \`${c.id}\`, type: ${c.type})`
      )
      channelInfo = `\n## Available Messaging Channels\n${channelLines.join('\n')}\nYou can send messages via these channels using PluginSendMessage (set plugin_id to channel_id, and include chat_id).\nFor Feishu channels, you can also use FeishuSendImage and FeishuSendFile to send media.\n`
    }
  }

  const hasChannelRouting = !!(channelsId && channelsChatId)
  const deliveryInstructions = hasChannelRouting
    ? `When finished, use **PluginSendMessage** with plugin_id="${channelsId}" and chat_id="${channelsChatId}" to send a friendly summary back through the channel. Do NOT use Notify or desktop notifications. Call PluginSendMessage EXACTLY ONCE as your very last action, then STOP.`
    : `When finished, call **Notify** EXACTLY ONCE with action="desktop" to send a friendly result summary. Do NOT call Notify more than once. Do NOT use action="session" or action="all". After calling Notify, STOP.`

  const cronContext = `You are a scheduled task assistant running cron job (ID: ${jobId}).
Agent: ${agentName}
${deliveryTarget ? `Target session: ${deliveryTarget}` : ''}
${channelInfo}
## Your Task
${prompt}

## Delivery Instructions
${deliveryInstructions}

Match the language of the task prompt in your delivery message (Chinese task → Chinese reply, English task → English reply). Be warm and friendly.

Begin working on this task now.`

  const userMessage: UnifiedMessage = {
    id: nanoid(),
    role: 'user',
    content: prompt,
    createdAt: Date.now(),
  }

  const loopUserMessage: UnifiedMessage = {
    id: nanoid(),
    role: 'user',
    content: cronContext,
    createdAt: userMessage.createdAt,
  }

  const transcriptMessages: UnifiedMessage[] = [userMessage]
  let transcriptFlushPromise: Promise<unknown> | null = null
  let transcriptFlushTimer: ReturnType<typeof setTimeout> | null = null

  const flushTranscript = async (): Promise<void> => {
    if (transcriptFlushTimer) {
      clearTimeout(transcriptFlushTimer)
      transcriptFlushTimer = null
    }
    transcriptFlushPromise = ipcClient
      .invoke(IPC.CRON_RUN_MESSAGES_REPLACE, {
        runId,
        messages: toPersistedMessages(transcriptMessages),
      })
      .catch((err) => {
        console.error('[CronAgent] Failed to persist transcript:', err)
      })
    await transcriptFlushPromise
  }

  const scheduleTranscriptFlush = (): void => {
    if (transcriptFlushTimer) return
    transcriptFlushTimer = setTimeout(() => {
      transcriptFlushTimer = null
      void flushTranscript()
    }, 150)
  }

  await flushTranscript()

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

  const appendLog = async (
    type: 'start' | 'text' | 'tool_call' | 'tool_result' | 'error' | 'end',
    content: string
  ): Promise<void> => {
    useCronStore.getState().appendAgentLog({
      jobId,
      timestamp: Date.now(),
      type,
      content,
    })
    try {
      await ipcClient.invoke(IPC.CRON_RUN_LOG_APPEND, {
        runId,
        timestamp: Date.now(),
        type,
        content,
      })
    } catch (err) {
      console.error('[CronAgent] Failed to append run log:', err)
    }
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
    await appendLog('start', prompt.slice(0, 200))
    emitProgress('initializing')

    const loop = runAgentLoop([loopUserMessage], loopConfig, toolCtx, async () => true)

    for await (const event of loop) {
      if (ac.signal.aborted) break

      switch (event.type) {
        case 'text_delta':
          output += event.text
          appendText(transcriptMessages, event.text)
          scheduleTranscriptFlush()
          break
        case 'thinking_delta':
          iterationCount++
          appendThinking(transcriptMessages, event.thinking)
          scheduleTranscriptFlush()
          emitProgress('thinking')
          break
        case 'image_generated':
          if (event.imageBlock) {
            appendImageBlock(transcriptMessages, event.imageBlock)
            scheduleTranscriptFlush()
          }
          break
        case 'image_error':
          if (event.imageError) {
            appendImageBlock(transcriptMessages, {
              type: 'image_error',
              code: event.imageError.code,
              message: event.imageError.message,
            })
            scheduleTranscriptFlush()
          }
          break
        case 'tool_use_generated':
          appendToolUse(transcriptMessages, {
            type: 'tool_use',
            id: event.toolUseBlock.id,
            name: event.toolUseBlock.name,
            input: event.toolUseBlock.input,
            ...(event.toolUseBlock.extraContent ? { extraContent: event.toolUseBlock.extraContent } : {}),
          })
          scheduleTranscriptFlush()
          await appendLog(
            'tool_call',
            `${event.toolUseBlock.name}(${JSON.stringify(event.toolUseBlock.input).slice(0, 200)})`
          )
          emitProgress(event.toolUseBlock.name)
          break
        case 'tool_call_result': {
          toolCallCount++
          const content = event.toolCall.error
            ? event.toolCall.error
            : (event.toolCall.output ?? 'ok')
          appendToolResult(transcriptMessages, event.toolCall.id, content, Boolean(event.toolCall.error))
          scheduleTranscriptFlush()
          await appendLog(
            'tool_result',
            `${event.toolCall.name}: ${event.toolCall.error ?? event.toolCall.output?.slice(0, 200) ?? 'ok'}`
          )
          emitProgress(event.toolCall.name)
          break
        }
        case 'message_end': {
          completeThinking(transcriptMessages)
          const last = transcriptMessages[transcriptMessages.length - 1]
          if (last?.role === 'assistant') {
            last.usage = event.usage
          }
          scheduleTranscriptFlush()
          break
        }
        case 'error':
          error = event.error.message
          await appendLog('error', error)
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

  const runEntry: CronRunEntry = {
    id: runId,
    jobId,
    startedAt,
    finishedAt,
    status,
    toolCallCount,
    outputSummary: outputSummary || null,
    error: error ?? null,
    scheduledFor: firedAt ?? null,
    jobNameSnapshot: name ?? null,
    promptSnapshot: prompt,
    sourceSessionIdSnapshot: sessionId ?? null,
    sourceSessionTitleSnapshot: sourceSessionTitle,
    sourceProjectIdSnapshot: sourceProjectId,
    sourceProjectNameSnapshot: sourceProjectName,
    sourceProviderIdSnapshot: effectiveProviderId,
    modelSnapshot: effectiveModel,
    workingFolderSnapshot: effectiveWorkingFolder,
    deliveryModeSnapshot: _deliveryMode,
    deliveryTargetSnapshot: deliveryTarget ?? null,
  }

  useCronStore.getState().recordRun(runEntry)

  try {
    await ipcClient.invoke(IPC.CRON_RUN_UPDATE, {
      runId,
      patch: {
        finishedAt,
        status,
        toolCallCount,
        outputSummary: outputSummary || null,
        error: error ?? null,
      },
    })
  } catch (err) {
    console.error('[CronAgent] Failed to update cron run:', err)
  }

  await flushTranscript()

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

  const elapsedLabel =
    elapsed < 60_000 ? `${Math.round(elapsed / 1000)}s` : `${(elapsed / 60_000).toFixed(1)}m`
  if (error) {
    console.error(`[CronAgent] Job ${jobId} completed with error (${elapsedLabel}): ${error}`)
    await appendLog('end', `Failed (${elapsedLabel}): ${error}`)
  } else {
    console.log(`[CronAgent] Job ${jobId} completed (${elapsedLabel}). ${toolCallCount} tool calls`)
    await appendLog('end', `Completed (${elapsedLabel}): ${toolCallCount} tool calls`)
  }
}

async function logAndRecord(
  jobId: string,
  runId: string,
  errorMsg: string,
  snapshot: {
    startedAt: number
    firedAt?: number
    name?: string
    prompt: string
    sessionId?: string | null
    sourceSessionTitle?: string | null
    sourceProjectId?: string | null
    sourceProjectName?: string | null
    sourceProviderId?: string | null
    model?: string | null
    workingFolder?: string | null
    deliveryMode?: string
    deliveryTarget?: string | null
  }
): Promise<void> {
  useCronStore.getState().appendAgentLog({
    jobId,
    timestamp: Date.now(),
    type: 'error',
    content: errorMsg,
  })
  try {
    await ipcClient.invoke(IPC.CRON_RUN_LOG_APPEND, {
      runId,
      timestamp: Date.now(),
      type: 'error',
      content: errorMsg,
    })
    await ipcClient.invoke(IPC.CRON_RUN_MESSAGES_REPLACE, {
      runId,
      messages: [
        {
          id: nanoid(),
          role: 'user',
          content: snapshot.prompt,
          source: null,
          createdAt: snapshot.startedAt,
        },
      ],
    })
    await ipcClient.invoke(IPC.CRON_RUN_UPDATE, {
      runId,
      patch: {
        finishedAt: Date.now(),
        status: 'error',
        toolCallCount: 0,
        outputSummary: null,
        error: errorMsg,
      },
    })
  } catch (err) {
    console.error('[CronAgent] Failed to persist error run:', err)
  }

  useCronStore.getState().recordRun({
    id: runId,
    jobId,
    startedAt: snapshot.startedAt,
    finishedAt: Date.now(),
    status: 'error',
    toolCallCount: 0,
    outputSummary: null,
    error: errorMsg,
    scheduledFor: snapshot.firedAt ?? null,
    jobNameSnapshot: snapshot.name ?? null,
    promptSnapshot: snapshot.prompt,
    sourceSessionIdSnapshot: snapshot.sessionId ?? null,
    sourceSessionTitleSnapshot: snapshot.sourceSessionTitle ?? null,
    sourceProjectIdSnapshot: snapshot.sourceProjectId ?? null,
    sourceProjectNameSnapshot: snapshot.sourceProjectName ?? null,
    sourceProviderIdSnapshot: snapshot.sourceProviderId ?? null,
    modelSnapshot: snapshot.model ?? null,
    workingFolderSnapshot: snapshot.workingFolder ?? null,
    deliveryModeSnapshot: snapshot.deliveryMode ?? null,
    deliveryTargetSnapshot: snapshot.deliveryTarget ?? null,
  })
}
