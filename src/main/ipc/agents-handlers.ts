import { registerMessagePackHandler } from './messagepack-handler'
import {
  ensureNativeUserContent,
  getBundledResourceDirCandidates,
  nativeUserContentRequest
} from './user-content-native'

export interface AgentInfo {
  name: string
  description: string
  icon?: string
  tools: string[]
  allowedTools: string[]
  disallowedTools: string[]
  maxTurns: number
  maxIterations: number
  initialPrompt?: string
  background?: boolean
  model?: string
  temperature?: number
  systemPrompt: string
}

export interface AgentManageItem {
  id: string
  name: string
  description: string
  path: string
  source: 'user'
  editable: true
}

type AgentManageReadResult =
  | (AgentManageItem & {
      content: string
    })
  | { error: string }

type AgentMutationResult = {
  success: boolean
  error?: string
}

function agentParams(args: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...args,
    bundledDirCandidates: getBundledResourceDirCandidates('agents')
  }
}

export function registerAgentsHandlers(): void {
  ensureNativeUserContent('agents/ensure', agentParams())

  registerMessagePackHandler<undefined, AgentInfo[]>('agents:list', async () => {
    return nativeUserContentRequest<AgentInfo[]>('agents/list', agentParams())
  })

  registerMessagePackHandler<{ name: string }, AgentInfo | { error: string }>(
    'agents:load',
    async (args) => {
      return nativeUserContentRequest<AgentInfo | { error: string }>(
        'agents/load',
        agentParams(args)
      )
    }
  )

  registerMessagePackHandler<undefined, AgentManageItem[]>('agents:manage-list', async () => {
    return nativeUserContentRequest<AgentManageItem[]>('agents/manage-list', agentParams())
  })

  registerMessagePackHandler<{ path: string }, AgentManageReadResult>(
    'agents:manage-read',
    async (args) => {
      return nativeUserContentRequest<AgentManageReadResult>(
        'agents/manage-read',
        agentParams(args)
      )
    }
  )

  registerMessagePackHandler<{ path: string; content: string }, AgentMutationResult>(
    'agents:manage-save',
    async (args) => {
      return nativeUserContentRequest<AgentMutationResult>(
        'agents/manage-save',
        agentParams(args)
      )
    }
  )
}
