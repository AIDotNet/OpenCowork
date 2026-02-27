// ===== Unified API Type System =====

// --- Token Usage ---

export interface RequestTiming {
  /** Total request duration in milliseconds (request start → message_end). */
  totalMs: number
  /** Time to first token in milliseconds (request start → first streamed content). */
  ttftMs?: number
  /** Output tokens per second, calculated from streamed output. */
  tps?: number
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  /** Anthropic prompt caching: tokens written to cache */
  cacheCreationTokens?: number
  /** Anthropic prompt caching: tokens read from cache */
  cacheReadTokens?: number
  /** Reasoning model (o3/o4-mini etc.) internal thinking tokens */
  reasoningTokens?: number
  /** Last API call's input tokens — represents current context window usage (not accumulated) */
  contextTokens?: number
  /** Total wall time for the full agent run (including tools), in ms. */
  totalDurationMs?: number
  /** Per-request timing metrics for each API call in the loop. */
  requestTimings?: RequestTiming[]
}

// --- Content Blocks ---

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ImageBlock {
  type: 'image'
  source: { type: 'base64' | 'url'; mediaType?: string; data?: string; url?: string }
}

export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export type ToolResultContent = string | Array<TextBlock | ImageBlock>

export interface ToolResultBlock {
  type: 'tool_result'
  toolUseId: string
  content: ToolResultContent
  isError?: boolean
}

export interface ThinkingBlock {
  type: 'thinking'
  thinking: string
  /** Provider-issued encrypted/signature payload for reasoning continuity validation */
  encryptedContent?: string
  /** Which provider emitted encryptedContent (used to replay only to compatible APIs) */
  encryptedContentProvider?: 'anthropic' | 'openai-responses'
  startedAt?: number
  completedAt?: number
}

export type ContentBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock

// --- Messages ---

export interface RequestDebugInfo {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
  timestamp: number
}

export interface UnifiedMessage {
  id: string
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentBlock[]
  createdAt: number
  usage?: TokenUsage
  debugInfo?: RequestDebugInfo
  /** Optional source marker for non-manual message insertion paths. */
  source?: 'team' | 'queued'
}

// --- Streaming Events ---

export type StreamEventType =
  | 'message_start'
  | 'text_delta'
  | 'thinking_delta'
  | 'thinking_encrypted'
  | 'tool_call_start'
  | 'tool_call_delta'
  | 'tool_call_end'
  | 'message_end'
  | 'error'
  | 'request_debug'

export interface StreamEvent {
  type: StreamEventType
  text?: string
  thinking?: string
  thinkingEncryptedContent?: string
  thinkingEncryptedProvider?: 'anthropic' | 'openai-responses'
  toolCallId?: string
  toolName?: string
  argumentsDelta?: string
  toolCallInput?: Record<string, unknown>
  stopReason?: string
  usage?: TokenUsage
  timing?: RequestTiming
  error?: { type: string; message: string }
  debugInfo?: RequestDebugInfo
}

// --- Tool Definitions ---

export interface ToolDefinition {
  name: string
  description: string
  inputSchema:
    | {
        type: 'object'
        properties: Record<string, unknown>
        required?: string[]
      }
    | {
        type: 'object'
        oneOf: Array<{
          type: 'object'
          properties: Record<string, unknown>
          required?: string[]
          additionalProperties?: boolean
        }>
      }
}

// --- Thinking / Reasoning Config ---

export type ReasoningEffortLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

export interface ThinkingConfig {
  /** Extra key-value pairs merged into the request body when thinking is enabled */
  bodyParams: Record<string, unknown>
  /** Extra key-value pairs merged into the request body when thinking is explicitly disabled (e.g. MiMo: thinking.type="disabled") */
  disabledBodyParams?: Record<string, unknown>
  /** Force-override temperature when thinking is active (e.g. Anthropic requires 1) */
  forceTemperature?: number
  /**
   * Available reasoning effort levels for this model.
   * When set, the UI shows a level selector instead of a simple toggle.
   * The bodyParams should use a placeholder that gets replaced at runtime.
   */
  reasoningEffortLevels?: ReasoningEffortLevel[]
  /** Default reasoning effort level when thinking is first enabled */
  defaultReasoningEffort?: ReasoningEffortLevel
}

// --- AI Provider Management ---

export type ProviderType = 'anthropic' | 'openai-chat' | 'openai-responses'
export type ResponseSummary = 'auto' | 'concise' | 'detailed'

export type AuthMode = 'apiKey' | 'oauth' | 'channel'

export interface OAuthConfig {
  authorizeUrl: string
  tokenUrl: string
  clientId: string
  clientIdLocked?: boolean
  scope?: string
  /** Use system proxy for OAuth token exchanges */
  useSystemProxy?: boolean
  includeScopeInTokenRequest?: boolean
  tokenRequestMode?: 'form' | 'json'
  tokenRequestHeaders?: Record<string, string>
  refreshRequestMode?: 'form' | 'json'
  refreshRequestHeaders?: Record<string, string>
  refreshScope?: string
  redirectPath?: string
  redirectPort?: number
  extraParams?: Record<string, string>
  usePkce?: boolean
}

export interface OAuthToken {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  scope?: string
  tokenType?: string
  accountId?: string
}

export interface ChannelConfig {
  vcodeUrl: string
  tokenUrl: string
  userUrl: string
  defaultChannelType?: 'sms' | 'email'
  requiresAppToken?: boolean
  defaultAppId?: string
  appIdLocked?: boolean
}

