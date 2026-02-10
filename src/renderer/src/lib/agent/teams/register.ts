import { toolRegistry } from '../tool-registry'
import { teamEvents } from './events'
import { useTeamStore } from '../../../stores/team-store'
import { useUIStore } from '../../../stores/ui-store'
import { teamCreateTool } from './tools/team-create'
import { taskCreateTool } from './tools/task-create'
import { taskUpdateTool } from './tools/task-update'
import { taskListTool } from './tools/task-list'
import { spawnTeammateTool } from './tools/spawn-teammate'
import { sendMessageTool } from './tools/send-message'
import { teamDeleteTool } from './tools/team-delete'

const TEAM_TOOLS = [
  teamCreateTool,
  taskCreateTool,
  taskUpdateTool,
  taskListTool,
  spawnTeammateTool,
  sendMessageTool,
  teamDeleteTool,
]

/** All team tool names for identification in UI rendering */
export const TEAM_TOOL_NAMES = new Set(TEAM_TOOLS.map((t) => t.definition.name))

/**
 * Register all Agent Team tools into the global tool registry
 * and set up the persistent teamEvents → team-store subscription.
 *
 * Call this once at application startup. The event subscription is
 * global and never unsubscribed — teammate agent loops outlive the
 * lead's agent loop, so scoped subscriptions would lose events.
 */
export function registerTeamTools(): void {
  for (const tool of TEAM_TOOLS) {
    toolRegistry.register(tool)
  }

  // Persistent global subscription: forward all team events to the store
  teamEvents.on((event) => {
    useTeamStore.getState().handleTeamEvent(event)

    // Auto-switch to Team tab when a team is created
    if (event.type === 'team_start') {
      const ui = useUIStore.getState()
      ui.setRightPanelOpen(true)
      ui.setRightPanelTab('team')
    }
  })
}
