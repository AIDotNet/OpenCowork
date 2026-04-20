import { registerTaskTools } from './todo-tool'
import { registerFsTools } from './fs-tool'
import { registerSearchTools } from './search-tool'
import {
  registerWebSearchTool,
  unregisterWebSearchTool,
  isWebSearchToolRegistered
} from './web-search-tool'
import {
  registerBrowserTool,
  unregisterBrowserTool,
  isBrowserToolRegistered
} from './browser-tool'
import { registerBashTools } from './bash-tool'
import { registerSubAgents } from '../agent/sub-agents/builtin'
import { registerTeamTools } from '../agent/teams/register'
import { registerSkillTools } from './skill-tool'
import { registerWidgetTools } from './widget-tool'
import { registerAskUserTools } from './ask-user-tool'
import { registerPlanTools } from './plan-tool'
import { registerCronTools } from './cron-tool'
import { registerNotifyTool } from './notify-tool'
import { updateWikiToolRegistration } from './wiki-tool'

let _allToolsRegistered = false

export async function registerAllTools(): Promise<void> {
  if (_allToolsRegistered) return
  _allToolsRegistered = true

  registerTaskTools()
  registerFsTools()
  registerSearchTools()
  // Note: WebSearchTool is NOT registered here — it's registered/unregistered dynamically
  // based on the webSearchEnabled setting (see web-search-tool.ts)
  registerBashTools()
  await registerSkillTools()
  registerWidgetTools()
  registerAskUserTools()
  registerPlanTools()
  registerCronTools()
  registerNotifyTool()

  // SubAgents (dynamically loaded from ~/.open-cowork/agents/*.md via IPC, then registered as unified Task tool)
  await registerSubAgents()

  // Agent Team tools
  registerTeamTools()

  // Plugin tools are registered/unregistered dynamically via channel-store toggle
  // They are NOT registered here — see plugin-tools.ts registerPluginTools/unregisterPluginTools
}

export function updateWebSearchToolRegistration(enabled: boolean): void {
  const isRegistered = isWebSearchToolRegistered()
  if (enabled && !isRegistered) {
    registerWebSearchTool()
  } else if (!enabled && isRegistered) {
    unregisterWebSearchTool()
  }
}

export function updateBrowserToolRegistration(enabled: boolean): void {
  const isRegistered = isBrowserToolRegistered()
  if (enabled && !isRegistered) {
    registerBrowserTool()
  } else if (!enabled && isRegistered) {
    unregisterBrowserTool()
  }
}

export { updateWikiToolRegistration }
