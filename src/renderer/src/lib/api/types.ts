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
  /** Normalized non-cached input tokens used for pricing/display when available. */
  billableInputTokens?: number
  /** Anthropic prompt caching: tokens written to cache */
  cacheCreationTokens?: number
  /** Anthropic prompt caching: tokens written to 5m cache */
  cacheCreation5mTokens?: number
  /** Anthropic prompt caching: tokens written to 1h cache */
  cacheCreation1hTokens?: number
  /** Anthropic prompt caching: tokens read from cache */
  cacheReadTokens?: number
  /** Reasoning model (o3/o4-mini etc.) internal thinking tokens */
  reasoningTokens?: number
  /** Last API call's input tokens — represents current context window usage (not accumulated) */
  contextTokens?: number
  /** Effective context limit used for compression/runtime budgeting on this request */
  contextLength?: number
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
  source: {
    type: 'base64' | 'url'
    mediaType?: string
    data?: string
    url?: string
    filePath?: string
  }
}

export type ImageErrorCode = 'timeout' | 'network' | 'request_aborted' | 'api_error' | 'unknown'

export interface ImageErrorBlock {
  type: 'image_error'
  code: ImageErrorCode
  message: string
}

export type AgentErrorCode = 'runtime_error' | 'tool_error' | 'unknown'

export interface AgentErrorBlock {
  type: 'agent_error'
  code: AgentErrorCode
  message: string
  errorType?: string
  details?: string
  stackTrace?: string
}

export type OpenAIComputerActionType =
  | 'click'
  | 'double_click'
  | 'scroll'
  | 'keypress'
  | 'type'
  | 'wait'
  | 'screenshot'

export interface ToolCallExtraContent {
  google?: {
    thought_signature?: string
  }
  openaiResponses?: {
    computerUse?: {
      kind: 'computer_use'
      computerCallId: string
      computerActionType: OpenAIComputerActionType
      computerActionIndex: number
      autoAddedScreenshot?: boolean
    }
  }
}

export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
  extraContent?: ToolCallExtraContent
}

/**
 * Placeholder stored in a persisted Write/Edit tool_use input field when the
 * original string was too large to keep resident in renderer memory. The full
 * payload is still present in the SQLite message row and can be rehydrated on
 * demand (see loadRequestContextMessages in chat-store.ts).
 */
export interface ElidedToolInput {
  __elided: true
  bytes: number
}

export function isElidedToolInput(value: unknown): value is ElidedToolInput {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __elided?: unknown }).__elided === true
  )
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
  encryptedContentProvider?: 'anthropic' | 'openai-responses' | 'google'
  startedAt?: number
  completedAt?: number
}

export type ContentBlock =
  | TextBlock
  | ImageBlock
  | ImageErrorBlock
  | AgentErrorBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock

// --- Messages ---

export interface RequestDebugInfo {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
  timestamp: number
  providerId?: string
  providerBuiltinId?: string
  model?: string
  executionPath?: 'node' | 'sidecar'
  transport?: 'http' | 'websocket'
  fallbackReason?: string
  reusedConnection?: boolean
  websocketRequestKind?: 'warmup' | 'full' | 'incremental'
  websocketIncrementalReason?: string
  previousResponseId?: string
}

