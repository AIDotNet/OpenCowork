import type { ProviderConfig, ToolDefinition, UnifiedMessage, TokenUsage } from '../api/types'

// --- Tool Call Runtime State ---

export type ToolCallStatus = 'streaming' | 'pending_approval' | 'running' | 'completed' | 'error'

export interface ToolCallState {
  id: string
  name: string
  input: Record<string, unknown>
  status: ToolCallStatus
  output?: string
  error?: string
  requiresApproval: boolean
  startedAt?: number
  completedAt?: number
}

// --- Message Queue for mid-loop injection ---

/**
 * A simple queue that allows external code to push messages into a running
 * agent loop. The loop drains the queue at iteration boundaries (between
 * turns) and appends the messages to the conversation — matching Claude
 * Code's behavior of delivering teammate messages between turns.
 */
export class MessageQueue {
  private pending: UnifiedMessage[] = []

  /** Push a message to be injected at the next iteration boundary. */
  push(msg: UnifiedMessage): void {
    this.pending.push(msg)
  }

  /** Drain all pending messages (non-blocking). Returns empty array if none. */
  drain(): UnifiedMessage[] {
    if (this.pending.length === 0) return []
    const msgs = this.pending
    this.pending = []
    return msgs
  }

  get size(): number {
    return this.pending.length
  }
}

// --- Agent Loop Config ---

export interface AgentLoopConfig {
  maxIterations: number
  provider: ProviderConfig
  tools: ToolDefinition[]
  systemPrompt: string
  workingFolder?: string
  signal: AbortSignal
  /** Optional message queue for injecting messages mid-loop (used by teammates). */
  messageQueue?: MessageQueue
}

// --- Agent Loop Events ---

export type AgentEvent =
  | { type: 'loop_start' }
  | { type: 'iteration_start'; iteration: number }
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'message_end'; usage?: TokenUsage }
  | { type: 'tool_use_streaming_start'; toolCallId: string; toolName: string }
  | { type: 'tool_use_args_delta'; toolCallId: string; partialInput: Record<string, unknown> }
  | { type: 'tool_use_generated'; toolUseBlock: { id: string; name: string; input: Record<string, unknown> } }
  | { type: 'tool_call_start'; toolCall: ToolCallState }
  | { type: 'tool_call_approval_needed'; toolCall: ToolCallState }
  | { type: 'tool_call_result'; toolCall: ToolCallState }
  | { type: 'iteration_end'; stopReason: string; toolResults?: { toolUseId: string; content: string; isError?: boolean }[] }
  | { type: 'loop_end'; reason: 'completed' | 'max_iterations' | 'aborted' | 'error' }
  | { type: 'error'; error: Error }

// --- Agent Loop Stop Reasons ---

export type LoopEndReason = 'completed' | 'max_iterations' | 'aborted' | 'error'
