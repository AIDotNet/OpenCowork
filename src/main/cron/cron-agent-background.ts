import { app } from 'electron'
import { nanoid } from 'nanoid'
import { Allow, parse as parsePartialJSON } from 'partial-json'
import { glob } from 'glob'
import { spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as http from 'http'
import * as https from 'https'
import { Readable } from 'stream'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { readConfig } from '../ipc/secure-key-store'
import { readSettings } from '../ipc/settings-handlers'
import { showSystemNotification } from '../ipc/notify-handlers'
import type {
  ToolCallState,
  InteractiveAgentEvent,
  AgentToolResultContent
} from '../../shared/agent-loop-types'
export type { ToolCallState, InteractiveAgentEvent }
import type { RequestDebugInfoWire } from '../../shared/agent-stream-protocol'
import { executePluginAction } from '../ipc/channel-handlers'
import { getSshClientForGitExec } from '../ipc/ssh-handlers'
import { safeSendToAllWindows } from '../window-ipc'
import { getDb } from '../db/database'
import {
  resolveResponsesWebsocketConfig,
  type ResponsesWebsocketMode
} from '../../shared/openai-responses-websocket'
import { normalizeMessagesForAnthropicToolReplay } from '../../shared/anthropic-tool-replay'
import {
  summarizeOpenAITextAndImages,
  supportsOpenAIImageParts
} from '../../shared/openai-message-support'
import { compactShellOutputPayload, compactShellText } from '../../shared/shell-output-compactor'
import { ResponsesWebSocketSessionManager } from '../lib/responses-websocket-session-manager'
import { applyDefaultApiUserAgent } from '../lib/api-user-agent'

const DEFAULT_AGENT = 'CronAgent'
const DEFAULT_BASH_TIMEOUT_MS = 600_000
const BASH_RESULT_PREVIEW_CHARS = 5_000
const BASH_RESULT_PREVIEW_LINES = 120
const BASH_IMPORTANT_LINE_LIMIT = 80
// One initial attempt plus at least five retries for retryable upstream failures.
const MAX_PROVIDER_RETRIES = 6
const BASE_RETRY_DELAY_MS = 1_500
const PROMPTS_DIR = path.join(os.homedir(), '.open-cowork', 'prompts')
const AGENTS_DIR = path.join(os.homedir(), '.open-cowork', 'agents')
const SYSTEM_PROXY_ENV_KEYS = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy'
]
const insecureHttpsAgent = new https.Agent({ rejectUnauthorized: false })
const secureHttpsAgent = new https.Agent()
const insecureProxyAgents = new Map<string, HttpsProxyAgent<string>>()
const secureProxyAgents = new Map<string, HttpsProxyAgent<string>>()
const responsesWsManager = new ResponsesWebSocketSessionManager('cron')
const promptCacheKeyPrefix = 'opencowork'
const globalPromptCacheKey = createPromptCacheKey()
const promptCacheKeysBySession = new Map<string, string>()

function createPromptCacheKey(seed?: string): string {
  const normalizedSeed = seed?.trim()
  if (normalizedSeed) return `${promptCacheKeyPrefix}-${normalizedSeed}`
  return `${promptCacheKeyPrefix}-${nanoid()}`
}

function getPromptCacheKey(config?: Pick<ProviderConfig, 'sessionId'>): string {
  const sessionId = config?.sessionId?.trim()
  if (!sessionId) return globalPromptCacheKey

  const existing = promptCacheKeysBySession.get(sessionId)
  if (existing) return existing

  const created = createPromptCacheKey(sessionId)
  promptCacheKeysBySession.set(sessionId, created)
  return created
}

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
  'PluginReplyMessage',
  'SubmitReport'
])

const SUBMIT_REPORT_TOOL_NAME = 'SubmitReport'

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
  cacheCreationTokens?: number
  cacheCreation5mTokens?: number
  cacheCreation1hTokens?: number
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
type ImageBlock = {
  type: 'image'
  source: { type: 'base64' | 'url'; data?: string; mediaType?: string; url?: string }
}
type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock | ImageBlock
export type ToolResultContent = AgentToolResultContent

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

type ReasoningEffortLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'max' | 'xhigh'

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
  serviceTier?: string
  websocketUrl?: string
  websocketMode?: ResponsesWebsocketMode
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
  userAgent?: string
  requestOverrides?: RequestOverrides
  instructionsPrompt?: string
  serviceTier?: string
  sessionId?: string
  computerUseEnabled?: boolean
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

interface StreamEvent {
  type:
    | 'thinking_delta'
    | 'thinking_encrypted'
    | 'text_delta'
    | 'tool_call_start'
    | 'tool_call_delta'
    | 'tool_call_end'
    | 'image_generation_started'
    | 'image_generation_partial'
    | 'image_generated'
    | 'image_error'
    | 'message_end'
    | 'error'
    | 'request_debug'
  thinking?: string
  thinkingEncryptedContent?: string
  thinkingEncryptedProvider?: 'anthropic' | 'openai-responses' | 'google'
  text?: string
  toolCallId?: string
  toolName?: string
  argumentsDelta?: string
  toolCallInput?: Record<string, unknown>
  toolCallExtraContent?: Record<string, unknown>
  imageBlock?: {
    type: 'image'
    source: { type: 'base64' | 'url'; data?: string; mediaType?: string }
  }
  partialImageIndex?: number
  imageError?: { code: string; message: string }
  stopReason?: string
  usage?: TokenUsage
  timing?: RequestTiming
  providerResponseId?: string
  error?: { type?: string; message?: string }
  debugInfo?: RequestDebugInfoWire
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
  fallbackToolExecutor?: (
    name: string,
    input: Record<string, unknown>,
    ctx: ToolContext
  ) => Promise<{ content: ToolResultContent; isError?: boolean; error?: string }>
  resolveRequiresApproval?: (
    name: string,
    input: Record<string, unknown>,
    ctx: ToolContext
  ) => Promise<boolean>
}