export interface ChannelAuth {
  appId: string
  appToken?: string
  accessToken?: string
  accessTokenExpiresAt?: number
  channelType?: 'sms' | 'email'
  userInfo?: Record<string, unknown>
}

export type ModelCategory = 'chat' | 'speech' | 'embedding' | 'image'

export interface AIModelConfig {
  id: string
  name: string
  enabled: boolean
  /** Optional protocol override for this model; falls back to provider.type when omitted */
  type?: ProviderType
  /** How this model should be used (chat, speech, embedding, image) */
  category?: ModelCategory
  /** Icon key for model-level icon (e.g. 'openai', 'claude', 'gemini', 'deepseek') */
  icon?: string
  contextLength?: number
  maxOutputTokens?: number
  /** Price per million input tokens (USD) */
  inputPrice?: number
  /** Price per million output tokens (USD) */
  outputPrice?: number
  /** Price per million tokens for cache creation/write (USD) */
  cacheCreationPrice?: number
  /** Price per million tokens for cache hit/read (USD) */
  cacheHitPrice?: number
  /** Whether the model supports image/vision input */
  supportsVision?: boolean
  /** Whether the model supports function/tool calling */
  supportsFunctionCall?: boolean
  /** Whether the model supports toggleable thinking/reasoning mode */
  supportsThinking?: boolean
  /** Configuration describing how to enable thinking for this model */
  thinkingConfig?: ThinkingConfig
  /** OpenAI Responses: summary of reasoning (auto/concise/detailed) */
  responseSummary?: ResponseSummary
  /** OpenAI Responses: enable prompt caching with session-based key */
  enablePromptCache?: boolean
  /** Anthropic: enable system prompt caching */
  enableSystemPromptCache?: boolean
}

export interface RequestOverrides {
  /** Extra headers to include with API requests */
  headers?: Record<string, string>
  /** Body key-value overrides merged into the request body */
  body?: Record<string, unknown>
  /** Body keys to omit from the final payload */
  omitBodyKeys?: string[]
}

export interface ProviderUiConfig {
  /** Hide OAuth settings fields and related hints in the UI */
  hideOAuthSettings?: boolean
}

export interface AIProvider {
  id: string
  name: string
  type: ProviderType
  apiKey: string
  baseUrl: string
  enabled: boolean
  models: AIModelConfig[]
  builtinId?: string
  createdAt: number
  /** Whether this provider requires an API key. Defaults to true when omitted. */
  requiresApiKey?: boolean
  /** Whether to route API requests via the system proxy */
  useSystemProxy?: boolean
  /** Custom User-Agent header (e.g. Moonshot套餐 requires 'RooCode/3.48.0') */
  userAgent?: string
  /** Default model ID to use when this provider is first selected */
  defaultModel?: string
  /** Authentication mode for this provider */
  authMode?: AuthMode
  /** OAuth token payload (if authMode === 'oauth') */
  oauth?: OAuthToken
  /** OAuth configuration for this provider */
  oauthConfig?: OAuthConfig
  /** Channel auth data (if authMode === 'channel') */
  channel?: ChannelAuth
  /** Channel auth configuration */
  channelConfig?: ChannelConfig
  /** Optional request overrides (headers/body) for this provider */
  requestOverrides?: RequestOverrides
  /** Optional prompt name to use for Responses instructions */
  instructionsPrompt?: string
  /** Optional UI configuration for this provider */
  ui?: ProviderUiConfig
}

// --- Provider Config ---

export interface ProviderConfig {
  type: ProviderType
  apiKey: string
  baseUrl?: string
  model: string
  /** Provider ID (used for quota tracking and UI bindings) */
  providerId?: string
  /** Built-in provider ID (for preset-based mapping) */
  providerBuiltinId?: string
  maxTokens?: number
  temperature?: number
  systemPrompt?: string
  /** Whether this provider actually needs an API key */
  requiresApiKey?: boolean
  /** Whether to route API requests via the system proxy */
  useSystemProxy?: boolean
  /** Whether thinking mode is enabled for this request */
  thinkingEnabled?: boolean
  /** Thinking configuration from the active model */
  thinkingConfig?: ThinkingConfig
  /** Selected reasoning effort level (when model supports reasoningEffortLevels) */
  reasoningEffort?: ReasoningEffortLevel
  /** Current session ID — used for prompt_cache_key on OpenAI endpoints */
  sessionId?: string
  /** OpenAI Responses: summary of reasoning (auto/concise/detailed) */
  responseSummary?: ResponseSummary
  /** OpenAI Responses: enable prompt caching with session-based key */
  enablePromptCache?: boolean
  /** Anthropic: enable system prompt caching */
  enableSystemPromptCache?: boolean
  /** Custom User-Agent header (e.g. Moonshot套餐 requires 'RooCode/3.48.0') */
  userAgent?: string
  /** Optional request overrides (headers/body) for this request */
  requestOverrides?: RequestOverrides
  /** Optional prompt name to use for Responses instructions */
  instructionsPrompt?: string
}

// --- Provider Interface ---

export interface APIProvider {
  readonly name: string
  readonly type: ProviderType

  sendMessage(
    messages: UnifiedMessage[],
    tools: ToolDefinition[],
    config: ProviderConfig,
    signal?: AbortSignal
  ): AsyncIterable<StreamEvent>

  formatMessages(messages: UnifiedMessage[]): unknown
  formatTools(tools: ToolDefinition[]): unknown
}
