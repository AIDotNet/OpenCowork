// Shared types for the agent loop event protocol.
// Used by both main-process cron loop and renderer interactive loop.

// ---- Minimal content types for the event wire format ----

export interface AgentTextBlock {
  type: 'text'
  text: string
}

export interface AgentImageResultBlock {
  type: 'image'
  source: {
    type: 'base64' | 'url'
    mediaType?: string
    data?: string
    url?: string
    filePath?: string
  }
}

export type AgentToolResultContent = string | Array<AgentTextBlock | AgentImageResultBlock>

export interface AgentTokenUsage {
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
  requestTimings?: AgentRequestTiming[]
}

export interface AgentRequestTiming {
  totalMs: number
  ttftMs?: number
  tps?: number
}

// ---- Tool call state ----

export interface ToolCallState {
  id: string
  name: string
  input: Record<string, unknown>
  status: 'streaming' | 'pending_approval' | 'running' | 'completed' | 'error'
  output?: AgentToolResultContent
  error?: string
  requiresApproval: boolean
  startedAt?: number
  completedAt?: number
}

// ---- Agent loop events ----

export type InteractiveAgentEvent =
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
  | { type: 'tool_call_approval_needed'; toolCall: ToolCallState }
  | { type: 'tool_call_result'; toolCall: ToolCallState }
  | {
      type: 'request_retry'
      attempt: number
      maxAttempts: number
      delayMs: number
      statusCode?: number
      reason: string
    }
  | {
      type: 'iteration_end'
      toolResults: { toolUseId: string; content: AgentToolResultContent; isError?: boolean }[]
    }
  | {
      type: 'message_end'
      usage?: AgentTokenUsage
      timing?: AgentRequestTiming
      providerResponseId?: string
    }
  | { type: 'error'; error: Error }
  | {
      type: 'loop_end'
      reason: 'completed' | 'max_iterations' | 'aborted' | 'error'
      messages?: AgentLoopMessage[]
    }

// Minimal message shape carried in loop_end events.
// Both sides map to their own richer UnifiedMessage type.
export interface AgentLoopMessage {
  id: string
  role: 'system' | 'user' | 'assistant'
  content: string | AgentLoopContentBlock[]
  createdAt: number
  usage?: AgentTokenUsage
  providerResponseId?: string
  source?: string | null
}

export type AgentLoopContentBlock =
  | AgentTextBlock
  | {
      type: 'thinking'
      thinking: string
      encryptedContent?: string
      encryptedContentProvider?: 'anthropic' | 'openai-responses' | 'google'
    }
  | {
      type: 'tool_use'
      id: string
      name: string
      input: Record<string, unknown>
      extraContent?: Record<string, unknown>
    }
  | { type: 'tool_result'; toolUseId: string; content: AgentToolResultContent; isError?: boolean }