interface ToolHandler {
  definition: ToolDefinition
  execute: (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResultContent>
  requiresApproval?: (input: Record<string, unknown>, ctx: ToolContext) => boolean
}

interface MessageQueueLike {
  drain(): UnifiedMessage[]
}

export interface AgentLoopConfig {
  maxIterations: number
  provider: ProviderConfig
  tools: ToolDefinition[]
  signal: AbortSignal
  forceApproval?: boolean
  onApprovalNeeded?: (toolCall: ToolCallState) => Promise<boolean>
  messageQueue?: MessageQueueLike
  captureFinalMessages?: boolean
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

function encodeStructuredToolResult(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function compactCronShellPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return compactShellOutputPayload(payload, {
    stdoutMaxChars: BASH_RESULT_PREVIEW_CHARS,
    stderrMaxChars: BASH_RESULT_PREVIEW_CHARS,
    streamMaxLines: BASH_RESULT_PREVIEW_LINES,
    importantLineLimit: BASH_IMPORTANT_LINE_LIMIT
  })
}

function encodeShellToolResult(value: Record<string, unknown>): string {
  return encodeStructuredToolResult(compactCronShellPayload(value))
}

function compactCronShellToolResultContent(output: ToolResultContent): ToolResultContent {
  if (typeof output === 'string') {
    try {
      const parsed = JSON.parse(output) as unknown
      if (isRecord(parsed)) {
        return encodeStructuredToolResult(compactCronShellPayload(parsed))
      }
    } catch {
      // Plain-text shell output still needs a hard cap before it enters context.
    }

    const preview = compactShellText(output, {
      stdoutMaxChars: BASH_RESULT_PREVIEW_CHARS,
      streamMaxLines: BASH_RESULT_PREVIEW_LINES,
      importantLineLimit: BASH_IMPORTANT_LINE_LIMIT
    })
    return preview.truncated ? preview.text : output
  }

  return output.map((block) => {
    if (block.type !== 'text') return block
    const preview = compactShellText(block.text, {
      stdoutMaxChars: BASH_RESULT_PREVIEW_CHARS,
      streamMaxLines: BASH_RESULT_PREVIEW_LINES,
      importantLineLimit: BASH_IMPORTANT_LINE_LIMIT
    })
    return preview.truncated ? { ...block, text: preview.text } : block
  })
}

function encodeToolError(message: string): string {
  return encodeStructuredToolResult({ success: false, error: message })
}

function extractStructuredToolError(output: ToolResultContent): string | undefined {
  if (typeof output !== 'string') return undefined

  try {
    const parsed = JSON.parse(output) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined

    const record = parsed as Record<string, unknown>
    const hasErrorOnlyShape = Object.keys(record).length === 1
    if (typeof record.error === 'string' && (record.success === false || hasErrorOnlyShape)) {
      return record.error
    }
  } catch {
    // Non-JSON tool output is not a structured cron tool error.
  }

  return undefined
}

type SearchLimitReason = 'max_results' | 'max_output_bytes' | 'timeout' | 'max_depth' | null
type GrepMatchKind = 'match' | 'context'
type GrepOutputMode = 'matches' | 'files_with_matches' | 'count'
type GrepPathStyle = 'relative' | 'absolute'

type SearchMeta = {
  truncated: boolean
  timedOut: boolean
  limitReason: SearchLimitReason
  warnings?: string[]
}

const CRON_SEARCH_MAX_RESULTS = 20
const CRON_SEARCH_MAX_RESULTS_CAP = 200
const CRON_GREP_MAX_CONTEXT = 20
const CRON_GREP_DEFAULT_MAX_LINE_LENGTH = 160
const CRON_GREP_MAX_LINE_LENGTH = 1000
const CRON_GREP_DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024
const CRON_GREP_MAX_OUTPUT_BYTES = 64 * 1024

function shouldUseCompactSearchPayload(meta: SearchMeta, error?: string): boolean {
  return !error && !meta.truncated && !meta.timedOut && (meta.warnings?.length ?? 0) === 0
}

function formatGlobToolResult(args: {
  matches: string[]
  truncated?: boolean
  limitReason?: SearchLimitReason
  warnings?: string[]
  error?: string
}): string {
  const matches = args.matches.slice(0, CRON_SEARCH_MAX_RESULTS)
  const truncated = args.truncated === true || args.matches.length > matches.length
  const meta: SearchMeta = {
    truncated,
    timedOut: false,
    limitReason: args.limitReason ?? (truncated ? 'max_results' : null),
    warnings: args.warnings ?? []
  }

  if (shouldUseCompactSearchPayload(meta, args.error)) {
    return encodeStructuredToolResult(matches)
  }

  return encodeStructuredToolResult({
    matches,
    truncated: meta.truncated,
    timedOut: false,
    limitReason: meta.limitReason,
    warnings: meta.warnings,
    error: args.error
  })
}

function formatGrepToolResult(args: {
  matches: Array<{
    file: string
    line?: number
    text?: string
    kind?: GrepMatchKind
    count?: number
  }>
  truncated?: boolean
  timedOut?: boolean
  limitReason?: SearchLimitReason
  warnings?: string[]
  error?: string
  outputMode?: GrepOutputMode
  maxResults?: number
  maxOutputBytes?: number
}): string {
  const maxResults = Math.min(
    args.maxResults ?? CRON_SEARCH_MAX_RESULTS,
    CRON_SEARCH_MAX_RESULTS_CAP
  )
  const maxOutputBytes = Math.min(
    args.maxOutputBytes ?? CRON_GREP_DEFAULT_MAX_OUTPUT_BYTES,
    CRON_GREP_MAX_OUTPUT_BYTES
  )
  const outputMode = args.outputMode ?? 'matches'
  const matches: typeof args.matches = []
  const outputLines: string[] = []
  let totalBytes = 0
  let outputLimitReason: SearchLimitReason = null

  for (const item of args.matches) {
    if (matches.length >= maxResults) {
      outputLimitReason = 'max_results'
      break
    }

    const line =
      outputMode === 'files_with_matches'
        ? item.file
        : outputMode === 'count'
          ? `${item.file}:${item.count ?? 0}`
          : typeof item.line !== 'number'
            ? item.file
            : `${item.file}${item.kind === 'context' ? '-' : ':'}${item.line}${
                item.kind === 'context' ? '-' : ':'
              }${item.text ?? ''}`
    const nextBytes = Buffer.byteLength(line, 'utf8') + 1
    if (totalBytes + nextBytes > maxOutputBytes) {
      outputLimitReason = 'max_output_bytes'
      break
    }

    matches.push(item)
    outputLines.push(line)
    totalBytes += nextBytes
  }

  const truncated =
    args.truncated === true || args.matches.length > matches.length || outputLimitReason !== null
  const meta: SearchMeta = {
    truncated,
    timedOut: args.timedOut === true,
    limitReason: args.limitReason ?? outputLimitReason ?? (truncated ? 'max_results' : null),
    warnings: args.warnings ?? []
  }
  const output = outputLines.join('\n')

  if (output && shouldUseCompactSearchPayload(meta, args.error)) {
    return output
  }

  return encodeStructuredToolResult({
    output,
    matches,
    truncated: meta.truncated,
    timedOut: meta.timedOut,
    limitReason: meta.limitReason,
    warnings: meta.warnings,
    error: args.error
  })
}

function normalizeCronSearchError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function escapeRegexForLiteral(pattern: string): string {
  return pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function includesIgnoredDir(pattern: string, dirName: string): boolean {
  return new RegExp(`(^|/)${escapeRegexForLiteral(dirName)}(/|$)`).test(pattern.replace(/\\/g, '/'))
}

function buildCronSearchIgnore(pattern: string): string[] {
  const defaultIgnoredDirs = ['.git', 'node_modules', 'out', 'dist']
  return defaultIgnoredDirs.flatMap((dir) =>
    includesIgnoredDir(pattern, dir) ? [] : [`**/${dir}/**`, `${dir}/**`]
  )
}

function buildCronSearchWarnings(messages: Array<string | false | null | undefined>): string[] {
  return messages.filter((item): item is string => typeof item === 'string' && item.length > 0)
}

type CronGrepOptions = {
  pattern: string
  include: string
  exclude?: string
  caseSensitive: boolean
  smartCase: boolean
  literal: boolean
  word: boolean
  line: boolean
  invertMatch: boolean
  beforeContext: number
  afterContext: number
  maxResults: number
  maxLineLength: number
  maxOutputBytes: number
  maxDepth: number | null
  hidden: boolean
  respectGitignore: boolean
  followSymlinks: boolean
  outputMode: GrepOutputMode
  pathStyle: GrepPathStyle
}

type CronGrepResultItem = {
  file: string
  line?: number
  text?: string
  kind?: GrepMatchKind
  count?: number
}

function clampCronGrepNumber(value: unknown, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback
  const normalized = Math.floor(Number(value))
  if (normalized <= 0) return fallback
  return Math.min(normalized, max)
}

function clampCronGrepOptionalNumber(value: unknown, max: number): number | null {
  if (!Number.isFinite(value)) return null
  const normalized = Math.floor(Number(value))
  if (normalized <= 0) return null
  return Math.min(normalized, max)
}

function clampCronGrepContext(value: unknown): number {
  if (!Number.isFinite(value)) return 0
  const normalized = Math.floor(Number(value))
  if (normalized <= 0) return 0
  return Math.min(normalized, CRON_GREP_MAX_CONTEXT)
}

function normalizeCronBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function normalizeCronOutputMode(value: unknown): GrepOutputMode {
  return value === 'files_with_matches' || value === 'count' ? value : 'matches'
}

function normalizeCronPathStyle(value: unknown): GrepPathStyle {
  return value === 'absolute' ? 'absolute' : 'relative'
}

function normalizeCronGrepOptions(input: Record<string, unknown>): CronGrepOptions {
  const pattern = String(input.pattern ?? '')
  const smartCase = normalizeCronBoolean(input.smartCase, false)
  const hasExplicitCaseSensitive = typeof input.caseSensitive === 'boolean'
  const caseSensitive = hasExplicitCaseSensitive
    ? Boolean(input.caseSensitive)
    : smartCase
      ? /[A-Z]/.test(pattern)
      : false
  const context = clampCronGrepContext(input.context)
  const include =
    typeof input.include === 'string' && input.include.trim() ? input.include.trim() : '**/*'
  const exclude =
    typeof input.exclude === 'string' && input.exclude.trim() ? input.exclude.trim() : undefined

  return {
    pattern,
    include,
    exclude,
    caseSensitive,
    smartCase,
    literal: normalizeCronBoolean(input.literal, false),
    word: normalizeCronBoolean(input.word, false),
    line: normalizeCronBoolean(input.line, false),
    invertMatch: normalizeCronBoolean(input.invertMatch, false),
    beforeContext:
      input.beforeContext === undefined ? context : clampCronGrepContext(input.beforeContext),
    afterContext:
      input.afterContext === undefined ? context : clampCronGrepContext(input.afterContext),
    maxResults: clampCronGrepNumber(
      input.maxResults,
      CRON_SEARCH_MAX_RESULTS,
      CRON_SEARCH_MAX_RESULTS_CAP
    ),
    maxLineLength: clampCronGrepNumber(
      input.maxLineLength,
      CRON_GREP_DEFAULT_MAX_LINE_LENGTH,
      CRON_GREP_MAX_LINE_LENGTH
    ),
    maxOutputBytes: clampCronGrepNumber(
      input.maxOutputBytes,
      CRON_GREP_DEFAULT_MAX_OUTPUT_BYTES,
      CRON_GREP_MAX_OUTPUT_BYTES
    ),
    maxDepth: clampCronGrepOptionalNumber(input.maxDepth, 50),
    hidden: normalizeCronBoolean(input.hidden, true),
    respectGitignore: normalizeCronBoolean(input.respectGitignore, true),
    followSymlinks: normalizeCronBoolean(input.followSymlinks, false),
    outputMode: normalizeCronOutputMode(input.outputMode),
    pathStyle: normalizeCronPathStyle(input.pathStyle)
  }
}

function normalizeCronGrepText(text: string, maxLineLength: number): string {
  const normalized = text.trim()
  if (normalized.length <= maxLineLength) return normalized
  return `${normalized.slice(0, Math.max(0, maxLineLength - 3))}...`
}

function buildCronGrepRegex(options: CronGrepOptions): RegExp {
  let source = options.literal ? escapeRegexForLiteral(options.pattern) : options.pattern
  if (options.word) source = `\\b(?:${source})\\b`
  if (options.line) source = `^(?:${source})$`
  return new RegExp(source, options.caseSensitive ? '' : 'i')
}

function formatCronGrepPath(
  searchRoot: string,
  filePath: string,
  pathStyle: GrepPathStyle
): string {
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(searchRoot, filePath)
  if (pathStyle === 'absolute') return absolutePath
  return path.relative(searchRoot, absolutePath) || path.basename(absolutePath)
}

function formatCronRemoteGrepPath(
  searchRoot: string,
  filePath: string,
  pathStyle: GrepPathStyle
): string {
  const normalizedPath = filePath.replace(/^\.\//, '')
  const absolutePath = path.posix.isAbsolute(normalizedPath)
    ? normalizedPath
    : path.posix.join(searchRoot, normalizedPath)
  if (pathStyle === 'absolute') return absolutePath
  return path.posix.relative(searchRoot, absolutePath) || path.posix.basename(absolutePath)
}

function parseCronGlobList(value?: string): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function appendCronRipgrepSearchFlags(rgArgs: string[], options: CronGrepOptions): void {
  if (options.outputMode === 'matches') {
    rgArgs.push('--json')
    if (options.beforeContext > 0) rgArgs.push('--before-context', String(options.beforeContext))
    if (options.afterContext > 0) rgArgs.push('--after-context', String(options.afterContext))
  } else if (options.outputMode === 'files_with_matches') {
    rgArgs.push('--files-with-matches')
  } else {
    rgArgs.push('--count')
  }

  if (options.smartCase) rgArgs.push('--smart-case')
  else if (!options.caseSensitive) rgArgs.push('--ignore-case')
  if (options.literal) rgArgs.push('--fixed-strings')
  if (options.word) rgArgs.push('--word-regexp')
  if (options.line) rgArgs.push('--line-regexp')
  if (options.invertMatch) rgArgs.push('--invert-match')
  if (options.hidden) rgArgs.push('--hidden')
  if (!options.respectGitignore) rgArgs.push('--no-ignore')
  if (options.followSymlinks) rgArgs.push('--follow')
  if (options.maxDepth !== null) rgArgs.push('--max-depth', String(options.maxDepth))
}

async function runCronLocalRipgrepSearch(
  searchRoot: string,
  options: CronGrepOptions
): Promise<{
  matches: CronGrepResultItem[]
  truncated: boolean
  timedOut: boolean
  limitReason: SearchLimitReason
} | null> {
  const rgArgs = ['--line-number', '--color', 'never', '--no-messages', '--max-filesize', '10M']
  appendCronRipgrepSearchFlags(rgArgs, options)

  for (const ignoredDir of ['.git', 'node_modules', 'out', 'dist']) {
    rgArgs.push('--glob', `!${ignoredDir}/**`)
    rgArgs.push('--glob', `!**/${ignoredDir}/**`)
  }
  for (const includePattern of parseCronGlobList(options.include)) {
    rgArgs.push('--glob', includePattern)
  }
  for (const excludePattern of parseCronGlobList(options.exclude)) {
    rgArgs.push('--glob', `!${excludePattern}`)
  }
  rgArgs.push('--', options.pattern, '.')

  return await new Promise((resolve) => {
    const child = spawn('rg', rgArgs, { cwd: searchRoot, windowsHide: true })
    const matches: CronGrepResultItem[] = []
    let stdoutBuffer = ''
    let timedOut = false
    let settled = false

    const finish = (
      value: {
        matches: CronGrepResultItem[]
        truncated: boolean
        timedOut: boolean
        limitReason: SearchLimitReason
      } | null
    ): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }

    const appendMatch = (item: CronGrepResultItem): void => {
      if (matches.length >= options.maxResults) {
        child.kill()
        return
      }
      matches.push(item)
      if (matches.length >= options.maxResults) child.kill()
    }

    const processLine = (rawLine: string): void => {
      if (!rawLine.trim()) return

      if (options.outputMode === 'files_with_matches') {
        appendMatch({
          file: formatCronGrepPath(searchRoot, rawLine.trimEnd(), options.pathStyle)
        })
        return
      }

      if (options.outputMode === 'count') {
        const countMatch = rawLine.trimEnd().match(/^(.*):(\d+)$/)
        if (!countMatch) return
        const count = Number(countMatch[2])
        if (count <= 0) return
        appendMatch({
          file: formatCronGrepPath(searchRoot, countMatch[1], options.pathStyle),
          count
        })
        return
      }

      try {
        const parsed = JSON.parse(rawLine) as {
          type?: string
          data?: {
            path?: { text?: string }
            lines?: { text?: string }
            line_number?: number
          }
        }
        if (parsed.type !== 'match' && parsed.type !== 'context') return
        const rawPath = parsed.data?.path?.text
        const lineNumber = parsed.data?.line_number
        if (typeof rawPath !== 'string' || typeof lineNumber !== 'number') return
        appendMatch({
          file: formatCronGrepPath(searchRoot, rawPath, options.pathStyle),
          line: lineNumber,
          text: normalizeCronGrepText(parsed.data?.lines?.text ?? '', options.maxLineLength),
          kind: parsed.type as GrepMatchKind
        })
      } catch {
        finish(null)
      }
    }

    const flushStdout = (flush = false): void => {
      let newlineIndex = stdoutBuffer.indexOf('\n')
      while (newlineIndex !== -1 || (flush && stdoutBuffer.length > 0)) {
        const endIndex = newlineIndex === -1 ? stdoutBuffer.length : newlineIndex
        const line = stdoutBuffer.slice(0, endIndex)
        stdoutBuffer = stdoutBuffer.slice(Math.min(endIndex + 1, stdoutBuffer.length))
        processLine(line)
        if (settled) return
        newlineIndex = stdoutBuffer.indexOf('\n')
      }
    }

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, 60_000)

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8')
      flushStdout()
    })

    child.on('error', () => {
      finish(null)
    })

    child.on('close', (code) => {
      flushStdout(true)
      if (settled) return

      const truncated = timedOut || matches.length >= options.maxResults
      if (code === 0 || code === 1 || truncated) {
        finish({
          matches,
          truncated,
          timedOut,
          limitReason: timedOut ? 'timeout' : truncated ? 'max_results' : null
        })
        return
      }

      finish(null)
    })
  })
}

const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.ico',
  '.webp',
  '.svg',
  '.mp3',
  '.mp4',
  '.wav',
  '.ogg',
  '.webm',
  '.avi',
  '.mov',
  '.zip',
  '.gz',
  '.tar',
  '.rar',
  '.7z',
  '.bz2',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.dat',
  '.node',
  '.wasm',
  '.pyc',
  '.class',
  '.sqlite',
  '.db',
  '.db-wal',
  '.db-shm',
  '.asar',
  '.snap',
  '.deb',
  '.rpm',
  '.msi',
  '.dmg',
  '.lock'
])
const MAX_GREP_FILE_SIZE = 1_048_576

function isNonEmptyTextFile(filePath: string): Promise<boolean> {
  const ext = path.extname(filePath).toLowerCase()
  if (BINARY_EXTENSIONS.has(ext)) return Promise.resolve(false)
  return fs.promises
    .stat(filePath)
    .then((stat) => stat.isFile() && stat.size > 0 && stat.size <= MAX_GREP_FILE_SIZE)
    .catch(() => false)
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

function isReasoningEffortLevel(value: unknown): value is ReasoningEffortLevel {
  return (
    value === 'none' ||
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'max' ||
    value === 'xhigh'
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
  const websocketUrl = model?.websocketUrl ?? provider.websocketUrl
  const websocketMode = model?.websocketMode ?? provider.websocketMode
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
    ...(websocketUrl ? { websocketUrl } : {}),
    ...(websocketMode ? { websocketMode } : {}),
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

function buildRequestDebugInfo(
  config: ProviderConfig,
  args: {
    url: string
    method: string
    headers: Record<string, string>
    body?: string
    contextWindowBody?: string
    transport: 'http' | 'websocket'
    fallbackReason?: string
    reusedConnection?: boolean
    websocketRequestKind?: 'warmup' | 'full' | 'incremental'
    websocketIncrementalReason?: string
    previousResponseId?: string
  }
): RequestDebugInfoWire {
  return {
    url: args.url,
    method: args.method,
    headers: maskHeaders(args.headers),
    ...(typeof args.body === 'string' ? { body: args.body } : {}),
    ...(typeof args.contextWindowBody === 'string'
      ? { contextWindowBody: args.contextWindowBody }
      : {}),
    timestamp: Date.now(),
    ...(config.providerId ? { providerId: config.providerId } : {}),
    ...(config.providerBuiltinId ? { providerBuiltinId: config.providerBuiltinId } : {}),
    ...(config.model ? { model: config.model } : {}),
    transport: args.transport,
    ...(args.fallbackReason ? { fallbackReason: args.fallbackReason } : {}),
    ...(typeof args.reusedConnection === 'boolean'
      ? { reusedConnection: args.reusedConnection }
      : {}),
    ...(args.websocketRequestKind ? { websocketRequestKind: args.websocketRequestKind } : {}),
    ...(args.websocketIncrementalReason
      ? { websocketIncrementalReason: args.websocketIncrementalReason }
      : {}),
    ...(args.previousResponseId ? { previousResponseId: args.previousResponseId } : {})
  }
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

type ImageLikeBlock = {
  type: 'image'
  source: { type: 'base64' | 'url'; data?: string; mediaType?: string; url?: string }
}
type ToolResultContentBlock = Exclude<ToolResultContent, string>[number]

function getImageBlockUrl(block: ImageLikeBlock): string | null {
  if (block.source.type === 'base64') {
    if (!block.source.data) return null
    return `data:${block.source.mediaType || 'image/png'};base64,${block.source.data}`
  }
  return block.source.url || null
}

function formatOpenAIChatImagePart(block: ImageLikeBlock): unknown | null {
  const url = getImageBlockUrl(block)
  return url ? { type: 'image_url', image_url: { url } } : null
}

function formatOpenAIResponsesImagePart(block: ImageLikeBlock): unknown | null {
  const url = getImageBlockUrl(block)
  return url ? { type: 'input_image', image_url: url } : null
}

function formatOpenAIChatToolResultContent(content: ToolResultContent): unknown {
  if (!Array.isArray(content)) return content

  const textParts = content
    .filter((block): block is Extract<ToolResultContentBlock, { type: 'text' }> => {
      return block.type === 'text'
    })
    .map((block) => block.text)
  const imageCount = content.filter((block) => block.type === 'image').length

  // Chat-compatible tool messages are text-only on many OpenAI-compatible backends.
  if (imageCount > 0 && !supportsOpenAIImageParts('chat-completions', 'tool')) {
    return summarizeOpenAITextAndImages(textParts, imageCount)
  }

  const parts: unknown[] = []
  for (const block of content) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text })
      continue
    }
    const imagePart = formatOpenAIChatImagePart(block)
    if (imagePart) parts.push(imagePart)
  }
  return parts
}

