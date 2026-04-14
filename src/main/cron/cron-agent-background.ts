import { app } from 'electron'
import { nanoid } from 'nanoid'
import { Allow, parse as parsePartialJSON } from 'partial-json'
import { glob } from 'glob'
import { spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { readConfig } from '../ipc/secure-key-store'
import { readSettings } from '../ipc/settings-handlers'
import { showSystemNotification } from '../ipc/notify-handlers'
import { executePluginAction } from '../ipc/channel-handlers'
import { safeSendToAllWindows } from '../window-ipc'
import { getDb } from '../db/database'
import { getSidecarManager } from '../ipc/sidecar-manager'

const DEFAULT_AGENT = 'CronAgent'
const DEFAULT_BASH_TIMEOUT_MS = 600_000
const MAX_PROVIDER_RETRIES = 3
const BASE_RETRY_DELAY_MS = 1_500
const PROMPTS_DIR = path.join(os.homedir(), '.open-cowork', 'prompts')
const AGENTS_DIR = path.join(os.homedir(), '.open-cowork', 'agents')

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
  cacheReadTokens?: number
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
type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock
type ToolResultContent = string

interface UnifiedMessage {
  id: string
  role: 'system' | 'user' | 'assistant'
  content: string | ContentBlock[]
  createdAt: number
  usage?: TokenUsage
  providerResponseId?: string
  source?: string | null
}

interface ToolDefinition {
  name: string
  description: string
  inputSchema: ToolInputSchema
}

interface AIModelConfig {
  id: string
  enabled?: boolean
  type?: ProviderType
  category?: string
  maxOutputTokens?: number
  requestOverrides?: RequestOverrides
  responseSummary?: 'auto' | 'concise' | 'detailed'
  enablePromptCache?: boolean
  enableSystemPromptCache?: boolean
  serviceTier?: string
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
  userAgent?: string
  requestOverrides?: RequestOverrides
  instructionsPrompt?: string
  defaultModel?: string
  authMode?: string
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
  category?: string
  providerId?: string
  providerBuiltinId?: string
  requiresApiKey?: boolean
  useSystemProxy?: boolean
  responseSummary?: 'auto' | 'concise' | 'detailed'
  enablePromptCache?: boolean
  enableSystemPromptCache?: boolean
  userAgent?: string
  requestOverrides?: RequestOverrides
  instructionsPrompt?: string
  serviceTier?: string
  sessionId?: string
  computerUseEnabled?: boolean
  accountId?: string
}

interface StreamEvent {
  type:
    | 'thinking_delta'
    | 'thinking_encrypted'
    | 'text_delta'
    | 'tool_call_start'
    | 'tool_call_delta'
    | 'tool_call_end'
    | 'message_end'
    | 'error'
  thinking?: string
  thinkingEncryptedContent?: string
  thinkingEncryptedProvider?: 'anthropic' | 'openai-responses' | 'google'
  text?: string
  toolCallId?: string
  toolName?: string
  argumentsDelta?: string
  toolCallInput?: Record<string, unknown>
  toolCallExtraContent?: Record<string, unknown>
  stopReason?: string
  usage?: TokenUsage
  timing?: RequestTiming
  providerResponseId?: string
  error?: { type?: string; message?: string }
}

interface ToolCallState {
  id: string
  name: string
  input: Record<string, unknown>
  status: 'streaming' | 'pending_approval' | 'running' | 'completed' | 'error'
  output?: ToolResultContent
  error?: string
  requiresApproval: boolean
  startedAt?: number
  completedAt?: number
}

interface ToolContext {
  sessionId?: string
  workingFolder?: string
  signal: AbortSignal
  currentToolUseId?: string
  callerAgent?: string
  pluginId?: string
  pluginChatId?: string
  sharedState?: { deliveryUsed?: boolean }
}

interface ToolHandler {
  definition: ToolDefinition
  execute: (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResultContent>
}

interface AgentLoopConfig {
  maxIterations: number
  provider: ProviderConfig
  tools: ToolDefinition[]
  signal: AbortSignal
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
  firedAt?: number
  deliveryMode?: string
  deliveryTarget?: string | null
  maxIterations?: number
  pluginId?: string | null
  pluginChatId?: string | null
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
}

const activeRuns = new Map<string, AbortController>()
const executionState = new Map<string, ExecutionState>()

function normalizeProviderType(type: ProviderType): ProviderType {
  if (type === 'gemini' || type === 'vertex-ai') return 'openai-chat'
  return type
}

function encodeStructuredToolResult(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function encodeToolError(message: string): string {
  return encodeStructuredToolResult({ success: false, error: message })
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

function getPersistedProvidersState(): {
  providers: AIProviderConfigRecord[]
  activeProviderId?: string | null
  activeModelId?: string
  activeFastProviderId?: string | null
  activeFastModelId?: string
} {
  const root = readConfig()
  return (
    decodePersistedStoreState<{
      providers: AIProviderConfigRecord[]
      activeProviderId?: string | null
      activeModelId?: string
      activeFastProviderId?: string | null
      activeFastModelId?: string
    }>(root['opencowork-providers']) ?? { providers: [] }
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

function buildProviderConfigById(
  state: ReturnType<typeof getPersistedProvidersState>,
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
  return {
    type: requestType,
    apiKey: provider.apiKey,
    baseUrl: provider.baseUrl ? normalizeProviderBaseUrl(provider.baseUrl, requestType) : undefined,
    model: modelId,
    category: model?.category,
    providerId: provider.id,
    providerBuiltinId: provider.builtinId,
    requiresApiKey: provider.requiresApiKey,
    ...(provider.useSystemProxy !== undefined ? { useSystemProxy: provider.useSystemProxy } : {}),
    ...(provider.userAgent ? { userAgent: provider.userAgent } : {}),
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
    ...(model?.serviceTier ? { serviceTier: model.serviceTier } : {}),
    maxTokens: getEffectiveMaxTokens(settings, model),
    temperature: Number(settings.temperature ?? 0.7)
  }
}

function getFastProviderConfig(
  state: ReturnType<typeof getPersistedProvidersState>,
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

function resolveCronProviderConfig(
  providerId?: string | null,
  modelOverride?: string | null
): ProviderConfig | null {
  const settings = getPersistedSettingsState()
  const state = getPersistedProvidersState()
  if (providerId && modelOverride) {
    const direct = buildProviderConfigById(state, settings, providerId, modelOverride)
    if (direct && (direct.apiKey || direct.requiresApiKey === false)) {
      return direct
    }
  }

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

  const fallbackType = normalizeProviderType(
    (settings.provider as ProviderType | undefined) ?? 'anthropic'
  )
  const fallbackModel =
    (modelOverride as string | undefined) ?? (settings.model as string | undefined) ?? ''
  const fallbackApiKey = String(settings.apiKey ?? '')
  if (!fallbackApiKey && fallbackType !== 'openai-chat') {
    return null
  }
  return {
    type: fallbackType,
    apiKey: fallbackApiKey,
    baseUrl:
      typeof settings.baseUrl === 'string' && settings.baseUrl ? settings.baseUrl : undefined,
    model: fallbackModel,
    maxTokens: Number(settings.maxTokens ?? 32000),
    temperature: Number(settings.temperature ?? 0.7)
  }
}

function getBundledPromptsDir(): string {
  if (!app.isPackaged) {
    return path.join(app.getAppPath(), 'resources', 'prompts')
  }
  const unpacked = path.join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'prompts')
  if (fs.existsSync(unpacked)) return unpacked
  return path.join(process.resourcesPath, 'resources', 'prompts')
}

function normalizePromptFileName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return ''
  return trimmed.toLowerCase().endsWith('.md') ? trimmed : `${trimmed}.md`
}

async function loadPromptContent(name: string): Promise<string | null> {
  const fileName = normalizePromptFileName(name)
  if (!fileName) return null
  const candidates = [path.join(PROMPTS_DIR, fileName), path.join(getBundledPromptsDir(), fileName)]
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return await fs.promises.readFile(candidate, 'utf8')
      }
    } catch {
      // ignore
    }
  }
  return null
}

function parseAgentFile(content: string, filename: string): AgentDefinition | null {
  const fmMatch = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/)
  if (!fmMatch) return null
  const fmBlock = fmMatch[1]
  const body = content.slice(fmMatch[0].length).trimStart()
  const getString = (key: string): string | undefined => {
    const match = fmBlock.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))
    if (!match) return undefined
    return match[1].trim().replace(/^["']|["']$/g, '')
  }
  const getNumber = (key: string): number | undefined => {
    const value = getString(key)
    if (value === undefined) return undefined
    const num = Number(value)
    return Number.isFinite(num) ? num : undefined
  }
  const name = getString('name')
  const description = getString('description')
  if (!name || !description) {
    console.warn(`[CronAgent] Invalid agent file ${filename}: missing name or description`)
    return null
  }
  const allowedTools = (getString('allowedTools') ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  return {
    name,
    description,
    allowedTools,
    maxIterations: getNumber('maxIterations') ?? 15,
    model: getString('model'),
    temperature: getNumber('temperature'),
    systemPrompt: body || `You are ${name}, a specialized scheduled task agent.`
  }
}

async function resolveCronAgentDefinition(agentId?: string | null): Promise<AgentDefinition> {
  if (!agentId || agentId === DEFAULT_AGENT) return FALLBACK_CRON_AGENT
  try {
    if (!fs.existsSync(AGENTS_DIR)) return FALLBACK_CRON_AGENT
    const entries = await fs.promises.readdir(AGENTS_DIR, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      const content = await fs.promises.readFile(path.join(AGENTS_DIR, entry.name), 'utf8')
      const agent = parseAgentFile(content, entry.name)
      if (agent?.name === agentId) {
        return {
          ...agent,
          allowedTools: agent.allowedTools.filter((toolName) =>
            SUPPORTED_BACKGROUND_TOOLS.has(toolName)
          )
        }
      }
    }
  } catch (err) {
    console.warn('[CronAgent] Failed to load custom agent definition:', err)
  }
  return FALLBACK_CRON_AGENT
}

function computeTps(
  outputTokens: number,
  firstTokenAt: number | null,
  completedAt: number
): number | undefined {
  if (!firstTokenAt || outputTokens <= 0 || completedAt <= firstTokenAt) return undefined
  const seconds = (completedAt - firstTokenAt) / 1000
  if (seconds <= 0) return undefined
  return Number((outputTokens / seconds).toFixed(2))
}

function maskHeaders(headers: Record<string, string>): Record<string, string> {
  const masked: Record<string, string> = {}
  const sensitiveKeys = ['authorization', 'x-api-key', 'api-key', 'x-goog-api-key']
  for (const [key, value] of Object.entries(headers)) {
    if (sensitiveKeys.includes(key.toLowerCase()) && value.length > 8) {
      masked[key] = `${value.slice(0, 4)}****${value.slice(-4)}`
    } else {
      masked[key] = value
    }
  }
  return masked
}

interface FetchReaderLike {
  read(): Promise<{ done: boolean; value?: Uint8Array }>
}

interface FetchResponseLike {
  ok: boolean
  status: number
  statusText: string
  text(): Promise<string>
  body?: {
    getReader?: () => FetchReaderLike
  } | null
}

async function* parseSSEStream(
  response: FetchResponseLike
): AsyncIterable<{ event?: string; data: string }> {
  const reader = response.body?.getReader?.()
  if (!reader) return
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const events = buffer.split(/\r?\n\r?\n/)
    buffer = events.pop() || ''
    for (const eventStr of events) {
      const lines = eventStr.split(/\r?\n/)
      const parsed: { event?: string; data: string } = { data: '' }
      const dataLines: string[] = []
      for (const line of lines) {
        if (line.startsWith('event:')) {
          parsed.event = line.slice(line.charAt(6) === ' ' ? 7 : 6)
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(line.charAt(5) === ' ' ? 6 : 5))
        }
      }
      parsed.data = dataLines.join('\n')
      if (parsed.data) yield parsed
    }
  }
  if (buffer.trim()) {
    const lines = buffer.split(/\r?\n/)
    const parsed: { event?: string; data: string } = { data: '' }
    const dataLines: string[] = []
    for (const line of lines) {
      if (line.startsWith('event:')) {
        parsed.event = line.slice(line.charAt(6) === ' ' ? 7 : 6)
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(line.charAt(5) === ' ' ? 6 : 5))
      }
    }
    parsed.data = dataLines.join('\n')
    if (parsed.data) yield parsed
  }
}

