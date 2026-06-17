import type {
  ProviderConfig,
  TokenUsage,
  UnifiedMessage,
  ToolUseBlock,
  ImageBlock,
  ImageErrorCode,
  ToolCallExtraContent
} from '../../api/types'
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
  /** Allowed tool names. Supports '*' to expose all currently registered tools. */
  tools: string[]
  /** Tools explicitly denied for this SubAgent even when tools='*'. */
  disallowedTools: string[]
  /** Max LLM turns before forced stop. Non-positive values fall back to a safety cap. */
  maxTurns: number
  /** Optional initial task prefix appended before runtime input. */
  initialPrompt?: string
  /** Whether this agent definition is intended for background execution. */
  background?: boolean
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
  /** Parent provider config, used as a fallback when no usable fast provider is configured. */
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
  /** Final text output resolved from the sub-agent's actual assistant messages. */
  output: string
  /** Whether a non-empty final result was captured. */
  reportSubmitted?: boolean
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
  | {
      type: 'sub_agent_queued'
      subAgentName: string
      toolUseId: string
      input: Record<string, unknown>
    }
  | {
      type: 'sub_agent_dequeued'
      subAgentName: string
      toolUseId: string
    }
  | {
      type: 'sub_agent_start'
      subAgentName: string
      toolUseId: string
      input: Record<string, unknown>
      promptMessage: UnifiedMessage
    }
  | {
      type: 'sub_agent_iteration'
      subAgentName: string
      toolUseId: string
      iteration: number
      assistantMessage: UnifiedMessage
    }
  | { type: 'sub_agent_text_delta'; subAgentName: string; toolUseId: string; text: string }
  | { type: 'sub_agent_thinking_delta'; subAgentName: string; toolUseId: string; thinking: string }
  | {
      type: 'sub_agent_thinking_encrypted'
      subAgentName: string
      toolUseId: string
      thinkingEncryptedContent: string
      thinkingEncryptedProvider: 'anthropic' | 'openai-responses' | 'google'
    }
  | {
      type: 'sub_agent_tool_use_streaming_start'
      subAgentName: string
      toolUseId: string
      toolCallId: string
      toolName: string
      toolCallExtraContent?: ToolCallExtraContent
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
      toolUseBlock: ToolUseBlock
    }
  | {
      type: 'sub_agent_image_generated'
      subAgentName: string
      toolUseId: string
      imageBlock: ImageBlock
    }
  | {
      type: 'sub_agent_image_error'
      subAgentName: string
      toolUseId: string
      imageError: { code: ImageErrorCode; message: string }
    }
  | {
      type: 'sub_agent_message_end'
      subAgentName: string
      toolUseId: string
      usage?: TokenUsage
      providerResponseId?: string
    }
  | {
      type: 'sub_agent_tool_result_message'
      subAgentName: string
      toolUseId: string
      message: UnifiedMessage
    }
  | {
      type: 'sub_agent_user_message'
      subAgentName: string
      toolUseId: string
      message: UnifiedMessage
    }
  | {
      type: 'sub_agent_report_update'
      subAgentName: string
      toolUseId: string
      report: string
      status: 'pending' | 'queued' | 'submitted' | 'retrying' | 'fallback' | 'missing'
    }
  | {
      type: 'sub_agent_tool_call'
      subAgentName: string
      toolUseId: string
      toolCall: ToolCallState
    }
  | { type: 'sub_agent_end'; subAgentName: string; toolUseId: string; result: SubAgentResult }
