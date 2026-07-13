import { nanoid } from 'nanoid'
import { readPermissionPolicySnapshot, readSettings } from '../ipc/settings-handlers'
import type {
  ToolCallState,
  InteractiveAgentEvent,
  AgentToolResultContent
} from '../../shared/agent-loop-types'
export type { ToolCallState, InteractiveAgentEvent }
import type { RequestDebugInfoWire } from '../../shared/agent-stream-protocol'
import { decodeAgentStreamEnvelope } from '../../shared/messagepack/agent-stream-codec'
import { getNativeSshConnectionPayload } from '../ipc/ssh-connection-payload'
import {
  getBundledResourceDirCandidates,
  nativeUserContentRequest
} from '../ipc/user-content-native'
import { safeSendMessagePackToAllWindows } from '../window-ipc'
import {
  appendCronRunLog,
  createCronRun,
  getCronJob,
  getCronRun,
  replaceCronRunMessages,
  updateCronRun,
  type CronRunLogType,
  type CronRunMessageInput,
  type CronRunStatus
} from '../db/cron-dao'
import { getNativeAgentRuntimeManager } from '../ipc/native-agent-runtime'
import { getDefaultApiUserAgent, resolveApiUserAgent } from '../lib/api-user-agent'
import { readPersistedProviderStore } from '../lib/ai-provider-store'
import { runHooks } from '../hooks/hooks-service'
import {
  collectHookContextTexts,
  HOOK_EVENTS,
  HOOK_RUN_SOURCE,
  HOOK_SESSION_START_SOURCE
} from '../../shared/hooks/types'

const DEFAULT_AGENT = 'CronAgent'
const RESPONSES_SESSION_SCOPE_AGENT_MAIN = 'agent-main'

const CRON_FINAL_REPORT_PROTOCOL = `<final_report_protocol>
Your final assistant message is persisted verbatim as the cron run report.
You MUST finish every run with a detailed report, regardless of whether the task completed, partially completed, was blocked, or failed.
The report must be self-contained, factual, and written in the same language as the scheduled task unless the task requests another language.
Complete any required delivery action before writing the report. Do not call tools after the final report and do not end with a tool call.

Write the report naturally without a required template, fixed headings, or status enum.
Clearly explain the outcome, work performed, material actions or changes, findings, affected files or resources, delivery actions, and concrete evidence.
Describe checks or commands actually run and their outcomes. Never claim validation you did not perform.
If the task fails or is blocked, clearly explain the cause, what was attempted, the current state, and the safest recovery path.
Include any remaining issues, risks, or useful next steps when relevant, with enough detail for the user to understand this run without replaying the transcript.
</final_report_protocol>`

const FALLBACK_CRON_AGENT = {
  name: DEFAULT_AGENT,
  description: 'Scheduled task agent for cron jobs',
  allowedTools: [
    'Read',
    'Write',
    'Edit',
    'LS',
    'Glob',
    'Grep',
    'Bash',
    'Notify',
    'PluginSendMessage',
    'PluginReplyMessage'
  ],
  maxIterations: 15,
  model: undefined as string | undefined,
  temperature: undefined as number | undefined,
  systemPrompt:
    'You are CronAgent, a scheduled task assistant. You execute tasks autonomously on a timer. ' +
    'Be concise and action-oriented. Complete the task, then deliver results as instructed.'
}

const SUPPORTED_BACKGROUND_TOOLS = new Set([
  'Read',
  'Write',
  'Edit',
  'LS',
  'Glob',
  'Grep',
  'Bash',
  'Notify',
  'PluginSendMessage',
  'PluginReplyMessage'
])

type ProviderType =
  | 'anthropic'
  | 'openai-chat'
  | 'openai-responses'
  | 'openai-images'
  | 'gemini'
  | 'vertex-ai'

type ToolInputSchema =
  | {
      type: 'object'
      properties?: Record<string, unknown>
      required?: string[]
      additionalProperties?: boolean
    }
  | {
      oneOf: Array<{
        type: 'object'
        properties?: Record<string, unknown>
        required?: string[]
        additionalProperties?: boolean
      }>
    }

interface RequestTiming {
  totalMs: number
  ttftMs?: number
  tps?: number
}

interface TokenUsage {
  inputTokens: number
  outputTokens: number
  billableInputTokens?: number
  contextTokens?: number
  contextLength?: number
  cacheCreationTokens?: number
  cacheCreation5mTokens?: number
  cacheCreation1hTokens?: number
  cacheReadTokens?: number
  cacheReadRatio?: number
  reasoningTokens?: number
}

