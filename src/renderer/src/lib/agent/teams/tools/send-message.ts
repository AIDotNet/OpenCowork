import { nanoid } from 'nanoid'
import type { ToolHandler } from '../../../tools/tool-types'
import { teamEvents } from '../events'
import { useTeamStore } from '../../../../stores/team-store'
import type { TeamMessage, TeamMessageType } from '../types'

const VALID_TYPES: TeamMessageType[] = ['message', 'broadcast', 'shutdown_request', 'shutdown_response']

export const sendMessageTool: ToolHandler = {
  definition: {
    name: 'TeamSendMessage',
    description:
      'Send a message to a teammate, broadcast to all teammates, or send a shutdown request. Use this for inter-agent communication within the team.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['message', 'broadcast', 'shutdown_request', 'shutdown_response'],
          description: 'Message type: "message" for direct, "broadcast" for all, "shutdown_request" to ask a teammate to stop',
        },
        recipient: {
          type: 'string',
          description: 'Name of the recipient teammate (required for "message" and "shutdown_request")',
        },
        content: {
          type: 'string',
          description: 'Message content',
        },
        sender: {
          type: 'string',
          description: 'Your name as the sender (defaults to "lead")',
        },
        summary: {
          type: 'string',
          description: 'Optional short summary of the message',
        },
      },
      required: ['type', 'content'],
    },
  },
  execute: async (input) => {
    const team = useTeamStore.getState().activeTeam
    if (!team) {
      return JSON.stringify({ error: 'No active team' })
    }

    const msgType = String(input.type) as TeamMessageType
    if (!VALID_TYPES.includes(msgType)) {
      return JSON.stringify({ error: `Invalid message type: ${input.type}` })
    }

    const recipient = msgType === 'broadcast' ? 'all' : String(input.recipient ?? 'all')

    const msg: TeamMessage = {
      id: nanoid(8),
      from: 'lead',
      to: recipient,
      type: msgType,
      content: String(input.content),
      summary: input.summary ? String(input.summary) : undefined,
      timestamp: Date.now(),
    }

    teamEvents.emit({ type: 'team_message', message: msg })

    return JSON.stringify({
      success: true,
      message_id: msg.id,
      type: msgType,
      to: recipient,
    })
  },
  requiresApproval: () => false,
}
