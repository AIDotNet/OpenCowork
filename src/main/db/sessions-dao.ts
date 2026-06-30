import { getNativeWorker } from '../lib/native-worker'

export interface SessionRow {
  id: string
  title: string
  icon: string | null
  mode: string
  created_at: number
  updated_at: number
  project_id: string | null
  working_folder: string | null
  ssh_connection_id: string | null
  plan_id: string | null
  pinned: number
  plugin_id: string | null
  provider_id: string | null
  model_id: string | null
  model_selection_mode: string | null
  message_count?: number
}

interface SessionFindResult {
  success: boolean
  session?: SessionRow | null
  error?: string | null
}

interface SessionMutationResult {
  success: boolean
  changed: number
  error?: string | null
}

interface SessionClearAllResult {
  success: boolean
  sessionIds: string[]
  deletedMessages: number
  deletedSessions: number
  error?: string | null
}

async function requestMutation(method: string, params: object): Promise<SessionMutationResult> {
  const result = await getNativeWorker().request<SessionMutationResult>(method, params, 120_000)
  if (!result.success) {
    throw new Error(result.error || `Native session mutation failed: ${method}`)
  }
  return result
}

export function listSessions(limit = 2000, offset = 0): Promise<SessionRow[]> {
  return getNativeWorker().request<SessionRow[]>('db/sessions-list', { limit, offset }, 120_000)
}

export async function getSession(id: string): Promise<SessionRow | undefined> {
  const result = await getNativeWorker().request<SessionFindResult>(
    'db/sessions-get',
    { id },
    120_000
  )
  if (!result.success) {
    throw new Error(result.error || 'Native session get failed')
  }
  return result.session ?? undefined
}

export async function createSession(session: {
  id: string
  title: string
  icon?: string
  mode: string
  createdAt: number
  updatedAt: number
  projectId?: string | null
  workingFolder?: string
  sshConnectionId?: string
  planId?: string | null
  pinned?: boolean
  pluginId?: string
  providerId?: string
  modelId?: string
  modelSelectionMode?: string
}): Promise<void> {
  await requestMutation('db/sessions-create', session)
}

export async function updateSession(
  id: string,
  patch: Partial<{
    title: string
    icon: string | null
    mode: string
    updatedAt: number
    projectId: string | null
    workingFolder: string | null
    sshConnectionId: string | null
    planId: string | null
    pinned: boolean
    pluginId: string | null
    providerId: string | null
    modelId: string | null
    modelSelectionMode: string | null
  }>
): Promise<void> {
  await requestMutation('db/sessions-update', { id, patch })
}

export async function deleteSession(id: string): Promise<void> {
  await requestMutation('db/sessions-delete', { id })
}

export async function clearAllSessions(): Promise<SessionClearAllResult> {
  const result = await getNativeWorker().request<SessionClearAllResult>(
    'db/sessions-clear-all',
    {},
    120_000
  )
  if (!result.success) {
    throw new Error(result.error || 'Native session clear-all failed')
  }
  return result
}