type TextBlock = { type: 'text'; text: string }
type ThinkingBlock = {
  type: 'thinking'
  thinking: string
  encryptedContent?: string
  encryptedContentProvider?: 'anthropic' | 'openai-responses' | 'google'
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
type ToolResultBlock = {
  type: 'tool_result'
  toolUseId: string
  content: ToolResultContent
  isError?: boolean
}
type ImageBlock = {
  type: 'image'
  source: { type: 'base64' | 'url'; data?: string; mediaType?: string; url?: string }
}
type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock | ImageBlock
export type ToolResultContent = AgentToolResultContent

interface UnifiedMessage {
  id: string
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentBlock[]
  createdAt: number
  usage?: TokenUsage
  providerResponseId?: string
  source?: string | null
  meta?: Record<string, unknown>
}

export interface CompressionConfig {
  enabled: boolean
  contextLength: number
  threshold: number
  preCompressThreshold?: number
  reservedOutputBudget?: number
}

interface ToolDefinition {
  name: string
  description: string
  inputSchema: ToolInputSchema
}

type ReasoningEffortLevel =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'ultra'
type ResponsesWebsocketMode = 'auto' | 'disabled'

interface ThinkingConfig {
  bodyParams: Record<string, unknown>
  disabledBodyParams?: Record<string, unknown>
  forceTemperature?: number
  reasoningEffortLevels?: ReasoningEffortLevel[]
  defaultReasoningEffort?: ReasoningEffortLevel
}

interface AIModelConfig {
  id: string
  enabled?: boolean
  type?: ProviderType
  category?: string
  maxOutputTokens?: number
  thinkingConfig?: ThinkingConfig
  requestOverrides?: RequestOverrides
  responseSummary?: 'auto' | 'concise' | 'detailed'
  enablePromptCache?: boolean
  enableSystemPromptCache?: boolean
  cacheTtl?: '5m' | '1h'
  serviceTier?: string
  websocketUrl?: string
  websocketMode?: ResponsesWebsocketMode
  supportsBuiltinSearch?: boolean
  enableBuiltinSearch?: boolean
  supportsWebsocket?: boolean
  supportsImageGeneration?: boolean
  responsesImageGeneration?: ProviderConfig['responsesImageGeneration']
}

interface AIProviderConfigRecord {
  id: string
  name: string
  type: ProviderType
  apiKey: string
  baseUrl: string
  enabled: boolean
  builtinId?: string
  models: AIModelConfig[]
  requiresApiKey?: boolean
  useSystemProxy?: boolean
  allowInsecureTls?: boolean
  userAgent?: string
  requestOverrides?: RequestOverrides
  instructionsPrompt?: string
  defaultModel?: string
  authMode?: string
  websocketUrl?: string
  websocketMode?: ResponsesWebsocketMode
  cacheTtl?: '5m' | '1h'
  oauth?: {
    accountId?: string
  }
}

interface RequestOverrides {
  headers?: Record<string, string>
  body?: Record<string, unknown>
  omitBodyKeys?: string[]
}

interface ProviderConfig {
  type: ProviderType
  apiKey: string
  baseUrl?: string
  model: string
  maxTokens?: number
  temperature?: number
  systemPrompt?: string
  thinkingEnabled?: boolean
  thinkingConfig?: ThinkingConfig
  reasoningEffort?: ReasoningEffortLevel
  category?: string
  providerId?: string
  providerBuiltinId?: string
  requiresApiKey?: boolean
  useSystemProxy?: boolean
  allowInsecureTls?: boolean
  responseSummary?: 'auto' | 'concise' | 'detailed'
  enablePromptCache?: boolean
  enableSystemPromptCache?: boolean
  cacheTtl?: '5m' | '1h'
  userAgent?: string
  requestOverrides?: RequestOverrides
  instructionsPrompt?: string
  serviceTier?: string
  sessionId?: string
  responsesSessionScope?: string
  computerUseEnabled?: boolean
  builtinSearchEnabled?: boolean
  responsesImageGeneration?: {
    enabled?: boolean
    action?: string
    background?: string
    inputFidelity?: string
    inputImageMask?: { fileId?: string; imageUrl?: string }
    moderation?: string
    outputFormat?: string
    outputCompression?: number
    quality?: string
    size?: string
    partialImages?: number
  }
  accountId?: string
  websocketUrl?: string
  websocketMode?: ResponsesWebsocketMode
}

export interface ToolContext {
  sessionId?: string
  workingFolder?: string
  signal: AbortSignal
  currentToolUseId?: string
  agentRunId?: string
  callerAgent?: string
  pluginId?: string
  pluginChatId?: string
  pluginChatType?: 'p2p' | 'group'
  pluginSenderId?: string
  pluginSenderName?: string
  sshConnectionId?: string
  sharedState?: { deliveryUsed?: boolean }
}

interface MessageQueueLike {
  drain(): UnifiedMessage[]
}

interface AgentLoopConfig {
  maxIterations: number
  provider: ProviderConfig
  tools: ToolDefinition[]
  signal: AbortSignal
  forceApproval?: boolean
  enableParallelToolExecution?: boolean
  maxParallelTools?: number
  onApprovalNeeded?: (toolCall: ToolCallState) => Promise<boolean>
  messageQueue?: MessageQueueLike
  captureFinalMessages?: boolean
  contextCompression?: CompressionConfig
}

interface AgentDefinition {
  name: string
  description: string
  allowedTools: string[]
  maxIterations: number
  model?: string
  temperature?: number
  systemPrompt: string
}

export interface CronAgentRunOptions {
  jobId: string
  name?: string
  sessionId?: string | null
  prompt: string
  agentId?: string | null
  model?: string | null
  sourceProviderId?: string | null
  workingFolder?: string | null
  sshConnectionId?: string | null
  firedAt?: number
  deliveryMode?: string
  deliveryTarget?: string | null
  maxIterations?: number
  pluginId?: string | null
  pluginChatId?: string | null
  getScheduledState?: () => boolean
}

interface ExecutionState {
  startedAt: number
  progress: { iteration: number; toolCalls: number; currentStep?: string } | null
}

interface CronRunFinishedPayload {
  jobId: string
  runId: string
  status: 'success' | 'error' | 'aborted'
  toolCallCount: number
  jobName?: string
  sessionId?: string | null
  deliveryMode?: string
  deliveryTarget?: string | null
  outputSummary?: string
  error?: string
  scheduled?: boolean
}

const activeRuns = new Map<string, AbortController>()
const executionState = new Map<string, ExecutionState>()

function normalizeProviderType(type: ProviderType): ProviderType {
  if (type === 'gemini' || type === 'vertex-ai') return 'openai-chat'
  return type
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function decodePersistedStoreState<T>(raw: unknown): T | null {
  if (raw == null) return null
  let parsed = raw
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      return null
    }
  }
  if (!parsed || typeof parsed !== 'object') return null
  if ('state' in (parsed as Record<string, unknown>)) {
    return ((parsed as Record<string, unknown>).state as T) ?? null
  }
  return parsed as T
}

type PersistedProvidersState = {
  providers: AIProviderConfigRecord[]
  activeProviderId?: string | null
  activeModelId?: string
  activeFastProviderId?: string | null
  activeFastModelId?: string
}

async function getPersistedProvidersState(): Promise<PersistedProvidersState> {
  return (
    decodePersistedStoreState<{
      providers: AIProviderConfigRecord[]
      activeProviderId?: string | null
      activeModelId?: string
      activeFastProviderId?: string | null
      activeFastModelId?: string
    }>(readPersistedProviderStore()) ?? { providers: [] }
  )
}

function getPersistedSettingsState(): Record<string, unknown> {
  const root = readSettings()
  return decodePersistedStoreState<Record<string, unknown>>(root['opencowork-settings']) ?? {}
}

function normalizeProviderBaseUrl(baseUrl: string, requestType: ProviderType): string {
  const normalizedType = normalizeProviderType(requestType)
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (normalizedType === 'anthropic') {
    return trimmed.replace(/\/v1(?:\/messages)?$/i, '')
  }
  if (requestType === 'gemini' || requestType === 'vertex-ai') {
    return trimmed.replace(/\/openai$/i, '')
  }
  return trimmed
}

function buildRequestOverrides(
  providerOverrides: RequestOverrides | undefined,
  modelOverrides: RequestOverrides | undefined,
  modelId?: string
): RequestOverrides | undefined {
  const headers = {
    ...(providerOverrides?.headers ?? {}),
    ...(modelOverrides?.headers ?? {})
  }
  const body = {
    ...(providerOverrides?.body ?? {}),
    ...(modelOverrides?.body ?? {})
  }
  const omitBodyKeys = Array.from(
    new Set([...(providerOverrides?.omitBodyKeys ?? []), ...(modelOverrides?.omitBodyKeys ?? [])])
  )
  if (/^gpt-5/i.test(modelId ?? '')) {
    omitBodyKeys.push('temperature')
  }
  return Object.keys(headers).length > 0 || Object.keys(body).length > 0 || omitBodyKeys.length > 0
    ? {
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        ...(Object.keys(body).length > 0 ? { body } : {}),
        ...(omitBodyKeys.length > 0 ? { omitBodyKeys: Array.from(new Set(omitBodyKeys)) } : {})
      }
    : undefined
}

function resolveProviderDefaultModelId(provider: AIProviderConfigRecord): string {
  if (
    provider.defaultModel &&
    provider.models.some((model) => model.id === provider.defaultModel)
  ) {
    return provider.defaultModel
  }
  return provider.models.find((model) => model.enabled)?.id ?? provider.models[0]?.id ?? ''
}

function getEffectiveMaxTokens(
  settings: Record<string, unknown>,
  model?: AIModelConfig | null
): number {
  const userMaxTokens = Number(settings.maxTokens ?? 32000)
  if (!model?.maxOutputTokens) return userMaxTokens
  return Math.min(userMaxTokens, model.maxOutputTokens)
}

function isReasoningEffortLevel(value: unknown): value is ReasoningEffortLevel {
  return (
    value === 'none' ||
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max' ||
    value === 'ultra'
  )
}

function getReasoningEffortKey(providerId?: string | null, modelId?: string | null): string | null {
  if (!providerId || !modelId) return null
  return `${providerId}:${modelId}`
}

function resolveReasoningEffortForModel(args: {
  reasoningEffort: ReasoningEffortLevel
  reasoningEffortByModel?: Record<string, ReasoningEffortLevel>
  providerId?: string | null
  modelId?: string | null
  thinkingConfig?: ThinkingConfig
}): ReasoningEffortLevel {
  const key = getReasoningEffortKey(args.providerId, args.modelId)
  const levels = args.thinkingConfig?.reasoningEffortLevels
  const savedEffort = key ? args.reasoningEffortByModel?.[key] : undefined

  if (savedEffort && (!levels || levels.includes(savedEffort))) {
    return savedEffort
  }

  return args.thinkingConfig?.defaultReasoningEffort ?? args.reasoningEffort
}

