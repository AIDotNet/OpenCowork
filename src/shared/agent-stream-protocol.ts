// Agent stream protocol — canonical wire format for main→renderer event streaming.
// Both processes import these types directly. No normalization layer needed.

// ---- Protocol version ----

export const AGENT_STREAM_PROTOCOL_VERSION = 1

// ---- Wire envelope ----

export interface AgentStreamEnvelope {
  v: typeof AGENT_STREAM_PROTOCOL_VERSION
  runId: string
  sessionId: string
  seq: number
  events: AgentStreamEvent[]
}

// ---- Wire sub-types (flat, JSON-serializable, no class instances) ----

export interface TokenUsageWire {
  inputTokens: number
  outputTokens: number
  billableInputTokens?: number
  cacheCreationTokens?: number
  cacheCreation5mTokens?: number
  cacheCreation1hTokens?: number
  cacheReadTokens?: number
  reasoningTokens?: number
  contextTokens?: number
  contextLength?: number
  totalDurationMs?: number
  requestTimings?: RequestTimingWire[]
}

export interface RequestTimingWire {
  totalMs: number
  ttftMs?: number
  tps?: number
}

export interface ToolCallStateWire {
  id: string
  name: string
  input: Record<string, unknown>
  status: 'streaming' | 'pending_approval' | 'running' | 'completed' | 'error' | 'canceled'
  output?: string | Array<TextBlockWire | ImageBlockWire>
  error?: string
  requiresApproval: boolean
  extraContent?: ToolCallExtraContentWire
  startedAt?: number
  completedAt?: number
}

export interface ToolCallExtraContentWire {
  google?: { thought_signature?: string }
  openaiResponses?: {
    computerUse?: {
      kind: 'computer_use'
      computerCallId: string
      computerActionType: string
      computerActionIndex: number
      autoAddedScreenshot?: boolean
    }
  }
}

export interface ToolUseBlockWire {
  id: string
  name: string
  input: Record<string, unknown>
  extraContent?: ToolCallExtraContentWire
}

export interface ToolResultWire {
  toolUseId: string
  content: string | Array<TextBlockWire | ImageBlockWire>
  isError?: boolean
}

export interface TextBlockWire {
  type: 'text'
  text: string
}

export interface ImageBlockWire {
  type: 'image'
  source: {
    type: 'base64' | 'url'
    mediaType?: string
    data?: string
    url?: string
    filePath?: string
  }
}

export interface ImageErrorWire {
  code: 'timeout' | 'network' | 'request_aborted' | 'api_error' | 'unknown'
  message: string
}

export interface RequestDebugInfoWire {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
  contextWindowBody?: string
  timestamp: number
  providerId?: string
  providerBuiltinId?: string
  model?: string
  transport?: 'http' | 'websocket'
  fallbackReason?: string
  reusedConnection?: boolean
  websocketRequestKind?: 'warmup' | 'full' | 'incremental'
  websocketIncrementalReason?: string
  previousResponseId?: string
  executionPath?: 'node' | 'sidecar'
}

// Minimal message shape for loop_end / context_compressed payloads.
export interface MessageWire {
  id: string
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentBlockWire[]
  createdAt: number
  usage?: TokenUsageWire
  providerResponseId?: string
  source?: string | null
  meta?: Record<string, unknown>
}

export type ContentBlockWire =
  | TextBlockWire
  | ImageBlockWire
  | { type: 'image_error'; code: string; message: string }
  | {
      type: 'agent_error'
      code: 'runtime_error' | 'tool_error' | 'unknown'
      message: string
      errorType?: string
      details?: string
      stackTrace?: string
    }
  | {
      type: 'tool_use'
      id: string
      name: string
      input: Record<string, unknown>
      extraContent?: ToolCallExtraContentWire
    }
  | {
      type: 'tool_result'
      toolUseId: string
      content: string | Array<TextBlockWire | ImageBlockWire>
      isError?: boolean
    }
  | {
      type: 'thinking'
      thinking: string
      encryptedContent?: string
      encryptedContentProvider?: 'anthropic' | 'openai-responses' | 'google'
    }

// ---- Event classification ----

export type AgentStreamEventType = AgentStreamEvent['type']

export const AGGREGATABLE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'text_delta',
  'thinking_delta',
  'tool_use_args_delta'
])

// ---- Event union ----