function resolveHeaderTemplate(value: string, config: ProviderConfig): string {
  return value
    .replace(/\{\{\s*sessionId\s*\}\}/g, config.sessionId ?? '')
    .replace(/\{\{\s*model\s*\}\}/g, config.model ?? '')
}

function applyHeaderOverrides(
  headers: Record<string, string>,
  config: ProviderConfig
): Record<string, string> {
  const overrides = config.requestOverrides?.headers
  if (!overrides) return headers
  for (const [key, rawValue] of Object.entries(overrides)) {
    const value = resolveHeaderTemplate(String(rawValue), config).trim()
    if (value) headers[key] = value
  }
  return headers
}

function applyBodyOverrides(body: Record<string, unknown>, config: ProviderConfig): void {
  const overrides = config.requestOverrides
  if (overrides?.body) {
    for (const [key, value] of Object.entries(overrides.body)) {
      body[key] = value
    }
  }
  if (overrides?.omitBodyKeys) {
    for (const key of overrides.omitBodyKeys) {
      delete body[key]
    }
  }
}

function isGoogleOpenAICompatible(config: ProviderConfig): boolean {
  if (config.providerBuiltinId === 'google') return true
  return /generativelanguage\.googleapis\.com/i.test((config.baseUrl || '').trim())
}

function normalizeMessagesForReplay(messages: UnifiedMessage[]): UnifiedMessage[] {
  const normalized: UnifiedMessage[] = []
  const validToolUseIds = new Set<string>()
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message.role === 'system' || typeof message.content === 'string') {
      normalized.push(message)
      continue
    }
    const blocks = message.content as ContentBlock[]
    const replayableToolUseIds = new Set(
      blocks
        .filter((block): block is ToolUseBlock => block.type === 'tool_use')
        .map((block) => block.id)
    )
    const pairedToolUseIds = new Set<string>()
    if (replayableToolUseIds.size > 0) {
      const nextMessage = messages[index + 1]
      if (nextMessage?.role === 'user' && Array.isArray(nextMessage.content)) {
        for (const block of nextMessage.content as ContentBlock[]) {
          if (block.type !== 'tool_result' || !replayableToolUseIds.has(block.toolUseId)) continue
          pairedToolUseIds.add(block.toolUseId)
          validToolUseIds.add(block.toolUseId)
        }
      }
    }
    const sanitizedBlocks = blocks.filter((block) => {
      if (block.type === 'tool_use') {
        return pairedToolUseIds.has(block.id)
      }
      if (block.type !== 'tool_result') return true
      return validToolUseIds.has(block.toolUseId)
    })
    if (sanitizedBlocks.length === 0) continue
    normalized.push({ ...message, content: sanitizedBlocks })
  }
  return normalized
}

function formatOpenAIChatMessages(
  messages: UnifiedMessage[],
  systemPrompt?: string,
  config?: ProviderConfig
): unknown[] {
  const formatted: unknown[] = []
  const isGoogleCompatible = config ? isGoogleOpenAICompatible(config) : false
  const normalizedMessages = normalizeMessagesForReplay(messages)
  if (systemPrompt) {
    formatted.push({ role: 'system', content: systemPrompt })
  }
  for (const message of normalizedMessages) {
    if (message.role === 'system') continue
    if (typeof message.content === 'string') {
      formatted.push({ role: message.role, content: message.content })
      continue
    }
    const blocks = message.content as ContentBlock[]
    if (message.role === 'user') {
      const textBlocks = blocks.filter((block): block is TextBlock => block.type === 'text')
      if (textBlocks.length > 0) {
        formatted.push({
          role: 'user',
          content: textBlocks.map((block) => ({ type: 'text', text: block.text }))
        })
        continue
      }
    }
    const toolResults = blocks.filter(
      (block): block is ToolResultBlock => block.type === 'tool_result'
    )
    if (toolResults.length > 0) {
      for (const result of toolResults) {
        formatted.push({ role: 'tool', tool_call_id: result.toolUseId, content: result.content })
      }
      continue
    }
    const toolUses = blocks.filter((block): block is ToolUseBlock => block.type === 'tool_use')
    const textContent = blocks
      .filter((block): block is TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')
    const thinkingBlocks = blocks.filter(
      (block): block is ThinkingBlock => block.type === 'thinking'
    )
    const reasoningContent = thinkingBlocks.map((block) => block.thinking).join('')
    const googleThinkingSignature = isGoogleCompatible
      ? [...thinkingBlocks]
          .reverse()
          .find(
            (block) =>
              block.encryptedContent &&
              (block.encryptedContentProvider === 'google' || !block.encryptedContentProvider)
          )?.encryptedContent
      : undefined
    const nextMessage: Record<string, unknown> = { role: 'assistant', content: textContent || null }
    if (reasoningContent) nextMessage.reasoning_content = reasoningContent
    if (googleThinkingSignature) nextMessage.reasoning_encrypted_content = googleThinkingSignature
    if (toolUses.length > 0) {
      nextMessage.tool_calls = toolUses.map((toolUse) => ({
        id: toolUse.id,
        type: 'function',
        function: { name: toolUse.name, arguments: JSON.stringify(toolUse.input) },
        ...(toolUse.extraContent ? { extra_content: toolUse.extraContent } : {})
      }))
    }
    formatted.push(nextMessage)
  }
  return formatted
}

function formatOpenAITools(tools: ToolDefinition[]): unknown[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: normalizeToolSchema(tool.inputSchema)
    }
  }))
}

function formatOpenAIResponsesMessages(
  messages: UnifiedMessage[],
  systemPrompt?: string,
  includeEncryptedReasoning = false
): unknown[] {
  const input: unknown[] = []
  const normalizedMessages = normalizeMessagesForReplay(messages)
  if (systemPrompt) {
    input.push({ type: 'message', role: 'developer', content: systemPrompt })
  }
  for (const message of normalizedMessages) {
    if (message.role === 'system') continue
    if (typeof message.content === 'string') {
      input.push({ type: 'message', role: message.role, content: message.content })
      continue
    }
    const blocks = message.content as ContentBlock[]
    for (const block of blocks) {
      switch (block.type) {
        case 'text':
          input.push({ type: 'message', role: message.role, content: block.text })
          break
        case 'thinking':
          if (
            includeEncryptedReasoning &&
            message.role === 'assistant' &&
            block.encryptedContent &&
            (block.encryptedContentProvider === 'openai-responses' ||
              !block.encryptedContentProvider)
          ) {
            input.push({
              type: 'reasoning',
              summary: block.thinking ? [{ type: 'summary_text', text: block.thinking }] : [],
              encrypted_content: block.encryptedContent
            })
          }
          break
        case 'tool_use':
          input.push({
            type: 'function_call',
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input),
            status: 'completed'
          })
          break
        case 'tool_result':
          input.push({
            type: 'function_call_output',
            call_id: block.toolUseId,
            output: block.content
          })
          break
      }
    }
  }
  return input
}

function formatOpenAIResponsesTools(tools: ToolDefinition[]): unknown[] {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: normalizeToolSchema(tool.inputSchema),
    strict: false
  }))
}

function formatAnthropicMessages(messages: UnifiedMessage[]): unknown[] {
  return normalizeMessagesForReplay(messages)
    .filter((message) => message.role !== 'system')
    .map((message) => {
      if (typeof message.content === 'string') {
        return { role: message.role, content: message.content }
      }
      const blocks = message.content as ContentBlock[]
      return {
        role: message.role,
        content: blocks.map((block) => {
          switch (block.type) {
            case 'thinking':
              return {
                type: 'thinking',
                thinking: block.thinking,
                ...(block.encryptedContent &&
                (block.encryptedContentProvider === 'anthropic' || !block.encryptedContentProvider)
                  ? { signature: block.encryptedContent }
                  : {})
              }
            case 'text':
              return { type: 'text', text: block.text }
            case 'tool_use':
              return { type: 'tool_use', id: block.id, name: block.name, input: block.input }
            case 'tool_result':
              return { type: 'tool_result', tool_use_id: block.toolUseId, content: block.content }
          }
        })
      }
    })
}

function formatAnthropicTools(tools: ToolDefinition[]): unknown[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: normalizeToolSchema(tool.inputSchema)
  }))
}

function normalizeToolSchema(schema: ToolInputSchema): Record<string, unknown> {
  if ('properties' in schema) return schema
  if (!('oneOf' in schema)) {
    return { type: 'object', properties: {}, additionalProperties: false }
  }
  const mergedProperties: Record<string, unknown> = {}
  let requiredIntersection: string[] | null = null
  for (const variant of schema.oneOf) {
    for (const [key, value] of Object.entries(variant.properties ?? {})) {
      if (!(key in mergedProperties)) mergedProperties[key] = value
    }
    const required = variant.required ?? []
    if (requiredIntersection === null) {
      requiredIntersection = [...required]
    } else {
      requiredIntersection = requiredIntersection.filter((key) => required.includes(key))
    }
  }
  return {
    type: 'object',
    properties: mergedProperties,
    ...(requiredIntersection && requiredIntersection.length > 0
      ? { required: requiredIntersection }
      : {}),
    additionalProperties: false
  }
}