function readReasoningEffortByModel(
  value: unknown
): Record<string, ReasoningEffortLevel> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined

  const entries = Object.entries(value)
    .filter(([, raw]) => isReasoningEffortLevel(raw))
    .map(([key, raw]) => [key, raw] as const)

  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function buildProviderConfigById(
  state: PersistedProvidersState,
  settings: Record<string, unknown>,
  providerId: string,
  modelId: string
): ProviderConfig | null {
  const provider = state.providers.find((item) => item.id === providerId)
  if (!provider) return null
  const model = provider.models.find((item) => item.id === modelId)
  const requestType = normalizeProviderType(model?.type ?? provider.type)
  const requestOverrides = buildRequestOverrides(
    provider.requestOverrides,
    model?.requestOverrides,
    modelId
  )
  // Server-tool/transport capabilities are per-model opt-ins (default false): a relay can
  // speak the protocol without supporting the feature, so unsupported models must send an
  // explicit "off" rather than inherit provider-level or runtime defaults.
  const supportsWebsocket = requestType === 'openai-responses' && model?.supportsWebsocket === true
  const websocketUrl = supportsWebsocket
    ? (model?.websocketUrl ?? provider.websocketUrl)
    : undefined
  const websocketMode = supportsWebsocket
    ? (model?.websocketMode ?? provider.websocketMode)
    : requestType === 'openai-responses'
      ? 'disabled'
      : undefined
  const thinkingConfig = model?.thinkingConfig
  const baseReasoningEffort = isReasoningEffortLevel(settings.reasoningEffort)
    ? settings.reasoningEffort
    : 'medium'
  const reasoningEffort = resolveReasoningEffortForModel({
    reasoningEffort: baseReasoningEffort,
    reasoningEffortByModel: readReasoningEffortByModel(settings.reasoningEffortByModel),
    providerId: provider.id,
    modelId,
    thinkingConfig
  })
  return {
    type: requestType,
    apiKey: provider.apiKey,
    baseUrl: provider.baseUrl ? normalizeProviderBaseUrl(provider.baseUrl, requestType) : undefined,
    model: modelId,
    thinkingEnabled: settings.thinkingEnabled === true && !!thinkingConfig,
    ...(thinkingConfig ? { thinkingConfig } : {}),
    reasoningEffort,
    category: model?.category,
    providerId: provider.id,
    providerBuiltinId: provider.builtinId,
    requiresApiKey: provider.requiresApiKey,
    ...(provider.useSystemProxy !== undefined ? { useSystemProxy: provider.useSystemProxy } : {}),
    ...(provider.allowInsecureTls !== undefined
      ? { allowInsecureTls: provider.allowInsecureTls }
      : {}),
    userAgent: resolveApiUserAgent(provider.userAgent),
    ...(requestOverrides ? { requestOverrides } : {}),
    ...(provider.instructionsPrompt ? { instructionsPrompt: provider.instructionsPrompt } : {}),
    ...(provider.oauth?.accountId ? { accountId: provider.oauth.accountId } : {}),
    ...(model?.responseSummary ? { responseSummary: model.responseSummary } : {}),
    ...(model?.enablePromptCache !== undefined
      ? { enablePromptCache: model.enablePromptCache }
      : {}),
    ...(model?.enableSystemPromptCache !== undefined
      ? { enableSystemPromptCache: model.enableSystemPromptCache }
      : {}),
    cacheTtl: model?.cacheTtl ?? provider.cacheTtl,
    ...(model?.serviceTier ? { serviceTier: model.serviceTier } : {}),
    ...((requestType === 'anthropic' || requestType === 'openai-responses') &&
    model?.supportsBuiltinSearch === true &&
    model?.enableBuiltinSearch === true
      ? { builtinSearchEnabled: true }
      : {}),
    // The runtime treats a missing image_generation config as enabled, so Responses
    // requests always carry an explicit flag derived from the model capability.
    ...(requestType === 'openai-responses'
      ? {
          responsesImageGeneration: {
            ...(model?.responsesImageGeneration ?? {}),
            enabled:
              model?.supportsImageGeneration === true &&
              model?.responsesImageGeneration?.enabled !== false
          }
        }
      : {}),
    ...(websocketUrl ? { websocketUrl } : {}),
    ...(websocketMode ? { websocketMode } : {}),
    maxTokens: getEffectiveMaxTokens(settings, model),
    temperature: Number(settings.temperature ?? 0.7)
  }
}

function getFastProviderConfig(
  state: PersistedProvidersState,
  settings: Record<string, unknown>
): ProviderConfig | null {
  const providerId = state.activeFastProviderId ?? state.activeProviderId
  if (!providerId) return null
  const provider = state.providers.find((item) => item.id === providerId)
  if (!provider) return null
  const modelId =
    state.activeFastModelId && provider.models.some((model) => model.id === state.activeFastModelId)
      ? state.activeFastModelId
      : resolveProviderDefaultModelId(provider)
  if (!modelId) return null
  return buildProviderConfigById(state, settings, providerId, modelId)
}

async function resolveCronProviderConfig(
  providerId?: string | null,
  modelOverride?: string | null
): Promise<ProviderConfig | null> {
  const settings = getPersistedSettingsState()
  const state = await getPersistedProvidersState()

  // 1. Try the explicit provider (with model override or its default model)
  if (providerId) {
    const provider = state.providers.find((item) => item.id === providerId)
    if (provider) {
      const modelId = modelOverride || resolveProviderDefaultModelId(provider)
      if (modelId) {
        const direct = buildProviderConfigById(state, settings, providerId, modelId)
        if (direct && (direct.apiKey || direct.requiresApiKey === false)) {
          return direct
        }
      }
      console.warn(
        `[CronAgent] Provider ${providerId} found but no usable model/key (model=${modelOverride})`
      )
    } else {
      console.warn(`[CronAgent] Provider ${providerId} not found in persisted state`)
    }
  }

  // 2. Try the fast provider (or active provider)
  const fast = getFastProviderConfig(state, settings)
  if (fast && (fast.apiKey || fast.requiresApiKey === false)) {
    const model = modelOverride || fast.model
    return {
      ...fast,
      model,
      maxTokens: Number(settings.maxTokens ?? fast.maxTokens ?? 32000),
      temperature: Number(settings.temperature ?? fast.temperature ?? 0.7)
    }
  }

  // 3. Legacy fallback from settings.json
  const fallbackType = normalizeProviderType(
    (settings.provider as ProviderType | undefined) ?? 'anthropic'
  )
  const fallbackModel =
    (modelOverride as string | undefined) ?? (settings.model as string | undefined) ?? ''
  const fallbackApiKey = String(settings.apiKey ?? '')
  if (!fallbackApiKey && fallbackType !== 'openai-chat') {
    console.warn(
      `[CronAgent] No provider resolved: providerId=${providerId ?? 'null'}, ` +
        `fastProvider=${state.activeFastProviderId ?? state.activeProviderId ?? 'null'}, ` +
        `providerCount=${state.providers.length}, fallbackKey=${fallbackApiKey ? 'set' : 'empty'}`
    )
    return null
  }
  return {
    type: fallbackType,
    apiKey: fallbackApiKey,
    baseUrl:
      typeof settings.baseUrl === 'string' && settings.baseUrl ? settings.baseUrl : undefined,
    model: fallbackModel,
    maxTokens: Number(settings.maxTokens ?? 32000),
    temperature: Number(settings.temperature ?? 0.7),
    userAgent: getDefaultApiUserAgent()
  }
}

