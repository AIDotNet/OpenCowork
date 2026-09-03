/**
 * Headless channel auto-reply.
 *
 * Fallback executor used when no renderer window acknowledges a
 * `plugin:session-task`. Runs the reply turn entirely in the main process
 * through the Worker hosted-session path (same assembly as the v2 runtime
 * service), persists the transcript to the desktop DB, and delivers the
 * assistant text back through the channel service.
 *
 * This keeps channel auto-reply alive with zero open windows — renderer
 * liveness no longer defines channel runtime availability.
 */

import { nanoid } from 'nanoid'
import { getNativeAgentRuntimeManager } from '../ipc/native-agent-runtime'
import { AgentSessionService } from '../ipc/agent-runtime/agent-session-service'
import { assembleHostedSessionContext } from '../ipc/agent-runtime/agent-session-service-host'
import {
  normalizeRendererRequestRecord,
  readNonEmptyString
} from '../ipc/agent-runtime/request-utils'
import { readAgentStreamEnvelope } from '../../shared/messagepack/agent-stream-codec'
import { readChannelPlugins } from './channel-config-store'
import type { ChannelInstance, ChannelPermissions } from './channel-types'
import { downloadFeishuMessageResourceFromMain, executePluginAction } from '../ipc/channel-handlers'
import {
  addMessage,
  addMessages,
  getMessageWindowIndex,
  type MessageInput
} from '../db/messages-dao'
import { getSession } from '../db/sessions-dao'
import { decodePersistedStoreState, readPersistedSettingsState } from '../ipc/settings-handlers'
import { readPersistedProviderStore } from '../lib/ai-provider-store'
import { getNativeWorker } from '../lib/native-worker'
import {
  buildProviderConfigById,
  resolveProviderDefaultModelId,
  type AIModelConfig,
  type PersistedProvidersState
} from '../lib/provider-run-config'

export interface HeadlessChannelTask {
  sessionId: string
  pluginId: string
  pluginType: string
  chatId: string
  chatType?: 'p2p' | 'group'
  senderId?: string
  senderName?: string
  chatName?: string
  content: string
  messageId?: string
  images?: Array<{ base64: string; mediaType: string }>
  audio?: { fileKey: string; fileName?: string; mediaType?: string; durationMs?: number }
  workingFolder?: string
  sshConnectionId?: string | null
}

// Mirrors the renderer DEFAULT_PLUGIN_PERMISSIONS so headless and windowed
// runs enforce the same channel security posture.
const DEFAULT_CHANNEL_PERMISSIONS: ChannelPermissions = {
  allowReadHome: false,
  readablePathPrefixes: [],
  allowWriteOutside: false,
  allowShell: false,
  allowSubAgents: true
}

const HEADLESS_MAX_ITERATIONS = 15
const HEADLESS_RUN_TIMEOUT_MS = 30 * 60_000
const OPENAI_AUDIO_NATIVE_TIMEOUT_MS = 10 * 60_000
const SHELL_TOOL_NAMES = new Set(['Bash', 'Shell', 'PowerShell', 'Monitor'])
const WRITE_TOOL_NAMES = new Set(['Write', 'Edit', 'NotebookEdit'])

const scopeChains = new Map<string, Promise<void>>()
const handledMessageIds = new Set<string>()

type RunAuthority = { permissions: ChannelPermissions }
const runAuthorities = new Map<string, RunAuthority>()
const sessionAuthorities = new Map<string, RunAuthority>()

// ── Approval interception ──

/**
 * Auto-resolves worker approval requests for headless channel runs using the
 * channel's permission flags — the same decisions the renderer applies via
 * `ToolContext.channelPermissions` when a window is open. Returns null when
 * the request does not belong to a headless channel run.
 */
export function resolveHeadlessChannelApproval(
  params: unknown
): { approved: boolean; reason?: string } | null {
  const record = normalizeRendererRequestRecord(params)
  const runId = readNonEmptyString(record.runId) ?? readNonEmptyString(record.agentRunId)
  const sessionId = readNonEmptyString(record.sessionId)
  const authority =
    (runId ? runAuthorities.get(runId) : undefined) ??
    (sessionId ? sessionAuthorities.get(sessionId) : undefined)
  if (!authority) return null

  const toolCall = normalizeRendererRequestRecord(record.toolCall)
  const toolName = readNonEmptyString(toolCall.name) ?? ''
  return decideHeadlessApproval(toolName, authority.permissions)
}