async function sendFetchRequest(
  url: string,
  init: Record<string, unknown>
): Promise<FetchResponseLike> {
  const response = (await fetch(url, init as RequestInit)) as FetchResponseLike
  if (!response.ok) {
    const errorBody = await response.text().catch(() => '')
    throw new Error(`HTTP ${response.status}: ${errorBody || response.statusText}`)
  }
  return response
}

async function* sendOpenAIChat(
  messages: UnifiedMessage[],
  tools: ToolDefinition[],
  config: ProviderConfig,
  signal?: AbortSignal
): AsyncIterable<StreamEvent> {
  const requestStartedAt = Date.now()
  let firstTokenAt: number | null = null
  let outputTokens = 0
  const baseUrl = (config.baseUrl || 'https://api.openai.com/v1').trim().replace(/\/+$/, '')
  const url = `${baseUrl}/chat/completions`
  const body: Record<string, unknown> = {
    model: config.model,
    messages: formatOpenAIChatMessages(messages, config.systemPrompt, config),
    stream: true,
    stream_options: { include_usage: true }
  }
  if (tools.length > 0) {
    body.tools = formatOpenAITools(tools)
    body.tool_choice = 'auto'
  }
  if (config.temperature !== undefined) body.temperature = config.temperature
  if (config.serviceTier) body.service_tier = config.serviceTier
  if (config.maxTokens) {
    const isReasoningModel = /^(o[1-9]|o\d+-mini)/.test(config.model)
    if (isReasoningModel) {
      body.max_completion_tokens = config.maxTokens
    } else {
      body.max_tokens = config.maxTokens
    }
  }
  applyBodyOverrides(body, config)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiKey}`
  }
  if (config.userAgent) headers['User-Agent'] = config.userAgent
  if (config.serviceTier) headers.service_tier = config.serviceTier
  applyHeaderOverrides(headers, config)
  console.log('[CronAgent][OpenAI Chat] request', {
    url,
    model: config.model,
    headers: maskHeaders(headers)
  })
  const response = await sendFetchRequest(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal
  })
  const toolBuffers = new Map<
    number,
    { id: string; name: string; args: string; extraContent?: Record<string, unknown> }
  >()
  for await (const sse of parseSSEStream(response)) {
    if (!sse.data || sse.data === '[DONE]') continue
    let data: {
      choices?: Array<{
        delta?: {
          content?: string
          reasoning_content?: string
          tool_calls?: Array<{
            index?: number
            id?: string
            function?: { name?: string; arguments?: string }
            extra_content?: Record<string, unknown>
          }>
        }
        finish_reason?: string | null
      }>
      usage?: {
        prompt_tokens?: number
        completion_tokens?: number
        completion_tokens_details?: { reasoning_tokens?: number }
      }
    } | null = null
    try {
      data = JSON.parse(sse.data) as {
        choices?: Array<{
          delta?: {
            content?: string
            reasoning_content?: string
            tool_calls?: Array<{
              index?: number
              id?: string
              function?: { name?: string; arguments?: string }
              extra_content?: Record<string, unknown>
            }>
          }
          finish_reason?: string | null
        }>
        usage?: {
          prompt_tokens?: number
          completion_tokens?: number
          completion_tokens_details?: { reasoning_tokens?: number }
        }
      }
    } catch {
      continue
    }
    if (!data) continue
    const choice = data.choices?.[0]
    const delta = choice?.delta
    if (!delta) continue
    if (delta.content) {
      if (firstTokenAt === null) firstTokenAt = Date.now()
      yield { type: 'text_delta', text: delta.content }
    }
    if (delta.reasoning_content) {
      if (firstTokenAt === null) firstTokenAt = Date.now()
      yield { type: 'thinking_delta', thinking: delta.reasoning_content }
    }
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const index = Number(tc.index ?? 0)
        const existing = toolBuffers.get(index) ?? {
          id: String(tc.id ?? ''),
          name: String(tc.function?.name ?? ''),
          args: '',
          extraContent: tc.extra_content
        }
        if (tc.id) existing.id = tc.id
        if (tc.function?.name) {
          const isFirst = !existing.name
          existing.name = tc.function.name
          if (isFirst && existing.id) {
            yield {
              type: 'tool_call_start',
              toolCallId: existing.id,
              toolName: existing.name,
              ...(existing.extraContent ? { toolCallExtraContent: existing.extraContent } : {})
            }
          }
        }
        if (tc.extra_content) existing.extraContent = tc.extra_content
        if (tc.function?.arguments) {
          existing.args += tc.function.arguments
          yield {
            type: 'tool_call_delta',
            toolCallId: existing.id || undefined,
            argumentsDelta: tc.function.arguments
          }
        }
        toolBuffers.set(index, existing)
      }
    }
    const finishReason = choice.finish_reason as string | null | undefined
    if (
      (finishReason === 'tool_calls' || finishReason === 'function_call') &&
      toolBuffers.size > 0
    ) {
      for (const [, buffer] of toolBuffers) {
        if (!buffer.id) continue
        try {
          yield {
            type: 'tool_call_end',
            toolCallId: buffer.id,
            toolName: buffer.name,
            toolCallInput: JSON.parse(buffer.args),
            ...(buffer.extraContent ? { toolCallExtraContent: buffer.extraContent } : {})
          }
        } catch {
          yield {
            type: 'tool_call_end',
            toolCallId: buffer.id,
            toolName: buffer.name,
            toolCallInput: {},
            ...(buffer.extraContent ? { toolCallExtraContent: buffer.extraContent } : {})
          }
        }
      }
      toolBuffers.clear()
    }
    if (finishReason === 'stop') {
      const requestCompletedAt = Date.now()
      if (data.usage) {
        outputTokens = data.usage.completion_tokens ?? outputTokens
      }
      yield {
        type: 'message_end',
        stopReason: 'stop',
        ...(data.usage
          ? {
              usage: {
                inputTokens: data.usage.prompt_tokens ?? 0,
                outputTokens: data.usage.completion_tokens ?? 0,
                ...(data.usage.completion_tokens_details?.reasoning_tokens
                  ? { reasoningTokens: data.usage.completion_tokens_details.reasoning_tokens }
                  : {})
              }
            }
          : {}),
        timing: {
          totalMs: requestCompletedAt - requestStartedAt,
          ttftMs: firstTokenAt ? firstTokenAt - requestStartedAt : undefined,
          tps: computeTps(outputTokens, firstTokenAt, requestCompletedAt)
        }
      }
    }
  }
}

async function* sendAnthropic(
  messages: UnifiedMessage[],
  tools: ToolDefinition[],
  config: ProviderConfig,
  signal?: AbortSignal
): AsyncIterable<StreamEvent> {
  const requestStartedAt = Date.now()
  let firstTokenAt: number | null = null
  let outputTokens = 0
  const baseUrl = (config.baseUrl || 'https://api.anthropic.com').trim().replace(/\/+$/, '')
  const url = `${baseUrl}/v1/messages`
  const body: Record<string, unknown> = {
    model: config.model,
    system: config.systemPrompt,
    messages: formatAnthropicMessages(messages),
    max_tokens: config.maxTokens ?? 4096,
    stream: true
  }
  if (tools.length > 0) {
    body.tools = formatAnthropicTools(tools)
  }
  if (config.temperature !== undefined) body.temperature = config.temperature
  applyBodyOverrides(body, config)

  const maxTokens =
    typeof body.max_tokens === 'number'
      ? Math.max(1, Math.floor(body.max_tokens))
      : typeof body.max_tokens === 'string'
        ? Math.max(1, Math.floor(Number(body.max_tokens) || (config.maxTokens ?? 4096)))
        : Math.max(1, Math.floor(config.maxTokens ?? 4096))
  body.max_tokens = maxTokens

  if (typeof body.thinking === 'object' && body.thinking !== null) {
    const thinking = { ...(body.thinking as Record<string, unknown>) }
    const rawBudget =
      typeof thinking.budget_tokens === 'number'
        ? thinking.budget_tokens
        : typeof thinking.budget_tokens === 'string'
          ? Number(thinking.budget_tokens)
          : undefined

    if (rawBudget != null && Number.isFinite(rawBudget) && rawBudget > 0) {
      thinking.budget_tokens = Math.max(1, Math.min(Math.floor(rawBudget), maxTokens - 1))
    }

    body.thinking = thinking
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    'x-api-key': config.apiKey
  }
  if (config.userAgent) headers['User-Agent'] = config.userAgent
  applyHeaderOverrides(headers, config)
  const response = await sendFetchRequest(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal
  })
  let activeToolCall: { id: string; name: string; input: string } | null = null
  for await (const sse of parseSSEStream(response)) {
    if (!sse.data || sse.data === '[DONE]') continue
    let data: {
      content_block?: { type?: string; id?: string; name?: string }
      delta?: {
        type?: string
        text?: string
        thinking?: string
        signature?: string
        partial_json?: string
      }
      usage?: { input_tokens?: number; output_tokens?: number }
      stop_reason?: string
      error?: { type?: string; message?: string }
    } | null = null
    try {
      data = JSON.parse(sse.data) as {
        content_block?: { type?: string; id?: string; name?: string }
        delta?: {
          type?: string
          text?: string
          thinking?: string
          signature?: string
          partial_json?: string
        }
        usage?: { input_tokens?: number; output_tokens?: number }
        stop_reason?: string
        error?: { type?: string; message?: string }
      }
    } catch {
      continue
    }
    if (!data) continue
    switch (sse.event) {
      case 'content_block_start': {
        if (data.content_block?.type === 'tool_use') {
          activeToolCall = {
            id: String(data.content_block.id ?? nanoid()),
            name: String(data.content_block.name ?? ''),
            input: ''
          }
          yield {
            type: 'tool_call_start',
            toolCallId: activeToolCall.id,
            toolName: activeToolCall.name
          }
        }
        break
      }
      case 'content_block_delta': {
        if (data.delta?.type === 'text_delta' && typeof data.delta.text === 'string') {
          if (firstTokenAt === null) firstTokenAt = Date.now()
          yield { type: 'text_delta', text: data.delta.text }
        } else if (
          data.delta?.type === 'thinking_delta' &&
          typeof data.delta.thinking === 'string'
        ) {
          if (firstTokenAt === null) firstTokenAt = Date.now()
          yield { type: 'thinking_delta', thinking: data.delta.thinking }
        } else if (
          data.delta?.type === 'signature_delta' &&
          typeof data.delta.signature === 'string'
        ) {
          yield {
            type: 'thinking_encrypted',
            thinkingEncryptedContent: data.delta.signature,
            thinkingEncryptedProvider: 'anthropic'
          }
        } else if (
          data.delta?.type === 'input_json_delta' &&
          typeof data.delta.partial_json === 'string' &&
          activeToolCall
        ) {
          activeToolCall.input += data.delta.partial_json
          yield {
            type: 'tool_call_delta',
            toolCallId: activeToolCall.id,
            argumentsDelta: data.delta.partial_json
          }
        }
        break
      }
      case 'content_block_stop': {
        if (activeToolCall) {
          let parsedInput: Record<string, unknown> = {}
          try {
            parsedInput = JSON.parse(activeToolCall.input || '{}')
          } catch {
            parsedInput = {}
          }
          yield {
            type: 'tool_call_end',
            toolCallId: activeToolCall.id,
            toolName: activeToolCall.name,
            toolCallInput: parsedInput
          }
          activeToolCall = null
        }
        break
      }
      case 'message_delta': {
        if (data.usage?.output_tokens !== undefined) {
          outputTokens = data.usage.output_tokens
        }
        break
      }
      case 'message_stop': {
        const requestCompletedAt = Date.now()
        yield {
          type: 'message_end',
          stopReason: data.stop_reason,
          usage: data.usage
            ? {
                inputTokens: data.usage.input_tokens ?? 0,
                outputTokens: data.usage.output_tokens ?? 0
              }
            : undefined,
          timing: {
            totalMs: requestCompletedAt - requestStartedAt,
            ttftMs: firstTokenAt ? firstTokenAt - requestStartedAt : undefined,
            tps: computeTps(outputTokens, firstTokenAt, requestCompletedAt)
          }
        }
        break
      }
      case 'error':
        yield { type: 'error', error: data.error }
        break
    }
  }
}

async function* sendOpenAIResponses(
  messages: UnifiedMessage[],
  tools: ToolDefinition[],
  config: ProviderConfig,
  signal?: AbortSignal
): AsyncIterable<StreamEvent> {
  const requestStartedAt = Date.now()
  let firstTokenAt: number | null = null
  let outputTokens = 0
  const baseUrl = (config.baseUrl || 'https://api.openai.com/v1').trim().replace(/\/+$/, '')
  const url = `${baseUrl}/responses`
  const body: Record<string, unknown> = {
    model: config.model,
    input: formatOpenAIResponsesMessages(messages, config.systemPrompt, true),
    stream: true
  }
  const formattedTools = formatOpenAIResponsesTools(tools)
  if (formattedTools.length > 0) {
    body.tools = formattedTools
  }
  if (config.temperature !== undefined) body.temperature = config.temperature
  if (config.maxTokens) body.max_output_tokens = config.maxTokens
  if (config.instructionsPrompt) {
    const instructions = await loadPromptContent(config.instructionsPrompt)
    if (instructions) {
      body.instructions = instructions
    }
  }
  applyBodyOverrides(body, config)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiKey}`
  }
  if (config.userAgent) headers['User-Agent'] = config.userAgent
  if (config.serviceTier) headers.service_tier = config.serviceTier
  applyHeaderOverrides(headers, config)
  const response = await sendFetchRequest(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal
  })
  let emittedThinkingDelta = false
  const emittedThinkingEncrypted = new Set<string>()
  const tryBuildThinkingDeltaEvent = (thinking: unknown): StreamEvent | null => {
    if (typeof thinking !== 'string' || !thinking) return null
    emittedThinkingDelta = true
    return { type: 'thinking_delta', thinking }
  }
  const tryBuildThinkingEncryptedEvent = (encryptedContent: unknown): StreamEvent | null => {
    if (typeof encryptedContent !== 'string') return null
    const trimmed = encryptedContent.trim()
    if (!trimmed || emittedThinkingEncrypted.has(trimmed)) return null
    emittedThinkingEncrypted.add(trimmed)
    return {
      type: 'thinking_encrypted',
      thinkingEncryptedContent: trimmed,
      thinkingEncryptedProvider: 'openai-responses'
    }
  }
  for await (const sse of parseSSEStream(response)) {
    if (!sse.data || sse.data === '[DONE]') continue
    let data: {
      delta?: string
      text?: string
      call_id?: string
      name?: string
      arguments?: string
      item?: {
        type?: string
        call_id?: string
        name?: string
        encrypted_content?: string
        reasoning?: { encrypted_content?: string }
      }
      response?: {
        id?: string
        status?: string
        usage?: {
          input_tokens?: number
          output_tokens?: number
          input_tokens_details?: { cached_tokens?: number }
          output_tokens_details?: { reasoning_tokens?: number }
        }
      }
    } | null = null
    try {
      data = JSON.parse(sse.data) as {
        delta?: string
        text?: string
        call_id?: string
        name?: string
        arguments?: string
        item?: {
          type?: string
          call_id?: string
          name?: string
          encrypted_content?: string
          reasoning?: { encrypted_content?: string }
        }
        response?: {
          id?: string
          status?: string
          usage?: {
            input_tokens?: number
            output_tokens?: number
            input_tokens_details?: { cached_tokens?: number }
            output_tokens_details?: { reasoning_tokens?: number }
          }
        }
      }
    } catch {
      continue
    }
    if (!data) continue
    switch (sse.event) {
      case 'response.output_text.delta':
        if (firstTokenAt === null) firstTokenAt = Date.now()
        yield { type: 'text_delta', text: data.delta }
        break
      case 'response.reasoning_summary_text.delta': {
        if (firstTokenAt === null) firstTokenAt = Date.now()
        const thinkingEvent = tryBuildThinkingDeltaEvent(data.delta)
        if (thinkingEvent) yield thinkingEvent
        break
      }
      case 'response.reasoning_summary_text.done': {
        if (firstTokenAt === null) firstTokenAt = Date.now()
        if (!emittedThinkingDelta) {
          const thinkingEvent = tryBuildThinkingDeltaEvent(data.text ?? data.delta)
          if (thinkingEvent) yield thinkingEvent
        }
        break
      }
      case 'response.output_item.added':
        if (data.item?.type === 'function_call') {
          yield {
            type: 'tool_call_start',
            toolCallId: data.item.call_id,
            toolName: data.item.name
          }
        } else if (data.item?.type === 'reasoning') {
          const encryptedEvent = tryBuildThinkingEncryptedEvent(
            data.item.encrypted_content ?? data.item.reasoning?.encrypted_content
          )
          if (encryptedEvent) yield encryptedEvent
        }
        break
      case 'response.function_call_arguments.delta':
        yield { type: 'tool_call_delta', toolCallId: data.call_id, argumentsDelta: data.delta }
        break
      case 'response.function_call_arguments.done':
        try {
          yield {
            type: 'tool_call_end',
            toolCallId: data.call_id,
            toolName: data.name,
            toolCallInput: JSON.parse(data.arguments ?? '{}')
          }
        } catch {
          yield {
            type: 'tool_call_end',
            toolCallId: data.call_id,
            toolName: data.name,
            toolCallInput: {}
          }
        }
        break
      case 'response.completed': {
        const requestCompletedAt = Date.now()
        if (data.response?.usage?.output_tokens !== undefined) {
          outputTokens = data.response.usage.output_tokens ?? outputTokens
        }
        const rawInputTokens = data.response?.usage?.input_tokens ?? 0
        const cachedTokens = data.response?.usage?.input_tokens_details?.cached_tokens ?? 0
        yield {
          type: 'message_end',
          stopReason: data.response?.status,
          providerResponseId: data.response?.id,
          usage: data.response?.usage
            ? {
                inputTokens: rawInputTokens,
                outputTokens: data.response.usage.output_tokens ?? 0,
                billableInputTokens: Math.max(0, rawInputTokens - cachedTokens),
                contextTokens: rawInputTokens,
                ...(cachedTokens > 0 ? { cacheReadTokens: cachedTokens } : {}),
                ...(data.response.usage.output_tokens_details?.reasoning_tokens
                  ? { reasoningTokens: data.response.usage.output_tokens_details.reasoning_tokens }
                  : {})
              }
            : undefined,
          timing: {
            totalMs: requestCompletedAt - requestStartedAt,
            ttftMs: firstTokenAt ? firstTokenAt - requestStartedAt : undefined,
            tps: computeTps(outputTokens, firstTokenAt, requestCompletedAt)
          }
        }
        break
      }
      case 'response.failed':
        yield { type: 'error', error: { type: 'api_error', message: JSON.stringify(data) } }
        break
      case 'error':
        yield { type: 'error', error: { type: 'api_error', message: JSON.stringify(data) } }
        break
    }
  }
}