function formatOpenAIResponsesToolResultOutput(content: ToolResultContent): string {
  if (!Array.isArray(content)) return content

  const textParts = content
    .filter((block): block is Extract<ToolResultContentBlock, { type: 'text' }> => {
      return block.type === 'text'
    })
    .map((block) => block.text)
  const imageCount = content.filter((block) => block.type === 'image').length
  return (
    [...textParts, ...Array.from({ length: imageCount }, () => '[Image attached]')].join('\n') ||
    '[Image]'
  )
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
      const toolResults = blocks.filter(
        (block): block is ToolResultBlock => block.type === 'tool_result'
      )
      for (const result of toolResults) {
        formatted.push({
          role: 'tool',
          tool_call_id: result.toolUseId,
          content: formatOpenAIChatToolResultContent(result.content)
        })
      }

      const parts: unknown[] = []
      for (const block of blocks) {
        if (block.type === 'text') {
          parts.push({ type: 'text', text: block.text })
        } else if (block.type === 'image') {
          const imagePart = supportsOpenAIImageParts('chat-completions', 'user')
            ? formatOpenAIChatImagePart(block)
            : null
          if (imagePart) parts.push(imagePart)
        }
      }
      if (parts.length > 0) {
        formatted.push({ role: 'user', content: parts })
      }
      continue
    }
    const toolResults = blocks.filter(
      (block): block is ToolResultBlock => block.type === 'tool_result'
    )
    if (toolResults.length > 0) {
      for (const result of toolResults) {
        formatted.push({
          role: 'tool',
          tool_call_id: result.toolUseId,
          content: formatOpenAIChatToolResultContent(result.content)
        })
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
    const hasAssistantPayload =
      textContent.length > 0 ||
      reasoningContent.length > 0 ||
      !!googleThinkingSignature ||
      toolUses.length > 0
    if (!hasAssistantPayload) continue

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
    if (message.role === 'user') {
      const parts: unknown[] = []
      let emittedToolResult = false

      for (const block of blocks) {
        if (block.type !== 'tool_result') continue
        emittedToolResult = true
        input.push({
          type: 'function_call_output',
          call_id: block.toolUseId,
          output: formatOpenAIResponsesToolResultOutput(block.content)
        })
      }

      for (const block of blocks) {
        if (block.type === 'text') {
          parts.push({ type: 'input_text', text: block.text })
        } else if (block.type === 'image') {
          const imagePart = supportsOpenAIImageParts('responses', 'user')
            ? formatOpenAIResponsesImagePart(block)
            : null
          if (imagePart) parts.push(imagePart)
        }
      }

      if (parts.length > 0) {
        input.push({ type: 'message', role: 'user', content: parts })
        continue
      }
      if (emittedToolResult) continue
    }

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
            output: formatOpenAIResponsesToolResultOutput(block.content)
          })
          break
        case 'image': {
          const imagePart = formatOpenAIResponsesImagePart(block)
          if (imagePart && message.role === 'user') {
            input.push({ type: 'message', role: 'user', content: [imagePart] })
          }
          break
        }
      }
    }
  }
  return input
}

function buildImageGenerationTool(
  config?: ProviderConfig['responsesImageGeneration']
): Record<string, unknown> | null {
  if (!config || config.enabled === false) return null
  const tool: Record<string, unknown> = { type: 'image_generation' }
  if (config.action) tool.action = config.action
  if (config.background) tool.background = config.background
  if (config.inputFidelity) tool.input_fidelity = config.inputFidelity
  if (config.inputImageMask) {
    tool.input_image_mask = {
      ...(config.inputImageMask.fileId ? { file_id: config.inputImageMask.fileId } : {}),
      ...(config.inputImageMask.imageUrl ? { image_url: config.inputImageMask.imageUrl } : {})
    }
  }
  if (config.moderation) tool.moderation = config.moderation
  if (config.outputFormat) tool.output_format = config.outputFormat
  if (config.quality) tool.quality = config.quality
  if (config.size) tool.size = config.size
  if (typeof config.outputCompression === 'number')
    tool.output_compression = config.outputCompression
  const partialImages = typeof config.partialImages === 'number' ? config.partialImages : 3
  tool.partial_images = partialImages
  return tool
}

function collectImageBase64Values(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value] : []
  if (Array.isArray(value)) return value.flatMap((item) => collectImageBase64Values(item))
  if (!value || typeof value !== 'object') return []
  const record = value as {
    b64_json?: unknown
    image_base64?: unknown
    data?: unknown
    result?: unknown
  }
  for (const candidate of [record.b64_json, record.image_base64, record.data, record.result]) {
    const extracted = collectImageBase64Values(candidate)
    if (extracted.length > 0) return extracted
  }
  return []
}

function getImageGenerationErrorMessage(item: unknown): string | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null
  const record = item as {
    error?: { message?: unknown; code?: unknown; type?: unknown } | unknown
    message?: unknown
    status?: unknown
  }
  if (record.error && typeof record.error === 'object' && !Array.isArray(record.error)) {
    const errorRecord = record.error as { message?: unknown; code?: unknown; type?: unknown }
    for (const candidate of [errorRecord.message, errorRecord.code, errorRecord.type]) {
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
    }
  }
  if (typeof record.message === 'string' && record.message.trim()) return record.message.trim()
  if (typeof record.status === 'string' && record.status.trim() === 'failed') {
    return 'Image generation failed'
  }
  return null
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

function buildAnthropicCacheControl(): { type: 'ephemeral' } {
  return { type: 'ephemeral' }
}

const MAX_ANTHROPIC_CACHE_CONTROL_BLOCKS = 4

interface AnthropicCacheControlBudget {
  readonly remaining: number
  use(): { type: 'ephemeral' } | undefined
}

function createAnthropicCacheControlBudget(enabled: boolean): AnthropicCacheControlBudget {
  let remaining = enabled ? MAX_ANTHROPIC_CACHE_CONTROL_BLOCKS : 0

  return {
    get remaining() {
      return remaining
    },
    use() {
      if (remaining <= 0) return undefined
      remaining -= 1
      return buildAnthropicCacheControl()
    }
  }
}

function consumeAnthropicCacheControl(
  budget: AnthropicCacheControlBudget
): { cache_control: { type: 'ephemeral' } } | Record<string, never> {
  const cacheControl = budget.use()
  return cacheControl ? { cache_control: cacheControl } : {}
}

function isAnthropicCacheableContentBlock(block: ContentBlock): boolean {
  switch (block.type) {
    case 'text':
      return Boolean(block.text.trim())
    case 'tool_result':
    case 'image':
      return true
    default:
      return false
  }
}

function collectAnthropicMessageCacheTargets(
  messages: UnifiedMessage[],
  budget: AnthropicCacheControlBudget
): Set<string> {
  const targets = new Set<string>()
  let remaining = budget.remaining
  if (remaining <= 0) return targets

  for (
    let messageIndex = messages.length - 1;
    messageIndex >= 0 && remaining > 0;
    messageIndex -= 1
  ) {
    const content = messages[messageIndex].content
    if (typeof content === 'string') {
      if (content.trim()) {
        targets.add(`message:${messageIndex}`)
        remaining -= 1
      }
      continue
    }

    for (let blockIndex = content.length - 1; blockIndex >= 0; blockIndex -= 1) {
      if (!isAnthropicCacheableContentBlock(content[blockIndex])) continue
      targets.add(`block:${messageIndex}:${blockIndex}`)
      remaining -= 1
      break
    }
  }

  return targets
}

const MIN_ANTHROPIC_THINKING_BUDGET = 1024

function readNonNegativeNumber(value: unknown): number | undefined {
  const numericValue =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : undefined
  return numericValue != null && Number.isFinite(numericValue) && numericValue > 0
    ? Math.floor(numericValue)
    : undefined
}

function readTokenCount(value: unknown): number | undefined {
  const numericValue =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : undefined
  return numericValue != null && Number.isFinite(numericValue) && numericValue >= 0
    ? Math.floor(numericValue)
    : undefined
}

function extractAnthropicCacheCreationUsage(
  usage: Record<string, unknown> | undefined
): Partial<TokenUsage> {
  if (!usage) return {}

  let cacheCreation: Record<string, unknown> | undefined
  if (usage.cache_creation && typeof usage.cache_creation === 'object') {
    cacheCreation = usage.cache_creation as Record<string, unknown>
  } else if (usage.cacheCreation && typeof usage.cacheCreation === 'object') {
    cacheCreation = usage.cacheCreation as Record<string, unknown>
  }

  const cacheCreation5mTokens = readNonNegativeNumber(
    cacheCreation?.ephemeral_5m_input_tokens ??
      cacheCreation?.ephemeral5mInputTokens ??
      usage.cache_creation_5m_input_tokens ??
      usage.cacheCreation5mTokens
  )
  const cacheCreation1hTokens = readNonNegativeNumber(
    cacheCreation?.ephemeral_1h_input_tokens ??
      cacheCreation?.ephemeral1hInputTokens ??
      usage.cache_creation_1h_input_tokens ??
      usage.cacheCreation1hTokens
  )

  if (cacheCreation5mTokens != null || cacheCreation1hTokens != null) {
    const total = (cacheCreation5mTokens ?? 0) + (cacheCreation1hTokens ?? 0)
    return {
      ...(total > 0 ? { cacheCreationTokens: total } : {}),
      ...(cacheCreation5mTokens != null ? { cacheCreation5mTokens } : {}),
      ...(cacheCreation1hTokens != null ? { cacheCreation1hTokens } : {})
    }
  }

  const cacheCreationTokens = readNonNegativeNumber(
    usage.cache_creation_input_tokens ?? usage.cache_creation_tokens ?? usage.cacheCreationTokens
  )
  return cacheCreationTokens != null
    ? {
        cacheCreationTokens,
        cacheCreation5mTokens: cacheCreationTokens
      }
    : {}
}

function mergeAnthropicUsage(target: TokenUsage, usage: Record<string, unknown> | undefined): void {
  if (!usage) return

  const outputTokens = readTokenCount(
    usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens
  )
  if (outputTokens !== undefined) {
    target.outputTokens = outputTokens
  }

  const cacheCreationUsage = extractAnthropicCacheCreationUsage(usage)
  Object.assign(target, cacheCreationUsage)

  const inputTokenDetails =
    usage.input_tokens_details && typeof usage.input_tokens_details === 'object'
      ? (usage.input_tokens_details as Record<string, unknown>)
      : undefined
  const outputTokenDetails =
    usage.output_tokens_details && typeof usage.output_tokens_details === 'object'
      ? (usage.output_tokens_details as Record<string, unknown>)
      : undefined

  const cacheReadTokens = readTokenCount(
    usage.cache_read_input_tokens ??
      usage.cache_read_tokens ??
      usage.cacheReadTokens ??
      inputTokenDetails?.cached_tokens
  )
  if (cacheReadTokens !== undefined && cacheReadTokens > 0) {
    target.cacheReadTokens = cacheReadTokens
  }

  const uncachedInputTokens = readTokenCount(
    usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens
  )
  const cacheCreationTokens =
    cacheCreationUsage.cacheCreationTokens ??
    (cacheCreationUsage.cacheCreation5mTokens ?? 0) +
      (cacheCreationUsage.cacheCreation1hTokens ?? 0)
  const cachedInputTokens = (cacheCreationTokens ?? 0) + (cacheReadTokens ?? 0)
  if (uncachedInputTokens !== undefined || cachedInputTokens > 0) {
    const totalInputTokens = (uncachedInputTokens ?? 0) + cachedInputTokens
    target.inputTokens = totalInputTokens
    target.contextTokens = totalInputTokens
    if (cachedInputTokens > 0) {
      target.billableInputTokens = uncachedInputTokens ?? 0
    }
  }

  const reasoningTokens = readTokenCount(
    usage.reasoning_tokens ?? usage.reasoningTokens ?? outputTokenDetails?.reasoning_tokens
  )
  if (reasoningTokens !== undefined && reasoningTokens > 0) {
    target.reasoningTokens = reasoningTokens
  }
}

function normalizeAnthropicThinkingBodyParams(
  bodyParams?: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (!bodyParams) return undefined

  const nextBodyParams: Record<string, unknown> = { ...bodyParams }
  const rawEnableThinking = nextBodyParams.enable_thinking
  delete nextBodyParams.enable_thinking

  if (!('thinking' in nextBodyParams) && typeof rawEnableThinking === 'boolean') {
    nextBodyParams.thinking = rawEnableThinking
      ? { type: 'enabled', budget_tokens: MIN_ANTHROPIC_THINKING_BUDGET }
      : { type: 'disabled' }
  }

  const thinking = nextBodyParams.thinking
  if (thinking && typeof thinking === 'object' && !Array.isArray(thinking)) {
    const normalizedThinking = { ...(thinking as Record<string, unknown>) }
    if (normalizedThinking.type === 'enabled' && normalizedThinking.budget_tokens === undefined) {
      normalizedThinking.budget_tokens = MIN_ANTHROPIC_THINKING_BUDGET
    }
    nextBodyParams.thinking = normalizedThinking
  }

  return nextBodyParams
}

function readAnthropicThinkingBudgetFromBodyParams(
  bodyParams?: Record<string, unknown>
): number | undefined {
  const normalizedBodyParams = normalizeAnthropicThinkingBodyParams(bodyParams)
  const thinking = normalizedBodyParams?.thinking
  if (!thinking || typeof thinking !== 'object' || Array.isArray(thinking)) return undefined

  const budgetValue = (thinking as Record<string, unknown>).budget_tokens
  const budgetTokens =
    typeof budgetValue === 'number'
      ? budgetValue
      : typeof budgetValue === 'string'
        ? Number(budgetValue)
        : undefined

  return Number.isFinite(budgetTokens) && budgetTokens != null && budgetTokens > 0
    ? Math.floor(budgetTokens)
    : undefined
}

function buildAnthropicThinkingBodyParams(
  config: ProviderConfig
): Record<string, unknown> | undefined {
  const bodyParams = config.thinkingConfig?.bodyParams
  if (!config.thinkingEnabled || !bodyParams) return undefined
  return normalizeAnthropicThinkingBodyParams(bodyParams)
}

function buildAnthropicDisabledThinkingBodyParams(
  config: ProviderConfig
): Record<string, unknown> | undefined {
  const bodyParams = config.thinkingConfig?.disabledBodyParams
  if (config.thinkingEnabled || !bodyParams) return undefined
  return normalizeAnthropicThinkingBodyParams(bodyParams)
}

function normalizeAnthropicThinkingRequestBody(body: Record<string, unknown>): void {
  const normalized = normalizeAnthropicThinkingBodyParams(body)
  if (!normalized) return

  for (const key of Object.keys(body)) {
    delete body[key]
  }
  Object.assign(body, normalized)
}