function decideHeadlessApproval(
  toolName: string,
  permissions: ChannelPermissions
): { approved: boolean; reason?: string } {
  if (/^(Plugin|Feishu|Weixin)/.test(toolName)) {
    return { approved: true, reason: 'Channel messaging tool auto-approved for auto-reply' }
  }
  if (SHELL_TOOL_NAMES.has(toolName)) {
    return permissions.allowShell
      ? { approved: true, reason: 'Channel permissions allow shell' }
      : { approved: false, reason: 'Shell access is disabled for this channel' }
  }
  if (WRITE_TOOL_NAMES.has(toolName)) {
    return permissions.allowWriteOutside
      ? { approved: true, reason: 'Channel permissions allow writing outside the working folder' }
      : {
          approved: false,
          reason: 'Writing outside the channel working folder is disabled for this channel'
        }
  }
  if (toolName === 'Task') {
    return permissions.allowSubAgents
      ? { approved: true, reason: 'Channel permissions allow sub-agents' }
      : { approved: false, reason: 'Sub-agent tools are disabled for this channel' }
  }
  return {
    approved: false,
    reason: 'This tool requires desktop approval, which is unavailable in headless channel replies'
  }
}

// ── Entry ──

/** Queues a headless reply per plugin:chat scope so turns never interleave. */
export function runHeadlessChannelAutoReply(task: HeadlessChannelTask): Promise<void> {
  if (task.messageId) {
    if (handledMessageIds.has(task.messageId)) {
      return Promise.resolve()
    }
    handledMessageIds.add(task.messageId)
    if (handledMessageIds.size > 400) {
      const first = handledMessageIds.values().next().value
      if (first) handledMessageIds.delete(first)
    }
  }

  const scopeKey = `${task.pluginId}:${encodeURIComponent(task.chatId)}`
  const previous = scopeChains.get(scopeKey) ?? Promise.resolve()
  const run = previous
    .catch(() => {})
    .then(() => executeHeadlessTask(task))
    .catch((err) => {
      console.error('[HeadlessAutoReply] Task failed:', err)
    })
  scopeChains.set(scopeKey, run)
  void run.finally(() => {
    if (scopeChains.get(scopeKey) === run) {
      scopeChains.delete(scopeKey)
    }
  })
  return run
}

// ── Transcript folding types ──

type TextBlock = { type: 'text'; text: string }
type ThinkingBlock = {
  type: 'thinking'
  thinking: string
  startedAt?: number
  completedAt?: number
}
type ToolUseBlock = {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
  extraContent?: Record<string, unknown>
}
type ImageSourceBlock = {
  type: 'image'
  source: { type: 'base64'; mediaType: string; data: string }
}
type AssistantBlock = TextBlock | ThinkingBlock | ToolUseBlock
type ToolResultEntry = { toolUseId: string; content: unknown; isError?: boolean }

type StreamEvent = {
  type?: string
  text?: string
  thinking?: string
  reason?: string
  message?: string
  toolCallId?: string
  toolName?: string
  toolUseBlock?: {
    id?: string
    name?: string
    input?: Record<string, unknown>
    extraContent?: Record<string, unknown>
  }
  toolResults?: Array<{ toolUseId?: string; content?: unknown; isError?: boolean }>
  usage?: Record<string, unknown>
  providerResponseId?: string
}