async function resolveCronAgentDefinition(agentId?: string | null): Promise<AgentDefinition> {
  if (!agentId || agentId === DEFAULT_AGENT) return FALLBACK_CRON_AGENT
  try {
    const agent = await nativeUserContentRequest<
      | (AgentDefinition & {
          tools?: string[]
          maxTurns?: number
        })
      | { error: string }
    >('agents/load', {
      name: agentId,
      bundledDirCandidates: getBundledResourceDirCandidates('agents')
    })
    if ('error' in agent) {
      console.warn('[CronAgent] Native agent load failed:', agent.error)
      return FALLBACK_CRON_AGENT
    }

    const sourceTools =
      agent.allowedTools.length > 0
        ? agent.allowedTools
        : Array.isArray(agent.tools)
          ? agent.tools
          : []
    const maxIterations =
      agent.maxIterations > 0
        ? agent.maxIterations
        : (agent.maxTurns ?? 0) > 0
          ? agent.maxTurns!
          : 15

    return {
      name: agent.name,
      description: agent.description,
      allowedTools: sourceTools.filter((toolName) => SUPPORTED_BACKGROUND_TOOLS.has(toolName)),
      maxIterations,
      model: agent.model,
      temperature: agent.temperature,
      systemPrompt: agent.systemPrompt
    }
  } catch (err) {
    console.warn('[CronAgent] Failed to load custom agent definition from native worker:', err)
  }
  return FALLBACK_CRON_AGENT
}

function buildCronAgentSystemPrompt(systemPrompt: string): string {
  return `${systemPrompt.trim()}\n\n${CRON_FINAL_REPORT_PROTOCOL}`
}

type NativeAgentRunResult = {
  started?: boolean
  runId?: string
}

type NativeAgentToolUseBlock = {
  id?: string
  name?: string
  input?: Record<string, unknown>
  extraContent?: Record<string, unknown>
}

type NativeAgentToolResult = {
  toolUseId?: string
  content?: ToolResultContent
  isError?: boolean
}

type NativeAgentToolCallState = {
  id?: string
  name?: string
  input?: Record<string, unknown>
  status?: ToolCallState['status']
  output?: ToolResultContent
  error?: string
  requiresApproval?: boolean
  startedAt?: number
  completedAt?: number
}

type NativeAgentStreamEvent = {
  type?: string
  iteration?: number
  reason?: 'completed' | 'max_iterations' | 'aborted' | 'error'
  text?: string
  thinking?: string
  content?: string
  provider?: 'anthropic' | 'openai-responses' | 'google'
  message?: string
  errorType?: string
  details?: string
  stackTrace?: string
  toolCallId?: string
  toolName?: string
  partialInput?: Record<string, unknown>
  toolUseBlock?: NativeAgentToolUseBlock
  toolCall?: NativeAgentToolCallState
  toolResults?: NativeAgentToolResult[]
  debugInfo?: RequestDebugInfoWire
  usage?: TokenUsage
  timing?: RequestTiming
  providerResponseId?: string
  stopReason?: string
  imageBlock?: ImageBlock
  partialImageIndex?: number
  imageError?: { code: string; message: string }
}

type NativeAgentStreamEnvelope = {
  runId?: string
  events?: NativeAgentStreamEvent[]
}

function normalizeNativeToolCall(toolCall: NativeAgentToolCallState | undefined): ToolCallState {
  return {
    id: toolCall?.id ?? nanoid(),
    name: toolCall?.name ?? '',
    input: isRecord(toolCall?.input) ? toolCall.input : {},
    status: toolCall?.status ?? 'running',
    output: toolCall?.output,
    error: toolCall?.error,
    requiresApproval: toolCall?.requiresApproval === true,
    startedAt: toolCall?.startedAt,
    completedAt: toolCall?.completedAt
  }
}

function mapNativeAgentEventToInteractiveEvent(
  event: NativeAgentStreamEvent
): InteractiveAgentEvent | null {
  switch (event.type) {
    case 'loop_start':
      return { type: 'loop_start' }
    case 'iteration_start':
      return { type: 'iteration_start', iteration: event.iteration ?? 0 }
    case 'thinking_delta':
      return { type: 'thinking_delta', thinking: event.thinking ?? '' }
    case 'thinking_encrypted':
      return event.content && event.provider
        ? {
            type: 'thinking_encrypted',
            thinkingEncryptedContent: event.content,
            thinkingEncryptedProvider: event.provider
          }
        : null
    case 'text_delta':
      return { type: 'text_delta', text: event.text ?? '' }
    case 'tool_use_streaming_start':
      return event.toolCallId
        ? {
            type: 'tool_use_streaming_start',
            toolCallId: event.toolCallId,
            toolName: event.toolName ?? ''
          }
        : null
    case 'tool_use_args_delta':
      return event.toolCallId
        ? {
            type: 'tool_use_args_delta',
            toolCallId: event.toolCallId,
            partialInput: isRecord(event.partialInput) ? event.partialInput : {}
          }
        : null
    case 'tool_use_generated': {
      const block = event.toolUseBlock
      if (!block?.id || !block.name) return null
      return {
        type: 'tool_use_generated',
        toolUseBlock: {
          id: block.id,
          name: block.name,
          input: isRecord(block.input) ? block.input : {},
          ...(block.extraContent ? { extraContent: block.extraContent } : {})
        }
      }
    }
    case 'tool_call_start':
      return { type: 'tool_call_start', toolCall: normalizeNativeToolCall(event.toolCall) }
    case 'tool_call_approval_needed':
      return {
        type: 'tool_call_approval_needed',
        toolCall: normalizeNativeToolCall(event.toolCall)
      }
    case 'tool_call_result':
      return { type: 'tool_call_result', toolCall: normalizeNativeToolCall(event.toolCall) }
    case 'image_generation_started':
      return { type: 'image_generation_started' }
    case 'image_generation_partial':
      return event.imageBlock
        ? {
            type: 'image_generation_partial',
            imageBlock: event.imageBlock,
            ...(typeof event.partialImageIndex === 'number'
              ? { partialImageIndex: event.partialImageIndex }
              : {})
          }
        : null
    case 'image_generated':
      return event.imageBlock ? { type: 'image_generated', imageBlock: event.imageBlock } : null
    case 'image_error':
      return event.imageError ? { type: 'image_error', imageError: event.imageError } : null
    case 'request_debug':
      return event.debugInfo ? { type: 'request_debug', debugInfo: event.debugInfo } : null
    case 'message_end':
      return {
        type: 'message_end',
        usage: event.usage,
        timing: event.timing,
        providerResponseId: event.providerResponseId
      }
    case 'iteration_end':
      return {
        type: 'iteration_end',
        toolResults: Array.isArray(event.toolResults)
          ? event.toolResults
              .filter(
                (
                  result
                ): result is Required<Pick<NativeAgentToolResult, 'toolUseId'>> &
                  NativeAgentToolResult => typeof result.toolUseId === 'string'
              )
              .map((result) => ({
                toolUseId: result.toolUseId,
                content: result.content ?? '',
                ...(result.isError ? { isError: true } : {})
              }))
          : []
      }
    case 'error':
      return {
        type: 'error',
        error: Object.assign(new Error(event.message ?? 'Native cron agent failed'), {
          name: event.errorType ?? 'NativeCronAgentError',
          details: event.details,
          stack: event.stackTrace
        })
      }
    case 'loop_end':
      return { type: 'loop_end', reason: event.reason ?? 'completed' }
    default:
      return null
  }
}

