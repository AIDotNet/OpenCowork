// ===== Unified API Type System =====

// --- Token Usage ---

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  /** Anthropic prompt caching: tokens written to cache */
  cacheCreationTokens?: number
  /** Anthropic prompt caching: tokens read from cache */
  cacheReadTokens?: number
  /** Reasoning model (o3/o4-mini etc.) internal thinking tokens */
  reasoningTokens?: number
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

export interface ToolResultBlock {
  type: 'tool_result'
  toolUseId: string
  content: string
  isError?: boolean
}

export interface ThinkingBlock {
  type: 'thinking'
  thinking: string
  startedAt?: number
  completedAt?: number
}

export type ContentBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock

// --- Messages ---

export interface UnifiedMessage {
  id: string
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentBlock[]
  createdAt: number
  usage?: TokenUsage
}

// --- Streaming Events ---

export type StreamEventType =
  | 'message_start'
  | 'text_delta'
  | 'thinking_delta'
  | 'tool_call_start'
  | 'tool_call_delta'
  | 'tool_call_end'
  | 'message_end'
  | 'error'

export interface StreamEvent {
  type: StreamEventType
  text?: string
  thinking?: string
  toolCallId?: string
  toolName?: string
  argumentsDelta?: string
  toolCallInput?: Record<string, unknown>
  stopReason?: string
  usage?: TokenUsage
  error?: { type: string; message: string }
}

// --- Tool Definitions ---

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

// --- Provider Config ---

export type ProviderType = 'anthropic' | 'openai-chat' | 'openai-responses'

export interface ProviderConfig {
  type: ProviderType
  apiKey: string
  baseUrl?: string
  model: string
  maxTokens?: number
  temperature?: number
  systemPrompt?: string
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