export interface UnifiedMessage {
  id: string
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentBlock[]
  createdAt: number
  usage?: TokenUsage
  debugInfo?: RequestDebugInfo
  /** Provider-native response ID for follow-up requests such as OpenAI Responses previous_response_id. */
  providerResponseId?: string
  /** Optional source marker for non-manual message insertion paths. */
  source?: 'team' | 'queued'
  /**
   * Monotonic counter bumped by the chat-store every time the message is mutated.
   * Used by React.memo equality checks to skip expensive deep content scans.
   * Not persisted to the database.
   */
  _revision?: number
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
  | 'image_generated'
  | 'image_error'
  | 'message_end'
  | 'error'
  | 'request_debug'

export interface StreamEvent {
  type: StreamEventType
  text?: string
  thinking?: string
  thinkingEncryptedContent?: string
  thinkingEncryptedProvider?: 'anthropic' | 'openai-responses' | 'google'
  toolCallId?: string
  toolName?: string
  argumentsDelta?: string
  toolCallInput?: Record<string, unknown>
  toolCallExtraContent?: ToolCallExtraContent
  imageBlock?: ImageBlock
  imageError?: { code: ImageErrorCode; message: string }
  stopReason?: string
  usage?: TokenUsage
  timing?: RequestTiming
  providerResponseId?: string
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
        additionalProperties?: boolean
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

export type ReasoningEffortLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'max' | 'xhigh'

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

export type ProviderType =
  | 'anthropic'
  | 'openai-chat'
  | 'openai-responses'
  | 'openai-images'
  | 'gemini'
  | 'vertex-ai'
export type ResponseSummary = 'auto' | 'concise' | 'detailed'

export type AuthMode = 'apiKey' | 'oauth' | 'channel'
export type OAuthFlowType = 'authorization_code' | 'device_code'
export type OAuthRequestMode = 'form' | 'json'

export interface OAuthConfig {
  authorizeUrl: string
  tokenUrl: string
  clientId: string
  clientIdLocked?: boolean
  scope?: string
  flowType?: OAuthFlowType
  /** Base GitHub / OAuth host, used to derive endpoints when individual URLs are not overridden */
  host?: string
  /** API host used for token exchange endpoints (e.g. https://api.github.com or GHE api/v3) */
  apiHost?: string
  /** Device code endpoint for OAuth device flow */
  deviceCodeUrl?: string
  /** Copilot / provider-specific token exchange endpoint used after OAuth login */
  tokenExchangeUrl?: string
  /** Use system proxy for OAuth token exchanges */
  useSystemProxy?: boolean
  includeScopeInTokenRequest?: boolean
  tokenRequestMode?: OAuthRequestMode
  tokenRequestHeaders?: Record<string, string>
  refreshRequestMode?: OAuthRequestMode
  refreshRequestHeaders?: Record<string, string>
  refreshScope?: string
  deviceCodeRequestMode?: OAuthRequestMode
  deviceCodeRequestHeaders?: Record<string, string>
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
  idToken?: string
  deviceId?: string
  copilotAccessToken?: string
  copilotTokenType?: string
  copilotExpiresAt?: number
  copilotRefreshAt?: number
  copilotApiUrl?: string
  copilotChatEnabled?: boolean
  copilotSku?: string
  copilotTelemetry?: string
}

export interface AccountRateLimit {
  /** When the rate-limit was first observed (epoch ms) */
  limitedAt: number
  /** When the rate-limit window is expected to reset (epoch ms). Accounts auto-revive once now >= resetAt. */
  resetAt: number
  /** Origin of the rate-limit marker */
  reason: 'http-429' | 'codex-quota'
  /** For Codex quota markers, which window saturated */
  windowType?: 'primary' | 'secondary'
  /** Human-readable detail (shown in UI tooltip) */
  message?: string
}

export interface ProviderOAuthAccount {
  /** Stable UUID used as the account key */
  id: string
  /** Required — primary display label and dedup key on import */
  email: string
  /** Optional user-friendly nickname */
  label?: string
  oauth: OAuthToken
  /** Set when the account is temporarily rate-limited; cleared once resetAt elapses */
  rateLimit?: AccountRateLimit
  createdAt: number
  lastUsedAt?: number
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
  /** Allow context compression to use the model's full configured context length when it exceeds 200K */
  enableExtendedContextCompression?: boolean
  /** Full context compression trigger ratio, clamped to 0.3 ~ 0.9 */
  contextCompressionThreshold?: number
  maxOutputTokens?: number
  /** Price per million input tokens (USD) */
  inputPrice?: number
  /** Price per million output tokens (USD) */
  outputPrice?: number
  /** Price per million tokens for cache creation/write (USD) */
  cacheCreationPrice?: number
  /** Price per million tokens for cache hit/read (USD) */
  cacheHitPrice?: number
  /** GitHub Copilot premium request multiplier */
  premiumRequestMultiplier?: number
  /** Plans that commonly expose this model in Copilot */
  availablePlans?: string[]
  /** Whether the model supports image/vision input */
  supportsVision?: boolean
  /** Whether the model supports function/tool calling */
  supportsFunctionCall?: boolean
  /** Whether the model supports toggleable thinking/reasoning mode */
  supportsThinking?: boolean
  /** Whether the model supports OpenAI Computer Use via the Responses API */
  supportsComputerUse?: boolean
  /** Whether Computer Use is enabled for this model */
  enableComputerUse?: boolean
  /** Configuration describing how to enable thinking for this model */
  thinkingConfig?: ThinkingConfig
  /** OpenAI Responses: summary of reasoning (auto/concise/detailed) */
  responseSummary?: ResponseSummary
  /** OpenAI-compatible endpoints: enable prompt caching with the app-global cache key */
  enablePromptCache?: boolean
  /** Anthropic: enable system prompt caching */
  enableSystemPromptCache?: boolean
  /** Optional request overrides applied only to this model */
  requestOverrides?: RequestOverrides
  /** OpenAI-compatible service tier (e.g. priority). Effective when fast mode is enabled. */
  serviceTier?: 'priority'
  /** OpenAI Responses WebSocket endpoint override for this model */
  websocketUrl?: string
  /** OpenAI Responses transport mode for this model */
  websocketMode?: 'auto' | 'disabled'
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
  /** Whether to skip TLS certificate validation for this provider's agent requests */
  allowInsecureTls?: boolean
  /** Custom User-Agent header (e.g. Moonshot套餐 requires 'RooCode/3.48.0') */
  userAgent?: string
  /** Default model ID to use when this provider is first selected */
  defaultModel?: string
  /** Authentication mode for this provider */
  authMode?: AuthMode
  /**
   * OAuth token payload (if authMode === 'oauth').
   * When multi-account mode is active, this mirrors the currently selected account's token
   * so legacy consumers can keep reading `provider.oauth` directly.
   */
  oauth?: OAuthToken
  /** Multi-account list. Priority order = array order. First entry is the default. */
  oauthAccounts?: ProviderOAuthAccount[]
  /** Currently selected account id. Falls back to the first usable entry in oauthAccounts. */
  activeAccountId?: string
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
  /** OpenAI Responses WebSocket endpoint override for this provider */
  websocketUrl?: string
  /** OpenAI Responses transport mode for this provider */
  websocketMode?: 'auto' | 'disabled'
}

// --- Provider Config ---

export interface ProviderConfig {
  type: ProviderType
  apiKey: string
  baseUrl?: string
  model: string
  category?: ModelCategory
  /** Provider ID (used for quota tracking and UI bindings) */
  providerId?: string
  /** Built-in provider ID (for preset-based mapping) */
  providerBuiltinId?: string
  /** OpenAI-compatible service tier override */
  serviceTier?: 'priority'
  maxTokens?: number
  temperature?: number
  systemPrompt?: string
  /** Whether this provider actually needs an API key */
  requiresApiKey?: boolean
  /** Whether to route API requests via the system proxy */
  useSystemProxy?: boolean
  /** Whether to skip TLS certificate validation for this provider request */
  allowInsecureTls?: boolean
  /** Whether thinking mode is enabled for this request */
  thinkingEnabled?: boolean
  /** Thinking configuration from the active model */
  thinkingConfig?: ThinkingConfig
  /** Selected reasoning effort level (when model supports reasoningEffortLevels) */
  reasoningEffort?: ReasoningEffortLevel
  /** Current session ID — used for request correlation and Responses transport continuity */
  sessionId?: string
  /** OpenAI Responses reusable WebSocket session scope. Use distinct values for auxiliary flows. */
  responsesSessionScope?: string
  /** OpenAI Responses: summary of reasoning (auto/concise/detailed) */
  responseSummary?: ResponseSummary
  /** OpenAI Responses: enable prompt caching with session-based key */
  enablePromptCache?: boolean
  /** Whether OpenAI Computer Use should be enabled for this request */
  computerUseEnabled?: boolean
  /** Anthropic: enable system prompt caching */
  enableSystemPromptCache?: boolean
  /** Custom User-Agent header (e.g. Moonshot套餐 requires 'RooCode/3.48.0') */
  userAgent?: string
  /** Optional request overrides (headers/body) for this request */
  requestOverrides?: RequestOverrides
  /** Optional prompt name to use for Responses instructions */
  instructionsPrompt?: string
  /** OpenAI organization header */
  organization?: string
  /** OpenAI project header */
  project?: string
  /** Account-backed OpenAI/Codex requests may require Chatgpt-Account-Id */
  accountId?: string
  /** OpenAI Responses WebSocket endpoint override resolved for this request */
  websocketUrl?: string
  /** OpenAI Responses transport mode resolved for this request */
  websocketMode?: 'auto' | 'disabled'
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
