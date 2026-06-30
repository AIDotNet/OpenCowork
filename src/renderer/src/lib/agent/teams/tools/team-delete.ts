import type { ToolHandler } from '../../../tools/tool-types'
import { nativeOnlyTeamResult } from './team-native-guard'

export const teamDeleteTool: ToolHandler = {
  definition: {
    name: 'TeamDelete',
    description:
      'Delete the active team and clean up all resources. Use this when all tasks are completed and the team is no longer needed.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  execute: async () => nativeOnlyTeamResult('TeamDelete'),
  requiresApproval: () => true
}
