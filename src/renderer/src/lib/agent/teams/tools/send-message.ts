import type { ToolHandler } from '../../../tools/tool-types'
import { nativeOnlyTeamResult } from './team-native-guard'

export const sendMessageTool: ToolHandler = {
  definition: {
    name: 'SendMessage',
    description:
      'Send a message to a teammate, broadcast to all teammates, or send a shutdown request. Use this for inter-agent communication within the team.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: [
            'message',
            'broadcast',
            'shutdown_request',
            'shutdown_response',
            'idle_notification',
            'permission_request',
            'permission_response',
            'plan_approval_request',
            'plan_approval_response',
            'team_permission_update',
            'mode_set_request'
          ],
          description:
            'Structured team message type. Use "message" for direct messages, "broadcast" for team-wide messages, and approval/protocol types for team coordination flows.'
        },
        recipient: {
          type: 'string',
          description:
            'Name of the recipient teammate (required for "message" and "shutdown_request")'
        },
        content: {
          type: 'string',
          description: 'Message content'
        },
        sender: {
          type: 'string',
          description: 'Your name as the sender (defaults to "lead")'
        },
        summary: {
          type: 'string',
          description: 'Optional short summary of the message'
        }
      },
      required: ['type', 'content']
    }
  },
  execute: async () => nativeOnlyTeamResult('SendMessage'),
  requiresApproval: () => false
}
