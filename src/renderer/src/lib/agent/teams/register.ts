import { toolRegistry } from '../tool-registry'
import type { ToolDefinition } from '../../api/types'
import { TASK_TOOL_NAME } from '../sub-agents/create-tool'
import { teamEvents } from './events'
import { useTeamStore } from '../../../stores/team-store'
import { useUIStore } from '../../../stores/ui-store'
import { useChatStore } from '../../../stores/chat-store'
import { teamCreateTool } from './tools/team-create'
import { sendMessageTool } from './tools/send-message'
import { teamDeleteTool } from './tools/team-delete'
import { teamStatusTool } from './tools/team-status'
import { getTeamRuntimeSnapshot } from './runtime-client'
import { startTeamInboxPoller } from './inbox-poller'

const TEAM_TOOLS = [teamCreateTool, sendMessageTool, teamStatusTool, teamDeleteTool]

export const TEAM_TOOL_NAMES = new Set(TEAM_TOOLS.map((t) => t.definition.name))

function stripTaskBackgroundMode(tool: ToolDefinition): ToolDefinition {
  const schema = tool.inputSchema
  if (!('oneOf' in schema)) return tool

  const oneOf = schema.oneOf.filter((variant) => !('run_in_background' in variant.properties))
  if (oneOf.length === schema.oneOf.length || oneOf.length === 0) return tool

  return {
    ...tool,
    description: tool.description.replace(/\n- Set "run_in_background": true[^\n]*/g, ''),
    inputSchema: {
      ...schema,
      oneOf
    }
  }
}

export function filterTeamToolDefinitions(
  toolDefs: ToolDefinition[],
  teamToolsEnabled: boolean
): ToolDefinition[] {
  if (teamToolsEnabled) return toolDefs

  return toolDefs
    .filter((tool) => !TEAM_TOOL_NAMES.has(tool.name))
    .map((tool) => (tool.name === TASK_TOOL_NAME ? stripTaskBackgroundMode(tool) : tool))
}

let _teamToolsRegistered = false

export function registerTeamTools(): void {
  if (_teamToolsRegistered) return
  _teamToolsRegistered = true

  for (const tool of TEAM_TOOLS) {
    toolRegistry.register(tool)
  }

  teamEvents.on((event) => {
    const sessionId = event.sessionId ?? useChatStore.getState().activeSessionId ?? undefined
    useTeamStore.getState().handleTeamEvent(event, sessionId)

    if (event.type === 'team_start') {
      const ui = useUIStore.getState()
      ui.setRightPanelOpen(true)
      ui.setRightPanelTab('team')
    }
  })

  const activeTeam = useTeamStore.getState().activeTeam
  if (activeTeam?.name) {
    void getTeamRuntimeSnapshot({ teamName: activeTeam.name, limit: 10 })
      .then((snapshot) => {
        if (!snapshot) return
        useTeamStore.getState().syncRuntimeSnapshot(snapshot, activeTeam.sessionId)
      })
      .catch((error) => {
        console.error('[TeamRuntime] Failed to load active team snapshot:', error)
      })
  }

  startTeamInboxPoller()
}
