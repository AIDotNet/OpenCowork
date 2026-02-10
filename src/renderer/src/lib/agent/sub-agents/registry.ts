import type { SubAgentDefinition } from './types'

/**
 * SubAgent Registry — manages available SubAgent definitions.
 * Similar pattern to ToolRegistry but for SubAgents.
 */
class SubAgentRegistry {
  private agents = new Map<string, SubAgentDefinition>()

  register(def: SubAgentDefinition): void {
    this.agents.set(def.name, def)
  }

  unregister(name: string): void {
    this.agents.delete(name)
  }

  get(name: string): SubAgentDefinition | undefined {
    return this.agents.get(name)
  }

  has(name: string): boolean {
    return this.agents.has(name)
  }

  getAll(): SubAgentDefinition[] {
    return Array.from(this.agents.values())
  }

  getNames(): string[] {
    return Array.from(this.agents.keys())
  }
}

export const subAgentRegistry = new SubAgentRegistry()