async function* runNativeAgentLoop(args: {
  runId: string
  messages: UnifiedMessage[]
  config: AgentLoopConfig
  toolCtx: ToolContext
}): AsyncGenerator<InteractiveAgentEvent> {
  const manager = getNativeAgentRuntimeManager()
  const ready = await manager.ensureStarted()
  if (!ready) {
    throw new Error('Native agent runtime is unavailable')
  }

  const queue: InteractiveAgentEvent[] = []
  let nativeRunId = args.runId
  let finished = false
  let notify: (() => void) | null = null

  const wake = (): void => {
    if (!notify) return
    const resume = notify
    notify = null
    resume()
  }

  const dispatch = (event: NativeAgentStreamEvent): void => {
    const mapped = mapNativeAgentEventToInteractiveEvent(event)
    if (!mapped) return
    queue.push(mapped)
    if (mapped.type === 'loop_end' || mapped.type === 'error') {
      finished = true
    }
    wake()
  }

  const unsubscribe = manager.addRawEventListener((frame) => {
    if (frame.runId !== nativeRunId) return

    let envelope: NativeAgentStreamEnvelope | null = null
    try {
      envelope = decodeAgentStreamEnvelope(frame.bytes) as NativeAgentStreamEnvelope
    } catch (error) {
      console.warn(
        '[CronAgent] Failed to decode native stream frame:',
        error instanceof Error ? error.message : String(error)
      )
      return
    }

    if (!envelope.runId || envelope.runId !== nativeRunId || !Array.isArray(envelope.events)) return
    for (const event of envelope.events) {
      dispatch(event)
    }
  })

  const abortHandler = (): void => {
    if (nativeRunId) {
      void manager.request('agent/cancel', { runId: nativeRunId }, 10_000).catch(() => {})
    }
    finished = true
    queue.push({ type: 'loop_end', reason: 'aborted' })
    wake()
  }
  args.config.signal.addEventListener('abort', abortHandler, { once: true })

  try {
    const connection = args.toolCtx.sshConnectionId
      ? getNativeSshConnectionPayload(args.toolCtx.sshConnectionId)
      : null
    if (args.toolCtx.sshConnectionId && !connection) {
      throw new Error(`SSH connection not found for cron agent: ${args.toolCtx.sshConnectionId}`)
    }

    const permissionPolicy = readPermissionPolicySnapshot()
    const runRequest = {
      runId: args.runId,
      sessionId: args.toolCtx.sessionId ?? args.runId,
      messages: args.messages,
      provider: args.config.provider,
      tools: args.config.tools,
      workingFolder: args.toolCtx.workingFolder,
      sshConnectionId: args.toolCtx.sshConnectionId,
      ...(connection ? { connection } : {}),
      ...(permissionPolicy ? { permissionPolicy } : {}),
      maxIterations: args.config.maxIterations,
      forceApproval: args.config.forceApproval === true,
      maxParallelTools: args.config.maxParallelTools,
      callerAgent: 'CronAgent',
      pluginId: args.toolCtx.pluginId,
      pluginChatId: args.toolCtx.pluginChatId,
      pluginChatType: args.toolCtx.pluginChatType,
      pluginSenderId: args.toolCtx.pluginSenderId,
      pluginSenderName: args.toolCtx.pluginSenderName
    }

    const sessionStartHook = await runHooks({
      eventName: HOOK_EVENTS.sessionStart,
      matcherValue: HOOK_SESSION_START_SOURCE.startup,
      sessionId: args.toolCtx.sessionId ?? args.runId,
      runId: args.runId,
      projectRoot: args.toolCtx.workingFolder,
      sshConnectionId: args.toolCtx.sshConnectionId,
      input: {
        source: HOOK_SESSION_START_SOURCE.startup,
        runSource: HOOK_RUN_SOURCE.cron,
        sessionMode: 'cron',
        toolNames: args.config.tools.map((tool) => tool.name),
        providerType: args.config.provider.type,
        modelId: args.config.provider.model
      }
    })
    if (sessionStartHook.blocked) {
      throw new Error(sessionStartHook.reason || 'SessionStart hook blocked cron agent run')
    }
    const hookContextTexts = collectHookContextTexts(sessionStartHook)

    const result = (await manager.request(
      'agent/run',
      hookContextTexts.length > 0
        ? { ...runRequest, requestContextTexts: hookContextTexts }
        : runRequest,
      30_000
    )) as NativeAgentRunResult
    if (!result.started || !result.runId) {
      throw new Error('Native cron agent run did not start')
    }
    nativeRunId = result.runId
    console.log('[CronAgent] native agent run started', {
      runId: nativeRunId,
      providerType: args.config.provider.type,
      model: args.config.provider.model
    })

    while (!finished || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          notify = resolve
        })
        continue
      }
      const next = queue.shift()
      if (next) yield next
    }
  } catch (error) {
    yield {
      type: 'error',
      error: error instanceof Error ? error : new Error(String(error))
    }
    yield { type: 'loop_end', reason: args.config.signal.aborted ? 'aborted' : 'error' }
  } finally {
    args.config.signal.removeEventListener('abort', abortHandler)
    unsubscribe()
  }
}

const BACKGROUND_TOOL_DEFINITIONS: Record<string, ToolDefinition> = {
  Read: {
    name: 'Read',
    description: 'Read a file from the filesystem',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute path or relative to the working folder'
        },
        offset: { type: 'number', description: 'Start line (1-indexed)' },
        limit: { type: 'number', description: 'Number of lines to read' }
      },
      required: ['file_path']
    }
  },
  Write: {
    name: 'Write',
    description: 'Writes a file to the filesystem.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute path or relative to the working folder'
        },
        content: { type: 'string', description: 'The content to write to the file' }
      },
      required: ['file_path', 'content']
    }
  },
  Edit: {
    name: 'Edit',
    description: 'Performs exact string replacements in files.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute path or relative to the working folder'
        },
        old_string: { type: 'string', description: 'The text to replace' },
        new_string: { type: 'string', description: 'Replacement text' },
        replace_all: { type: 'boolean', description: 'Replace all occurrences' }
      },
      required: ['file_path', 'old_string', 'new_string']
    }
  },
  LS: {
    name: 'LS',
    description: 'List files and directories in a given path',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path or relative to the working folder' },
        ignore: { type: 'array', items: { type: 'string' }, description: 'Glob patterns to ignore' }
      }
    }
  },
  Glob: {
    name: 'Glob',
    description: 'Fast file pattern matching tool',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern to match files' },
        path: { type: 'string', description: 'Optional search directory' },
        limit: { type: 'number', description: 'Maximum result count' }
      },
      required: ['pattern']
    }
  },
  Grep: {
    name: 'Grep',
    description: 'Search file contents using regular expressions',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        path: { type: 'string', description: 'Directory to search in' },
        glob: { type: 'string', description: 'File glob to include' },
        output_mode: {
          type: 'string',
          description: 'matches, files_with_matches, files_without_matches, or count'
        },
        maxResults: { type: 'number', description: 'Maximum result rows to return' },
        maxDepth: { type: 'number', description: 'Maximum directory depth to search' },
        ignoreCase: { type: 'boolean', description: 'Use case-insensitive matching' },
        literal: { type: 'boolean', description: 'Treat pattern as a literal string' }
      },
      required: ['pattern']
    }
  },
  Bash: {
    name: 'Bash',
    description: 'Execute a shell command in the working folder.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command to execute' },
        timeout: { type: 'number', description: 'Timeout in milliseconds' }
      },
      required: ['command']
    }
  },
  Notify: {
    name: 'Notify',
    description: 'Send a desktop notification to the user.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Notification title' },
        body: { type: 'string', description: 'Notification body' },
        type: { type: 'string', description: 'Notification style' },
        duration: {
          type: 'number',
          description: 'How long the toast stays visible in milliseconds'
        }
      },
      required: ['title', 'body']
    }
  },
  PluginSendMessage: {
    name: 'PluginSendMessage',
    description: 'Send a message to a chat/group via a messaging channel.',
    inputSchema: {
      type: 'object',
      properties: {
        plugin_id: { type: 'string', description: 'The channel instance ID to use' },
        chat_id: { type: 'string', description: 'The chat/group ID to send the message to' },
        content: { type: 'string', description: 'The message content to send' }
      },
      required: ['plugin_id', 'chat_id', 'content']
    }
  },
  PluginReplyMessage: {
    name: 'PluginReplyMessage',
    description: 'Reply to a specific message via a messaging channel.',
    inputSchema: {
      type: 'object',
      properties: {
        plugin_id: { type: 'string', description: 'The channel instance ID to use' },
        message_id: { type: 'string', description: 'The message ID to reply to' },
        content: { type: 'string', description: 'The reply content' }
      },
      required: ['plugin_id', 'message_id', 'content']
    }
  }
}

