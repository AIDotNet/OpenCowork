import { IPC } from '@renderer/lib/ipc/channels'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { useProjectsStore } from './draw-projects-store'

interface WorkspaceResult {
  workspacePath: string
}

export async function ensureDrawAgentWorkspace(projectId: string): Promise<string> {
  const store = useProjectsStore.getState()
  const project = store.projects.find((candidate) => candidate.id === projectId)
  if (!project) throw new Error('Canvas project not found')
  const result = (await ipcClient.invoke(IPC.DRAW_AGENT_WORKSPACE_ENSURE, {
    projectId,
    name: project.name,
    workspacePath: project.workspacePath
  })) as WorkspaceResult
  store.setWorkspacePath(projectId, result.workspacePath)
  return result.workspacePath
}

export async function renameDrawAgentWorkspace(projectId: string, name: string): Promise<string> {
  const store = useProjectsStore.getState()
  const project = store.projects.find((candidate) => candidate.id === projectId)
  if (!project) throw new Error('Canvas project not found')
  const workspacePath = project.workspacePath ?? (await ensureDrawAgentWorkspace(projectId))
  const result = (await ipcClient.invoke(IPC.DRAW_AGENT_WORKSPACE_RENAME, {
    projectId,
    name,
    workspacePath
  })) as WorkspaceResult
  store.setWorkspacePath(projectId, result.workspacePath)
  return result.workspacePath
}

export async function trashDrawAgentWorkspace(projectId: string): Promise<boolean> {
  const project = useProjectsStore
    .getState()
    .projects.find((candidate) => candidate.id === projectId)
  if (!project?.workspacePath) return false
  const result = (await ipcClient.invoke(IPC.DRAW_AGENT_WORKSPACE_TRASH, {
    workspacePath: project.workspacePath
  })) as { trashed: boolean }
  return result.trashed
}
