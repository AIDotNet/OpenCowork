import { getNativeWorker } from '../lib/native-worker'

export interface PlanRow {
  id: string
  session_id: string
  title: string
  status: string
  file_path: string | null
  content: string | null
  spec_json: string | null
  created_at: number
  updated_at: number
}

interface PlanFindResult {
  success: boolean
  plan?: PlanRow | null
  error?: string | null
}

interface PlanMutationResult {
  success: boolean
  changed: number
  error?: string | null
}

async function requestMutation(method: string, params: object): Promise<PlanMutationResult> {
  const result = await getNativeWorker().request<PlanMutationResult>(method, params, 120_000)
  if (!result.success) {
    throw new Error(result.error || `Native plan mutation failed: ${method}`)
  }
  return result
}

export function listPlans(): Promise<PlanRow[]> {
  return getNativeWorker().request<PlanRow[]>('db/plans-list', {}, 120_000)
}

export async function getPlan(id: string): Promise<PlanRow | undefined> {
  const result = await getNativeWorker().request<PlanFindResult>('db/plans-get', { id }, 120_000)
  if (!result.success) {
    throw new Error(result.error || 'Native plan get failed')
  }
  return result.plan ?? undefined
}

export async function getPlanBySession(sessionId: string): Promise<PlanRow | undefined> {
  const result = await getNativeWorker().request<PlanFindResult>(
    'db/plans-get-by-session',
    { sessionId },
    120_000
  )
  if (!result.success) {
    throw new Error(result.error || 'Native plan session lookup failed')
  }
  return result.plan ?? undefined
}

export async function createPlan(plan: {
  id: string
  sessionId: string
  title: string
  status?: string
  filePath?: string
  content?: string
  specJson?: string
  createdAt: number
  updatedAt: number
}): Promise<void> {
  await requestMutation('db/plans-create', plan)
}

export async function updatePlan(
  id: string,
  patch: Partial<{
    title: string
    status: string
    filePath: string | null
    content: string | null
    specJson: string | null
    updatedAt: number
  }>
): Promise<void> {
  await requestMutation('db/plans-update', { id, patch })
}

export async function deletePlan(id: string): Promise<void> {
  await requestMutation('db/plans-delete', { id })
}
