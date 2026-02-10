import { subAgentRegistry } from '../registry'
import { createSubAgentTool } from '../create-tool'
import { toolRegistry } from '../../tool-registry'
import { useSettingsStore } from '@renderer/stores/settings-store'
import type { ProviderConfig } from '../../../api/types'

import { codeSearchAgent } from './code-search'
import { codeReviewAgent } from './code-review'
import { plannerAgent } from './planner'

const builtinAgents = [codeSearchAgent, codeReviewAgent, plannerAgent]

/**
 * Register all built-in SubAgents in both the SubAgent registry
 * and the tool registry (so the main agent can invoke them as tools).
 */
export function registerBuiltinSubAgents(): void {
  const providerGetter = (): ProviderConfig => {
    const s = useSettingsStore.getState()
    return {
      type: s.provider,
      apiKey: s.apiKey,
      baseUrl: s.baseUrl || undefined,
      model: s.model,
      maxTokens: s.maxTokens,
      temperature: s.temperature,
    }
  }

  for (const def of builtinAgents) {
    subAgentRegistry.register(def)
    toolRegistry.register(createSubAgentTool(def, providerGetter))
  }
}
