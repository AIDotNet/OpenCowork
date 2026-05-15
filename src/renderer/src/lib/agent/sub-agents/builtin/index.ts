import { subAgentRegistry } from '../registry'
import { createTaskTool } from '../create-tool'
import { toolRegistry } from '../../tool-registry'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useProviderStore } from '@renderer/stores/provider-store'
import type { ProviderConfig } from '../../../api/types'
import type { SubAgentDefinition } from '../types'
import { ipcClient } from '../../../ipc/ipc-client'
import { resolveSubAgentMaxTurns } from '../limits'

/** Shape returned by the agents:list IPC handler */
interface AgentInfo {
  name: string
  description: string
  icon?: string
  tools?: string[]
  allowedTools?: string[]
  disallowedTools?: string[]
  maxTurns?: number
  maxIterations?: number
  initialPrompt?: string
  background?: boolean
  model?: string
  temperature?: number
  systemPrompt: string
}

/** Convert an IPC AgentInfo into a SubAgentDefinition */
function toDefinition(info: AgentInfo): SubAgentDefinition {
  return {
    name: info.name,
    description: info.description,
    icon: info.icon,
    tools: info.tools ?? info.allowedTools ?? ['Read', 'Glob', 'Grep', 'LS', 'Bash'],
    disallowedTools: info.disallowedTools ?? [],
    maxTurns: resolveSubAgentMaxTurns(info.maxTurns ?? info.maxIterations),
    initialPrompt: info.initialPrompt,
    background: info.background,
    model: info.model,
    temperature: info.temperature,
    systemPrompt: info.systemPrompt,
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'The detailed task for the sub-agent to perform'
        }
      },
      required: ['prompt']
    }
  }
}

function getProviderConfig(): ProviderConfig {
  const s = useSettingsStore.getState()
  const store = useProviderStore.getState()
  const fastConfig = store.getFastProviderConfig()
  if (fastConfig && (fastConfig.apiKey || fastConfig.requiresApiKey === false)) {
    return {
      ...fastConfig,
      maxTokens: store.getEffectiveMaxTokens(s.maxTokens, fastConfig.model),
      temperature: s.temperature
    }
  }
  const fallbackModel = s.model
  return {
    type: s.provider,
    apiKey: s.apiKey,
    baseUrl: s.baseUrl || undefined,
    model: fallbackModel,
    maxTokens: store.getEffectiveMaxTokens(s.maxTokens, fallbackModel),
    temperature: s.temperature
  }
}

/**
 * Load all agent .md files from ~/.open-cowork/agents/ via IPC,
 * register them in the SubAgent registry, then register one unified
 * "Task" tool in the tool registry.
 *
 * This is async because it reads files via IPC from the main process.
 */
export async function registerSubAgents(): Promise<void> {
  try {
    const agents = (await ipcClient.invoke('agents:list')) as AgentInfo[]
    if (Array.isArray(agents)) {
      for (const info of agents) {
        subAgentRegistry.register(toDefinition(info))
      }
    }
  } catch (err) {
    console.error('[SubAgents] Failed to load agents from IPC:', err)
  }

  // Register one unified Task tool that dispatches by subagent_type
  // (works even if no agents were loaded — will produce an empty enum)
  toolRegistry.register(createTaskTool(getProviderConfig))
}
