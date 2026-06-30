import type { ToolDefinition, ToolResultContent } from '../api/types'
import type { PluginPermissions as ChannelPermissions } from '../channel/types'

// --- Tool Context ---

export interface ToolContext {
  sessionId?: string
  workingFolder?: string
  sshConnectionId?: string
  signal: AbortSignal
  ipc: IPCClient
  /** Files read during this run, keyed by normalized resolved path. */
  readFileHistory?: Map<string, FileReadSnapshot>
  /** Per-run inline tool handlers that should shadow the global registry. */
  inlineToolHandlers?: Record<string, ToolHandler>
  /** The tool_use block id currently being executed by the active agent runtime. */
  currentToolUseId?: string
  /** Current top-level agent run id, reused for post-run change review and rollback. */
  agentRunId?: string
  /** Identifies the calling agent (e.g. 'CronAgent') — used to restrict certain tool behaviors */
  callerAgent?: string
  /** Plugin ID when running inside a plugin auto-reply session */
  pluginId?: string
  /** Plugin chat ID for routing replies back through the plugin channel */
  pluginChatId?: string
  /** Plugin chat type (p2p | group) when available */
  pluginChatType?: 'p2p' | 'group'
  /** Plugin message sender identifiers (when available) */
  pluginSenderId?: string
  pluginSenderName?: string
  /** Mutable shared state bag — survives { ...toolCtx } spread copies in runtime tool dispatch.
   *  Used for per-run flags like deliveryUsed that must persist across tool calls. */
  sharedState?: { deliveryUsed?: boolean; bashCwd?: string }
  /** Channel security permissions for tool approval checks. */
  channelPermissions?: ChannelPermissions
  /** Channel working home dir for path-based access control */
  channelHomedir?: string
  /** Per-run local tool handlers that should not be exposed globally */
  localToolHandlers?: Record<string, ToolHandler>
}

export interface FileReadSnapshot {
  exists: boolean
  type?: 'file' | 'directory' | 'other' | null
  size?: number | null
  mtimeMs?: number | null
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