function formatAnthropicMessages(
  messages: UnifiedMessage[],
  promptCacheEnabled = false,
  cacheBudget = createAnthropicCacheControlBudget(false)
): unknown[] {
  const filteredMessages = normalizeMessagesForAnthropicToolReplay(messages).filter(
    (message) => message.role !== 'system'
  )
  const cacheTargets = promptCacheEnabled
    ? collectAnthropicMessageCacheTargets(filteredMessages, cacheBudget)
    : new Set<string>()

  return filteredMessages.map((message, messageIndex) => {
    if (typeof message.content === 'string') {
      if (!cacheTargets.has(`message:${messageIndex}`)) {
        return { role: message.role, content: message.content }
      }

      return {
        role: message.role,
        content: [
          {
            type: 'text',
            text: message.content,
            ...consumeAnthropicCacheControl(cacheBudget)
          }
        ]
      }
    }
    const blocks = message.content as ContentBlock[]
    return {
      role: message.role,
      content: blocks.map((block, blockIndex) => {
        const shouldCache = cacheTargets.has(`block:${messageIndex}:${blockIndex}`)
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
            return {
              type: 'text',
              text: block.text,
              ...(shouldCache ? consumeAnthropicCacheControl(cacheBudget) : {})
            }
          case 'tool_use':
            return { type: 'tool_use', id: block.id, name: block.name, input: block.input }
          case 'tool_result': {
            let formattedContent: unknown = block.content
            if (Array.isArray(block.content)) {
              formattedContent = block.content.map((contentBlock) => {
                if (contentBlock.type === 'image') {
                  return {
                    type: 'image',
                    source: {
                      type: contentBlock.source.type,
                      media_type: contentBlock.source.mediaType,
                      data: contentBlock.source.data
                    }
                  }
                }
                return contentBlock
              })
            }
            return {
              type: 'tool_result',
              tool_use_id: block.toolUseId,
              content: formattedContent,
              ...(shouldCache ? consumeAnthropicCacheControl(cacheBudget) : {})
            }
          }
          case 'image':
            return {
              type: 'image',
              source: {
                type: block.source.type,
                media_type: block.source.mediaType,
                data: block.source.data,
                ...(block.source.url ? { url: block.source.url } : {})
              },
              ...(shouldCache ? consumeAnthropicCacheControl(cacheBudget) : {})
            }
        }
      })
    }
  })
}

function formatAnthropicTools(
  tools: ToolDefinition[],
  promptCacheEnabled = false,
  cacheBudget = createAnthropicCacheControlBudget(false)
): unknown[] {
  return tools.map((tool, index) => ({
    name: tool.name,
    description: tool.description,
    input_schema: normalizeToolSchema(tool.inputSchema),
    ...(promptCacheEnabled && index === tools.length - 1
      ? consumeAnthropicCacheControl(cacheBudget)
      : {})
  }))
}

function formatAnthropicSystemPrompt(
  systemPrompt?: string,
  systemPromptCacheEnabled = false,
  cacheBudget = createAnthropicCacheControlBudget(false)
): Array<{ type: 'text'; text: string }> | undefined {
  if (!systemPrompt) return undefined
  return [
    {
      type: 'text',
      text: systemPrompt,
      ...(systemPromptCacheEnabled && systemPrompt.trim()
        ? consumeAnthropicCacheControl(cacheBudget)
        : {})
    }
  ]
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

function getSystemProxyUrl(): string | null {
  const saved = readSettings().systemProxyUrl
  if (typeof saved === 'string' && saved.trim()) return saved.trim()
  for (const key of SYSTEM_PROXY_ENV_KEYS) {
    const value = process.env[key]?.trim()
    if (value) return value
  }
  return null
}

function getProxyAgent(proxyUrl: string, allowInsecureTls: boolean): HttpsProxyAgent<string> {
  const cache = allowInsecureTls ? insecureProxyAgents : secureProxyAgents
  const existing = cache.get(proxyUrl)
  if (existing) return existing
  const agent = new HttpsProxyAgent(proxyUrl, {
    rejectUnauthorized: !allowInsecureTls
  })
  cache.set(proxyUrl, agent)
  return agent
}

function resolveRequestAgent(
  targetUrl: URL,
  useSystemProxy: boolean,
  allowInsecureTls: boolean
): HttpsProxyAgent<string> | https.Agent | undefined {
  if (useSystemProxy) {
    const proxyUrl = getSystemProxyUrl()
    if (proxyUrl) return getProxyAgent(proxyUrl, allowInsecureTls)
  }
  if (targetUrl.protocol === 'https:') {
    return allowInsecureTls ? insecureHttpsAgent : secureHttpsAgent
  }
  return undefined
}

const REQUEST_BODY_MANAGED_HEADERS = new Set([
  'connection',
  'content-length',
  'expect',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
])

function buildForwardHeaders(
  headers: Record<string, string>,
  bodyBuffer: Buffer | null
): Record<string, string> {
  const forwarded: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (value == null) continue
    const stringValue = String(value)
    if (!stringValue || /\r|\n/.test(stringValue)) continue
    if (REQUEST_BODY_MANAGED_HEADERS.has(key.toLowerCase())) continue
    forwarded[key] = stringValue
  }
  applyDefaultApiUserAgent(forwarded)
  if (bodyBuffer) forwarded['Content-Length'] = String(bodyBuffer.byteLength)
  return forwarded
}

