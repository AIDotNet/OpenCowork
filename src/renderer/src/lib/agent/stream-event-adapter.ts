import type { AgentStreamEvent } from '../../../../shared/agent-stream-protocol'
import type { AgentEvent } from './types'
import type { SubAgentEvent } from './sub-agents/types'

export function toAgentEvent(e: AgentStreamEvent): AgentEvent | null {
  switch (e.type) {
    case 'loop_start':
    case 'iteration_start':
    case 'text_delta':
    case 'thinking_delta':
    case 'image_generation_started':
    case 'context_compression_start':
    case 'tool_use_args_delta':
    case 'request_retry':
      return e as AgentEvent

    case 'thinking_encrypted':
      return {
        type: 'thinking_encrypted',
        thinkingEncryptedContent: e.content,
        thinkingEncryptedProvider: e.provider
      }

    case 'tool_use_streaming_start':
      return {
        type: 'tool_use_streaming_start',
        toolCallId: e.toolCallId,
        toolName: e.toolName,
        toolCallExtraContent: e.extraContent
      } as AgentEvent

    case 'error':
      return {
        type: 'error',
        error: new Error(e.message),
        errorType: e.errorType,
        details: e.details,
        stackTrace: e.stackTrace
      }

    case 'image_generation_partial':
    case 'image_generated':
    case 'image_error':
    case 'message_end':
    case 'tool_use_generated':
    case 'tool_call_start':
    case 'tool_call_approval_needed':
    case 'tool_call_result':
    case 'iteration_end':
    case 'request_debug':
    case 'context_compressed':
      return e as unknown as AgentEvent

    case 'loop_end':
      return e as unknown as AgentEvent

    default:
      if ((e as { type: string }).type.startsWith('sub_agent_')) return null
      return null
  }
}

export function toSubAgentEvent(e: AgentStreamEvent): SubAgentEvent | null {
  if (!(e as { type: string }).type.startsWith('sub_agent_')) return null
  return e as unknown as SubAgentEvent
}