export type AgentStreamEvent =
  // Lifecycle
  | { type: 'loop_start' }
  | { type: 'iteration_start'; iteration: number }
  | { type: 'iteration_end'; stopReason: string; toolResults?: ToolResultWire[] }
  | { type: 'loop_end'; reason: LoopEndReasonWire; messages?: MessageWire[] }
  // Streaming deltas (aggregatable)
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'thinking_encrypted'; content: string; provider: ThinkingProviderWire }
  // Image generation
  | { type: 'image_generation_started' }
  | { type: 'image_generation_partial'; imageBlock: ImageBlockWire; partialImageIndex?: number }
  | { type: 'image_generated'; imageBlock: ImageBlockWire }
  | { type: 'image_error'; imageError: ImageErrorWire }
  // Message completion
  | {
      type: 'message_end'
      usage?: TokenUsageWire
      timing?: RequestTimingWire
      providerResponseId?: string
      stopReason?: string
    }
  // Tool streaming
  | {
      type: 'tool_use_streaming_start'
      toolCallId: string
      toolName: string
      extraContent?: ToolCallExtraContentWire
    }
  | { type: 'tool_use_args_delta'; toolCallId: string; partialInput: Record<string, unknown> }
  | { type: 'tool_use_generated'; toolUseBlock: ToolUseBlockWire }
  // Tool execution
  | { type: 'tool_call_start'; toolCall: ToolCallStateWire }
  | { type: 'tool_call_approval_needed'; toolCall: ToolCallStateWire }
  | { type: 'tool_call_result'; toolCall: ToolCallStateWire }
  // Retry / error
  | {
      type: 'request_retry'
      attempt: number
      maxAttempts: number
      delayMs: number
      statusCode?: number
      reason: string
    }
  | { type: 'error'; message: string; errorType?: string; details?: string; stackTrace?: string }
  // Debug / compression
  | { type: 'request_debug'; debugInfo: RequestDebugInfoWire }
  | { type: 'context_compression_start' }
  | {
      type: 'context_compressed'
      originalCount: number
      newCount: number
      messages?: MessageWire[]
    }
  // Sub-agent events
  | {
      type: 'sub_agent_start'
      subAgentName: string
      toolUseId: string
      input: Record<string, unknown>
      promptMessage: MessageWire
    }
  | {
      type: 'sub_agent_iteration'
      subAgentName: string
      toolUseId: string
      iteration: number
      assistantMessage: MessageWire
    }
  | { type: 'sub_agent_text_delta'; subAgentName: string; toolUseId: string; text: string }
  | { type: 'sub_agent_thinking_delta'; subAgentName: string; toolUseId: string; thinking: string }
  | {
      type: 'sub_agent_thinking_encrypted'
      subAgentName: string
      toolUseId: string
      thinkingEncryptedContent: string
      thinkingEncryptedProvider: ThinkingProviderWire
    }
  | {
      type: 'sub_agent_tool_use_streaming_start'
      subAgentName: string
      toolUseId: string
      toolCallId: string
      toolName: string
      toolCallExtraContent?: ToolCallExtraContentWire
    }
  | {
      type: 'sub_agent_tool_use_args_delta'
      subAgentName: string
      toolUseId: string
      toolCallId: string
      partialInput: Record<string, unknown>
    }
  | {
      type: 'sub_agent_tool_use_generated'
      subAgentName: string
      toolUseId: string
      toolUseBlock: {
        type: 'tool_use'
        id: string
        name: string
        input: Record<string, unknown>
        extraContent?: ToolCallExtraContentWire
      }
    }
  | {
      type: 'sub_agent_image_generated'
      subAgentName: string
      toolUseId: string
      imageBlock: ImageBlockWire
    }
  | {
      type: 'sub_agent_image_error'
      subAgentName: string
      toolUseId: string
      imageError: ImageErrorWire
    }
  | {
      type: 'sub_agent_message_end'
      subAgentName: string
      toolUseId: string
      usage?: TokenUsageWire
      providerResponseId?: string
    }
  | {
      type: 'sub_agent_tool_result_message'
      subAgentName: string
      toolUseId: string
      message: MessageWire
    }
  | {
      type: 'sub_agent_user_message'
      subAgentName: string
      toolUseId: string
      message: MessageWire
    }
  | {
      type: 'sub_agent_report_update'
      subAgentName: string
      toolUseId: string
      report: string
      status: 'pending' | 'submitted' | 'retrying' | 'fallback' | 'missing'
    }
  | {
      type: 'sub_agent_tool_call'
      subAgentName: string
      toolUseId: string
      toolCall: ToolCallStateWire
    }
  | { type: 'sub_agent_end'; subAgentName: string; toolUseId: string; result: SubAgentResultWire }

export type LoopEndReasonWire = 'completed' | 'max_iterations' | 'aborted' | 'error'
export type ThinkingProviderWire = 'anthropic' | 'openai-responses' | 'google'

export interface SubAgentResultWire {
  success: boolean
  output: string
  reportSubmitted?: boolean
  toolCallCount: number
  iterations: number
  usage: TokenUsageWire
  error?: string
}
