import type { ProviderConfig, ToolDefinition } from '../api/types'

// --- Tool Call Runtime State ---

export type ToolCallStatus = 'pending_approval' | 'running' | 'completed' | 'error'

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

// --- Agent Loop Config ---

export interface AgentLoopConfig {
  maxIterations: number
  provider: ProviderConfig
  tools: ToolDefinition[]
  systemPrompt: string
  workingFolder?: string
  signal: AbortSignal
}

// --- Agent Loop Events ---

export type AgentEvent =
  | { type: 'loop_start' }
  | { type: 'iteration_start'; iteration: number }
  | { type: 'text_delta'; text: string }
  | { type: 'message_end'; usage?: { inputTokens: number; outputTokens: number } }
  | { type: 'tool_use_generated'; toolUseBlock: { id: string; name: string; input: Record<string, unknown> } }
  | { type: 'tool_call_start'; toolCall: ToolCallState }
  | { type: 'tool_call_approval_needed'; toolCall: ToolCallState }
  | { type: 'tool_call_result'; toolCall: ToolCallState }
  | { type: 'iteration_end'; stopReason: string; toolResults?: { toolUseId: string; content: string; isError?: boolean }[] }
  | { type: 'loop_end'; reason: 'completed' | 'max_iterations' | 'aborted' | 'error' }
  | { type: 'error'; error: Error }

// --- Agent Loop Stop Reasons ---

export type LoopEndReason = 'completed' | 'max_iterations' | 'aborted' | 'error'