async function* sendProviderMessage(
  messages: UnifiedMessage[],
  tools: ToolDefinition[],
  config: ProviderConfig,
  signal?: AbortSignal
): AsyncIterable<StreamEvent> {
  const type = normalizeProviderType(config.type)
  if (type === 'anthropic') {
    yield* sendAnthropic(messages, tools, config, signal)
    return
  }
  if (type === 'openai-responses') {
    yield* sendOpenAIResponses(messages, tools, config, signal)
    return
  }
  yield* sendOpenAIChat(messages, tools, config, signal)
}

class ProviderRequestError extends Error {
  statusCode?: number
  errorType?: string
  constructor(message: string, options?: { statusCode?: number; type?: string }) {
    super(message)
    this.name = 'ProviderRequestError'
    this.statusCode = options?.statusCode
    this.errorType = options?.type
  }
}

async function* runAgentLoop(
  messages: UnifiedMessage[],
  config: AgentLoopConfig,
  toolCtx: ToolContext
): AsyncGenerator<
  | { type: 'loop_start' }
  | { type: 'iteration_start'; iteration: number }
  | { type: 'thinking_delta'; thinking: string }
  | {
      type: 'thinking_encrypted'
      thinkingEncryptedContent: string
      thinkingEncryptedProvider: 'anthropic' | 'openai-responses' | 'google'
    }
  | { type: 'text_delta'; text: string }
  | {
      type: 'tool_use_streaming_start'
      toolCallId: string
      toolName: string
      toolCallExtraContent?: Record<string, unknown>
    }
  | { type: 'tool_use_args_delta'; toolCallId: string; partialInput: Record<string, unknown> }
  | {
      type: 'tool_use_generated'
      toolUseBlock: {
        id: string
        name: string
        input: Record<string, unknown>
        extraContent?: Record<string, unknown>
      }
    }
  | { type: 'tool_call_start'; toolCall: ToolCallState }
  | { type: 'tool_call_result'; toolCall: ToolCallState }
  | {
      type: 'iteration_end'
      toolResults: { toolUseId: string; content: ToolResultContent; isError?: boolean }[]
    }
  | { type: 'message_end'; usage?: TokenUsage; timing?: RequestTiming; providerResponseId?: string }
  | { type: 'error'; error: Error }
  | { type: 'loop_end'; reason: 'completed' | 'max_iterations' | 'aborted' | 'error' }