async function sendFetchRequest(
  url: string,
  init: Record<string, unknown>,
  allowInsecureTls = true,
  useSystemProxy = false
): Promise<FetchResponseLike> {
  const targetUrl = new URL(url)
  const isHttps = targetUrl.protocol === 'https:'
  const httpModule = isHttps ? https : http
  const body = typeof init.body === 'string' ? init.body : undefined
  const bodyBuffer = body ? Buffer.from(body, 'utf-8') : null
  const headers = buildForwardHeaders(
    (init.headers as Record<string, string> | undefined) ?? {},
    bodyBuffer
  )
  const agent = resolveRequestAgent(targetUrl, useSystemProxy, allowInsecureTls)

  const response = await new Promise<FetchResponseLike>((resolve, reject) => {
    const req = httpModule.request(
      {
        hostname: targetUrl.hostname,
        port: targetUrl.port || (isHttps ? 443 : 80),
        path: targetUrl.pathname + targetUrl.search,
        method: String(init.method ?? 'GET'),
        headers,
        ...(agent ? { agent } : {}),
        ...(isHttps && !agent && allowInsecureTls ? { rejectUnauthorized: false } : {})
      },
      (res) => {
        const webStream = Readable.toWeb(res) as ReadableStream<Uint8Array>
        resolve(
          new Response(webStream, {
            status: res.statusCode || 0,
            statusText: res.statusMessage || '',
            headers: res.headers as HeadersInit
          }) as FetchResponseLike
        )
      }
    )

    req.on('error', reject)

    const signal = init.signal as AbortSignal | undefined
    const abortRequest = (): void => {
      req.destroy(new Error('Request aborted'))
    }
    signal?.addEventListener('abort', abortRequest, { once: true })

    req.on('close', () => {
      signal?.removeEventListener('abort', abortRequest)
    })

    if (bodyBuffer) req.write(bodyBuffer)
    req.end()
  })

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

  if (config.thinkingEnabled && config.thinkingConfig) {
    Object.assign(body, config.thinkingConfig.bodyParams)
    if (config.thinkingConfig.reasoningEffortLevels && config.reasoningEffort) {
      body.reasoning_effort = config.reasoningEffort
    }
    if (config.thinkingConfig.forceTemperature !== undefined) {
      body.temperature = config.thinkingConfig.forceTemperature
    }
  } else if (!config.thinkingEnabled && config.thinkingConfig?.disabledBodyParams) {
    Object.assign(body, config.thinkingConfig.disabledBodyParams)
  }

  applyBodyOverrides(body, config)
  if (typeof body.prompt_cache_key !== 'string' || !body.prompt_cache_key.trim()) {
    body.prompt_cache_key = getPromptCacheKey(config)
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiKey}`
  }
  if (config.userAgent) headers['User-Agent'] = config.userAgent
  if (config.serviceTier) headers.service_tier = config.serviceTier
  applyHeaderOverrides(headers, config)
  applyDefaultApiUserAgent(headers)
  const bodyStr = JSON.stringify(body)
  yield {
    type: 'request_debug',
    debugInfo: buildRequestDebugInfo(config, {
      url,
      method: 'POST',
      headers,
      body: bodyStr,
      transport: 'http'
    })
  }
  console.log('[CronAgent][OpenAI Chat] request', {
    url,
    model: config.model,
    headers: maskHeaders(headers)
  })
  const response = await sendFetchRequest(
    url,
    {
      method: 'POST',
      headers,
      body: bodyStr,
      signal
    },
    config.allowInsecureTls ?? true,
    config.useSystemProxy ?? false
  )
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
        prompt_tokens_details?: { cached_tokens?: number }
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
          prompt_tokens_details?: { cached_tokens?: number }
          completion_tokens_details?: { reasoning_tokens?: number }
        }
      }
    } catch {
      continue
    }
    if (!data) continue
    const choice = data.choices?.[0]
    if (!choice) {
      if (data.usage) {
        outputTokens = data.usage.completion_tokens ?? outputTokens
        const requestCompletedAt = Date.now()
        yield {
          type: 'message_end',
          usage: {
            inputTokens: data.usage.prompt_tokens ?? 0,
            outputTokens: data.usage.completion_tokens ?? 0,
            ...(data.usage.prompt_tokens_details?.cached_tokens
              ? {
                  billableInputTokens: Math.max(
                    0,
                    (data.usage.prompt_tokens ?? 0) - data.usage.prompt_tokens_details.cached_tokens
                  ),
                  cacheReadTokens: data.usage.prompt_tokens_details.cached_tokens
                }
              : {}),
            contextTokens: data.usage.prompt_tokens ?? 0,
            ...(data.usage.completion_tokens_details?.reasoning_tokens
              ? { reasoningTokens: data.usage.completion_tokens_details.reasoning_tokens }
              : {})
          },
          timing: {
            totalMs: requestCompletedAt - requestStartedAt,
            ttftMs: firstTokenAt ? firstTokenAt - requestStartedAt : undefined,
            tps: computeTps(outputTokens, firstTokenAt, requestCompletedAt)
          }
        }
      }
      continue
    }
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
                ...(data.usage.prompt_tokens_details?.cached_tokens
                  ? {
                      billableInputTokens: Math.max(
                        0,
                        (data.usage.prompt_tokens ?? 0) -
                          data.usage.prompt_tokens_details.cached_tokens
                      ),
                      cacheReadTokens: data.usage.prompt_tokens_details.cached_tokens
                    }
                  : {}),
                contextTokens: data.usage.prompt_tokens ?? 0,
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
  const promptCacheEnabled = config.enablePromptCache !== false
  const systemPromptCacheEnabled = config.enableSystemPromptCache !== false
  const thinkingBodyParams = buildAnthropicThinkingBodyParams(config)
  const disabledThinkingBodyParams = buildAnthropicDisabledThinkingBodyParams(config)
  const resolveAnthropicEffort = (): 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined => {
    const levels = config.thinkingConfig?.reasoningEffortLevels
    if (!levels || levels.length === 0) return undefined

    const selected =
      config.reasoningEffort && levels.includes(config.reasoningEffort)
        ? config.reasoningEffort
        : (config.thinkingConfig?.defaultReasoningEffort ?? levels[0])

    switch (selected) {
      case 'low':
      case 'medium':
      case 'high':
      case 'xhigh':
      case 'max':
        return selected
      default:
        return undefined
    }
  }

  const readAnthropicThinkingBudget = (): number | undefined => {
    if (!config.thinkingEnabled) return undefined
    return readAnthropicThinkingBudgetFromBodyParams(config.thinkingConfig?.bodyParams)
  }

  const resolveAnthropicMaxTokens = (): number => {
    const configuredMaxTokens = Math.max(1, Math.floor(config.maxTokens ?? 32000))
    const thinkingBudget = readAnthropicThinkingBudget()
    return thinkingBudget != null
      ? Math.max(configuredMaxTokens, thinkingBudget + 1)
      : configuredMaxTokens
  }

  const baseUrl = (config.baseUrl || 'https://api.anthropic.com').trim().replace(/\/+$/, '')
  const url = `${baseUrl}/v1/messages`
  const cacheBudget = createAnthropicCacheControlBudget(
    promptCacheEnabled || systemPromptCacheEnabled
  )
  const system = formatAnthropicSystemPrompt(
    config.systemPrompt,
    systemPromptCacheEnabled,
    cacheBudget
  )
  const formattedTools =
    tools.length > 0 ? formatAnthropicTools(tools, promptCacheEnabled, cacheBudget) : undefined
  const body: Record<string, unknown> = {
    model: config.model,
    ...(system ? { system } : {}),
    messages: formatAnthropicMessages(messages, promptCacheEnabled, cacheBudget),
    max_tokens: resolveAnthropicMaxTokens(),
    stream: true
  }
  if (tools.length > 0) {
    body.tools = formattedTools
  }

  if (thinkingBodyParams && config.thinkingConfig) {
    Object.assign(body, thinkingBodyParams)
    if (config.thinkingConfig.forceTemperature !== undefined) {
      body.temperature = config.thinkingConfig.forceTemperature
    }
  } else if (disabledThinkingBodyParams) {
    Object.assign(body, disabledThinkingBodyParams)
  }

  if (config.temperature !== undefined && body.temperature === undefined) {
    body.temperature = config.temperature
  }
  applyBodyOverrides(body, config)

  const effort = resolveAnthropicEffort()
  if (effort) {
    body.output_config = {
      ...(typeof body.output_config === 'object' && body.output_config !== null
        ? (body.output_config as Record<string, unknown>)
        : {}),
      effort
    }
  }

  normalizeAnthropicThinkingRequestBody(body)

  const maxTokens =
    typeof body.max_tokens === 'number'
      ? Math.max(1, Math.floor(body.max_tokens))
      : typeof body.max_tokens === 'string'
        ? Math.max(1, Math.floor(Number(body.max_tokens) || resolveAnthropicMaxTokens()))
        : resolveAnthropicMaxTokens()
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
    'anthropic-beta': 'prompt-caching-2024-07-31,interleaved-thinking-2025-05-14',
    'x-api-key': config.apiKey
  }
  if (config.userAgent) headers['User-Agent'] = config.userAgent
  applyHeaderOverrides(headers, config)
  applyDefaultApiUserAgent(headers)
  const bodyStr = JSON.stringify(body)
  yield {
    type: 'request_debug',
    debugInfo: buildRequestDebugInfo(config, {
      url,
      method: 'POST',
      headers,
      body: bodyStr,
      transport: 'http'
    })
  }
  const response = await sendFetchRequest(
    url,
    {
      method: 'POST',
      headers,
      body: bodyStr,
      signal
    },
    config.allowInsecureTls ?? true,
    config.useSystemProxy ?? false
  )
  let activeToolCall: { id: string; name: string; input: string[] } | null = null
  const pendingUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
  let pendingStopReason: string | undefined
  let sawMessageEvent = false
  let messageEndEmitted = false
  const flushActiveToolCall = (): StreamEvent | null => {
    if (!activeToolCall) return null

    let parsedInput: Record<string, unknown> = {}
    try {
      parsedInput = JSON.parse(activeToolCall.input.join('') || '{}')
    } catch {
      parsedInput = {}
    }
    const event: StreamEvent = {
      type: 'tool_call_end',
      toolCallId: activeToolCall.id,
      toolName: activeToolCall.name,
      toolCallInput: parsedInput
    }
    activeToolCall = null
    return event
  }
  for await (const sse of parseSSEStream(response)) {
    if (!sse.data || sse.data === '[DONE]') continue
    let data: {
      type?: string
      message?: {
        usage?: {
          input_tokens?: number
          output_tokens?: number
          cache_read_input_tokens?: number
          cache_creation_input_tokens?: number
          cache_creation?: {
            ephemeral_5m_input_tokens?: number
            ephemeral_1h_input_tokens?: number
          }
        }
      }
      content_block?: { type?: string; id?: string; name?: string }
      delta?: {
        type?: string
        text?: string
        thinking?: string
        signature?: string
        partial_json?: string
        stop_reason?: string
      }
      usage?: {
        input_tokens?: number
        output_tokens?: number
        cache_read_input_tokens?: number
        cache_creation_input_tokens?: number
        cache_creation?: {
          ephemeral_5m_input_tokens?: number
          ephemeral_1h_input_tokens?: number
        }
      }
      stop_reason?: string
      error?: { type?: string; message?: string }
    } | null = null
    try {
      data = JSON.parse(sse.data) as {
        type?: string
        message?: {
          usage?: {
            input_tokens?: number
            output_tokens?: number
            cache_read_input_tokens?: number
            cache_creation_input_tokens?: number
            cache_creation?: {
              ephemeral_5m_input_tokens?: number
              ephemeral_1h_input_tokens?: number
            }
          }
        }
        content_block?: { type?: string; id?: string; name?: string }
        delta?: {
          type?: string
          text?: string
          thinking?: string
          signature?: string
          partial_json?: string
          stop_reason?: string
        }
        usage?: {
          input_tokens?: number
          output_tokens?: number
          cache_read_input_tokens?: number
          cache_creation_input_tokens?: number
          cache_creation?: {
            ephemeral_5m_input_tokens?: number
            ephemeral_1h_input_tokens?: number
          }
        }
        stop_reason?: string
        error?: { type?: string; message?: string }
      }
    } catch {
      continue
    }
    if (!data) continue
    const hasUsagePayload = Boolean(data.message?.usage || data.usage)
    if (hasUsagePayload) {
      mergeAnthropicUsage(pendingUsage, data.message?.usage)
      mergeAnthropicUsage(pendingUsage, data.usage)
      outputTokens = pendingUsage.outputTokens
      sawMessageEvent = true
    }
    const eventType = sse.event ?? data.type
    switch (eventType) {
      case 'message_start': {
        sawMessageEvent = true
        break
      }
      case 'content_block_start': {
        sawMessageEvent = true
        if (data.content_block?.type === 'tool_use') {
          activeToolCall = {
            id: String(data.content_block.id ?? nanoid()),
            name: String(data.content_block.name ?? ''),
            input: []
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
        sawMessageEvent = true
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
          activeToolCall.input.push(data.delta.partial_json)
          yield {
            type: 'tool_call_delta',
            toolCallId: activeToolCall.id,
            argumentsDelta: data.delta.partial_json
          }
        }
        break
      }
      case 'content_block_stop': {
        sawMessageEvent = true
        const toolCallEndEvent = flushActiveToolCall()
        if (toolCallEndEvent) {
          yield toolCallEndEvent
        }
        break
      }
      case 'message_delta': {
        sawMessageEvent = true
        outputTokens = pendingUsage.outputTokens
        pendingStopReason = data.delta?.stop_reason ?? pendingStopReason
        break
      }
      case 'message_stop': {
        sawMessageEvent = true
        outputTokens = pendingUsage.outputTokens
        const toolCallEndEvent = flushActiveToolCall()
        if (toolCallEndEvent) {
          yield toolCallEndEvent
        }
        pendingStopReason = data.stop_reason ?? data.delta?.stop_reason ?? pendingStopReason
        break
      }
      case 'error':
        messageEndEmitted = true
        yield { type: 'error', error: data.error }
        break
    }
  }
  if (!messageEndEmitted && sawMessageEvent) {
    const requestCompletedAt = Date.now()
    const toolCallEndEvent = flushActiveToolCall()
    if (toolCallEndEvent) {
      yield toolCallEndEvent
    }
    yield {
      type: 'message_end',
      stopReason: pendingStopReason,
      usage: { ...pendingUsage },
      timing: {
        totalMs: requestCompletedAt - requestStartedAt,
        ttftMs: firstTokenAt ? firstTokenAt - requestStartedAt : undefined,
        tps: computeTps(outputTokens, firstTokenAt, requestCompletedAt)
      }
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
    input: formatOpenAIResponsesMessages(messages, config.systemPrompt, !!config.thinkingEnabled),
    stream: true
  }
  const formattedTools = formatOpenAIResponsesTools(tools)
  const allTools: unknown[] = []
  if (config.computerUseEnabled) {
    allTools.push({ type: 'computer' })
  }
  const imageGenTool = buildImageGenerationTool(config.responsesImageGeneration)
  if (imageGenTool) {
    allTools.push(imageGenTool)
  }
  allTools.push(...formattedTools)
  if (allTools.length > 0) {
    body.tools = allTools
  }
  if (config.temperature !== undefined) body.temperature = config.temperature
  if (config.maxTokens) body.max_output_tokens = config.maxTokens

  if (config.thinkingEnabled && config.thinkingConfig) {
    Object.assign(body, config.thinkingConfig.bodyParams)

    const reasoning =
      typeof body.reasoning === 'object' && body.reasoning !== null
        ? { ...(body.reasoning as Record<string, unknown>) }
        : {}

    if (config.thinkingConfig.reasoningEffortLevels && config.reasoningEffort) {
      reasoning.effort = config.reasoningEffort
    }

    if (body.model !== 'gpt-5.3-codex-spark') {
      reasoning.summary = config.responseSummary ?? 'auto'
    }
    if (Object.keys(reasoning).length > 0) {
      body.reasoning = reasoning
    }

    const include = Array.isArray(body.include)
      ? (body.include as unknown[]).filter((item): item is string => typeof item === 'string')
      : []
    if (!include.includes('reasoning.encrypted_content')) {
      include.push('reasoning.encrypted_content')
    }
    body.include = include

    if (config.thinkingConfig.forceTemperature !== undefined) {
      body.temperature = config.thinkingConfig.forceTemperature
    }
  } else if (!config.thinkingEnabled && config.thinkingConfig?.disabledBodyParams) {
    Object.assign(body, config.thinkingConfig.disabledBodyParams)
  }

  if (config.instructionsPrompt) {
    const instructions = await loadPromptContent(config.instructionsPrompt)
    if (instructions) {
      body.instructions = instructions
    }
  }
  applyBodyOverrides(body, config)
  if (typeof body.prompt_cache_key !== 'string' || !body.prompt_cache_key.trim()) {
    body.prompt_cache_key = getPromptCacheKey(config)
  }
  delete body.previous_response_id
  delete body.previousResponseId
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiKey}`
  }
  if (config.userAgent) headers['User-Agent'] = config.userAgent
  if (config.serviceTier) headers.service_tier = config.serviceTier
  applyHeaderOverrides(headers, config)
  applyDefaultApiUserAgent(headers)
  const fullBodyStr = JSON.stringify(body)
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
  const emittedImageGenerationStartIds = new Set<string>()
  const emittedImageOutputItemIds = new Set<string>()
  let imageGenerationStarted = false

  const getImageGenerationItemId = (item: unknown): string | null => {
    if (!item || typeof item !== 'object') return null
    const record = item as { id?: unknown; item_id?: unknown; call_id?: unknown }
    if (typeof record.id === 'string' && record.id.trim()) return record.id
    if (typeof record.item_id === 'string' && record.item_id.trim()) return record.item_id
    if (typeof record.call_id === 'string' && record.call_id.trim()) return record.call_id
    return null
  }

  const tryBuildImageGenerationStartedEvent = (item: unknown): StreamEvent | null => {
    const itemId = getImageGenerationItemId(item)
    if (itemId && emittedImageGenerationStartIds.has(itemId)) return null
    if (itemId) emittedImageGenerationStartIds.add(itemId)
    if (firstTokenAt === null) firstTokenAt = Date.now()
    imageGenerationStarted = true
    return { type: 'image_generation_started' }
  }

  const createImageBlock = (
    base64: string,
    outputFormat?: string | null
  ): NonNullable<StreamEvent['imageBlock']> => {
    let mediaType = 'image/png'
    switch ((outputFormat ?? '').trim().toLowerCase()) {
      case 'jpeg':
      case 'jpg':
        mediaType = 'image/jpeg'
        break
      case 'webp':
        mediaType = 'image/webp'
        break
    }
    return { type: 'image', source: { type: 'base64', data: base64, mediaType } }
  }

  const handleResponseEvent = (
    eventType: string | undefined,
    data: {
      delta?: string
      text?: string
      call_id?: string
      name?: string
      arguments?: string
      partial_image_b64?: string
      partial_image_index?: number
      output_format?: string
      item?: {
        type?: string
        id?: string
        call_id?: string
        name?: string
        result?: unknown
        output_format?: string
        status?: string
        encrypted_content?: string
        summary?: unknown
        reasoning?: { encrypted_content?: string; summary?: unknown }
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
    } | null
  ): StreamEvent[] => {
    if (!data) return []
    switch (eventType) {
      case 'response.output_text.delta':
        if (firstTokenAt === null) firstTokenAt = Date.now()
        return [{ type: 'text_delta', text: data.delta }]
      case 'response.reasoning_summary_text.delta': {
        if (firstTokenAt === null) firstTokenAt = Date.now()
        const thinkingEvent = tryBuildThinkingDeltaEvent(data.delta)
        return thinkingEvent ? [thinkingEvent] : []
      }
      case 'response.reasoning_summary_text.done': {
        if (firstTokenAt === null) firstTokenAt = Date.now()
        if (!emittedThinkingDelta) {
          const thinkingEvent = tryBuildThinkingDeltaEvent(data.text ?? data.delta)
          return thinkingEvent ? [thinkingEvent] : []
        }
        return []
      }
      case 'response.output_item.added':
        if (data.item?.type === 'function_call') {
          return [
            {
              type: 'tool_call_start',
              toolCallId: data.item.call_id,
              toolName: data.item.name
            }
          ]
        }
        if (data.item?.type === 'reasoning') {
          const encryptedEvent = tryBuildThinkingEncryptedEvent(
            data.item.encrypted_content ?? data.item.reasoning?.encrypted_content
          )
          return encryptedEvent ? [encryptedEvent] : []
        }
        if (data.item?.type === 'image_generation_call') {
          const imageEvent = tryBuildImageGenerationStartedEvent(data.item)
          return imageEvent ? [imageEvent] : []
        }
        return []
      case 'response.output_item.done': {
        const events: StreamEvent[] = []
        if (data.item?.type === 'image_generation_call') {
          const startEvent = tryBuildImageGenerationStartedEvent(data.item)
          if (startEvent) events.push(startEvent)
          const itemId = getImageGenerationItemId(data.item)
          if (!itemId || !emittedImageOutputItemIds.has(itemId)) {
            const b64Values = collectImageBase64Values(data.item.result)
            const outputFormat =
              typeof data.item.output_format === 'string'
                ? data.item.output_format
                : config.responsesImageGeneration?.outputFormat
            if (b64Values.length > 0) {
              if (itemId) emittedImageOutputItemIds.add(itemId)
              imageGenerationStarted = false
              for (const b64 of b64Values) {
                events.push({
                  type: 'image_generated',
                  imageBlock: createImageBlock(b64, outputFormat)
                })
              }
            } else {
              const errorMessage = getImageGenerationErrorMessage(data.item)
              if (errorMessage) {
                if (itemId) emittedImageOutputItemIds.add(itemId)
                imageGenerationStarted = false
                events.push({
                  type: 'image_error',
                  imageError: { code: 'api_error', message: errorMessage }
                })
              }
            }
          }
        }
        if (data.item?.type === 'reasoning') {
          const encryptedEvent = tryBuildThinkingEncryptedEvent(
            data.item.encrypted_content ?? data.item.reasoning?.encrypted_content
          )
          if (encryptedEvent) events.push(encryptedEvent)
        }
        return events
      }
      case 'response.image_generation_call.partial_image': {
        const events: StreamEvent[] = []
        const startEvent = tryBuildImageGenerationStartedEvent(data)
        if (startEvent) events.push(startEvent)
        if (typeof data.partial_image_b64 === 'string' && data.partial_image_b64.trim()) {
          if (firstTokenAt === null) firstTokenAt = Date.now()
          const outputFormat =
            typeof data.output_format === 'string'
              ? data.output_format
              : config.responsesImageGeneration?.outputFormat
          events.push({
            type: 'image_generation_partial',
            imageBlock: createImageBlock(data.partial_image_b64, outputFormat),
            ...(typeof data.partial_image_index === 'number'
              ? { partialImageIndex: data.partial_image_index }
              : {})
          })
        }
        return events
      }
      case 'response.function_call_arguments.delta':
        return [{ type: 'tool_call_delta', toolCallId: data.call_id, argumentsDelta: data.delta }]
      case 'response.function_call_arguments.done':
        try {
          return [
            {
              type: 'tool_call_end',
              toolCallId: data.call_id,
              toolName: data.name,
              toolCallInput: JSON.parse(data.arguments ?? '{}')
            }
          ]
        } catch {
          return [
            {
              type: 'tool_call_end',
              toolCallId: data.call_id,
              toolName: data.name,
              toolCallInput: {}
            }
          ]
        }
      case 'response.completed': {
        const requestCompletedAt = Date.now()
        if (data.response?.usage?.output_tokens !== undefined) {
          outputTokens = data.response.usage.output_tokens ?? outputTokens
        }
        const rawInputTokens = data.response?.usage?.input_tokens ?? 0
        const cachedTokens = data.response?.usage?.input_tokens_details?.cached_tokens ?? 0
        return [
          {
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
                    ? {
                        reasoningTokens: data.response.usage.output_tokens_details.reasoning_tokens
                      }
                    : {})
                }
              : undefined,
            timing: {
              totalMs: requestCompletedAt - requestStartedAt,
              ttftMs: firstTokenAt ? firstTokenAt - requestStartedAt : undefined,
              tps: computeTps(outputTokens, firstTokenAt, requestCompletedAt)
            }
          }
        ]
      }
      case 'response.failed':
      case 'error': {
        const events: StreamEvent[] = []
        if (imageGenerationStarted) {
          imageGenerationStarted = false
          const message =
            getImageGenerationErrorMessage(data) ??
            (typeof data?.response?.status === 'string' && data.response.status.trim()
              ? data.response.status
              : 'Image generation failed')
          events.push({
            type: 'image_error',
            imageError: { code: 'api_error', message }
          })
        }
        events.push({ type: 'error', error: { type: 'api_error', message: JSON.stringify(data) } })
        return events
      }
      default:
        return []
    }
  }

  const streamHttpResponse = async function* (
    requestBody = fullBodyStr
  ): AsyncIterable<StreamEvent> {
    yield {
      type: 'request_debug',
      debugInfo: buildRequestDebugInfo(config, {
        url,
        method: 'POST',
        headers,
        body: requestBody,
        transport: 'http'
      })
    }
    const response = await sendFetchRequest(
      url,
      {
        method: 'POST',
        headers,
        body: requestBody,
        signal
      },
      config.allowInsecureTls ?? true,
      config.useSystemProxy ?? false
    )
    for await (const sse of parseSSEStream(response)) {
      if (!sse.data || sse.data === '[DONE]') continue
      let data: Parameters<typeof handleResponseEvent>[1] = null
      try {
        data = JSON.parse(sse.data) as Parameters<typeof handleResponseEvent>[1]
      } catch {
        continue
      }
      for (const event of handleResponseEvent(sse.event, data)) {
        yield event
      }
    }
  }

  const websocketConfig = resolveResponsesWebsocketConfig({
    providerType: config.type,
    websocketMode: config.websocketMode,
    websocketUrl: config.websocketUrl,
    baseUrl: url
  })
  const circuitReason = websocketConfig.websocketUrl
    ? responsesWsManager.getCircuitReason(
        config.providerId ?? config.providerBuiltinId ?? 'unknown',
        websocketConfig.websocketUrl
      )
    : null

  if (
    websocketConfig.mode === 'disabled' ||
    !websocketConfig.websocketUrl ||
    websocketConfig.source === 'invalid' ||
    circuitReason
  ) {
    yield* streamHttpResponse()
    return
  }

  const websocketUrl = websocketConfig.websocketUrl
  const connectionKey =
    !config.sessionId || !config.model
      ? null
      : `${config.providerId ?? config.providerBuiltinId ?? 'unknown'}::${config.model}::${config.sessionId}::${websocketUrl}`
  const queue: StreamEvent[] = []
  let resolveQueue: (() => void) | null = null
  let managerDone = false

  const pushEvent = (streamEvent: StreamEvent): void => {
    queue.push(streamEvent)
    if (resolveQueue) {
      resolveQueue()
      resolveQueue = null
    }
  }

  const waitForQueue = (): Promise<void> =>
    new Promise<void>((resolve) => {
      if (queue.length > 0 || managerDone) {
        resolve()
        return
      }
      resolveQueue = resolve
    })

  const wsPromise = responsesWsManager.executeRequest({
    providerKey: config.providerId ?? config.providerBuiltinId ?? 'unknown',
    sessionKey: connectionKey,
    websocketUrl,
    headers,
    httpBody: fullBodyStr,
    useSystemProxy: config.useSystemProxy ?? false,
    allowInsecureTls: config.allowInsecureTls ?? true,
    signal,
    label: config.sessionId ?? config.providerId ?? config.model,
    onDebug: (debugInfo) => {
      pushEvent({
        type: 'request_debug',
        debugInfo: buildRequestDebugInfo(config, {
          url: debugInfo.url,
          method: 'WEBSOCKET',
          headers: debugInfo.headers,
          body: debugInfo.body,
          contextWindowBody: debugInfo.contextWindowBody,
          transport: debugInfo.transport,
          fallbackReason: debugInfo.fallbackReason,
          reusedConnection: debugInfo.reusedConnection,
          websocketRequestKind: debugInfo.websocketRequestKind,
          websocketIncrementalReason: debugInfo.websocketIncrementalReason,
          previousResponseId: debugInfo.previousResponseId
        })
      })
    },
    onEvent: (eventType, payload) => {
      for (const event of handleResponseEvent(
        eventType,
        payload as Parameters<typeof handleResponseEvent>[1]
      )) {
        pushEvent(event)
      }
    }
  })

  void wsPromise.finally(() => {
    managerDone = true
    if (resolveQueue) {
      resolveQueue()
      resolveQueue = null
    }
  })

  while (!managerDone || queue.length > 0) {
    await waitForQueue()
    while (queue.length > 0) {
      yield queue.shift()!
    }
  }

  const wsResult = await wsPromise
  if (signal?.aborted) return
  if (wsResult.kind === 'streamed') return
  if (wsResult.kind === 'fallback') {
    yield* streamHttpResponse()
    return
  }
  throw new Error(wsResult.error)
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
): AsyncGenerator<InteractiveAgentEvent> {
  yield { type: 'loop_start' }
  const conversationMessages = [...messages]
  let iteration = 0
  const hasIterationLimit = Number.isFinite(config.maxIterations) && config.maxIterations > 0
  const buildLoopEndEvent = (
    reason: 'completed' | 'max_iterations' | 'aborted' | 'error'
  ): InteractiveAgentEvent => ({
    type: 'loop_end',
    reason,
    ...(config.captureFinalMessages ? { messages: [...conversationMessages] } : {})
  })
  while (!hasIterationLimit || iteration < config.maxIterations) {
    if (config.signal.aborted) {
      yield buildLoopEndEvent('aborted')
      return
    }

    if (config.messageQueue) {
      const injected = config.messageQueue.drain()
      for (const message of injected) {
        conversationMessages.push(message)
      }
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
            yield buildLoopEndEvent('aborted')
            return
          }
          switch (event.type) {
            case 'request_debug':
              if (event.debugInfo) {
                yield {
                  type: 'request_debug',
                  debugInfo: event.debugInfo
                }
              }
              break
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

              // Skip emitting partial input for Edit/large Write — the full content
              // is parsed once at tool_call_end. Avoids sending growing file content
              // through IPC on every delta (can be 50KB+ per event for large edits).
              if (targetToolName === 'Edit') {
                break
              }
              const newLen = nextArgs.length
              if (targetToolName === 'Write' && newLen > 200) {
                break
              }

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
              const requiresApproval =
                config.forceApproval === true
                  ? true
                  : await resolveToolRequiresApproval(endToolName, toolInput, toolCtx)
              const toolCall: ToolCallState = {
                id: toolUseBlock.id,
                name: endToolName,
                input: toolInput,
                status: requiresApproval ? 'pending_approval' : 'running',
                requiresApproval
              }
              toolCalls.push(toolCall)
              // Compact large Edit/Write inputs before sending through IPC to avoid
              // serializing full file contents (can be 100KB+) to the renderer.
              // Keep preview fields so the UI can still display edit summaries.
              const IPC_PREVIEW_CHARS = 800
              let ipcToolInput = toolInput
              if (
                (endToolName === 'Edit' || endToolName === 'Write') &&
                toolInput &&
                typeof toolInput === 'object'
              ) {
                const compact: Record<string, unknown> = {}
                if (toolInput.file_path !== undefined) compact.file_path = toolInput.file_path
                if (toolInput.path !== undefined) compact.path = toolInput.path
                if (toolInput.explanation !== undefined) compact.explanation = toolInput.explanation
                if (toolInput.replace_all !== undefined) compact.replace_all = toolInput.replace_all
                if (typeof toolInput.old_string === 'string') {
                  const s = toolInput.old_string as string
                  compact.old_string_chars = s.length
                  compact.old_string_preview = s.slice(0, IPC_PREVIEW_CHARS)
                  if (s.length > IPC_PREVIEW_CHARS) compact.old_string_truncated = true
                }
                if (typeof toolInput.new_string === 'string') {
                  const s = toolInput.new_string as string
                  compact.new_string_chars = s.length
                  compact.new_string_preview = s.slice(0, IPC_PREVIEW_CHARS)
                  if (s.length > IPC_PREVIEW_CHARS) compact.new_string_truncated = true
                }
                if (typeof toolInput.content === 'string') {
                  const s = toolInput.content as string
                  compact.content_chars = s.length
                  compact.content_preview = s.slice(0, IPC_PREVIEW_CHARS)
                  if (s.length > IPC_PREVIEW_CHARS) compact.content_truncated = true
                }
                compact._compacted = true
                ipcToolInput = compact
              }
              yield {
                type: 'tool_use_generated',
                toolUseBlock: {
                  id: toolUseBlock.id,
                  name: endToolName,
                  input: ipcToolInput,
                  ...(toolUseBlock.extraContent ? { extraContent: toolUseBlock.extraContent } : {})
                }
              }
              break
            }
            case 'image_generation_started':
              streamedContent = true
              yield { type: 'image_generation_started' }
              break
            case 'image_generation_partial':
              streamedContent = true
              if (event.imageBlock) {
                yield {
                  type: 'image_generation_partial',
                  imageBlock: event.imageBlock,
                  ...(typeof event.partialImageIndex === 'number'
                    ? { partialImageIndex: event.partialImageIndex }
                    : {})
                }
              }
              break
            case 'image_generated':
              streamedContent = true
              if (event.imageBlock) {
                assistantContentBlocks.push(event.imageBlock)
                yield { type: 'image_generated', imageBlock: event.imageBlock }
              }
              break
            case 'image_error':
              streamedContent = true
              if (event.imageError) {
                yield {
                  type: 'image_error',
                  imageError: event.imageError
                }
              }
              break
            case 'message_end':
              providerResponseId = event.providerResponseId
              yield {
                type: 'message_end',
                usage: event.usage,
                timing: event.timing,
                providerResponseId: event.providerResponseId
              }
              break
            case 'error': {
              const errorType = event.error?.type
              const statusFromType =
                typeof errorType === 'string'
                  ? Number(/^http_(\d{3})$/i.exec(errorType)?.[1] ?? Number.NaN)
                  : Number.NaN
              throw new ProviderRequestError(event.error?.message ?? 'Unknown API error', {
                type: errorType,
                ...(Number.isFinite(statusFromType) ? { statusCode: statusFromType } : {})
              })
            }
          }
        }
        if (toolArgsById.size > 0) {
          for (const [danglingToolId, argsText] of toolArgsById) {
            const danglingName = toolNamesById.get(danglingToolId) || currentToolName
            const danglingInput =
              parseToolInputSnapshot(argsText, danglingName) ?? safeParseJSON(argsText)
            const requiresApproval =
              config.forceApproval === true
                ? true
                : await resolveToolRequiresApproval(danglingName, danglingInput, toolCtx)
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
              status: requiresApproval ? 'pending_approval' : 'running',
              requiresApproval
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
          yield buildLoopEndEvent('aborted')
          return
        }
        const delay = getRetryDelay(err, sendAttempt, streamedContent)
        if (delay === null || sendAttempt === MAX_PROVIDER_RETRIES - 1) {
          yield { type: 'error', error: err instanceof Error ? err : new Error(String(err)) }
          yield buildLoopEndEvent('error')
          return
        }
        const statusCode = extractStatusCode(err)
        yield {
          type: 'request_retry',
          attempt: sendAttempt + 1,
          maxAttempts: MAX_PROVIDER_RETRIES - 1,
          delayMs: delay,
          ...(statusCode !== null ? { statusCode } : {}),
          reason: err instanceof Error ? err.message : String(err)
        }
        sendAttempt += 1
        try {
          await delayWithAbort(delay, config.signal)
        } catch {
          yield buildLoopEndEvent('aborted')
          return
        }
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
      yield buildLoopEndEvent('completed')
      return
    }
    const toolResults: ContentBlock[] = []
    for (const toolCall of toolCalls) {
      if (toolCall.requiresApproval && config.onApprovalNeeded) {
        yield {
          type: 'tool_call_approval_needed',
          toolCall: { ...toolCall }
        }
        const approved = await config.onApprovalNeeded(toolCall)
        if (!approved) {
          if (config.signal.aborted) {
            yield buildLoopEndEvent('aborted')
            return
          }
          const deniedAt = Date.now()
          const deniedOutput = encodeToolError('User denied permission')
          yield {
            type: 'tool_call_result',
            toolCall: {
              ...toolCall,
              status: 'error',
              output: deniedOutput,
              error: 'User denied permission',
              startedAt: deniedAt,
              completedAt: deniedAt
            }
          }
          toolResults.push({
            type: 'tool_result',
            toolUseId: toolCall.id,
            content: deniedOutput,
            isError: true
          })
          continue
        }
      }

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
      if (toolCall.name === 'Bash') {
        output = compactCronShellToolResultContent(output)
      }
      const completedAt = Date.now()
      const resultError = toolError ?? extractStructuredToolError(output)
      yield {
        type: 'tool_call_result',
        toolCall: {
          ...toolCall,
          status: resultError ? 'error' : 'completed',
          output,
          ...(resultError ? { error: resultError } : {}),
          startedAt,
          completedAt
        }
      }
      toolResults.push({
        type: 'tool_result',
        toolUseId: toolCall.id,
        content: output,
        ...(resultError ? { isError: true } : {})
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
  yield buildLoopEndEvent('max_iterations')
}

export { runAgentLoop as runInteractiveAgentLoop }

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
  const isWidgetTool = toolName === 'visualize_show_widget'
  const looseWriteInput = isWriteTool ? parseWriteInputLoosely(rawArgs) : null
  const looseWidgetInput = isWidgetTool ? parseWidgetInputLoosely(rawArgs) : null
  const looseInput = looseWidgetInput ?? looseWriteInput
  try {
    const parsed = parsePartialJSON(rawArgs, Allow.ALL)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const normalized = normalizeParsedToolInput(parsed as Record<string, unknown>)
      if (looseInput && Object.keys(looseInput).length > 0) {
        return { ...looseInput, ...normalized }
      }
      return normalized
    }
  } catch {
    // ignore
  }
  if (looseInput && Object.keys(looseInput).length > 0) {
    return looseInput
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

function parseWidgetInputLoosely(rawArgs: string): Record<string, unknown> | null {
  const title = readLooseJsonStringField(rawArgs, 'title')
  const widgetCode = readLooseJsonStringField(rawArgs, 'widget_code')
  const input: Record<string, unknown> = {}
  if (title !== null) input.title = title
  if (widgetCode !== null) input.widget_code = widgetCode
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

function extractErrorType(err: unknown): string | null {
  if (err instanceof ProviderRequestError && typeof err.errorType === 'string') {
    return err.errorType
  }
  if (
    err &&
    typeof err === 'object' &&
    'errorType' in err &&
    typeof (err as { errorType?: unknown }).errorType === 'string'
  ) {
    return (err as { errorType: string }).errorType
  }
  return null
}

function extractStatusCode(err: unknown): number | null {
  if (err instanceof ProviderRequestError && typeof err.statusCode === 'number') {
    return err.statusCode
  }
  if (
    err &&
    typeof err === 'object' &&
    'statusCode' in err &&
    typeof (err as { statusCode?: unknown }).statusCode === 'number'
  ) {
    return (err as { statusCode: number }).statusCode
  }
  const errorType = extractErrorType(err)
  if (errorType) {
    const typeMatch = /^http_(\d{3})$/i.exec(errorType)
    if (typeMatch) {
      const code = Number(typeMatch[1])
      return Number.isFinite(code) ? code : null
    }
  }
  const message = err instanceof Error ? err.message : String(err)
  const match = /HTTP\s+(\d{3})/i.exec(message)
  return match ? Number(match[1]) : null
}

function isCircuitOpenError(err: unknown): boolean {
  const errorType = extractErrorType(err)
  if (errorType === 'transport_circuit_open') return true
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return message.includes('circuit is open')
}

function isTransportFailure(err: unknown): boolean {
  const errorType = extractErrorType(err)
  if (errorType === 'transport_error' || errorType === 'transport_circuit_open') return true
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return (
    message.includes('response ended prematurely') ||
    message.includes('responseended') ||
    message.includes('unexpected eof') ||
    message.includes('socket hang up') ||
    message.includes('connection closed') ||
    message.includes('connection timeout') ||
    message.includes('request timed out') ||
    message.includes('stream idle timeout') ||
    message.includes('econnreset') ||
    message.includes('etimedout')
  )
}

function getRetryDelay(err: unknown, attempt: number, streamedContent: boolean): number | null {
  if (isCircuitOpenError(err)) return null
  const status = extractStatusCode(err)
  if (status === 429) return BASE_RETRY_DELAY_MS * Math.pow(2, attempt + 1)
  if (status && status >= 400 && status < 500) return null
  if (status && status >= 500) return BASE_RETRY_DELAY_MS * Math.pow(2, attempt)
  if (isTransportFailure(err) && !streamedContent) {
    return BASE_RETRY_DELAY_MS * Math.pow(2, attempt)
  }
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

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function resolveToolPath(inputPath: unknown, workingFolder?: string, isRemote = false): string {
  const raw = typeof inputPath === 'string' ? inputPath.trim() : ''
  const base = workingFolder?.trim()
  if (!raw || raw === '.') return base && base.length > 0 ? base : '.'
  if (isAbsolutePath(raw)) return raw
  if (base && base.length > 0) return isRemote ? path.posix.join(base, raw) : path.join(base, raw)
  return raw
}

async function sshExecForCron(
  connectionId: string,
  command: string,
  timeout = DEFAULT_BASH_TIMEOUT_MS
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const client = await getSshClientForGitExec(connectionId)
  if (!client) {
    return { exitCode: 1, stdout: '', stderr: `SSH connection unavailable: ${connectionId}` }
  }

  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ exitCode: 124, stdout: '', stderr: 'SSH exec timeout' })
    }, timeout)

    client.exec(command, (err, stream) => {
      if (err) {
        clearTimeout(timer)
        resolve({ exitCode: 1, stdout: '', stderr: err.message })
        return
      }

      let stdout = ''
      let stderr = ''
      stream.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
      })
      stream.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })
      stream.on('close', (code: number) => {
        clearTimeout(timer)
        resolve({ exitCode: code ?? 0, stdout, stderr })
      })
    })
  })
}

