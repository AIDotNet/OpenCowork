import type {
  ImageBlock,
  ResponsesImageGenerationAction,
  ResponsesImageGenerationBackground,
  ResponsesImageGenerationConfig,
  ResponsesImageGenerationInputMask,
  ResponsesImageGenerationInputFidelity,
  ResponsesImageGenerationModeration,
  ResponsesImageGenerationOutputFormat,
  ResponsesImageGenerationQuality,
  ResponsesImageGenerationSize
} from './types'
import { ipcClient } from '../ipc/ipc-client'

export const RESPONSES_IMAGE_GENERATION_DEFAULT_OPTION = 'default'
export const RESPONSES_IMAGE_GENERATION_DEFAULT_PARTIAL_IMAGES = 3

export const RESPONSES_IMAGE_GENERATION_ACTIONS: ResponsesImageGenerationAction[] = [
  'auto',
  'generate',
  'edit'
]

export const RESPONSES_IMAGE_GENERATION_BACKGROUNDS: ResponsesImageGenerationBackground[] = [
  'auto',
  'transparent',
  'opaque'
]

export const RESPONSES_IMAGE_GENERATION_INPUT_FIDELITIES: ResponsesImageGenerationInputFidelity[] =
  ['low', 'high']

export const RESPONSES_IMAGE_GENERATION_MODERATIONS: ResponsesImageGenerationModeration[] = [
  'auto',
  'low'
]

export const RESPONSES_IMAGE_GENERATION_OUTPUT_FORMATS: ResponsesImageGenerationOutputFormat[] = [
  'png',
  'webp',
  'jpeg'
]

export const RESPONSES_IMAGE_GENERATION_QUALITIES: ResponsesImageGenerationQuality[] = [
  'auto',
  'low',
  'medium',
  'high'
]

export const RESPONSES_IMAGE_GENERATION_SIZES: ResponsesImageGenerationSize[] = [
  'auto',
  '1024x1024',
  '1024x1536',
  '1536x1024'
]

function clampInteger(value: number, min: number, max?: number): number {
  const normalized = Math.floor(value)
  if (normalized < min) return min
  if (max !== undefined && normalized > max) return max
  return normalized
}

export function normalizeResponsesImageGenerationConfig(
  config?: ResponsesImageGenerationConfig | null
): ResponsesImageGenerationConfig {
  return {
    ...(config ?? {}),
    enabled: config?.enabled ?? true,
    ...(normalizeResponsesImageGenerationInputMask(config?.inputImageMask)
      ? { inputImageMask: normalizeResponsesImageGenerationInputMask(config?.inputImageMask) }
      : {}),
    partialImages:
      normalizeResponsesImageGenerationPartialImages(config?.partialImages) ??
      RESPONSES_IMAGE_GENERATION_DEFAULT_PARTIAL_IMAGES
  }
}

export function isResponsesImageGenerationEnabled(
  config?: ResponsesImageGenerationConfig | null
): boolean {
  return normalizeResponsesImageGenerationConfig(config).enabled !== false
}

export function normalizeResponsesImageGenerationOutputCompression(
  value: unknown
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return clampInteger(value, 0, 100)
}

export function normalizeResponsesImageGenerationPartialImages(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return clampInteger(value, 0)
}

export function normalizeResponsesImageGenerationInputMask(
  value: ResponsesImageGenerationInputMask | null | undefined
): ResponsesImageGenerationInputMask | undefined {
  if (!value) return undefined

  const fileId = typeof value.fileId === 'string' ? value.fileId.trim() : ''
  const imageUrl = typeof value.imageUrl === 'string' ? value.imageUrl.trim() : ''

  if (!fileId && !imageUrl) return undefined

  return {
    ...(fileId ? { fileId } : {}),
    ...(imageUrl ? { imageUrl } : {})
  }
}

export function buildResponsesImageGenerationTool(
  config?: ResponsesImageGenerationConfig | null
): Record<string, unknown> | null {
  if (!isResponsesImageGenerationEnabled(config)) return null

  const normalized = normalizeResponsesImageGenerationConfig(config)
  const tool: Record<string, unknown> = { type: 'image_generation' }

  if (normalized.action) tool.action = normalized.action
  if (normalized.background) tool.background = normalized.background
  if (normalized.inputFidelity) tool.input_fidelity = normalized.inputFidelity
  if (normalized.inputImageMask) {
    tool.input_image_mask = {
      ...(normalized.inputImageMask.fileId ? { file_id: normalized.inputImageMask.fileId } : {}),
      ...(normalized.inputImageMask.imageUrl
        ? { image_url: normalized.inputImageMask.imageUrl }
        : {})
    }
  }
  if (normalized.moderation) tool.moderation = normalized.moderation
  if (normalized.outputFormat) tool.output_format = normalized.outputFormat
  if (normalized.quality) tool.quality = normalized.quality
  if (normalized.size) tool.size = normalized.size

  const outputCompression = normalizeResponsesImageGenerationOutputCompression(
    normalized.outputCompression
  )
  if (outputCompression !== undefined) tool.output_compression = outputCompression

  const partialImages = normalizeResponsesImageGenerationPartialImages(normalized.partialImages)
  if (partialImages !== undefined) tool.partial_images = partialImages

  return tool
}