> {
  yield { type: 'loop_start' }
  const conversationMessages = [...messages]
  let iteration = 0
  const hasIterationLimit = Number.isFinite(config.maxIterations) && config.maxIterations > 0
  while (!hasIterationLimit || iteration < config.maxIterations) {
    if (config.signal.aborted) {
      yield { type: 'loop_end', reason: 'aborted' }
      return
    }
    iteration += 1
    yield { type: 'iteration_start', iteration }
    let assistantContentBlocks: ContentBlock[] = []
    let toolCalls: ToolCallState[] = []
    let providerResponseId: string | undefined
    let sendAttempt = 0
    while (sendAttempt < MAX_PROVIDER_RETRIES) {
      assistantContentBlocks = []
      toolCalls = []
      const toolArgsById = new Map<string, string>()
      const toolNamesById = new Map<string, string>()
      const toolExtraContentById = new Map<string, Record<string, unknown>>()
      let currentToolId = ''
      let currentToolName = ''
      let streamedContent = false
      try {
        for await (const event of sendProviderMessage(
          conversationMessages,
          config.tools,
          config.provider,
          config.signal
        )) {
          if (config.signal.aborted) {
            yield { type: 'loop_end', reason: 'aborted' }
            return
          }
          switch (event.type) {
            case 'thinking_delta':
              streamedContent = true
              yield { type: 'thinking_delta', thinking: event.thinking ?? '' }
              appendThinkingToBlocks(assistantContentBlocks, event.thinking ?? '')
              break
            case 'thinking_encrypted':
              if (event.thinkingEncryptedContent && event.thinkingEncryptedProvider) {
                streamedContent = true
                yield {
                  type: 'thinking_encrypted',
                  thinkingEncryptedContent: event.thinkingEncryptedContent,
                  thinkingEncryptedProvider: event.thinkingEncryptedProvider
                }
                appendThinkingEncryptedToBlocks(
                  assistantContentBlocks,
                  event.thinkingEncryptedContent,
                  event.thinkingEncryptedProvider
                )
              }
              break
            case 'text_delta':
              streamedContent = true
              yield { type: 'text_delta', text: event.text ?? '' }
              appendTextToBlocks(assistantContentBlocks, event.text ?? '')
              break
            case 'tool_call_start':
              streamedContent = true
              currentToolId = event.toolCallId ?? ''
              currentToolName = event.toolName ?? ''
              if (currentToolId) {
                toolArgsById.set(currentToolId, '')
                toolNamesById.set(currentToolId, currentToolName)
                if (event.toolCallExtraContent) {
                  toolExtraContentById.set(currentToolId, event.toolCallExtraContent)
                }
              }
              yield {
                type: 'tool_use_streaming_start',
                toolCallId: currentToolId,
                toolName: currentToolName,
                ...(event.toolCallExtraContent
                  ? { toolCallExtraContent: event.toolCallExtraContent }
                  : {})
              }
              break
            case 'tool_call_delta': {
              streamedContent = true
              const targetToolId = event.toolCallId || currentToolId
              if (!targetToolId) break
              const nextArgs = `${toolArgsById.get(targetToolId) ?? ''}${event.argumentsDelta ?? ''}`
              toolArgsById.set(targetToolId, nextArgs)
              const targetToolName = toolNamesById.get(targetToolId) || currentToolName
              const partialInput = parseToolInputSnapshot(nextArgs, targetToolName)
              if (partialInput && Object.keys(partialInput).length > 0) {
                yield {
                  type: 'tool_use_args_delta',
                  toolCallId: targetToolId,
                  partialInput
                }
              }
              break
            }
            case 'tool_call_end': {
              streamedContent = true
              const endToolId = event.toolCallId || currentToolId || nanoid()
              const endToolName = event.toolName || currentToolName
              const rawToolArgs = toolArgsById.get(endToolId) ?? ''
              const streamedToolInput = parseToolInputSnapshot(rawToolArgs, endToolName)
              const mergedToolInput = mergeToolInputs(streamedToolInput, event.toolCallInput)
              const toolInput =
                Object.keys(mergedToolInput).length > 0
                  ? mergedToolInput
                  : safeParseJSON(rawToolArgs)
              const toolUseBlock: ToolUseBlock = {
                type: 'tool_use',
                id: endToolId,
                name: endToolName,
                input: toolInput,
                ...((event.toolCallExtraContent ?? toolExtraContentById.get(endToolId))
                  ? {
                      extraContent:
                        event.toolCallExtraContent ?? toolExtraContentById.get(endToolId)
                    }
                  : {})
              }
              assistantContentBlocks.push(toolUseBlock)
              toolArgsById.delete(endToolId)
              toolNamesById.delete(endToolId)
              toolExtraContentById.delete(endToolId)
              const toolCall: ToolCallState = {
                id: toolUseBlock.id,
                name: endToolName,
                input: toolInput,
                status: 'running',
                requiresApproval: false
              }
              toolCalls.push(toolCall)
              yield {
                type: 'tool_use_generated',
                toolUseBlock: {
                  id: toolUseBlock.id,
                  name: endToolName,
                  input: toolInput,
                  ...(toolUseBlock.extraContent ? { extraContent: toolUseBlock.extraContent } : {})
                }
              }
              break
            }
            case 'message_end':
              providerResponseId = event.providerResponseId
              yield {
                type: 'message_end',
                usage: event.usage,
                timing: event.timing,
                providerResponseId: event.providerResponseId
              }
              break
            case 'error':
              throw new ProviderRequestError(event.error?.message ?? 'Unknown API error', {
                type: event.error?.type
              })
          }
        }
        if (toolArgsById.size > 0) {
          for (const [danglingToolId, argsText] of toolArgsById) {
            const danglingName = toolNamesById.get(danglingToolId) || currentToolName
            const danglingInput =
              parseToolInputSnapshot(argsText, danglingName) ?? safeParseJSON(argsText)
            assistantContentBlocks.push({
              type: 'tool_use',
              id: danglingToolId,
              name: danglingName,
              input: danglingInput,
              ...(toolExtraContentById.get(danglingToolId)
                ? { extraContent: toolExtraContentById.get(danglingToolId) }
                : {})
            })
            toolCalls.push({
              id: danglingToolId,
              name: danglingName,
              input: danglingInput,
              status: 'running',
              requiresApproval: false
            })
            yield {
              type: 'tool_use_generated',
              toolUseBlock: { id: danglingToolId, name: danglingName, input: danglingInput }
            }
          }
          toolArgsById.clear()
          toolNamesById.clear()
        }
        break
      } catch (err) {
        if (config.signal.aborted) {
          yield { type: 'loop_end', reason: 'aborted' }
          return
        }
        const delay = getRetryDelay(err, sendAttempt, streamedContent)
        if (delay === null || sendAttempt === MAX_PROVIDER_RETRIES - 1) {
          yield { type: 'error', error: err instanceof Error ? err : new Error(String(err)) }
          yield { type: 'loop_end', reason: 'error' }
          return
        }
        sendAttempt += 1
        await delayWithAbort(delay, config.signal)
      }
    }
    const assistantMsg: UnifiedMessage = {
      id: nanoid(),
      role: 'assistant',
      content: assistantContentBlocks.length > 0 ? assistantContentBlocks : '',
      createdAt: Date.now(),
      ...(providerResponseId ? { providerResponseId } : {})
    }
    conversationMessages.push(assistantMsg)
    if (toolCalls.length === 0) {
      yield { type: 'loop_end', reason: 'completed' }
      return
    }
    const toolResults: ContentBlock[] = []
    for (const toolCall of toolCalls) {
      const startedAt = Date.now()
      yield { type: 'tool_call_start', toolCall: { ...toolCall, status: 'running', startedAt } }
      let output: ToolResultContent
      let toolError: string | undefined
      try {
        output = await executeTool(toolCall.name, toolCall.input, {
          ...toolCtx,
          currentToolUseId: toolCall.id
        })
      } catch (toolErr) {
        toolError = toolErr instanceof Error ? toolErr.message : String(toolErr)
        output = encodeToolError(toolError)
      }
      const completedAt = Date.now()
      yield {
        type: 'tool_call_result',
        toolCall: {
          ...toolCall,
          status: toolError ? 'error' : 'completed',
          output,
          ...(toolError ? { error: toolError } : {}),
          startedAt,
          completedAt
        }
      }
      toolResults.push({
        type: 'tool_result',
        toolUseId: toolCall.id,
        content: output,
        ...(toolError ? { isError: true } : {})
      })
    }
    const toolResultMessage: UnifiedMessage = {
      id: nanoid(),
      role: 'user',
      content: toolResults,
      createdAt: Date.now()
    }
    conversationMessages.push(toolResultMessage)
    yield {
      type: 'iteration_end',
      toolResults: toolResults.map((block) => ({
        toolUseId: (block as ToolResultBlock).toolUseId,
        content: (block as ToolResultBlock).content,
        isError: (block as ToolResultBlock).isError
      }))
    }
  }
  yield { type: 'loop_end', reason: 'max_iterations' }
}

function appendThinkingToBlocks(blocks: ContentBlock[], thinking: string): void {
  const last = blocks[blocks.length - 1]
  if (last && last.type === 'thinking') {
    last.thinking += thinking
  } else {
    blocks.push({ type: 'thinking', thinking })
  }
}

function appendThinkingEncryptedToBlocks(
  blocks: ContentBlock[],
  encryptedContent: string,
  provider: 'anthropic' | 'openai-responses' | 'google'
): void {
  if (!encryptedContent) return
  const target = [...blocks]
    .reverse()
    .find((block): block is ThinkingBlock => block.type === 'thinking' && !block.encryptedContent)
  if (target) {
    target.encryptedContent = encryptedContent
    target.encryptedContentProvider = provider
    return
  }
  blocks.push({
    type: 'thinking',
    thinking: '',
    encryptedContent,
    encryptedContentProvider: provider
  })
}

