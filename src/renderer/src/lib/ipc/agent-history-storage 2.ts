import { ipcClient } from './ipc-client'

export interface AgentHistoryApplyRequest<T> {
  upserts?: T[]
  removeIds?: string[]
  removeSessionIds?: string[]
}

export interface AgentHistoryIndex {
  total: number
  sessions: Array<{
    sessionId: string
    count: number
    latestStartedAt: number
  }>
}

export async function readAgentHistoryIndex(): Promise<AgentHistoryIndex> {
  return (await ipcClient.invoke('agent-history:index')) as AgentHistoryIndex
}

export async function readAgentHistory<T>(sessionId: string): Promise<T[]> {
  return (await ipcClient.invoke('agent-history:read', { sessionId })) as T[]
}

export async function applyAgentHistory<T>(request: AgentHistoryApplyRequest<T>): Promise<void> {
  await ipcClient.invoke('agent-history:apply', request)
}

export async function replaceAgentHistory(snapshot: unknown): Promise<void> {
  await ipcClient.invoke('agent-history:replace', { snapshot })
}
