import * as os from 'os'
import * as path from 'path'
import { getNativeWorker } from '../lib/native-worker'
import { readSettings } from '../ipc/settings-handlers'

export interface ProjectRow {
  id: string
  name: string
  working_folder: string | null
  ssh_connection_id: string | null
  plugin_id: string | null
  pinned: number
  created_at: number
  updated_at: number
  session_count: number
}

interface ProjectFindResult {
  success: boolean
  project?: ProjectRow | null
  error?: string | null
}

export interface ProjectDeleteResult {
  success: boolean
  deleted: boolean
  projectId?: string | null
  sessionIds: string[]
  error?: string | null
}

function getPreferredLocalProjectBaseDirectory(): string {
  const settings = readSettings()
  const mode = settings.projectDefaultDirectoryMode
  const customDir =
    typeof settings.projectDefaultDirectory === 'string'
      ? settings.projectDefaultDirectory.trim()
      : ''
  const lastUsedDir =
    typeof settings.lastProjectDirectory === 'string' ? settings.lastProjectDirectory.trim() : ''

  if (mode === 'custom' && customDir) {
    return customDir
  }
  if (lastUsedDir) {
    return lastUsedDir
  }
  return path.join(os.homedir(), 'Documents')
}

function withProjectBaseDirectory<T extends object>(params: T): T & { baseDirectory: string } {
  return {
    ...params,
    baseDirectory: getPreferredLocalProjectBaseDirectory()
  }
}

export function listProjects(): Promise<ProjectRow[]> {
  return getNativeWorker().request<ProjectRow[]>('db/projects-list', {}, 120_000)
}

export async function getProject(id: string): Promise<ProjectRow | undefined> {
  const result = await getNativeWorker().request<ProjectFindResult>(
    'db/projects-get',
    { id },
    120_000
  )
  if (!result.success) {
    throw new Error(result.error || 'Native project get failed')
  }
  return result.project ?? undefined
}

export async function findProjectByPluginId(pluginId: string): Promise<ProjectRow | undefined> {
  const result = await getNativeWorker().request<ProjectFindResult>(
    'db/projects-find-by-plugin',
    { pluginId },
    120_000
  )
  if (!result.success) {
    throw new Error(result.error || 'Native project plugin lookup failed')
  }
  return result.project ?? undefined
}

export function createProject(project: {
  id?: string
  name: string
  workingFolder?: string | null
  sshConnectionId?: string | null
  pluginId?: string | null
  pinned?: boolean
  createdAt?: number
  updatedAt?: number
}): Promise<ProjectRow> {
  return getNativeWorker().request<ProjectRow>(
    'db/projects-create',
    withProjectBaseDirectory(project),
    120_000
  )
}

export async function updateProject(
  id: string,
  patch: Partial<{
    name: string
    workingFolder: string | null
    sshConnectionId: string | null
    pluginId: string | null
    pinned: boolean
    updatedAt: number
  }>
): Promise<void> {
  const result = await getNativeWorker().request<ProjectFindResult>(
    'db/projects-update',
    withProjectBaseDirectory({ id, patch }),
    120_000
  )
  if (!result.success) {
    throw new Error(result.error || 'Native project update failed')
  }
}

export async function deleteProject(id: string): Promise<ProjectDeleteResult | null> {
  const result = await getNativeWorker().request<ProjectDeleteResult>(
    'db/projects-delete',
    { id },
    120_000
  )
  if (!result.success) {
    throw new Error(result.error || 'Native project delete failed')
  }
  return result.deleted ? result : null
}

export function ensureDefaultProject(): Promise<ProjectRow> {
  return getNativeWorker().request<ProjectRow>(
    'db/projects-ensure-default',
    withProjectBaseDirectory({}),
    120_000
  )
}

export function ensurePluginProject(pluginId: string, preferredName?: string): Promise<ProjectRow> {
  return getNativeWorker().request<ProjectRow>(
    'db/projects-ensure-plugin',
    withProjectBaseDirectory({ pluginId, preferredName }),
    120_000
  )
}