function buildAllowedToolDefinitions(allowedToolNames: string[]): ToolDefinition[] {
  return allowedToolNames
    .filter(
      (toolName) =>
        SUPPORTED_BACKGROUND_TOOLS.has(toolName) && !!BACKGROUND_TOOL_DEFINITIONS[toolName]
    )
    .map((toolName) => BACKGROUND_TOOL_DEFINITIONS[toolName])
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
    createdAt: Date.now()
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
    last.text += text
    return
  }
  blocks.push({ type: 'text', text })
}

function getLastAssistantText(messages: UnifiedMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'assistant') continue
    if (typeof message.content === 'string') {
      const text = message.content.trim()
      if (text) return text
      continue
    }

    const text = message.content
      .filter((block): block is TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim()
    if (text) return text
  }

  return ''
}

function appendThinking(messages: UnifiedMessage[], thinking: string): void {
  const message = ensureAssistantMessage(messages)
  const blocks = getAssistantBlocks(message)
  const last = blocks[blocks.length - 1]
  if (last?.type === 'thinking' && !last.completedAt) {
    last.thinking += thinking
    return
  }
  blocks.push({ type: 'thinking', thinking, startedAt: Date.now() })
}

function completeThinking(messages: UnifiedMessage[]): void {
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'assistant') return
  const blocks = getAssistantBlocks(last)
  const thinking = [...blocks]
    .reverse()
    .find((block): block is ThinkingBlock => block.type === 'thinking' && !block.completedAt)
  if (thinking) {
    thinking.completedAt = Date.now()
  }
}

function appendToolUse(messages: UnifiedMessage[], toolUse: ToolUseBlock): void {
  const message = ensureAssistantMessage(messages)
  const blocks = getAssistantBlocks(message)
  blocks.push(toolUse)
}

function appendToolResult(
  messages: UnifiedMessage[],
  toolUseId: string,
  content: ToolResultContent,
  isError?: boolean
): void {
  messages.push({
    id: nanoid(),
    role: 'user',
    content: [{ type: 'tool_result', toolUseId, content, ...(isError ? { isError: true } : {}) }],
    createdAt: Date.now()
  })
}

type CronRunSnapshot = {
  id: string
  jobId: string
  startedAt: number
  finishedAt: number | null
  status: CronRunStatus
  toolCallCount: number
  outputSummary: string | null
  error: string | null
  scheduledFor: number | null
  jobNameSnapshot: string | null
  promptSnapshot: string | null
  sourceSessionIdSnapshot: string | null
  sourceSessionTitleSnapshot: string | null
  sourceProjectIdSnapshot: string | null
  sourceProjectNameSnapshot: string | null
  sourceProviderIdSnapshot: string | null
  modelSnapshot: string | null
  workingFolderSnapshot: string | null
  deliveryModeSnapshot: string | null
  deliveryTargetSnapshot: string | null
}

type CronJobSnapshot = {
  id: string
  sessionId: string | null
  name: string
  schedule: {
    kind: 'at' | 'every' | 'cron'
    at: number | null
    every: number | null
    expr: string | null
    tz: string
  }
  prompt: string
  agentId: string | null
  model: string | null
  workingFolder: string | null
  sshConnectionId: string | null
  deliveryMode: string
  deliveryTarget: string | null
  pluginId: string | null
  pluginChatId: string | null
  enabled: boolean
  deleteAfterRun: boolean
  maxIterations: number
  deletedAt: number | null
  lastFiredAt: number | null
  fireCount: number
  createdAt: number
  updatedAt: number
  sourceSessionTitle: string | null
  sourceProjectId: string | null
  sourceProjectName: string | null
  sourceProviderId: string | null
  scheduled: boolean
  executing: boolean
  executionStartedAt: number | null
  executionProgress: { iteration: number; toolCalls: number; currentStep?: string } | null
}

function toPersistedMessages(messages: UnifiedMessage[]): CronRunMessageInput[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    usage: message.usage,
    source: message.source ?? null,
    createdAt: message.createdAt
  }))
}

async function createRunRecord(options: {
  runId: string
  jobId: string
  startedAt: number
  scheduledFor?: number | null
  jobNameSnapshot?: string | null
  promptSnapshot?: string | null
  sourceSessionIdSnapshot?: string | null
  sourceSessionTitleSnapshot?: string | null
  sourceProjectIdSnapshot?: string | null
  sourceProjectNameSnapshot?: string | null
  sourceProviderIdSnapshot?: string | null
  modelSnapshot?: string | null
  workingFolderSnapshot?: string | null
  deliveryModeSnapshot?: string | null
  deliveryTargetSnapshot?: string | null
}): Promise<void> {
  await createCronRun(options)
}

async function updateRunRecord(
  runId: string,
  patch: Partial<{
    finishedAt: number | null
    status: CronRunStatus
    toolCallCount: number
    outputSummary: string | null
    error: string | null
  }>
): Promise<void> {
  if (Object.keys(patch).length === 0) return
  await updateCronRun({ runId, patch })
}

function replaceRunMessages(
  runId: string,
  messages: ReturnType<typeof toPersistedMessages>
): Promise<void> {
  return replaceCronRunMessages(runId, messages)
}

function appendRunLog(
  runId: string,
  timestamp: number,
  type: CronRunLogType,
  content: string
): Promise<void> {
  return appendCronRunLog(runId, timestamp, type, content)
}

function emitRunStarted(jobId: string, runId: string): void {
  const payload = { jobId, runId }
  safeSendMessagePackToAllWindows('cron:run-started', payload)
}

function emitRunProgress(
  jobId: string,
  runId: string,
  progress: { iteration: number; toolCalls: number; currentStep?: string }
): void {
  const payload = {
    jobId,
    runId,
    ...progress,
    elapsed: Date.now() - (executionState.get(jobId)?.startedAt ?? Date.now())
  }
  safeSendMessagePackToAllWindows('cron:run-progress', payload)
}

function emitRunLog(
  jobId: string,
  entry: {
    timestamp: number
    type: 'start' | 'text' | 'tool_call' | 'tool_result' | 'error' | 'end'
    content: string
  }
): void {
  const payload = { jobId, ...entry }
  safeSendMessagePackToAllWindows('cron:run-log-appended', payload)
}

async function loadRunSnapshot(runId: string): Promise<CronRunSnapshot | null> {
  const row = await getCronRun(runId)
  if (!row) return null

  return {
    id: row.id,
    jobId: row.job_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
    toolCallCount: row.tool_call_count,
    outputSummary: row.output_summary,
    error: row.error,
    scheduledFor: row.scheduled_for,
    jobNameSnapshot: row.job_name_snapshot,
    promptSnapshot: row.prompt_snapshot,
    sourceSessionIdSnapshot: row.source_session_id_snapshot,
    sourceSessionTitleSnapshot: row.source_session_title_snapshot,
    sourceProjectIdSnapshot: row.source_project_id_snapshot,
    sourceProjectNameSnapshot: row.source_project_name_snapshot,
    sourceProviderIdSnapshot: row.source_provider_id_snapshot,
    modelSnapshot: row.model_snapshot,
    workingFolderSnapshot: row.working_folder_snapshot,
    deliveryModeSnapshot: row.delivery_mode_snapshot,
    deliveryTargetSnapshot: row.delivery_target_snapshot
  }
}