function appendTextToBlocks(blocks: ContentBlock[], text: string): void {
  const last = blocks[blocks.length - 1]
  if (last && last.type === 'text') {
    last.text += text
  } else {
    blocks.push({ type: 'text', text })
  }
}

function safeParseJSON(str: string): Record<string, unknown> {
  try {
    return JSON.parse(str)
  } catch {
    return {}
  }
}

function parseToolInputSnapshot(rawArgs: string, toolName: string): Record<string, unknown> | null {
  const isWriteTool = toolName === 'Write'
  const looseWriteInput = isWriteTool ? parseWriteInputLoosely(rawArgs) : null
  try {
    const parsed = parsePartialJSON(rawArgs, Allow.ALL)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const normalized = normalizeParsedToolInput(parsed as Record<string, unknown>)
      if (looseWriteInput && Object.keys(looseWriteInput).length > 0) {
        return { ...looseWriteInput, ...normalized }
      }
      return normalized
    }
  } catch {
    // ignore
  }
  if (looseWriteInput && Object.keys(looseWriteInput).length > 0) {
    return looseWriteInput
  }
  return null
}

function normalizeParsedToolInput(input: Record<string, unknown>): Record<string, unknown> {
  const args = input.args
  if (
    args &&
    typeof args === 'object' &&
    !Array.isArray(args) &&
    Object.keys(input).every((key) => key === 'args')
  ) {
    return args as Record<string, unknown>
  }
  return input
}

function mergeToolInputs(
  streamedInput: Record<string, unknown> | null,
  providerInput?: Record<string, unknown>
): Record<string, unknown> {
  const normalizedProviderInput =
    providerInput && typeof providerInput === 'object' && !Array.isArray(providerInput)
      ? normalizeParsedToolInput(providerInput)
      : {}
  if (streamedInput && Object.keys(streamedInput).length > 0) {
    return { ...streamedInput, ...normalizedProviderInput }
  }
  return normalizedProviderInput
}

function parseWriteInputLoosely(rawArgs: string): Record<string, unknown> | null {
  const filePath =
    readLooseJsonStringField(rawArgs, 'file_path') ?? readLooseJsonStringField(rawArgs, 'path')
  const content = readLooseJsonStringField(rawArgs, 'content')
  const input: Record<string, unknown> = {}
  if (filePath !== null) input.file_path = filePath
  if (content !== null) input.content = content
  return Object.keys(input).length > 0 ? input : null
}

function readLooseJsonStringField(raw: string, key: string): string | null {
  const keyPattern = new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*"`)
  const match = keyPattern.exec(raw)
  if (!match) return null
  let index = match.index + match[0].length
  let value = ''
  let escaped = false
  while (index < raw.length) {
    const ch = raw[index]
    if (escaped) {
      switch (ch) {
        case 'n':
          value += '\n'
          break
        case 'r':
          value += '\r'
          break
        case 't':
          value += '\t'
          break
        case '"':
          value += '"'
          break
        case '\\':
          value += '\\'
          break
        default:
          value += ch
          break
      }
      escaped = false
      index += 1
      continue
    }
    if (ch === '\\') {
      escaped = true
      index += 1
      continue
    }
    if (ch === '"') return value
    value += ch
    index += 1
  }
  if (escaped) value += '\\'
  return value
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function getRetryDelay(err: unknown, attempt: number, streamedContent: boolean): number | null {
  const message = err instanceof Error ? err.message : String(err)
  const match = /HTTP\s+(\d{3})/i.exec(message)
  const status = match ? Number(match[1]) : null
  if (status === 429) return BASE_RETRY_DELAY_MS * Math.pow(2, attempt + 1)
  if (status && status >= 400 && status < 500) return null
  if (status && status >= 500) return BASE_RETRY_DELAY_MS * Math.pow(2, attempt)
  if (!streamedContent) return BASE_RETRY_DELAY_MS * Math.pow(2, attempt)
  return BASE_RETRY_DELAY_MS
}

function delayWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      cleanup()
      reject(new Error('aborted'))
    }
    const cleanup = (): void => {
      signal?.removeEventListener('abort', onAbort)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function isAbsolutePath(inputPath: string): boolean {
  if (!inputPath) return false
  if (inputPath.startsWith('/') || inputPath.startsWith('\\')) return true
  return /^[a-zA-Z]:[\\/]/.test(inputPath)
}

function resolveToolPath(inputPath: unknown, workingFolder?: string): string {
  const raw = typeof inputPath === 'string' ? inputPath.trim() : ''
  const base = workingFolder?.trim()
  if (!raw || raw === '.') return base && base.length > 0 ? base : '.'
  if (isAbsolutePath(raw)) return raw
  if (base && base.length > 0) return path.join(base, raw)
  return raw
}

function countOccurrences(content: string, value: string): number {
  if (!value) return 0
  return content.split(value).length - 1
}

function buildToolHandlers(): Record<string, ToolHandler> {
  const readHandler: ToolHandler = {
    definition: {
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
    execute: async (input, ctx) => {
      const resolvedPath = resolveToolPath(input.file_path, ctx.workingFolder)
      const content = await fs.promises.readFile(resolvedPath, 'utf8')
      if (input.offset !== undefined || input.limit !== undefined) {
        const lines = content.split('\n')
        const start = (Number(input.offset ?? 1) || 1) - 1
        const limit = Number(input.limit ?? lines.length)
        const end = Number.isFinite(limit) ? start + limit : lines.length
        return lines
          .slice(start, end)
          .map((line, index) => `${start + index + 1}\t${line}`)
          .join('\n')
      }
      return content
    }
  }

  const writeHandler: ToolHandler = {
    definition: {
      name: 'Write',
      description: 'Writes a file to the local filesystem.',
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
    execute: async (input, ctx) => {
      const resolvedPath = resolveToolPath(input.file_path, ctx.workingFolder)
      const beforeExists = await fs.promises
        .access(resolvedPath)
        .then(() => true)
        .catch(() => false)
      await fs.promises.mkdir(path.dirname(resolvedPath), { recursive: true })
      await fs.promises.writeFile(resolvedPath, String(input.content ?? ''), 'utf8')
      return encodeStructuredToolResult({
        success: true,
        path: resolvedPath,
        op: beforeExists ? 'modify' : 'create'
      })
    }
  }

  const editHandler: ToolHandler = {
    definition: {
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
    execute: async (input, ctx) => {
      const resolvedPath = resolveToolPath(input.file_path, ctx.workingFolder)
      const content = await fs.promises.readFile(resolvedPath, 'utf8')
      const oldStr = String(input.old_string ?? '')
      const newStr = String(input.new_string ?? '')
      const replaceAll = Boolean(input.replace_all)
      if (!oldStr) {
        return encodeToolError('old_string is required')
      }
      if (oldStr === newStr) {
        return encodeToolError('new_string must be different from old_string')
      }

      const occurrences = countOccurrences(content, oldStr)
      if (occurrences === 0) {
        return encodeToolError('old_string not found in file')
      }
      if (!replaceAll && occurrences > 1) {
        return encodeToolError('old_string is not unique in file')
      }

      const updated = replaceAll
        ? content.split(oldStr).join(newStr)
        : content.replace(oldStr, newStr)

      await fs.promises.writeFile(resolvedPath, updated, 'utf8')
      return encodeStructuredToolResult({
        success: true,
        path: resolvedPath,
        replaceAll
      })
    }
  }

  const lsHandler: ToolHandler = {
    definition: {
      name: 'LS',
      description: 'List files and directories in a given path',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path or relative to the working folder' },
          ignore: {
            type: 'array',
            items: { type: 'string' },
            description: 'Glob patterns to ignore'
          }
        }
      }
    },
    execute: async (input, ctx) => {
      const targetPath = resolveToolPath(input.path ?? '.', ctx.workingFolder)
      const entries = await fs.promises.readdir(targetPath, { withFileTypes: true })
      const ignore = Array.isArray(input.ignore)
        ? input.ignore.filter((item): item is string => typeof item === 'string')
        : []
      const items = entries
        .filter((entry) => entry.isDirectory() || entry.isFile())
        .filter(
          (entry) => !ignore.some((pattern) => entry.name.includes(pattern.replace(/[*?]/g, '')))
        )
        .map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : 'file',
          path: path.join(targetPath, entry.name)
        }))
      return encodeStructuredToolResult(items)
    }
  }

  const globHandler: ToolHandler = {
    definition: {
      name: 'Glob',
      description: 'Fast file pattern matching tool',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern to match files' },
          path: { type: 'string', description: 'Optional search directory' }
        },
        required: ['pattern']
      }
    },
    execute: async (input, ctx) => {
      const cwd = resolveToolPath(input.path ?? '.', ctx.workingFolder)
      const matches = await glob(String(input.pattern ?? ''), {
        cwd,
        nodir: true,
        absolute: true,
        dot: true,
        ignore: ['**/.git/**', '**/node_modules/**', '**/out/**', '**/dist/**']
      })
      return encodeStructuredToolResult(matches)
    }
  }

  const grepHandler: ToolHandler = {
    definition: {
      name: 'Grep',
      description: 'Search file contents using regular expressions',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern to search for' },
          path: { type: 'string', description: 'Directory to search in' },
          include: { type: 'string', description: 'File pattern filter, e.g. *.ts' }
        },
        required: ['pattern']
      }
    },
    execute: async (input, ctx) => {
      const searchRoot = resolveToolPath(input.path ?? '.', ctx.workingFolder)
      const include =
        typeof input.include === 'string' && input.include.trim() ? input.include.trim() : '**/*'

      try {
        const sidecar = getSidecarManager()
        const ready = await sidecar.ensureStarted()
        if (ready) {
          const result = (await sidecar.request(
            'fs/grep',
            {
              pattern: String(input.pattern ?? ''),
              path: searchRoot,
              include,
              maxResults: 200,
              maxLineLength: 500,
              timeoutMs: 30_000
            },
            35_000
          )) as { results?: Array<{ file: string; line: number; text: string }> }

          if (Array.isArray(result?.results)) {
            return encodeStructuredToolResult(result.results)
          }
        }
      } catch {
        // fall through to local grep
      }

      const regex = new RegExp(String(input.pattern ?? ''), 'i')
      const files = await glob(include, {
        cwd: searchRoot,
        nodir: true,
        absolute: true,
        dot: true,
        ignore: ['**/.git/**', '**/node_modules/**', '**/out/**', '**/dist/**']
      })
      const results: Array<{ file: string; line: number; text: string }> = []
      for (const file of files) {
        let content = ''
        try {
          content = await fs.promises.readFile(file, 'utf8')
        } catch {
          continue
        }
        const lines = content.split(/\r?\n/)
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index]
          if (!regex.test(line)) continue
          results.push({ file, line: index + 1, text: line })
          if (results.length >= 200) {
            return encodeStructuredToolResult(results)
          }
        }
      }
      return encodeStructuredToolResult(results)
    }
  }

  const bashHandler: ToolHandler = {
    definition: {
      name: 'Bash',
      description: 'Execute a shell command',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command to execute' },
          timeout: { type: 'number', description: 'Timeout in milliseconds' },
          description: { type: 'string', description: 'Short description' }
        },
        required: ['command']
      }
    },
    execute: async (input, ctx) => {
      const command = String(input.command ?? '').trim()
      if (!command) return encodeStructuredToolResult({ exitCode: 1, stderr: 'Missing command' })
      const timeout = Number(input.timeout ?? DEFAULT_BASH_TIMEOUT_MS)
      return await new Promise<string>((resolve) => {
        const child = spawn(command, {
          cwd: ctx.workingFolder || process.cwd(),
          shell: true,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            LANG: 'zh_CN.UTF-8',
            LC_ALL: 'zh_CN.UTF-8',
            LESSCHARSET: 'utf-8',
            PYTHONIOENCODING: 'utf-8',
            PYTHONUTF8: '1'
          }
        })
        let stdout = ''
        let stderr = ''
        let settled = false
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          try {
            child.kill('SIGTERM')
          } catch {
            // ignore
          }
          resolve(
            encodeStructuredToolResult({
              exitCode: 124,
              stdout,
              stderr: `${stderr}\n[Timed out]`.trim()
            })
          )
        }, timeout)
        child.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8')
        })
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8')
        })
        child.on('error', (err) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(
            encodeStructuredToolResult({ exitCode: 1, stdout, stderr: err.message || stderr })
          )
        })
        child.on('exit', (code) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(encodeStructuredToolResult({ exitCode: code ?? 0, stdout, stderr }))
        })
        ctx.signal.addEventListener(
          'abort',
          () => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            try {
              child.kill('SIGTERM')
            } catch {
              // ignore
            }
            resolve(
              encodeStructuredToolResult({
                exitCode: 130,
                stdout,
                stderr: `${stderr}\n[Aborted]`.trim()
              })
            )
          },
          { once: true }
        )
      })
    }
  }

  const notifyHandler: ToolHandler = {
    definition: {
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
    execute: async (input, ctx) => {
      const title = String(input.title ?? '')
      const body = String(input.body ?? '')
      if (!title || !body) {
        return encodeToolError('title and body are required')
      }
      if (ctx.callerAgent === 'CronAgent' && ctx.sharedState?.deliveryUsed) {
        return encodeStructuredToolResult({
          success: true,
          skipped: true,
          reason: 'Already delivered results this run. Only one delivery call is allowed.'
        })
      }
      if (ctx.callerAgent === 'CronAgent' && ctx.pluginId && ctx.pluginChatId) {
        if (ctx.sharedState) ctx.sharedState.deliveryUsed = true
        const result = await executePluginAction({
          pluginId: ctx.pluginId,
          action: 'sendMessage',
          params: { chatId: ctx.pluginChatId, content: `ℹ️ ${title}\n${body}` }
        })
        return encodeStructuredToolResult(result)
      }
      showSystemNotification(title, body)
      if (ctx.callerAgent === 'CronAgent' && ctx.sharedState) {
        ctx.sharedState.deliveryUsed = true
      }
      return encodeStructuredToolResult({ success: true, title, body: body.slice(0, 200) })
    }
  }

  // ── Plugin channel messaging tools (issue #73) ──
  // When a cron job has pluginId + pluginChatId, the agent should be able to
  // call PluginSendMessage / PluginReplyMessage directly instead of relying
  // solely on Notify's implicit routing.

  const pluginSendMessageHandler: ToolHandler = {
    definition: {
      name: 'PluginSendMessage',
      description:
        'Send a message to a chat/group via a messaging channel (Feishu, DingTalk, WeChat, etc.).',
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
    execute: async (input, ctx) => {
      const pluginId = String(input.plugin_id ?? ctx.pluginId ?? '')
      const chatId = String(input.chat_id ?? ctx.pluginChatId ?? '')
      const content = String(input.content ?? '')
      if (!pluginId || !chatId || !content) {
        return encodeToolError('plugin_id, chat_id and content are required')
      }
      // Delivery-once guard
      if (ctx.callerAgent === 'CronAgent' && ctx.sharedState?.deliveryUsed) {
        return encodeStructuredToolResult({
          success: true,
          skipped: true,
          reason: 'Already delivered results this run. Only one delivery call is allowed.'
        })
      }
      if (ctx.callerAgent === 'CronAgent' && ctx.sharedState) {
        ctx.sharedState.deliveryUsed = true
      }
      try {
        const result = await executePluginAction({
          pluginId,
          action: 'sendMessage',
          params: { chatId, content }
        })
        return encodeStructuredToolResult(result)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return encodeToolError(`PluginSendMessage failed: ${msg}`)
      }
    }
  }

  const pluginReplyMessageHandler: ToolHandler = {
    definition: {
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
    },
    execute: async (input, ctx) => {
      const pluginId = String(input.plugin_id ?? ctx.pluginId ?? '')
      const messageId = String(input.message_id ?? '')
      const content = String(input.content ?? '')
      if (!pluginId || !messageId || !content) {
        return encodeToolError('plugin_id, message_id and content are required')
      }
      if (ctx.callerAgent === 'CronAgent' && ctx.sharedState?.deliveryUsed) {
        return encodeStructuredToolResult({
          success: true,
          skipped: true,
          reason: 'Already delivered results this run. Only one delivery call is allowed.'
        })
      }
      if (ctx.callerAgent === 'CronAgent' && ctx.sharedState) {
        ctx.sharedState.deliveryUsed = true
      }
      try {
        const result = await executePluginAction({
          pluginId,
          action: 'replyMessage',
          params: { messageId, content }
        })
        return encodeStructuredToolResult(result)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return encodeToolError(`PluginReplyMessage failed: ${msg}`)
      }
    }
  }

  return {
    Read: readHandler,
    Write: writeHandler,
    Edit: editHandler,
    LS: lsHandler,
    Glob: globHandler,
    Grep: grepHandler,
    Bash: bashHandler,
    Notify: notifyHandler,
    PluginSendMessage: pluginSendMessageHandler,
    PluginReplyMessage: pluginReplyMessageHandler
  }
}

const toolHandlers = buildToolHandlers()

function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResultContent> {
  const handler = toolHandlers[name]
  if (!handler) {
    return Promise.resolve(encodeToolError(`Unknown tool: ${name}`))
  }
  return handler.execute(input, ctx)
}

function buildAllowedToolDefinitions(allowedToolNames: string[]): ToolDefinition[] {
  return allowedToolNames
    .filter((toolName) => SUPPORTED_BACKGROUND_TOOLS.has(toolName) && !!toolHandlers[toolName])
    .map((toolName) => toolHandlers[toolName].definition)
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
    createdAt: message.createdAt
  }))
}

