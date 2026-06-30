import { getNativeWorker } from '../lib/native-worker'

export interface TaskRow {
  id: string
  session_id: string
  plan_id: string | null
  subject: string
  description: string
  active_form: string | null
  status: string
  owner: string | null
  blocks: string
  blocked_by: string
  metadata: string | null
  sort_order: number
  created_at: number
  updated_at: number
}

interface TaskFindResult {
  success: boolean
  task?: TaskRow | null
  error?: string | null
}

interface TaskMutationResult {
  success: boolean
  changed: number
  error?: string | null
}

async function requestMutation(method: string, params: object): Promise<TaskMutationResult> {
  const result = await getNativeWorker().request<TaskMutationResult>(method, params, 120_000)
  if (!result.success) {
    throw new Error(result.error || `Native task mutation failed: ${method}`)
  }
  return result
}

export function listTasksBySession(sessionId: string): Promise<TaskRow[]> {
  return getNativeWorker().request<TaskRow[]>('db/tasks-list-by-session', { sessionId }, 120_000)
}

export async function getTask(id: string): Promise<TaskRow | undefined> {
  const result = await getNativeWorker().request<TaskFindResult>('db/tasks-get', { id }, 120_000)
  if (!result.success) {
    throw new Error(result.error || 'Native task get failed')
  }
  return result.task ?? undefined
}

export async function createTask(task: {
  id: string
  sessionId: string
  planId?: string
  subject: string
  description: string
  activeForm?: string
  status?: string
  owner?: string
  blocks?: string[]
  blockedBy?: string[]
  metadata?: Record<string, unknown>
  sortOrder: number
  createdAt: number
  updatedAt: number
}): Promise<void> {
  await requestMutation('db/tasks-create', task)
}

export async function updateTask(
  id: string,
  patch: Partial<{
    subject: string
    description: string
    activeForm: string | null
    status: string
    owner: string | null
    blocks: string[]
    blockedBy: string[]
    metadata: Record<string, unknown> | null
    sortOrder: number
    updatedAt: number
  }>
): Promise<void> {
  await requestMutation('db/tasks-update', { id, patch })
}

export async function deleteTask(id: string): Promise<void> {
  await requestMutation('db/tasks-delete', { id })
}

export async function deleteTasksBySession(sessionId: string): Promise<void> {
  await requestMutation('db/tasks-delete-by-session', { sessionId })
}
