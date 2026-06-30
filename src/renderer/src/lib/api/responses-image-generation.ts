import type {
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

function normalizeEnumValue<T extends string>(
  value: unknown,
  allowed: readonly T[]
): T | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  if (!normalized) return undefined
  return allowed.includes(normalized as T) ? (normalized as T) : undefined
}

function clampInteger(value: number, min: number, max?: number): number {
  const normalized = Math.floor(value)
  if (normalized < min) return min
  if (max !== undefined && normalized > max) return max
  return normalized
}

export function normalizeResponsesImageGenerationConfig(
  config?: ResponsesImageGenerationConfig | null
): ResponsesImageGenerationConfig {
  const normalized: ResponsesImageGenerationConfig = {
    ...(config ?? {}),
    enabled: config?.enabled ?? true,
    partialImages:
      normalizeResponsesImageGenerationPartialImages(config?.partialImages) ??
      RESPONSES_IMAGE_GENERATION_DEFAULT_PARTIAL_IMAGES
  }

  const action = normalizeEnumValue(config?.action, RESPONSES_IMAGE_GENERATION_ACTIONS)
  const background = normalizeEnumValue(config?.background, RESPONSES_IMAGE_GENERATION_BACKGROUNDS)
  const inputFidelity = normalizeEnumValue(
    config?.inputFidelity,
    RESPONSES_IMAGE_GENERATION_INPUT_FIDELITIES
  )
  const moderation = normalizeEnumValue(config?.moderation, RESPONSES_IMAGE_GENERATION_MODERATIONS)
  const outputFormat = normalizeEnumValue(
    config?.outputFormat,
    RESPONSES_IMAGE_GENERATION_OUTPUT_FORMATS
  )
  const quality = normalizeEnumValue(config?.quality, RESPONSES_IMAGE_GENERATION_QUALITIES)
  const size = normalizeEnumValue(config?.size, RESPONSES_IMAGE_GENERATION_SIZES)
  const inputImageMask = normalizeResponsesImageGenerationInputMask(config?.inputImageMask)
  const outputCompression = normalizeResponsesImageGenerationOutputCompression(
    config?.outputCompression
  )

  if (action) normalized.action = action
  else delete normalized.action

  if (background) normalized.background = background
  else delete normalized.background

  if (inputFidelity) normalized.inputFidelity = inputFidelity
  else delete normalized.inputFidelity

  if (moderation) normalized.moderation = moderation
  else delete normalized.moderation

  if (outputFormat) normalized.outputFormat = outputFormat
  else delete normalized.outputFormat

  if (quality) normalized.quality = quality
  else delete normalized.quality

  if (size) normalized.size = size
  else delete normalized.size

  if (inputImageMask) normalized.inputImageMask = inputImageMask
  else delete normalized.inputImageMask

  if (outputCompression !== undefined) normalized.outputCompression = outputCompression
  else delete normalized.outputCompression

  return normalized
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
  return clampInteger(value, 0, 3)
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
