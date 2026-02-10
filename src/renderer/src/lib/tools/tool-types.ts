import type { ToolDefinition } from '../api/types'

// --- Tool Context ---

export interface ToolContext {
  workingFolder?: string
  signal: AbortSignal
  ipc: IPCClient
  /** The tool_use block id currently being executed (set by agent-loop) */
  currentToolUseId?: string
}

export interface IPCClient {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  send(channel: string, ...args: unknown[]): void
  on(channel: string, callback: (...args: unknown[]) => void): () => void
}

// --- Tool Handler ---

export interface ToolHandler {
  definition: ToolDefinition
  execute: (input: Record<string, unknown>, ctx: ToolContext) => Promise<string>
  requiresApproval?: (input: Record<string, unknown>, ctx: ToolContext) => boolean
}
