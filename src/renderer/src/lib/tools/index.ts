import { registerTodoTools } from './todo-tool'
import { registerFsTools } from './fs-tool'
import { registerSearchTools } from './search-tool'
import { registerBashTools } from './bash-tool'
import { registerBuiltinSubAgents } from '../agent/sub-agents/builtin'

/**
 * Register all built-in tools with the global tool registry.
 * Call this once at app initialization.
 *
 * SubAgents are registered AFTER regular tools because they
 * reference tool definitions from the registry.
 */
export function registerAllTools(): void {
  registerTodoTools()
  registerFsTools()
  registerSearchTools()
  registerBashTools()

  // SubAgents (registered as tools so the main agent can invoke them)
  registerBuiltinSubAgents()
}
