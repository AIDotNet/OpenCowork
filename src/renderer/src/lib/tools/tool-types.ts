import type { ToolDefinition, ToolResultContent } from '../api/types'
import type { PluginPermissions } from '../plugins/types'

// --- Tool Context ---

export interface ToolContext {
  sessionId?: string
  workingFolder?: string
  sshConnectionId?: string
  signal: AbortSignal
  ipc: IPCClient
  /** The tool_use block id currently being executed (set by agent-loop) */
  currentToolUseId?: string
  /** Identifies the calling agent (e.g. 'CronAgent') — used to restrict certain tool behaviors */
  callerAgent?: string
  /** Plugin ID when running inside a plugin auto-reply session */
  pluginId?: string
  /** Plugin chat ID for routing replies back through the plugin channel */
  pluginChatId?: string
  /** Mutable shared state bag — survives { ...toolCtx } spread copies in agent-loop.
   *  Used for per-run flags like deliveryUsed that must persist across tool calls. */
  sharedState?: { deliveryUsed?: boolean }
  /** Plugin security permissions — when set, tools use these to self-manage approval.
   *  Avoids the need for forceApproval + external approvalFn. */
  pluginPermissions?: PluginPermissions
  /** Home directory path — used by plugin permission checks for path-based access control */
  pluginHomedir?: string
}

export interface IPCClient {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  send(channel: string, ...args: unknown[]): void
  on(channel: string, callback: (...args: unknown[]) => void): () => void
}

// --- Tool Handler ---

export interface ToolHandler {
  definition: ToolDefinition
  execute: (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResultContent>
  requiresApproval?: (input: Record<string, unknown>, ctx: ToolContext) => boolean
}