async function loadJobSnapshot(jobId: string, scheduled: boolean): Promise<CronJobSnapshot | null> {
  const row = await getCronJob(jobId)
  if (!row) return null

  return {
    id: row.id,
    sessionId: row.session_id,
    name: row.name,
    schedule: {
      kind: row.schedule_kind,
      at: row.schedule_at,
      every: row.schedule_every,
      expr: row.schedule_expr,
      tz: row.schedule_tz
    },
    prompt: row.prompt,
    agentId: row.agent_id,
    model: row.model,
    workingFolder: row.working_folder,
    sshConnectionId: row.ssh_connection_id,
    deliveryMode: row.delivery_mode,
    deliveryTarget: row.delivery_target,
    pluginId: row.plugin_id,
    pluginChatId: row.plugin_chat_id,
    enabled: Boolean(row.enabled),
    deleteAfterRun: Boolean(row.delete_after_run),
    maxIterations: row.max_iterations,
    deletedAt: row.deleted_at,
    lastFiredAt: row.last_fired_at,
    fireCount: row.fire_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sourceSessionTitle: row.source_session_title,
    sourceProjectId: row.source_project_id,
    sourceProjectName: row.source_project_name,
    sourceProviderId: row.source_provider_id,
    scheduled,
    executing: false,
    executionStartedAt: null,
    executionProgress: null
  }
}

async function emitRunFinished(payload: CronRunFinishedPayload): Promise<void> {
  const run = await loadRunSnapshot(payload.runId)
  const job = await loadJobSnapshot(payload.jobId, Boolean(payload.scheduled))
  const eventPayload = {
    ...payload,
    ...(run ? { run } : {}),
    ...(job ? { job } : {})
  }
  safeSendMessagePackToAllWindows('cron:run-finished', eventPayload)
}

export function getCronExecutionState(jobId: string): ExecutionState | null {
  return executionState.get(jobId) ?? null
}

export function abortCronAgentRun(jobId: string): boolean {
  const controller = activeRuns.get(jobId)
  if (!controller) return false
  controller.abort()
  return true
}

export function runCronAgentInBackground(
  options: CronAgentRunOptions,
  onFinished?: (jobId: string) => void
): void {
  const { jobId } = options
  if (activeRuns.has(jobId)) {
    console.warn(`[CronAgent] Job ${jobId} is already running, skipping duplicate trigger`)
    return
  }
  const controller = new AbortController()
  activeRuns.set(jobId, controller)
  const startedAt = Date.now()
  executionState.set(jobId, {
    startedAt,
    progress: { iteration: 0, toolCalls: 0, currentStep: 'initializing' }
  })
  void runCronAgentInternal(options, controller)
    .catch((err) => {
      console.error('[CronAgent] Background run failed:', err)
    })
    .finally(() => {
      activeRuns.delete(jobId)
      executionState.delete(jobId)
      onFinished?.(jobId)
    })
}

