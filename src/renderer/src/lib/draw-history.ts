import type { ImageErrorCode } from '@renderer/lib/api/types'
import { invokeMessagePackBinary } from '@renderer/lib/ipc/messagepack-ipc-client'
import {
  DB_DRAW_RUNS_CLEAR_MSGPACK_CHANNEL,
  DB_DRAW_RUNS_DELETE_MSGPACK_CHANNEL,
  DB_DRAW_RUNS_LIST_MSGPACK_CHANNEL,
  DB_DRAW_RUNS_SAVE_MSGPACK_CHANNEL
} from '../../../shared/messagepack/binary-ipc'

export type DrawRunMode = 'image' | 'gif'

export type DrawRunImageKind = 'generated' | 'gif-grid' | 'gif-frame' | 'gif-output'

export type DrawGifInputMode = 'text' | 'reference'

export interface DrawRunImage {
  id: string
  src: string
  mediaType?: string
  filePath?: string
  kind?: DrawRunImageKind
  label?: string
  frameIndex?: number
}

export interface DrawGifInputSnapshot {
  inputMode: DrawGifInputMode
  characterPrompt: string
  stylePrompt: string
  actionPrompt: string
  referenceImage: {
    dataUrl: string
    mediaType: string
  } | null
  frameDurationMs: number
  gridSize: number
  stage?: 'requesting' | 'processing' | 'completed'
}

export interface DrawRunMeta {
  providerId?: string
  modelId?: string
  requestType?: string
  baseUrl?: string
  gif?: DrawGifInputSnapshot
}

export interface DrawRunError {
  code: ImageErrorCode
  message: string
  details?: string
}

export interface DrawRun {
  id: string
  prompt: string
  providerName: string
  modelName: string
  mode: DrawRunMode
  meta: DrawRunMeta | null
  createdAt: number
  isGenerating: boolean
  images: DrawRunImage[]
  error: DrawRunError | null
  previewImage?: DrawRunImage
  previewImageIndex?: number
}

interface DrawRunRow {
  id: string
  prompt: string
  provider_name: string
  model_name: string
  mode: string | null
  meta_json: string | null
  created_at: number
  is_generating: number
  images_json: string
  error_json: string | null
}

function safeParseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function normalizeRun(run: DrawRun, interruptedMessage: string, isStillActive: boolean): DrawRun {
  if (!run.isGenerating || isStillActive) return run

  return {
    ...run,
    isGenerating: false,
    error:
      run.error ??
      (run.images.length === 0
        ? {
            code: 'request_aborted',
            message: interruptedMessage
          }
        : null)
  }
}

function fromRow(
  row: DrawRunRow,
  interruptedMessage: string,
  activeRunIds: ReadonlySet<string>
): DrawRun {
  const run: DrawRun = {
    id: row.id,
    prompt: row.prompt,
    providerName: row.provider_name,
    modelName: row.model_name,
    mode: row.mode === 'gif' ? 'gif' : 'image',
    meta: safeParseJson<DrawRunMeta | null>(row.meta_json, null),
    createdAt: row.created_at,
    isGenerating: row.is_generating === 1,
    images: safeParseJson<DrawRunImage[]>(row.images_json, []),
    error: safeParseJson<DrawRunError | null>(row.error_json, null)
  }

  return normalizeRun(run, interruptedMessage, activeRunIds.has(row.id))
}

export async function listPersistedDrawRuns(
  interruptedMessage: string,
  options?: { activeRunIds?: ReadonlySet<string> }
): Promise<DrawRun[]> {
  const rows = await invokeMessagePackBinary<DrawRunRow[]>(DB_DRAW_RUNS_LIST_MSGPACK_CHANNEL, {})
  const activeRunIds = options?.activeRunIds ?? new Set<string>()
  const runs = rows.map((row) => fromRow(row, interruptedMessage, activeRunIds))

  await Promise.all(
    rows.map((row, index) => {
      if (row.is_generating !== 1 || activeRunIds.has(row.id)) return Promise.resolve()
      return savePersistedDrawRun(runs[index]).catch(() => undefined)
    })
  )

  return runs
}

export async function savePersistedDrawRun(run: DrawRun): Promise<void> {
  await invokeMessagePackBinary(DB_DRAW_RUNS_SAVE_MSGPACK_CHANNEL, {
    id: run.id,
    prompt: run.prompt,
    providerName: run.providerName,
    modelName: run.modelName,
    mode: run.mode,
    metaJson: run.meta ? JSON.stringify(run.meta) : null,
    createdAt: run.createdAt,
    isGenerating: run.isGenerating,
    imagesJson: JSON.stringify(run.images),
    errorJson: run.error ? JSON.stringify(run.error) : null,
    updatedAt: Date.now()
  })
}

export async function deletePersistedDrawRun(id: string): Promise<void> {
  await invokeMessagePackBinary(DB_DRAW_RUNS_DELETE_MSGPACK_CHANNEL, id)
}

export async function clearPersistedDrawRuns(): Promise<void> {
  await invokeMessagePackBinary(DB_DRAW_RUNS_CLEAR_MSGPACK_CHANNEL, {})
}