async function readTextForCron(ctx: ToolContext, filePath: string): Promise<string> {
  if (ctx.sshConnectionId) {
    const result = await sshExecForCron(ctx.sshConnectionId, `cat ${shellEscape(filePath)}`)
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `Remote read failed: ${filePath}`)
    }
    return result.stdout
  }
  return await fs.promises.readFile(filePath, 'utf8')
}

async function writeTextForCron(
  ctx: ToolContext,
  filePath: string,
  content: string
): Promise<void> {
  if (ctx.sshConnectionId) {
    const encoded = Buffer.from(content, 'utf8').toString('base64')
    const command =
      `mkdir -p ${shellEscape(path.posix.dirname(filePath))} && ` +
      `printf %s ${shellEscape(encoded)} | base64 -d > ${shellEscape(filePath)}`
    const result = await sshExecForCron(ctx.sshConnectionId, command)
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `Remote write failed: ${filePath}`)
    }
    return
  }
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
  await fs.promises.writeFile(filePath, content, 'utf8')
}

type EolStyle = '\n' | '\r\n' | null

function countOccurrences(content: string, value: string): number {
  if (!value) return 0
  return content.split(value).length - 1
}

function detectEolStyle(value: string): EolStyle {
  if (value.includes('\r\n')) return '\r\n'
  if (value.includes('\n')) return '\n'
  return null
}