async function runCronAgentInternal(
  options: CronAgentRunOptions,
  controller: AbortController
): Promise<void> {
  const {
    jobId,
    name,
    sessionId,
    prompt,
    agentId,
    model: modelOverride,
    sourceProviderId,
    workingFolder,
    sshConnectionId,
    firedAt,
    deliveryMode = 'desktop',
    deliveryTarget,
    maxIterations,
    pluginId,
    pluginChatId,
    getScheduledState
  } = options

  const runId = `run-${nanoid(8)}`
  const startedAt = executionState.get(jobId)?.startedAt ?? Date.now()
  const providerConfig = await resolveCronProviderConfig(
    sourceProviderId ?? null,
    modelOverride ?? null
  )
  const definition = await resolveCronAgentDefinition(agentId)
  const availableTools = buildAllowedToolDefinitions(
    definition.allowedTools.length > 0 ? definition.allowedTools : FALLBACK_CRON_AGENT.allowedTools
  )

  await createRunRecord({
    runId,
    jobId,
    startedAt,
    scheduledFor: firedAt ?? null,
    jobNameSnapshot: name ?? null,
    promptSnapshot: prompt,
    sourceSessionIdSnapshot: sessionId ?? null,
    modelSnapshot: modelOverride ?? null,
    workingFolderSnapshot: workingFolder ?? null,
    deliveryModeSnapshot: deliveryMode,
    deliveryTargetSnapshot: deliveryTarget ?? null
  })
  emitRunStarted(jobId, runId)

  if (!providerConfig) {
    const error = 'No AI provider configured for CronAgent background execution'
    await appendRunLog(runId, Date.now(), 'error', error)
    emitRunLog(jobId, { timestamp: Date.now(), type: 'error', content: error })
    await updateRunRecord(runId, {
      finishedAt: Date.now(),
      status: 'error',
      toolCallCount: 0,
      outputSummary: null,
      error
    })
    await emitRunFinished({
      jobId,
      runId,
      status: 'error',
      toolCallCount: 0,
      jobName: name,
      sessionId: sessionId ?? null,
      deliveryMode,
      deliveryTarget: deliveryTarget ?? null,
      error,
      scheduled: getScheduledState?.() ?? false
    })
    return
  }

  const innerProvider: ProviderConfig = {
    ...providerConfig,
    systemPrompt: buildCronAgentSystemPrompt(definition.systemPrompt),
    model: modelOverride || definition.model || providerConfig.model,
    temperature: definition.temperature ?? providerConfig.temperature,
    sessionId: sessionId ?? jobId,
    ...(normalizeProviderType(providerConfig.type) === 'openai-responses'
      ? { responsesSessionScope: RESPONSES_SESSION_SCOPE_AGENT_MAIN }
      : {})
  }

  if (innerProvider.requiresApiKey !== false && !innerProvider.apiKey) {
    const error = 'Provider API key is missing for CronAgent background execution'
    await appendRunLog(runId, Date.now(), 'error', error)
    emitRunLog(jobId, { timestamp: Date.now(), type: 'error', content: error })
    await updateRunRecord(runId, {
      finishedAt: Date.now(),
      status: 'error',
      toolCallCount: 0,
      outputSummary: null,
      error
    })
    await emitRunFinished({
      jobId,
      runId,
      status: 'error',
      toolCallCount: 0,
      jobName: name,
      sessionId: sessionId ?? null,
      deliveryMode,
      deliveryTarget: deliveryTarget ?? null,
      error,
      scheduled: getScheduledState?.() ?? false
    })
    return
  }

  const channelInfo =
    pluginId && pluginChatId
      ? `\n## Channel Reply Routing\nThis cron job was created from plugin channel \`${pluginId}\`.\nChat ID: \`${pluginChatId}\`\nWhen you have results to report, use **PluginSendMessage** with plugin_id="${pluginId}" and chat_id="${pluginChatId}" to send the results back through the channel. Alternatively, **Notify** will also route to the channel automatically.`
      : ''
  const deliveryInstructions =
    pluginId && pluginChatId
      ? `When the work is finished, call **PluginSendMessage** EXACTLY ONCE with plugin_id="${pluginId}" and chat_id="${pluginChatId}" to send a friendly result summary back through the channel. Then write the final task report as your last assistant message and stop.`
      : 'When the work is finished, call **Notify** EXACTLY ONCE to send a friendly desktop result summary. Then write the final task report as your last assistant message and stop.'

  const cronContext = `You are a scheduled task assistant running cron job (ID: ${jobId}).\nAgent: ${definition.name}\n${deliveryTarget ? `Target session: ${deliveryTarget}` : ''}${channelInfo}\n\n## Your Task\n${prompt}\n\n## Delivery Instructions\n${deliveryInstructions}\n\nMatch the language of the task prompt in both the delivery message and final report (Chinese task → Chinese reply, English task → English reply). Be concise and friendly.\n\n<system-remind>\nYour final assistant message is persisted verbatim as this cron run's report. End every run with a self-contained report whether the task completed, partially completed, was blocked, or failed. Complete delivery before the report, and do not call tools after the report.\n</system-remind>\n\nBegin working on this task now.`

  const transcriptMessages: UnifiedMessage[] = [
    {
      id: nanoid(),
      role: 'user',
      content: prompt,
      createdAt: Date.now()
    }
  ]
  await replaceRunMessages(runId, toPersistedMessages(transcriptMessages))

  const loopUserMessage: UnifiedMessage = {
    id: nanoid(),
    role: 'user',
    content: cronContext,
    createdAt: transcriptMessages[0].createdAt
  }

  const loopConfig: AgentLoopConfig = {
    maxIterations: maxIterations ?? definition.maxIterations,
    provider: innerProvider,
    tools: availableTools,
    signal: controller.signal
  }
  const toolCtx: ToolContext = {
    sessionId: deliveryTarget ?? undefined,
    workingFolder: workingFolder ?? undefined,
    sshConnectionId: sshConnectionId ?? undefined,
    signal: controller.signal,
    callerAgent: 'CronAgent',
    pluginId: pluginId ?? undefined,
    pluginChatId: pluginChatId ?? undefined,
    sharedState: { deliveryUsed: false }
  }

  let toolCallCount = 0
  let iterationCount = 0
  let error: string | undefined
  const appendLog = async (
    type: 'start' | 'text' | 'tool_call' | 'tool_result' | 'error' | 'end',
    content: string
  ): Promise<void> => {
    const timestamp = Date.now()
    await appendRunLog(runId, timestamp, type, content)
    emitRunLog(jobId, { timestamp, type, content })
  }
  const setProgress = (progress: {
    iteration: number
    toolCalls: number
    currentStep?: string
  }): void => {
    executionState.set(jobId, {
      startedAt,
      progress
    })
    emitRunProgress(jobId, runId, progress)
  }

  // Persisting the transcript replaces every row for the run, so writing on
  // each streamed delta is O(transcript²). Deltas only mark it dirty and a
  // trailing timer flushes; tool/message boundaries and run end flush inline.
  const TRANSCRIPT_FLUSH_MS = 800
  let transcriptDirty = false
  let transcriptFlushTimer: NodeJS.Timeout | null = null
  let transcriptPersistChain: Promise<void> = Promise.resolve()
  const persistTranscript = (): Promise<void> => {
    if (transcriptFlushTimer) {
      clearTimeout(transcriptFlushTimer)
      transcriptFlushTimer = null
    }
    if (!transcriptDirty) return transcriptPersistChain
    transcriptDirty = false
    const snapshot = toPersistedMessages(transcriptMessages)
    transcriptPersistChain = transcriptPersistChain
      .then(() => replaceRunMessages(runId, snapshot))
      .catch((err) => {
        console.error('[cron] failed to persist run transcript:', err)
      })
    return transcriptPersistChain
  }
  const markTranscriptDirty = (): void => {
    transcriptDirty = true
    if (!transcriptFlushTimer) {
      transcriptFlushTimer = setTimeout(() => {
        transcriptFlushTimer = null
        void persistTranscript()
      }, TRANSCRIPT_FLUSH_MS)
    }
  }
  const flushTranscript = (): Promise<void> => {
    transcriptDirty = true
    return persistTranscript()
  }

  await appendLog('start', prompt.slice(0, 400))
  setProgress({ iteration: 0, toolCalls: 0, currentStep: 'initializing' })

  try {
    const loop = runNativeAgentLoop({
      runId,
      messages: [loopUserMessage],
      config: loopConfig,
      toolCtx
    })
    for await (const event of loop) {
      if (controller.signal.aborted && event.type !== 'loop_end') continue
      switch (event.type) {
        case 'iteration_start':
          iterationCount = event.iteration
          setProgress({
            iteration: iterationCount,
            toolCalls: toolCallCount,
            currentStep: 'thinking'
          })
          break
        case 'thinking_delta':
          appendThinking(transcriptMessages, event.thinking)
          markTranscriptDirty()
          break
        case 'thinking_encrypted':
          break
        case 'text_delta':
          appendText(transcriptMessages, event.text)
          markTranscriptDirty()
          break
        case 'tool_use_streaming_start':
          appendToolUse(transcriptMessages, {
            type: 'tool_use',
            id: event.toolCallId,
            name: event.toolName,
            input: {},
            ...(event.toolCallExtraContent ? { extraContent: event.toolCallExtraContent } : {})
          })
          await flushTranscript()
          await appendLog('tool_call', `${event.toolName}(...streaming)`)
          setProgress({
            iteration: iterationCount,
            toolCalls: toolCallCount,
            currentStep: event.toolName
          })
          break
        case 'tool_use_generated': {
          const last = transcriptMessages[transcriptMessages.length - 1]
          if (last?.role === 'assistant' && Array.isArray(last.content)) {
            const blocks = last.content as ContentBlock[]
            const idx = blocks.findIndex(
              (block) => block.type === 'tool_use' && block.id === event.toolUseBlock.id
            )
            if (idx !== -1) {
              blocks[idx] = {
                type: 'tool_use',
                id: event.toolUseBlock.id,
                name: event.toolUseBlock.name,
                input: event.toolUseBlock.input,
                ...(event.toolUseBlock.extraContent
                  ? { extraContent: event.toolUseBlock.extraContent }
                  : {})
              }
            }
          }
          await flushTranscript()
          break
        }
        case 'tool_call_result':
          toolCallCount += 1
          appendToolResult(
            transcriptMessages,
            event.toolCall.id,
            event.toolCall.error ? event.toolCall.error : (event.toolCall.output ?? 'ok'),
            Boolean(event.toolCall.error)
          )
          await flushTranscript()
          await appendLog(
            'tool_result',
            `${event.toolCall.name}: ${event.toolCall.error ?? (event.toolCall.output ?? 'ok').slice(0, 300)}`
          )
          setProgress({
            iteration: iterationCount,
            toolCalls: toolCallCount,
            currentStep: event.toolCall.name
          })
          break
        case 'iteration_end':
          break
        case 'message_end': {
          completeThinking(transcriptMessages)
          const last = transcriptMessages[transcriptMessages.length - 1]
          if (last?.role === 'assistant') {
            last.usage = event.usage
            if (event.providerResponseId) {
              last.providerResponseId = event.providerResponseId
            }
          }
          await flushTranscript()
          break
        }
        case 'error':
          error = event.error.message
          await appendLog('error', error)
          break
        case 'loop_end':
          if (event.reason === 'aborted') {
            error = error ?? 'Aborted'
          }
          break
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
    await appendLog('error', error)
  }

  const finishedAt = Date.now()
  const status: 'success' | 'error' | 'aborted' = controller.signal.aborted
    ? 'aborted'
    : error
      ? 'error'
      : 'success'
  const outputSummary = getLastAssistantText(transcriptMessages)

  await appendLog('end', status)
  await updateRunRecord(runId, {
    finishedAt,
    status,
    toolCallCount,
    outputSummary: outputSummary || null,
    error: error ?? null
  })
  await flushTranscript()
  await emitRunFinished({
    jobId,
    runId,
    status,
    toolCallCount,
    jobName: name,
    sessionId: sessionId ?? null,
    deliveryMode,
    deliveryTarget: deliveryTarget ?? null,
    outputSummary,
    scheduled: getScheduledState?.() ?? false,
    ...(error ? { error } : {})
  })
}