function createRunRecord(options: {
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
}): void {
  const db = getDb()
  db.prepare(
    `
      INSERT INTO cron_runs (
        id, job_id, started_at, finished_at, status, tool_call_count, output_summary, error,
        scheduled_for, job_name_snapshot, prompt_snapshot,
        source_session_id_snapshot, source_session_title_snapshot,
        source_project_id_snapshot, source_project_name_snapshot, source_provider_id_snapshot,
        model_snapshot, working_folder_snapshot,
        delivery_mode_snapshot, delivery_target_snapshot
      ) VALUES (?, ?, ?, NULL, 'running', 0, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  ).run(
    options.runId,
    options.jobId,
    options.startedAt,
    options.scheduledFor ?? null,
    options.jobNameSnapshot ?? null,
    options.promptSnapshot ?? null,
    options.sourceSessionIdSnapshot ?? null,
    options.sourceSessionTitleSnapshot ?? null,
    options.sourceProjectIdSnapshot ?? null,
    options.sourceProjectNameSnapshot ?? null,
    options.sourceProviderIdSnapshot ?? null,
    options.modelSnapshot ?? null,
    options.workingFolderSnapshot ?? null,
    options.deliveryModeSnapshot ?? null,
    options.deliveryTargetSnapshot ?? null
  )
}

function updateRunRecord(
  runId: string,
  patch: Partial<{
    finishedAt: number | null
    status: 'running' | 'success' | 'error' | 'aborted'
    toolCallCount: number
    outputSummary: string | null
    error: string | null
  }>
): void {
  const db = getDb()
  const sets: string[] = []
  const values: unknown[] = []
  if (patch.finishedAt !== undefined) {
    sets.push('finished_at = ?')
    values.push(patch.finishedAt)
  }
  if (patch.status !== undefined) {
    sets.push('status = ?')
    values.push(patch.status)
  }
  if (patch.toolCallCount !== undefined) {
    sets.push('tool_call_count = ?')
    values.push(patch.toolCallCount)
  }
  if (patch.outputSummary !== undefined) {
    sets.push('output_summary = ?')
    values.push(patch.outputSummary)
  }
  if (patch.error !== undefined) {
    sets.push('error = ?')
    values.push(patch.error)
  }
  if (sets.length === 0) return
  values.push(runId)
  db.prepare(`UPDATE cron_runs SET ${sets.join(', ')} WHERE id = ?`).run(...values)
}

function replaceRunMessages(runId: string, messages: ReturnType<typeof toPersistedMessages>): void {
  const db = getDb()
  const deleteStmt = db.prepare('DELETE FROM cron_run_messages WHERE run_id = ?')
  const insertStmt = db.prepare(
    `INSERT INTO cron_run_messages (id, run_id, role, content, usage, message_source, sort_order, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const tx = db.transaction(() => {
    deleteStmt.run(runId)
    messages.forEach((message, index) => {
      insertStmt.run(
        message.id,
        runId,
        message.role,
        JSON.stringify(message.content),
        message.usage ? JSON.stringify(message.usage) : null,
        message.source ?? null,
        index,
        message.createdAt
      )
    })
  })
  tx()
}

function appendRunLog(
  runId: string,
  timestamp: number,
  type: 'start' | 'text' | 'tool_call' | 'tool_result' | 'error' | 'end',
  content: string
): void {
  const db = getDb()
  db.prepare(
    'INSERT INTO cron_run_logs (id, run_id, timestamp, type, content) VALUES (?, ?, ?, ?, ?)'
  ).run(`log-${nanoid(8)}`, runId, timestamp, type, content)
}

function emitRunStarted(jobId: string, runId: string): void {
  safeSendToAllWindows('cron:run-started', { jobId, runId })
}

function emitRunProgress(
  jobId: string,
  runId: string,
  progress: { iteration: number; toolCalls: number; currentStep?: string }
): void {
  safeSendToAllWindows('cron:run-progress', {
    jobId,
    runId,
    ...progress,
    elapsed: Date.now() - (executionState.get(jobId)?.startedAt ?? Date.now())
  })
}

function emitRunLog(
  jobId: string,
  entry: {
    timestamp: number
    type: 'start' | 'text' | 'tool_call' | 'tool_result' | 'error' | 'end'
    content: string
  }
): void {
  safeSendToAllWindows('cron:run-log-appended', { jobId, ...entry })
}

function loadRunSnapshot(runId: string): {
  id: string
  jobId: string
  startedAt: number
  finishedAt: number | null
  status: 'running' | 'success' | 'error' | 'aborted'
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
} | null {
  const db = getDb()
  const row = db
    .prepare(
      `SELECT id, job_id, started_at, finished_at, status, tool_call_count, output_summary, error,
              scheduled_for, job_name_snapshot, prompt_snapshot,
              source_session_id_snapshot, source_session_title_snapshot,
              source_project_id_snapshot, source_project_name_snapshot, source_provider_id_snapshot,
              model_snapshot, working_folder_snapshot, delivery_mode_snapshot, delivery_target_snapshot
         FROM cron_runs WHERE id = ? LIMIT 1`
    )
    .get(runId) as
    | {
        id: string
        job_id: string
        started_at: number
        finished_at: number | null
        status: 'running' | 'success' | 'error' | 'aborted'
        tool_call_count: number
        output_summary: string | null
        error: string | null
        scheduled_for: number | null
        job_name_snapshot: string | null
        prompt_snapshot: string | null
        source_session_id_snapshot: string | null
        source_session_title_snapshot: string | null
        source_project_id_snapshot: string | null
        source_project_name_snapshot: string | null
        source_provider_id_snapshot: string | null
        model_snapshot: string | null
        working_folder_snapshot: string | null
        delivery_mode_snapshot: string | null
        delivery_target_snapshot: string | null
      }
    | undefined

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

function loadJobSnapshot(jobId: string): {
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
} | null {
  const db = getDb()
  const row = db
    .prepare(
      `SELECT id, session_id, name, schedule_kind, schedule_at, schedule_every, schedule_expr, schedule_tz,
              prompt, agent_id, model, working_folder, delivery_mode, delivery_target,
              plugin_id, plugin_chat_id, enabled, delete_after_run, max_iterations, deleted_at,
              last_fired_at, fire_count, created_at, updated_at,
              source_session_title, source_project_id, source_project_name, source_provider_id
         FROM cron_jobs WHERE id = ? LIMIT 1`
    )
    .get(jobId) as
    | {
        id: string
        session_id: string | null
        name: string
        schedule_kind: 'at' | 'every' | 'cron'
        schedule_at: number | null
        schedule_every: number | null
        schedule_expr: string | null
        schedule_tz: string
        prompt: string
        agent_id: string | null
        model: string | null
        working_folder: string | null
        delivery_mode: string
        delivery_target: string | null
        plugin_id: string | null
        plugin_chat_id: string | null
        enabled: number
        delete_after_run: number
        max_iterations: number
        deleted_at: number | null
        last_fired_at: number | null
        fire_count: number
        created_at: number
        updated_at: number
        source_session_title: string | null
        source_project_id: string | null
        source_project_name: string | null
        source_provider_id: string | null
      }
    | undefined

  if (!row) return null

  const runtimeState = executionState.get(jobId)

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
    scheduled: false,
    executing: false,
    executionStartedAt: runtimeState?.startedAt ?? null,
    executionProgress: runtimeState?.progress ?? null
  }
}

function emitRunFinished(payload: CronRunFinishedPayload): void {
  const run = loadRunSnapshot(payload.runId)
  const job = loadJobSnapshot(payload.jobId)
  safeSendToAllWindows('cron:run-finished', {
    ...payload,
    ...(run ? { run } : {}),
    ...(job ? { job } : {})
  })
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
    firedAt,
    deliveryMode = 'desktop',
    deliveryTarget,
    maxIterations,
    pluginId,
    pluginChatId
  } = options

  const runId = `run-${nanoid(8)}`
  const startedAt = executionState.get(jobId)?.startedAt ?? Date.now()
  const providerConfig = resolveCronProviderConfig(sourceProviderId ?? null, modelOverride ?? null)
  const definition = await resolveCronAgentDefinition(agentId)
  const availableTools = buildAllowedToolDefinitions(
    definition.allowedTools.length > 0 ? definition.allowedTools : FALLBACK_CRON_AGENT.allowedTools
  )

  createRunRecord({
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
    appendRunLog(runId, Date.now(), 'error', error)
    emitRunLog(jobId, { timestamp: Date.now(), type: 'error', content: error })
    updateRunRecord(runId, {
      finishedAt: Date.now(),
      status: 'error',
      toolCallCount: 0,
      outputSummary: null,
      error
    })
    emitRunFinished({
      jobId,
      runId,
      status: 'error',
      toolCallCount: 0,
      jobName: name,
      sessionId: sessionId ?? null,
      deliveryMode,
      deliveryTarget: deliveryTarget ?? null,
      error
    })
    return
  }

  const innerProvider: ProviderConfig = {
    ...providerConfig,
    systemPrompt: definition.systemPrompt,
    model: modelOverride || definition.model || providerConfig.model,
    temperature: definition.temperature ?? providerConfig.temperature,
    sessionId: sessionId ?? undefined
  }

  if (innerProvider.requiresApiKey !== false && !innerProvider.apiKey) {
    const error = 'Provider API key is missing for CronAgent background execution'
    appendRunLog(runId, Date.now(), 'error', error)
    emitRunLog(jobId, { timestamp: Date.now(), type: 'error', content: error })
    updateRunRecord(runId, {
      finishedAt: Date.now(),
      status: 'error',
      toolCallCount: 0,
      outputSummary: null,
      error
    })
    emitRunFinished({
      jobId,
      runId,
      status: 'error',
      toolCallCount: 0,
      jobName: name,
      sessionId: sessionId ?? null,
      deliveryMode,
      deliveryTarget: deliveryTarget ?? null,
      error
    })
    return
  }

  const channelInfo =
    pluginId && pluginChatId
      ? `\n## Channel Reply Routing\nThis cron job was created from plugin channel \`${pluginId}\`.\nChat ID: \`${pluginChatId}\`\nWhen you have results to report, use **PluginSendMessage** with plugin_id="${pluginId}" and chat_id="${pluginChatId}" to send the results back through the channel. Alternatively, **Notify** will also route to the channel automatically.`
      : ''
  const deliveryInstructions =
    pluginId && pluginChatId
      ? `When finished, call **PluginSendMessage** EXACTLY ONCE with plugin_id="${pluginId}" and chat_id="${pluginChatId}" to send a friendly result summary back through the channel. After sending, STOP.`
      : 'When finished, call **Notify** EXACTLY ONCE to send a friendly desktop result summary. After calling Notify, STOP.'

  const cronContext = `You are a scheduled task assistant running cron job (ID: ${jobId}).\nAgent: ${definition.name}\n${deliveryTarget ? `Target session: ${deliveryTarget}` : ''}${channelInfo}\n\n## Your Task\n${prompt}\n\n## Delivery Instructions\n${deliveryInstructions}\n\nMatch the language of the task prompt in your delivery message (Chinese task → Chinese reply, English task → English reply). Be concise and friendly.\n\nBegin working on this task now.`

  const transcriptMessages: UnifiedMessage[] = [
    {
      id: nanoid(),
      role: 'user',
      content: prompt,
      createdAt: Date.now()
    }
  ]
  replaceRunMessages(runId, toPersistedMessages(transcriptMessages))

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
    signal: controller.signal,
    callerAgent: 'CronAgent',
    pluginId: pluginId ?? undefined,
    pluginChatId: pluginChatId ?? undefined,
    sharedState: { deliveryUsed: false }
  }

  let output = ''
  let toolCallCount = 0
  let iterationCount = 0
  let error: string | undefined
  const appendLog = (
    type: 'start' | 'text' | 'tool_call' | 'tool_result' | 'error' | 'end',
    content: string
  ): void => {
    const timestamp = Date.now()
    appendRunLog(runId, timestamp, type, content)
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

  appendLog('start', prompt.slice(0, 400))
  setProgress({ iteration: 0, toolCalls: 0, currentStep: 'initializing' })

  try {
    const loop = runAgentLoop([loopUserMessage], loopConfig, toolCtx)
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
          replaceRunMessages(runId, toPersistedMessages(transcriptMessages))
          break
        case 'thinking_encrypted':
          break
        case 'text_delta':
          output += event.text
          appendText(transcriptMessages, event.text)
          replaceRunMessages(runId, toPersistedMessages(transcriptMessages))
          break
        case 'tool_use_streaming_start':
          appendToolUse(transcriptMessages, {
            type: 'tool_use',
            id: event.toolCallId,
            name: event.toolName,
            input: {},
            ...(event.toolCallExtraContent ? { extraContent: event.toolCallExtraContent } : {})
          })
          replaceRunMessages(runId, toPersistedMessages(transcriptMessages))
          appendLog('tool_call', `${event.toolName}(...streaming)`)
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
          replaceRunMessages(runId, toPersistedMessages(transcriptMessages))
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
          replaceRunMessages(runId, toPersistedMessages(transcriptMessages))
          appendLog(
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
          replaceRunMessages(runId, toPersistedMessages(transcriptMessages))
          break
        }
        case 'error':
          error = event.error.message
          appendLog('error', error)
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
    appendLog('error', error)
  }

  const finishedAt = Date.now()
  const status: 'success' | 'error' | 'aborted' = controller.signal.aborted
    ? 'aborted'
    : error
      ? 'error'
      : 'success'
  const outputSummary = output.slice(0, 2000)

  appendLog('end', status)
  updateRunRecord(runId, {
    finishedAt,
    status,
    toolCallCount,
    outputSummary: outputSummary || null,
    error: error ?? null
  })
  replaceRunMessages(runId, toPersistedMessages(transcriptMessages))
  emitRunFinished({
    jobId,
    runId,
    status,
    toolCallCount,
    jobName: name,
    sessionId: sessionId ?? null,
    deliveryMode,
    deliveryTarget: deliveryTarget ?? null,
    outputSummary,
    ...(error ? { error } : {})
  })
}