function detectDominantEolStyle(value: string): EolStyle {
  let crlf = 0
  let lf = 0

  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '\r' && value[index + 1] === '\n') {
      crlf += 1
      index += 1
    } else if (value[index] === '\n') {
      lf += 1
    }
  }

  if (crlf === 0 && lf === 0) return null
  return crlf >= lf ? '\r\n' : '\n'
}

function normalizeToLf(value: string): string {
  return value.replace(/\r\n/g, '\n')
}

function applyEolStyle(value: string, style: EolStyle): string {
  if (!style) return value
  const normalized = normalizeToLf(value)
  return style === '\n' ? normalized : normalized.replace(/\n/g, '\r\n')
}

function buildOldStringVariants(
  oldStr: string,
  fileContent: string
): Array<{ text: string; eol: EolStyle }> {
  const variants: Array<{ text: string; eol: EolStyle }> = []
  const seen = new Set<string>()
  const addVariant = (text: string, eol: EolStyle): void => {
    if (seen.has(text)) return
    seen.add(text)
    variants.push({ text, eol })
  }

  addVariant(oldStr, detectEolStyle(oldStr))

  if (oldStr.includes('\n')) {
    const lfText = normalizeToLf(oldStr)
    addVariant(lfText, '\n')
    if (fileContent.includes('\r\n')) {
      addVariant(lfText.replace(/\n/g, '\r\n'), '\r\n')
    }
  }

  return variants
}