type StreamEnvelope = {
  runId?: string
  seq?: number
  events?: StreamEvent[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

// ── Core execution ──

async function executeHeadlessTask(task: HeadlessChannelTask): Promise<void> {
  const { sessionId, pluginId, chatId } = task

  let channelMeta: ChannelInstance | undefined
  try {
    channelMeta = (await readChannelPlugins()).find((plugin) => plugin.id === pluginId)
  } catch {
    /* keep undefined — defaults below */
  }
  if (channelMeta?.features?.autoReply === false) {
    console.log(`[HeadlessAutoReply] Auto-reply disabled for plugin ${pluginId}, skipping`)
    return
  }
  const permissions = channelMeta?.permissions ?? DEFAULT_CHANNEL_PERMISSIONS

  const shouldReplyToIncomingMessage = task.pluginType === 'qq-bot' && Boolean(task.messageId)
  const sendPluginMessage = async (message: string): Promise<boolean> => {
    try {
      await executePluginAction({
        pluginId,
        action: shouldReplyToIncomingMessage ? 'replyMessage' : 'sendMessage',
        params: shouldReplyToIncomingMessage
          ? { messageId: task.messageId, content: message }
          : { chatId, content: message }
      })
      return true
    } catch (err) {
      console.error('[HeadlessAutoReply] Failed to send plugin message:', err)
      return false
    }
  }

  // ── Provider resolution (channel override → session binding → active) ──
  const providersState = decodePersistedStoreState<PersistedProvidersState>(
    readPersistedProviderStore()
  ) ?? {
    providers: []
  }
  const settings = readPersistedSettingsState()
  const sessionRow = await getSession(sessionId).catch(() => null)
  if (!sessionRow) {
    console.error(`[HeadlessAutoReply] Session ${sessionId} not found, dropping task`)
    return
  }

  let providerId = channelMeta?.providerId || sessionRow.provider_id || ''
  if (!providerId) providerId = providersState.activeProviderId ?? ''
  const providerRecord = providersState.providers.find((provider) => provider.id === providerId)
  let modelId = channelMeta?.model || sessionRow.model_id || ''
  if (!modelId && providerRecord) {
    modelId =
      providersState.activeProviderId === providerId && providersState.activeModelId
        ? providersState.activeModelId
        : resolveProviderDefaultModelId(providerRecord)
  }

  const providerConfig =
    providerId && modelId
      ? buildProviderConfigById(providersState, settings, providerId, modelId)
      : null
  if (!providerConfig || (providerConfig.requiresApiKey !== false && !providerConfig.apiKey)) {
    console.error('[HeadlessAutoReply] No usable provider config for headless reply')
    await sendPluginMessage(
      'Model provider or API Key not configured, please configure in settings and try again.'
    )
    return
  }

  // ── Optional Feishu voice transcription ──
  const channelType = (channelMeta?.type ?? task.pluginType ?? '').toLowerCase()
  const isFeishuChannel = channelType === 'feishu' || channelType === 'feishu-bot'
  let effectiveContent = task.content
  if (task.audio && isFeishuChannel && task.messageId) {
    const transcript = await transcribeFeishuVoice(task, providersState, settings)
    if (!transcript.ok) {
      await sendPluginMessage(transcript.notice)
      return
    }
    effectiveContent = transcript.text
  }

  // ── User message content (vision-aware) ──
  const modelRecord = providerRecord?.models.find((model) => model.id === modelId)
  const supportsVision = modelSupportsVisionLoose(modelRecord)
  let userContent: string | Array<ImageSourceBlock | TextBlock> = effectiveContent
  if (task.images?.length) {
    if (supportsVision) {
      const blocks: Array<ImageSourceBlock | TextBlock> = task.images.map((img) => ({
        type: 'image' as const,
        source: { type: 'base64' as const, mediaType: img.mediaType, data: img.base64 }
      }))
      if (effectiveContent) blocks.push({ type: 'text', text: effectiveContent })
      userContent = blocks
    } else {
      const note = '[User sent an image, but the current model does not support vision.]'
      userContent = [effectiveContent, note].filter(Boolean).join('\n')
    }
  }

  // ── Persist the user message so hosted assembly picks it up as the trigger ──
  const baseSortOrder = await resolveNextSortOrder(sessionId)
  const userMessageId = nanoid()
  const now = Date.now()
  await addMessage({
    id: userMessageId,
    sessionId,
    role: 'user',
    content: typeof userContent === 'string' ? userContent : JSON.stringify(userContent),
    createdAt: now,
    sortOrder: baseSortOrder
  })

  // ── Start the hosted run ──
  const manager = getNativeAgentRuntimeManager()
  if (!(await manager.ensureStarted())) {
    await sendPluginMessage('Agent runtime is unavailable, please try again later.')
    return
  }

  const requestedRunId = `plugin-run-${nanoid(10)}`
  const enabledChannelTools = Object.entries(channelMeta?.tools ?? {})
    .filter(([, enabled]) => enabled !== false)
    .map(([name]) => name)
  const extraTemplate: Record<string, unknown> = {
    maxIterations: HEADLESS_MAX_ITERATIONS,
    pluginId,
    pluginChatId: chatId,
    pluginChannelContext: {
      channelName: channelMeta?.name ?? task.pluginType,
      channelId: pluginId,
      chatId,
      ...(task.chatType ? { chatType: task.chatType } : {}),
      ...(task.senderId ? { senderId: task.senderId } : {}),
      ...(task.senderName ? { senderName: task.senderName } : {}),
      ...(enabledChannelTools.length > 0 ? { availableTools: enabledChannelTools } : {}),
      autoReply: true
    }
  }
  if (task.chatType) extraTemplate.pluginChatType = task.chatType
  if (task.senderId) extraTemplate.pluginSenderId = task.senderId
  if (task.senderName) extraTemplate.pluginSenderName = task.senderName

  const service = new AgentSessionService({
    isRunning: () => manager.isRunning,
    request: (method, params, timeoutMs) => manager.request(method, params, timeoutMs),
    nextRunId: () => requestedRunId,
    assemble: (intent) => assembleHostedSessionContext({ ...intent, extraTemplate })
  })

  // ── Stream consumption state ──
  const assistantBlocks: AssistantBlock[] = []
  const toolResultMessages: ToolResultEntry[][] = []
  let assistantUsage: Record<string, unknown> | undefined
  let providerResponseId: string | undefined
  let fullText = ''
  let deliveredTextLength = 0
  let lastError: string | null = null
  let lastSequence = 0
  let activeRunId = requestedRunId
  let finished = false

  let resolveDone: () => void = () => {}
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  const finish = (): void => {
    if (finished) return
    finished = true
    resolveDone()
  }

  const deliverPendingText = async (): Promise<void> => {
    const pending = fullText.slice(deliveredTextLength).trim()
    const nextLength = fullText.length
    if (!pending) {
      deliveredTextLength = nextLength
      return
    }
    const sent = await sendPluginMessage(pending)
    if (sent) deliveredTextLength = nextLength
  }

  const appendText = (text: string): void => {
    if (!text) return
    fullText += text
    const last = assistantBlocks[assistantBlocks.length - 1]
    if (last?.type === 'text') {
      last.text += text
      return
    }
    assistantBlocks.push({ type: 'text', text })
  }

  const appendThinking = (thinking: string): void => {
    if (!thinking) return
    const last = assistantBlocks[assistantBlocks.length - 1]
    if (last?.type === 'thinking' && !last.completedAt) {
      last.thinking += thinking
      return
    }
    assistantBlocks.push({ type: 'thinking', thinking, startedAt: Date.now() })
  }

  // Reasoning disclosed only after the answer streamed belongs in front of that answer.
  const backfillThinking = (thinking: string): void => {
    if (!thinking) return
    let insertAt = assistantBlocks.length
    while (insertAt > 0 && assistantBlocks[insertAt - 1].type === 'text') insertAt -= 1
    if (insertAt === assistantBlocks.length) {
      appendThinking(thinking)
      return
    }
    const now = Date.now()
    const previous = assistantBlocks[insertAt - 1]
    if (previous?.type === 'thinking') {
      previous.thinking = previous.thinking ? `${previous.thinking}\n${thinking}` : thinking
      previous.completedAt ??= now
      return
    }
    assistantBlocks.splice(insertAt, 0, {
      type: 'thinking',
      thinking,
      startedAt: now,
      completedAt: now
    })
  }

  const completeThinking = (): void => {
    const open = [...assistantBlocks]
      .reverse()
      .find((block): block is ThinkingBlock => block.type === 'thinking' && !block.completedAt)
    if (open) open.completedAt = Date.now()
  }

  const upsertToolUse = (block: {
    id?: string
    name?: string
    input?: Record<string, unknown>
    extraContent?: Record<string, unknown>
  }): void => {
    if (!block.id || !block.name) return
    const existing = assistantBlocks.find(
      (candidate): candidate is ToolUseBlock =>
        candidate.type === 'tool_use' && candidate.id === block.id
    )
    if (existing) {
      existing.input = isRecord(block.input) ? block.input : existing.input
      if (block.extraContent) existing.extraContent = block.extraContent
      return
    }
    assistantBlocks.push({
      type: 'tool_use',
      id: block.id,
      name: block.name,
      input: isRecord(block.input) ? block.input : {},
      ...(block.extraContent ? { extraContent: block.extraContent } : {})
    })
  }

  const handleEvent = async (event: StreamEvent): Promise<void> => {
    switch (event.type) {
      case 'text_delta':
        appendText(event.text ?? '')
        break
      case 'thinking_delta':
        appendThinking(event.thinking ?? '')
        break
      case 'thinking_backfill':
        backfillThinking(event.thinking ?? '')
        break
      case 'tool_use_streaming_start':
        completeThinking()
        if (event.toolCallId && event.toolName) {
          upsertToolUse({ id: event.toolCallId, name: event.toolName, input: {} })
        }
        break
      case 'tool_use_generated':
        completeThinking()
        await deliverPendingText()
        if (event.toolUseBlock) upsertToolUse(event.toolUseBlock)
        break
      case 'iteration_end': {
        const results = (event.toolResults ?? [])
          .filter(
            (result): result is { toolUseId: string; content?: unknown; isError?: boolean } =>
              typeof result.toolUseId === 'string'
          )
          .map((result) => ({
            toolUseId: result.toolUseId,
            content: result.content ?? '',
            ...(result.isError ? { isError: true } : {})
          }))
        if (results.length > 0) toolResultMessages.push(results)
        break
      }
      case 'message_end':
        completeThinking()
        if (isRecord(event.usage)) assistantUsage = event.usage
        if (event.providerResponseId) providerResponseId = event.providerResponseId
        break
      case 'error':
        lastError = event.message ?? 'Native agent run failed'
        appendText(`\n\n> **Error:** ${lastError}`)
        break
      case 'loop_end':
        finish()
        break
      default:
        break
    }
  }

  let eventChain: Promise<void> = Promise.resolve()
  const unsubscribe = manager.addRawEventListener((frame) => {
    if (frame.runId !== activeRunId) return
    const envelope = readAgentStreamEnvelope(frame.envelope) as StreamEnvelope | null
    if (!envelope) {
      console.warn('[HeadlessAutoReply] Unreadable stream frame')
      return
    }
    if (
      !envelope ||
      envelope.runId !== activeRunId ||
      typeof envelope.seq !== 'number' ||
      !Array.isArray(envelope.events)
    ) {
      return
    }
    if (envelope.seq <= lastSequence) return
    if (envelope.seq !== lastSequence + 1) {
      console.warn(
        `[HeadlessAutoReply] Stream sequence gap: expected ${lastSequence + 1}, got ${envelope.seq}`
      )
    }
    lastSequence = envelope.seq
    for (const event of envelope.events) {
      eventChain = eventChain.then(() => handleEvent(event)).catch(() => {})
    }
  })

  sessionAuthorities.set(sessionId, { permissions })
  const watchdog = setTimeout(() => {
    console.warn(`[HeadlessAutoReply] Run timed out after ${HEADLESS_RUN_TIMEOUT_MS}ms, cancelling`)
    void manager.request('agent/cancel', { runId: activeRunId }, 10_000).catch(() => {})
    lastError = lastError ?? 'Headless channel reply timed out'
    finish()
  }, HEADLESS_RUN_TIMEOUT_MS)

  try {
    const result = await service.startRun({
      sessionId,
      triggerMessageId: userMessageId,
      mode: sessionRow.mode || 'cowork',
      providerId,
      modelId,
      attachmentIds: [],
      commandMetadata: null
    })
    if (!result.accepted || !result.runId) {
      throw new Error(
        result.errorCode
          ? `Headless channel run did not start (${result.errorCode})`
          : 'Headless channel run did not start'
      )
    }
    activeRunId = result.runId
    runAuthorities.set(activeRunId, { permissions })
    console.log('[HeadlessAutoReply] hosted run started', {
      runId: activeRunId,
      sessionId,
      pluginId,
      model: modelId
    })

    await done
    await eventChain
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err)
    console.error('[HeadlessAutoReply] Run failed:', err)
  } finally {
    clearTimeout(watchdog)
    unsubscribe()
    runAuthorities.delete(activeRunId)
    runAuthorities.delete(requestedRunId)
    if (sessionAuthorities.get(sessionId)?.permissions === permissions) {
      sessionAuthorities.delete(sessionId)
    }
    void manager.request('agent/session-close', { sessionId }, 10_000).catch(() => {})
  }

  // ── Final delivery ──
  const fallbackMessage = lastError
    ? `Model run failed: ${lastError}`
    : 'Model did not return a text reply, please check your current model configuration'
  if (!fullText.trim()) {
    appendText(fallbackMessage)
    fullText = fallbackMessage
    deliveredTextLength = 0
  }
  await deliverPendingText()

  // ── Persist assistant + tool-result messages ──
  try {
    const rows: MessageInput[] = []
    let sortOrder = baseSortOrder + 1
    const createdAt = Date.now()
    rows.push({
      id: nanoid(),
      sessionId,
      role: 'assistant',
      content: JSON.stringify(assistantBlocks),
      createdAt,
      usage: assistantUsage ? JSON.stringify(assistantUsage) : null,
      meta: providerResponseId ? JSON.stringify({ providerResponseId }) : null,
      sortOrder: sortOrder++
    })
    for (const results of toolResultMessages) {
      rows.push({
        id: nanoid(),
        sessionId,
        role: 'user',
        content: JSON.stringify(
          results.map((result) => ({
            type: 'tool_result',
            toolUseId: result.toolUseId,
            content: result.content,
            ...(result.isError ? { isError: true } : {})
          }))
        ),
        createdAt,
        sortOrder: sortOrder++
      })
    }
    await addMessages(rows)
  } catch (err) {
    console.error('[HeadlessAutoReply] Failed to persist transcript:', err)
  }

  console.log(
    `[HeadlessAutoReply] Completed for session=${sessionId}, ${fullText.length} chars` +
      (lastError ? `, error=${lastError}` : '')
  )
}

// ── Helpers ──

function modelSupportsVisionLoose(model: AIModelConfig | undefined): boolean {
  if (!model) return false
  const widened = model as AIModelConfig & { supportsVision?: boolean }
  return Boolean(widened.supportsVision || model.category === 'image')
}

async function resolveNextSortOrder(sessionId: string): Promise<number> {
  try {
    const index = await getMessageWindowIndex({
      sessionId,
      direction: 'tail',
      byteBudget: 65536,
      maxRows: 1
    })
    if (index.success && index.rows.length > 0) {
      return index.rows[index.rows.length - 1].sort_order + 1
    }
    if (index.success) {
      return index.total
    }
  } catch {
    /* fall through */
  }
  return Date.now()
}

async function transcribeFeishuVoice(
  task: HeadlessChannelTask,
  providersState: PersistedProvidersState,
  settings: Record<string, unknown>
): Promise<{ ok: true; text: string } | { ok: false; notice: string }> {
  const widened = providersState as PersistedProvidersState & {
    activeSpeechProviderId?: string | null
    activeSpeechModelId?: string
  }
  const speechProviderId = widened.activeSpeechProviderId ?? ''
  const speechModelId = widened.activeSpeechModelId ?? ''
  if (!speechProviderId || !speechModelId) {
    return {
      ok: false,
      notice:
        'Voice message received, but speech recognition model not configured. Please select one in Settings → Model → Speech Recognition Model and try again.'
    }
  }
  const speechProvider = providersState.providers.find(
    (provider) => provider.id === speechProviderId
  )
  if (
    !speechProvider ||
    (speechProvider.type !== 'openai-chat' && speechProvider.type !== 'openai-responses')
  ) {
    return {
      ok: false,
      notice:
        'Speech recognition requires an OpenAI-compatible provider. Please select an OpenAI-compatible model in Settings → Model → Speech Recognition Model and try again.'
    }
  }
  const speechConfig = buildProviderConfigById(
    providersState,
    settings,
    speechProviderId,
    speechModelId
  )
  if (!speechConfig || (speechConfig.requiresApiKey !== false && !speechConfig.apiKey)) {
    return {
      ok: false,
      notice:
        'Speech recognition provider authentication incomplete, please complete authentication in Settings → Model and try again.'
    }
  }

  const download = await downloadFeishuMessageResourceFromMain({
    pluginId: task.pluginId,
    messageId: task.messageId ?? '',
    fileKey: task.audio?.fileKey ?? '',
    type: 'file'
  })
  if (!download.ok || !download.base64) {
    return { ok: false, notice: `Voice download failed: ${download.error ?? 'unknown error'}` }
  }

  try {
    const result = (await getNativeWorker().request(
      'openai-audio/transcribe',
      {
        provider: speechConfig,
        file: {
          base64: download.base64,
          mediaType: task.audio?.mediaType ?? 'application/octet-stream',
          fileName: task.audio?.fileName ?? 'audio'
        }
      },
      OPENAI_AUDIO_NATIVE_TIMEOUT_MS
    )) as { text?: string }
    const text = (result.text ?? '').trim()
    return { ok: true, text: text || '[Voice transcribed, but content is empty]' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, notice: `Voice transcription failed: ${msg}` }
  }
}
