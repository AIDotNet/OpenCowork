import type { ProviderConfig, TokenUsage } from '../../api/types'
import type { ToolCallState } from '../types'
import type { ToolContext } from '../../tools/tool-types'

// --- SubAgent Definition (static, registered at startup) ---

export interface SubAgentDefinition {
  /** Unique name, used as the tool name in parent's tool list */
  name: string
  /** Human-readable description shown in parent's tool list and UI */
  description: string
  /** Lucide icon name for UI display */
  icon?: string
  /** Focused system prompt for this SubAgent */
  systemPrompt: string
  /** Names of tools this SubAgent is allowed to use (subset of registered tools) */
  allowedTools: string[]
  /** Max LLM iterations before forced stop */
  maxIterations: number
  /** Optional model override (e.g. use cheaper/faster model) */
  model?: string
  /** Optional temperature override */
  temperature?: number
  /** Input schema — what the parent agent passes to this SubAgent */
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
  /** Optional custom function to format SubAgent output before returning to parent */
  formatOutput?: (result: SubAgentResult) => string
}

// --- SubAgent Runtime Config ---

export interface SubAgentRunConfig {
  definition: SubAgentDefinition
  /** Parent's provider config (API key, base URL inherited; model/temp may be overridden) */
  parentProvider: ProviderConfig
  /** Tool context inherited from parent (working folder, IPC, signal) */
  toolContext: ToolContext
  /** Input from parent's tool_use call */
  input: Record<string, unknown>
  /** The tool_use block id from the parent agent, used to distinguish multiple same-name SubAgent calls */
  toolUseId: string
  /** Callback for progress events (so parent can yield them to UI) */
  onEvent?: (event: SubAgentEvent) => void
  /** Callback for tool approval (bubbled up from inner loop for write tools) */
  onApprovalNeeded?: (tc: ToolCallState) => Promise<boolean>
}

// --- SubAgent Result ---

export interface SubAgentResult {
  success: boolean
  /** Final text output (the SubAgent's last text response) */
  output: string
  /** Number of tool calls executed */
  toolCallCount: number
  /** Number of LLM iterations */
  iterations: number
  /** Aggregated token usage */
  usage: TokenUsage
  /** Error message if failed */
  error?: string
}

// --- SubAgent Events (yielded to parent/UI) ---

export type SubAgentEvent =
  | { type: 'sub_agent_start'; subAgentName: string; toolUseId: string; input: Record<string, unknown> }
  | { type: 'sub_agent_tool_call'; subAgentName: string; toolUseId: string; toolCall: ToolCallState }
  | { type: 'sub_agent_text_delta'; subAgentName: string; toolUseId: string; text: string }
  | { type: 'sub_agent_iteration'; subAgentName: string; toolUseId: string; iteration: number }
  | { type: 'sub_agent_end'; subAgentName: string; toolUseId: string; result: SubAgentResult }

// --- Read-only tools that SubAgents can auto-approve ---

export const READ_ONLY_TOOLS = new Set(['Read', 'LS', 'Glob', 'Grep', 'TodoRead'])