function getReplacementEolStyle(
  matchedOldString: { eol: EolStyle },
  fileContent: string
): EolStyle {
  return matchedOldString.eol ?? detectDominantEolStyle(fileContent)
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
      const resolvedPath = resolveToolPath(
        input.file_path,
        ctx.workingFolder,
        !!ctx.sshConnectionId
      )
      const content = await readTextForCron(ctx, resolvedPath)
      if (input.offset !== undefined || input.limit !== undefined) {
        const lines = content.split(/\r?\n/)
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
      const resolvedPath = resolveToolPath(
        input.file_path,
        ctx.workingFolder,
        !!ctx.sshConnectionId
      )
      const beforeExists = ctx.sshConnectionId
        ? (
            await sshExecForCron(
              ctx.sshConnectionId,
              `test -e ${shellEscape(resolvedPath)}`,
              15_000
            )
          ).exitCode === 0
        : await fs.promises
            .access(resolvedPath)
            .then(() => true)
            .catch(() => false)
      await writeTextForCron(ctx, resolvedPath, String(input.content ?? ''))
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
      const resolvedPath = resolveToolPath(
        input.file_path,
        ctx.workingFolder,
        !!ctx.sshConnectionId
      )
      const content = await readTextForCron(ctx, resolvedPath)
      const oldStr = String(input.old_string ?? '')
      const newStr = String(input.new_string ?? '')
      const replaceAll = Boolean(input.replace_all)
      if (!oldStr) {
        return encodeToolError('old_string is required')
      }
      if (oldStr === newStr) {
        return encodeToolError('new_string must be different from old_string')
      }

      const oldStringVariants = buildOldStringVariants(oldStr, content)
      const matchedVariant = oldStringVariants.find(
        (variant) => variant.text.length > 0 && content.includes(variant.text)
      )
      if (!matchedVariant) {
        return encodeToolError('old_string not found in file')
      }

      const occurrences = countOccurrences(content, matchedVariant.text)
      if (occurrences === 0) {
        return encodeToolError('old_string not found in file')
      }
      if (!replaceAll && occurrences > 1) {
        return encodeToolError('old_string is not unique in file')
      }

      const replacementText = applyEolStyle(newStr, getReplacementEolStyle(matchedVariant, content))
      const updated = replaceAll
        ? content.split(matchedVariant.text).join(replacementText)
        : content.replace(matchedVariant.text, replacementText)

      await writeTextForCron(ctx, resolvedPath, updated)
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
      const targetPath = resolveToolPath(
        input.path ?? '.',
        ctx.workingFolder,
        !!ctx.sshConnectionId
      )
      if (ctx.sshConnectionId) {
        const result = await sshExecForCron(
          ctx.sshConnectionId,
          `find ${shellEscape(targetPath)} -mindepth 1 -maxdepth 1 ` +
            `\\( -type f -o -type d \\) -printf '%f\\t%y\\t%p\\n' | head -1000`,
          60_000
        )
        if (result.exitCode !== 0) {
          return encodeToolError(result.stderr || `Remote LS failed: ${targetPath}`)
        }
        const ignore = Array.isArray(input.ignore)
          ? input.ignore.filter((item): item is string => typeof item === 'string')
          : []
        const items = result.stdout
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => {
            const [name, type, entryPath] = line.split('\t')
            return {
              name,
              type: type === 'd' ? 'directory' : 'file',
              path: entryPath
            }
          })
          .filter(
            (entry) => !ignore.some((pattern) => entry.name.includes(pattern.replace(/[*?]/g, '')))
          )
        return encodeStructuredToolResult(items)
      }
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
      description: 'Fast file pattern matching tool (returns at most 20 matches)',
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
      const cwd = resolveToolPath(input.path ?? '.', ctx.workingFolder, !!ctx.sshConnectionId)
      const pattern = String(input.pattern ?? '')
      if (ctx.sshConnectionId) {
        const nameOrPath = pattern.includes('/') ? '-path' : '-name'
        const remotePattern = pattern.includes('/')
          ? `./${pattern.startsWith('./') ? pattern.slice(2) : pattern}`
          : pattern
        const result = await sshExecForCron(
          ctx.sshConnectionId,
          `cd ${shellEscape(cwd)} && find . -type f ${nameOrPath} ${shellEscape(remotePattern)} -print | head -${CRON_SEARCH_MAX_RESULTS}`,
          60_000
        )
        if (result.exitCode !== 0) {
          return formatGlobToolResult({
            matches: [],
            error: result.stderr || `Remote glob failed: ${pattern}`
          })
        }
        const matches = result.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => path.posix.join(cwd, line.replace(/^\.\//, '')))
        const truncated = matches.length >= CRON_SEARCH_MAX_RESULTS
        return formatGlobToolResult({
          matches,
          truncated,
          limitReason: truncated ? 'max_results' : null,
          warnings: truncated
            ? buildCronSearchWarnings([
                `Cron glob reached the ${CRON_SEARCH_MAX_RESULTS} match limit`
              ])
            : []
        })
      }
      try {
        const matches = await glob(pattern, {
          cwd,
          nodir: true,
          absolute: true,
          dot: true,
          ignore: buildCronSearchIgnore(pattern)
        })
        return formatGlobToolResult({ matches })
      } catch (error) {
        return formatGlobToolResult({
          matches: [],
          error: normalizeCronSearchError(error)
        })
      }
    }
  }

  const grepHandler: ToolHandler = {
    definition: {
      name: 'Grep',
      description: 'Search file contents using regular expressions (returns at most 20 matches)',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern to search for' },
          path: { type: 'string', description: 'Directory to search in' },
          include: {
            type: 'string',
            description: 'Comma-separated file globs to include, e.g. *.ts'
          },
          exclude: { type: 'string', description: 'Comma-separated file globs to exclude' },
          caseSensitive: { type: 'boolean', description: 'Use case-sensitive matching' },
          smartCase: { type: 'boolean', description: 'Case-sensitive when pattern has uppercase' },
          literal: { type: 'boolean', description: 'Treat pattern as a literal string' },
          word: { type: 'boolean', description: 'Match whole words only' },
          line: { type: 'boolean', description: 'Match whole lines only' },
          invertMatch: { type: 'boolean', description: 'Return non-matching lines' },
          context: { type: 'number', description: 'Context lines before and after each match' },
          beforeContext: { type: 'number', description: 'Context lines before each match' },
          afterContext: { type: 'number', description: 'Context lines after each match' },
          maxResults: { type: 'number', description: 'Maximum result rows to return' },
          maxOutputBytes: { type: 'number', description: 'Maximum encoded result size' },
          maxLineLength: { type: 'number', description: 'Maximum text length per result line' },
          maxDepth: { type: 'number', description: 'Maximum directory depth to search' },
          hidden: { type: 'boolean', description: 'Include hidden files and directories' },
          respectGitignore: { type: 'boolean', description: 'Respect .gitignore when supported' },
          followSymlinks: { type: 'boolean', description: 'Follow symbolic links' },
          outputMode: {
            type: 'string',
            enum: ['matches', 'files_with_matches', 'count'],
            description: 'matches, files_with_matches, or count'
          },
          pathStyle: {
            type: 'string',
            enum: ['relative', 'absolute'],
            description: 'Return relative or absolute paths'
          }
        },
        required: ['pattern']
      }
    },
    execute: async (input, ctx) => {
      const searchRoot = resolveToolPath(
        input.path ?? '.',
        ctx.workingFolder,
        !!ctx.sshConnectionId
      )
      const options = normalizeCronGrepOptions(input)

      let regex: RegExp
      try {
        regex = buildCronGrepRegex(options)
      } catch (error) {
        return formatGrepToolResult({
          matches: [],
          error: `Invalid regex pattern: ${normalizeCronSearchError(error)}`,
          outputMode: options.outputMode,
          maxResults: options.maxResults,
          maxOutputBytes: options.maxOutputBytes
        })
      }

      try {
        if (ctx.sshConnectionId) {
          const hasRg =
            (await sshExecForCron(ctx.sshConnectionId, 'command -v rg >/dev/null 2>&1', 10_000))
              .exitCode === 0
          if (hasRg) {
            let cmd = `cd ${shellEscape(searchRoot)} && rg --line-number --color never --no-messages --max-filesize 10M`
            if (options.outputMode === 'matches') {
              cmd += ' --json'
              if (options.beforeContext > 0) cmd += ` --before-context ${options.beforeContext}`
              if (options.afterContext > 0) cmd += ` --after-context ${options.afterContext}`
            } else if (options.outputMode === 'files_with_matches') {
              cmd += ' --files-with-matches'
            } else {
              cmd += ' --count'
            }
            if (options.smartCase) cmd += ' --smart-case'
            else if (!options.caseSensitive) cmd += ' --ignore-case'
            if (options.literal) cmd += ' --fixed-strings'
            if (options.word) cmd += ' --word-regexp'
            if (options.line) cmd += ' --line-regexp'
            if (options.invertMatch) cmd += ' --invert-match'
            if (options.hidden) cmd += ' --hidden'
            if (!options.respectGitignore) cmd += ' --no-ignore'
            if (options.followSymlinks) cmd += ' --follow'
            if (options.maxDepth !== null) cmd += ` --max-depth ${options.maxDepth}`
            for (const includePattern of parseCronGlobList(options.include)) {
              cmd += ` --glob ${shellEscape(includePattern)}`
            }
            for (const excludePattern of parseCronGlobList(options.exclude)) {
              cmd += ` --glob ${shellEscape(`!${excludePattern}`)}`
            }
            const remoteLimit =
              options.outputMode === 'matches'
                ? Math.max(
                    options.maxResults *
                      Math.max(8, options.beforeContext + options.afterContext + 4),
                    options.maxResults + 100
                  )
                : options.maxResults
            cmd += ` ${shellEscape(options.pattern)} . 2>/dev/null | head -${remoteLimit}`

            const result = await sshExecForCron(ctx.sshConnectionId, cmd, 60_000)
            if (result.exitCode !== 0 && result.exitCode !== 1) {
              return formatGrepToolResult({
                matches: [],
                error: result.stderr || `Remote grep failed: ${options.pattern}`,
                outputMode: options.outputMode,
                maxResults: options.maxResults,
                maxOutputBytes: options.maxOutputBytes
              })
            }

            const matches: Array<{
              file: string
              line?: number
              text?: string
              kind?: GrepMatchKind
              count?: number
            }> = []
            for (const rawLine of result.stdout.split(/\r?\n/).filter(Boolean)) {
              if (options.outputMode === 'files_with_matches') {
                matches.push({
                  file: formatCronRemoteGrepPath(searchRoot, rawLine.trim(), options.pathStyle)
                })
                continue
              }
              if (options.outputMode === 'count') {
                const countMatch = rawLine.match(/^(.*?):(\d+)$/)
                if (!countMatch) continue
                const count = Number(countMatch[2])
                if (count > 0) {
                  matches.push({
                    file: formatCronRemoteGrepPath(searchRoot, countMatch[1], options.pathStyle),
                    count
                  })
                }
                continue
              }
              try {
                const parsed = JSON.parse(rawLine) as {
                  type?: string
                  data?: {
                    path?: { text?: string }
                    lines?: { text?: string }
                    line_number?: number
                  }
                }
                if (parsed.type !== 'match' && parsed.type !== 'context') continue
                const rawPath = parsed.data?.path?.text
                const lineNumber = parsed.data?.line_number
                if (typeof rawPath !== 'string' || typeof lineNumber !== 'number') continue
                matches.push({
                  file: formatCronRemoteGrepPath(searchRoot, rawPath, options.pathStyle),
                  line: lineNumber,
                  text: normalizeCronGrepText(
                    parsed.data?.lines?.text ?? '',
                    options.maxLineLength
                  ),
                  kind: parsed.type as GrepMatchKind
                })
              } catch {
                continue
              }
            }
            const truncated = matches.length >= options.maxResults
            return formatGrepToolResult({
              matches,
              truncated,
              limitReason: truncated ? 'max_results' : null,
              warnings: truncated
                ? buildCronSearchWarnings([
                    `Cron grep reached the ${options.maxResults} match limit`
                  ])
                : [],
              outputMode: options.outputMode,
              maxResults: options.maxResults,
              maxOutputBytes: options.maxOutputBytes
            })
          }

          const fallbackWarnings = buildCronSearchWarnings([
            options.respectGitignore
              ? 'Cron SSH grep fallback does not support gitignore semantics'
              : null,
            options.smartCase ? 'Cron SSH grep fallback does not support smartCase' : null,
            options.maxDepth !== null ? 'Cron SSH grep fallback does not support maxDepth' : null,
            !options.hidden ? 'Cron SSH grep fallback does not support hidden=false' : null
          ])
          const grepHelp = await sshExecForCron(ctx.sshConnectionId, 'grep --help 2>&1', 10_000)
          const grepHelpText = `${grepHelp.stdout}\n${grepHelp.stderr}`
          if (!grepHelpText.includes('--include') || !grepHelpText.includes('--exclude-dir')) {
            return formatGrepToolResult({
              matches: [],
              error:
                'Remote grep fallback requires ripgrep or GNU grep-style --include/--exclude-dir support',
              warnings: buildCronSearchWarnings([
                ...fallbackWarnings,
                'Install ripgrep on the remote host for full Cron SSH Grep support'
              ]),
              outputMode: options.outputMode,
              maxResults: options.maxResults,
              maxOutputBytes: options.maxOutputBytes
            })
          }
          const fallbackIncludeArgs = parseCronGlobList(options.include)
            .map((includePattern) => ` --include=${shellEscape(includePattern)}`)
            .join('')
          const fallbackExcludeArgs = parseCronGlobList(options.exclude)
            .map((excludePattern) => ` --exclude=${shellEscape(excludePattern)}`)
            .join('')
          const result = await sshExecForCron(
            ctx.sshConnectionId,
            `cd ${shellEscape(searchRoot)} && grep -Rsn${options.caseSensitive ? '' : ' -i'}${options.literal ? ' -F' : ''}${options.word ? ' -w' : ''}${options.line ? ' -x' : ''}${options.invertMatch ? ' -v' : ''}${options.outputMode === 'files_with_matches' ? ' -l' : ''}${options.outputMode === 'count' ? ' -c' : ''}${options.beforeContext > 0 ? ` -B ${options.beforeContext}` : ''}${options.afterContext > 0 ? ` -A ${options.afterContext}` : ''}${fallbackIncludeArgs}${fallbackExcludeArgs} ${shellEscape(options.pattern)} . 2>/dev/null | head -${options.maxResults}`,
            60_000
          )
          if (result.exitCode !== 0 && result.exitCode !== 1) {
            return formatGrepToolResult({
              matches: [],
              error: result.stderr || `Remote grep failed: ${options.pattern}`,
              warnings: fallbackWarnings,
              outputMode: options.outputMode,
              maxResults: options.maxResults,
              maxOutputBytes: options.maxOutputBytes
            })
          }
          const matches: Array<{
            file: string
            line?: number
            text?: string
            kind?: GrepMatchKind
            count?: number
          }> = []
          for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
            if (options.outputMode === 'files_with_matches') {
              matches.push({
                file: formatCronRemoteGrepPath(searchRoot, line, options.pathStyle)
              })
              continue
            }
            if (options.outputMode === 'count') {
              const countMatch = line.match(/^(.+?):(\d+)$/)
              if (!countMatch) continue
              const count = Number(countMatch[2])
              if (count <= 0) continue
              matches.push({
                file: formatCronRemoteGrepPath(searchRoot, countMatch[1], options.pathStyle),
                count
              })
              continue
            }
            const match = line.match(/^(.+?):(\d+):(.*)$/)
            if (!match) continue
            matches.push({
              file: formatCronRemoteGrepPath(searchRoot, match[1], options.pathStyle),
              line: Number(match[2]),
              text: normalizeCronGrepText(match[3], options.maxLineLength),
              kind: 'match'
            })
          }
          const truncated = matches.length >= options.maxResults
          return formatGrepToolResult({
            matches,
            truncated,
            limitReason: truncated ? 'max_results' : null,
            warnings: buildCronSearchWarnings([
              ...fallbackWarnings,
              truncated ? `Cron grep reached the ${options.maxResults} match limit` : null
            ]),
            outputMode: options.outputMode,
            maxResults: options.maxResults,
            maxOutputBytes: options.maxOutputBytes
          })
        }

        const ripgrepResult = await runCronLocalRipgrepSearch(searchRoot, options)
        if (ripgrepResult) {
          return formatGrepToolResult({
            matches: ripgrepResult.matches,
            truncated: ripgrepResult.truncated,
            timedOut: ripgrepResult.timedOut,
            limitReason: ripgrepResult.limitReason,
            warnings: ripgrepResult.truncated
              ? buildCronSearchWarnings([
                  ripgrepResult.timedOut
                    ? 'Cron grep timed out'
                    : `Cron grep reached the ${options.maxResults} match limit`
                ])
              : [],
            outputMode: options.outputMode,
            maxResults: options.maxResults,
            maxOutputBytes: options.maxOutputBytes
          })
        }

        const includePatterns = parseCronGlobList(options.include)
        const files = await glob(includePatterns.length > 0 ? includePatterns : '**/*', {
          cwd: searchRoot,
          nodir: true,
          absolute: true,
          dot: true,
          ignore: [
            ...buildCronSearchIgnore(options.include),
            ...parseCronGlobList(options.exclude)
          ],
          follow: options.followSymlinks
        })
        const results: Array<{
          file: string
          line?: number
          text?: string
          kind?: GrepMatchKind
          count?: number
        }> = []
        for (const file of files) {
          if (!options.hidden && file.split(/[\\/]+/).some((part) => part.startsWith('.'))) continue
          if (options.maxDepth !== null) {
            const depth = path.relative(searchRoot, file).split(/[\\/]+/).length - 1
            if (depth > options.maxDepth) continue
          }
          if (!(await isNonEmptyTextFile(file))) continue

          let content = ''
          try {
            content = await fs.promises.readFile(file, 'utf8')
          } catch {
            continue
          }
          const lines = content.split(/\r?\n/)
          let matchedCount = 0
          let afterContextRemaining = 0
          const beforeBuffer: Array<{ line: number; text: string }> = []
          const emittedContext = new Set<number>()
          for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index]
            let matches = regex.test(line)
            if (options.invertMatch) matches = !matches
            if (matches) {
              matchedCount += 1
              if (options.outputMode === 'files_with_matches') {
                results.push({ file: formatCronGrepPath(searchRoot, file, options.pathStyle) })
                break
              }
              if (options.outputMode === 'matches') {
                for (const contextLine of beforeBuffer) {
                  if (!emittedContext.has(contextLine.line)) {
                    emittedContext.add(contextLine.line)
                    results.push({
                      file: formatCronGrepPath(searchRoot, file, options.pathStyle),
                      line: contextLine.line,
                      text: normalizeCronGrepText(contextLine.text, options.maxLineLength),
                      kind: 'context'
                    })
                  }
                }
                results.push({
                  file: formatCronGrepPath(searchRoot, file, options.pathStyle),
                  line: index + 1,
                  text: normalizeCronGrepText(line, options.maxLineLength),
                  kind: 'match'
                })
                afterContextRemaining = options.afterContext
              }
            } else if (afterContextRemaining > 0 && options.outputMode === 'matches') {
              results.push({
                file: formatCronGrepPath(searchRoot, file, options.pathStyle),
                line: index + 1,
                text: normalizeCronGrepText(line, options.maxLineLength),
                kind: 'context'
              })
              afterContextRemaining -= 1
            }
            if (options.beforeContext > 0) {
              beforeBuffer.push({ line: index + 1, text: line })
              if (beforeBuffer.length > options.beforeContext) beforeBuffer.shift()
            }
            if (results.length >= options.maxResults) {
              return formatGrepToolResult({
                matches: results,
                truncated: true,
                limitReason: 'max_results',
                warnings: buildCronSearchWarnings([
                  `Cron grep reached the ${options.maxResults} match limit`,
                  options.respectGitignore
                    ? 'Cron local grep applies default ignores but not full .gitignore semantics'
                    : null
                ]),
                outputMode: options.outputMode,
                maxResults: options.maxResults,
                maxOutputBytes: options.maxOutputBytes
              })
            }
          }
          if (options.outputMode === 'count' && matchedCount > 0) {
            results.push({
              file: formatCronGrepPath(searchRoot, file, options.pathStyle),
              count: matchedCount
            })
          }
        }
        return formatGrepToolResult({
          matches: results,
          warnings: options.respectGitignore
            ? ['Cron local grep applies default ignores but not full .gitignore semantics']
            : [],
          outputMode: options.outputMode,
          maxResults: options.maxResults,
          maxOutputBytes: options.maxOutputBytes
        })
      } catch (error) {
        return formatGrepToolResult({
          matches: [],
          error: normalizeCronSearchError(error),
          outputMode: options.outputMode,
          maxResults: options.maxResults,
          maxOutputBytes: options.maxOutputBytes
        })
      }
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
      if (!command) return encodeShellToolResult({ exitCode: 1, stderr: 'Missing command' })
      const timeout = Number(input.timeout ?? DEFAULT_BASH_TIMEOUT_MS)
      if (ctx.sshConnectionId) {
        const remoteCommand = ctx.workingFolder
          ? `cd ${shellEscape(ctx.workingFolder)} && ${command}`
          : command
        return encodeShellToolResult(
          await sshExecForCron(ctx.sshConnectionId, remoteCommand, timeout)
        )
      }
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
            encodeShellToolResult({
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
          resolve(encodeShellToolResult({ exitCode: 1, stdout, stderr: err.message || stderr }))
        })
        child.on('exit', (code) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(encodeShellToolResult({ exitCode: code ?? 0, stdout, stderr }))
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
              encodeShellToolResult({
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

  const submitReportHandler: ToolHandler = {
    definition: {
      name: SUBMIT_REPORT_TOOL_NAME,
      description: 'Submit the final report and end this sub-agent session.',
      inputSchema: {
        type: 'object',
        properties: {
          report: { type: 'string', description: 'The complete final report body' }
        },
        required: ['report']
      }
    },
    execute: async (input) => {
      const report = typeof input.report === 'string' ? input.report.trim() : ''
      if (!report) {
        return encodeToolError('SubmitReport rejected: report is required')
      }
      return 'Report submitted. This sub-agent session will now terminate.'
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
    PluginReplyMessage: pluginReplyMessageHandler,
    [SUBMIT_REPORT_TOOL_NAME]: submitReportHandler
  }
}

const toolHandlers = buildToolHandlers()

function getToolHandler(name: string): ToolHandler | undefined {
  return toolHandlers[name]
}

async function resolveToolRequiresApproval(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext
): Promise<boolean> {
  const localHandler = getToolHandler(name)

  if (localHandler) {
    return localHandler.requiresApproval?.(input, ctx) ?? false
  }

  if (ctx.resolveRequiresApproval) {
    try {
      return await ctx.resolveRequiresApproval(name, input, ctx)
    } catch {
      // fall through to unknown-tool default behavior
    }
  }

  return true
}

function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResultContent> {
  const handler = getToolHandler(name)
  if (handler) {
    return handler.execute(input, ctx)
  }

  if (ctx.fallbackToolExecutor) {
    return ctx.fallbackToolExecutor(name, input, ctx).then((result) => {
      if (result.isError) {
        return encodeToolError(result.error || 'Renderer tool execution failed')
      }
      return result.content
    })
  }

  return Promise.resolve(encodeToolError(`Unknown tool: ${name}`))
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
  const nextSortOrder =
    ((
      db
        .prepare('SELECT MAX(sort_order) AS value FROM cron_run_logs WHERE run_id = ?')
        .get(runId) as { value?: number | null }
    )?.value ?? -1) + 1
  db.prepare(
    'INSERT INTO cron_run_logs (id, run_id, timestamp, type, content, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(`log-${nanoid(8)}`, runId, timestamp, type, content, nextSortOrder)
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

function loadJobSnapshot(
  jobId: string,
  scheduled: boolean
): {
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
    scheduled,
    executing: false,
    executionStartedAt: null,
    executionProgress: null
  }
}

function emitRunFinished(payload: CronRunFinishedPayload): void {
  const run = loadRunSnapshot(payload.runId)
  const job = loadJobSnapshot(payload.jobId, Boolean(payload.scheduled))
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
      error,
      scheduled: getScheduledState?.() ?? false
    })
    return
  }

  const innerProvider: ProviderConfig = {
    ...providerConfig,
    systemPrompt: definition.systemPrompt,
    model: modelOverride || definition.model || providerConfig.model,
    temperature: definition.temperature ?? providerConfig.temperature,
    sessionId: sessionId ?? jobId
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
    sshConnectionId: sshConnectionId ?? undefined,
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
    scheduled: getScheduledState?.() ?? false,
    ...(error ? { error } : {})
  })
}