export function inferResponsesImageGenerationOutputFormat(
  mediaType?: string | null
): ResponsesImageGenerationOutputFormat | undefined {
  switch ((mediaType ?? '').trim().toLowerCase()) {
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpeg'
    case 'image/webp':
      return 'webp'
    case 'image/png':
      return 'png'
    default:
      return undefined
  }
}

export function getResponsesImageGenerationMediaType(
  outputFormat?: string | null
): string | undefined {
  switch ((outputFormat ?? '').trim().toLowerCase()) {
    case 'jpeg':
    case 'jpg':
      return 'image/jpeg'
    case 'webp':
      return 'image/webp'
    case 'png':
      return 'image/png'
    default:
      return undefined
  }
}

export function detectResponsesImageGenerationMediaTypeFromBase64(
  imageBase64?: string | null
): string | undefined {
  if (typeof imageBase64 !== 'string') return undefined

  const normalized = imageBase64
    .trim()
    .replace(/^data:[^;,]+;base64,/, '')
    .replace(/\s+/g, '')
  if (!normalized) return undefined

  if (normalized.startsWith('iVBORw0KGgo')) return 'image/png'
  if (normalized.startsWith('/9j/')) return 'image/jpeg'
  if (normalized.startsWith('UklGR')) return 'image/webp'

  try {
    const binary = atob(normalized.slice(0, 24))
    if (binary.length >= 4 && binary.charCodeAt(0) === 0x89 && binary.charCodeAt(1) === 0x50) {
      return 'image/png'
    }
    if (binary.length >= 3 && binary.charCodeAt(0) === 0xff && binary.charCodeAt(1) === 0xd8) {
      return 'image/jpeg'
    }
    if (binary.length >= 12 && binary.slice(0, 4) === 'RIFF' && binary.slice(8, 12) === 'WEBP') {
      return 'image/webp'
    }
  } catch {
    return undefined
  }

  return undefined
}

export async function createResponsesImageBlock(
  imageBase64: string,
  outputFormat?: string | null
): Promise<ImageBlock> {
  const mediaType =
    getResponsesImageGenerationMediaType(outputFormat) ??
    detectResponsesImageGenerationMediaTypeFromBase64(imageBase64) ??
    'image/png'

  const persisted = (await ipcClient.invoke('image:persist-generated', {
    data: imageBase64,
    mediaType
  })) as { filePath?: string; mediaType?: string; data?: string; error?: string }

  if (persisted?.error) {
    return {
      type: 'image',
      source: {
        type: 'base64',
        data: imageBase64,
        ...(mediaType ? { mediaType } : {})
      }
    }
  }

  return {
    type: 'image',
    source: {
      type: 'base64',
      data: typeof persisted?.data === 'string' && persisted.data ? persisted.data : imageBase64,
      mediaType:
        typeof persisted?.mediaType === 'string' && persisted.mediaType
          ? persisted.mediaType
          : mediaType,
      ...(typeof persisted?.filePath === 'string' && persisted.filePath
        ? { filePath: persisted.filePath }
        : {})
    }
  }
}

function collectResponsesImageBase64Values(value: unknown): string[] {
  if (typeof value === 'string') {
    return value.trim() ? [value] : []
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectResponsesImageBase64Values(item))
  }

  if (!value || typeof value !== 'object') {
    return []
  }

  const record = value as {
    b64_json?: unknown
    image_base64?: unknown
    data?: unknown
    result?: unknown
  }

  for (const candidate of [record.b64_json, record.image_base64, record.data, record.result]) {
    const extracted = collectResponsesImageBase64Values(candidate)
    if (extracted.length > 0) return extracted
  }

  return []
}

export async function extractResponsesImageBlocks(
  item: unknown,
  fallbackOutputFormat?: string | null
): Promise<ImageBlock[]> {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return []
  const record = item as { result?: unknown; output_format?: unknown }
  const rawResults = collectResponsesImageBase64Values(record.result)
  const outputFormat =
    typeof record.output_format === 'string' ? record.output_format : fallbackOutputFormat

  return Promise.all(
    rawResults
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => createResponsesImageBlock(value, outputFormat))
  )
}

export async function extractResponsesPartialImageBlock(
  item: unknown,
  fallbackOutputFormat?: string | null
): Promise<ImageBlock | null> {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null
  const record = item as { partial_image_b64?: unknown; output_format?: unknown }
  if (typeof record.partial_image_b64 !== 'string' || !record.partial_image_b64.trim()) {
    return null
  }

  const outputFormat =
    typeof record.output_format === 'string' ? record.output_format : fallbackOutputFormat
  return createResponsesImageBlock(record.partial_image_b64, outputFormat)
}

export function getResponsesImageGenerationErrorMessage(item: unknown): string | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null
  const record = item as {
    error?: { message?: unknown; code?: unknown; type?: unknown } | unknown
    message?: unknown
    status?: unknown
  }

  if (record.error && typeof record.error === 'object' && !Array.isArray(record.error)) {
    const errorRecord = record.error as { message?: unknown; code?: unknown; type?: unknown }
    for (const candidate of [errorRecord.message, errorRecord.code, errorRecord.type]) {
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
    }
  }

  if (typeof record.message === 'string' && record.message.trim()) return record.message.trim()
  if (typeof record.status === 'string' && record.status.trim() === 'failed') {
    return 'Image generation failed'
  }

  return null
}
