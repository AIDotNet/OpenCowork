import { getNativeWorker } from '../lib/native-worker'

export interface DrawRunRow {
  id: string
  prompt: string
  provider_name: string
  model_name: string
  mode: string
  meta_json: string | null
  created_at: number
  is_generating: number
  images_json: string
  error_json: string | null
  updated_at: number
}

interface DrawRunMutationResult {
  success: boolean
  changed: number
  error?: string | null
}

function assertMutation(result: DrawRunMutationResult, operation: string): void {
  if (!result.success) {
    throw new Error(result.error || `Native draw run ${operation} failed`)
  }
}

export function listDrawRuns(): Promise<DrawRunRow[]> {
  return getNativeWorker().request<DrawRunRow[]>('db/draw-runs-list', {}, 120_000)
}

export async function saveDrawRun(run: {
  id: string
  prompt: string
  providerName: string
  modelName: string
  mode?: string
  metaJson?: string | null
  createdAt: number
  isGenerating: boolean
  imagesJson: string
  errorJson?: string | null
  updatedAt: number
}): Promise<void> {
  const result = await getNativeWorker().request<DrawRunMutationResult>(
    'db/draw-runs-save',
    run,
    120_000
  )
  assertMutation(result, 'save')
}

export async function deleteDrawRun(id: string): Promise<void> {
  const result = await getNativeWorker().request<DrawRunMutationResult>(
    'db/draw-runs-delete',
    { id },
    120_000
  )
  assertMutation(result, 'delete')
}

export async function clearDrawRuns(): Promise<void> {
  const result = await getNativeWorker().request<DrawRunMutationResult>(
    'db/draw-runs-clear',
    {},
    120_000
  )
  assertMutation(result, 'clear')
}
