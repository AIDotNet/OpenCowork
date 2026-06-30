import type { ToolHandler } from '../../../tools/tool-types'
import { nativeOnlyTeamResult } from './team-native-guard'

/**
 * TeamStatus — non-blocking snapshot of the current team state.
 * Returns members, tasks, and recent messages without waiting.
 * Use this to check progress without waiting.
 */
export const teamStatusTool: ToolHandler = {
  definition: {
    name: 'TeamStatus',
    description:
      'Get a snapshot of the current team state: all members with their status, all tasks, and recent messages. Non-blocking — returns immediately. Use this to check progress without waiting.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  execute: async () => nativeOnlyTeamResult('TeamStatus'),
  requiresApproval: () => false
}
