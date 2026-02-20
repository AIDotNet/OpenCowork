import { registerTaskTools } from './todo-tool'
import { registerFsTools } from './fs-tool'
import { registerSearchTools } from './search-tool'
import { registerBashTools } from './bash-tool'
import { registerBuiltinSubAgents } from '../agent/sub-agents/builtin'
import { registerTeamTools } from '../agent/teams/register'
import { registerSkillTools } from './skill-tool'
import { registerPreviewTools } from './preview-tool'
import { registerAskUserTools } from './ask-user-tool'
import { registerPlanTools } from './plan-tool'
import { registerCronTools } from './cron-tool'
import { registerNotifyTool } from './notify-tool'

/**
 * Register all built-in tools with the global tool registry.
 * Call this once at app initialization.
 *
 * SubAgents are registered AFTER regular tools because they
 * reference tool definitions from the registry.
 * Team tools are registered last.
 *
 * This is async because SubAgent definitions are loaded from
 * .md files via IPC from the main process.
 */
let _allToolsRegistered = false

export async function registerAllTools(): Promise<void> {
  if (_allToolsRegistered) return
  _allToolsRegistered = true

  registerTaskTools()
  registerFsTools()
  registerSearchTools()
  registerBashTools()
  await registerSkillTools()
  registerPreviewTools()
  registerAskUserTools()
  registerPlanTools()
  registerCronTools()
  registerNotifyTool()

  // SubAgents (loaded from ~/.open-cowork/agents/*.md via IPC, then registered as unified Task tool)
  await registerBuiltinSubAgents()

  // Agent Team tools
  registerTeamTools()

  // Plugin tools are registered/unregistered dynamically via plugin-store toggle
  // They are NOT registered here — see plugin-tools.ts registerPluginTools/unregisterPluginTools
}
