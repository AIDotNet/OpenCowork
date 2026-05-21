import type { ProviderConfig } from './types'
import { parseSSEStream } from './sse-parser'

const IMAGE_REQUEST_TIMEOUT_MS = 10 * 60 * 1000
const OPENAI_IMAGES_DEFAULT_STREAM_PARTIAL_IMAGES = 2

export type OpenAIImagesRequestErrorCode =
  | 'timeout'
  | 'network'
  | 'request_aborted'
  | 'api_error'
  | 'unknown'

export class OpenAIImagesRequestError extends Error {
  readonly code: OpenAIImagesRequestErrorCode
  readonly statusCode?: number

  constructor(
    message: string,
    options: { code: OpenAIImagesRequestErrorCode; statusCode?: number }
  ) {
    super(message)
    this.name = 'OpenAIImagesRequestError'
    this.code = options.code
    this.statusCode = options.statusCode
  }
}

export interface Base64ImageInput {
  dataUrl: string
  mediaType?: string
}

interface OpenAiImageResponseItem {
  b64_json?: string
  url?: string
  revised_prompt?: string
  output_format?: string
}

interface OpenAiImageStreamEventPayload {
  type?: string
  b64_json?: string
  output_format?: string
  partial_image_index?: number
}

export interface GeneratedImage {
  sourceType: 'base64' | 'url'
  data: string
  mediaType: string
}

export interface GeneratedImageStreamEvent {
  kind: 'partial' | 'completed'
  image: GeneratedImage
  partialImageIndex?: number
}

function getBaseUrl(config: ProviderConfig): string {
  return (config.baseUrl || 'https://api.openai.com/v1').trim().replace(/\/+$/, '')
}

function applyRequestOverridesToJsonBody(
  body: Record<string, unknown>,
  config: ProviderConfig
): Record<string, unknown> {
  const next = { ...body }
  const overrides = config.requestOverrides

  if (overrides?.body) {
    for (const [key, value] of Object.entries(overrides.body)) {
      next[key] = value
    }
  }

  if (overrides?.omitBodyKeys) {
    for (const key of overrides.omitBodyKeys) {
      delete next[key]
    }
  }

  return next
}

const OPENAI_IMAGE_STRING_OVERRIDE_KEYS = [
  'size',
  'quality',
  'background',
  'output_format'
] as const

function normalizeOptionalRequestString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized || undefined
}

function sanitizeImageRequestJsonBody(body: Record<string, unknown>): Record<string, unknown> {
  const next = { ...body }

  for (const key of OPENAI_IMAGE_STRING_OVERRIDE_KEYS) {
    if (typeof next[key] !== 'string') continue
    const normalized = normalizeOptionalRequestString(next[key])
    if (normalized) {
      next[key] = normalized
    } else {
      delete next[key]
    }
  }

  return next
}

function appendFormDataValue(formData: FormData, key: string, value: unknown): void {
  if (value === undefined || value === null) return
  if (value instanceof Blob) {
    formData.append(key, value)
    return
  }
  formData.append(key, String(value))
}

function applyRequestOverridesToFormData(formData: FormData, config: ProviderConfig): void {
  const overrides = config.requestOverrides

  if (overrides?.omitBodyKeys) {
    for (const key of overrides.omitBodyKeys) {
      formData.delete(key)
    }
  }

  if (overrides?.body) {
    for (const [key, value] of Object.entries(overrides.body)) {
      formData.delete(key)
      appendFormDataValue(formData, key, value)
    }
  }
}

function sanitizeImageRequestFormData(formData: FormData): void {
  for (const key of OPENAI_IMAGE_STRING_OVERRIDE_KEYS) {
    const value = formData.get(key)
    if (typeof value !== 'string') continue

    const normalized = normalizeOptionalRequestString(value)
    formData.delete(key)
    if (normalized) {
      formData.append(key, normalized)
    }
  }
}

function ensureApiKey(config: ProviderConfig): void {
  if (!config.apiKey) {
    throw new Error('Missing API key for OpenAI image request')
  }
}

function dataUrlToBlob(input: Base64ImageInput): Blob {
  const [header, data] = input.dataUrl.split(',')
  if (!data) {
    throw new Error('Invalid data URL for image attachment')
  }
  const mimeMatch = /data:(.*?);base64/.exec(header)
  const mediaType = input.mediaType || mimeMatch?.[1] || 'application/octet-stream'
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new Blob([bytes], { type: mediaType })
}

function normalizeImageStreamPartialImages(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return OPENAI_IMAGES_DEFAULT_STREAM_PARTIAL_IMAGES
  }
  return Math.max(0, Math.min(3, Math.floor(value)))
}

function mediaTypeFromOutputFormat(outputFormat?: string | null): string | undefined {
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

function detectImageMediaTypeFromBase64(data: string): string {
  try {
    const header = data.substring(0, 20)
    const binary = atob(header)
    // PNG signature: 89 50 4E 47
    if (binary.charCodeAt(0) === 0x89 && binary.charCodeAt(1) === 0x50) {
      return 'image/png'
    }
    // JPEG signature: FF D8 FF
    if (binary.charCodeAt(0) === 0xff && binary.charCodeAt(1) === 0xd8) {
      return 'image/jpeg'
    }
    // WebP signature: RIFF....WEBP
    if (binary.substring(0, 4) === 'RIFF' && binary.substring(8, 12) === 'WEBP') {
      return 'image/webp'
    }
  } catch (e) {
    console.warn('[OpenAI Images] Failed to detect image type, defaulting to PNG:', e)
  }
  return 'image/png'
}

function createBase64GeneratedImage(data: string, outputFormat?: string | null): GeneratedImage {
  return {
    sourceType: 'base64',
    data,
    mediaType: mediaTypeFromOutputFormat(outputFormat) ?? detectImageMediaTypeFromBase64(data)
  }
}

function normalizeImageResults(items: OpenAiImageResponseItem[]): GeneratedImage[] {
  return items
    .map((item) => {
      if (item.b64_json) {
        return createBase64GeneratedImage(item.b64_json, item.output_format)
      }
      if (item.url) {
        return { sourceType: 'url', data: item.url, mediaType: 'url' }
      }
      return null
    })
    .filter((item): item is GeneratedImage => Boolean(item))
}

function createRequestSignal(signal?: AbortSignal): {
  signal: AbortSignal
  didTimeout: () => boolean
  cleanup: () => void
} {
  const timeoutController = new AbortController()
  let timedOut = false
  let timeoutId: ReturnType<typeof setTimeout> | null = null

  const onParentAbort = (): void => {
    timeoutController.abort(signal?.reason)
  }

  if (signal?.aborted) {
    timeoutController.abort(signal.reason)
  } else {
    signal?.addEventListener('abort', onParentAbort, { once: true })
  }

  if (!timeoutController.signal.aborted) {
    timeoutId = setTimeout(() => {
      timedOut = true
      timeoutController.abort(new DOMException('Image request timed out', 'TimeoutError'))
    }, IMAGE_REQUEST_TIMEOUT_MS)
  }

  return {
    signal: timeoutController.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      if (timeoutId) {
        clearTimeout(timeoutId)
        timeoutId = null
      }
      signal?.removeEventListener('abort', onParentAbort)
    }
  }
}

async function getOpenAIImagesErrorMessage(
  response: Response,
  fallbackMessage: string
): Promise<string> {
  try {
    const errorData = await response.json()
    if (errorData.error?.message) {
      return errorData.error.message
    }
    if (errorData.message) {
      return errorData.message
    }
    return JSON.stringify(errorData)
  } catch {
    return await response.text().catch(() => fallbackMessage)
  }
}

function mapFetchError(error: unknown, didTimeout: boolean): OpenAIImagesRequestError {
  if (didTimeout) {
    return new OpenAIImagesRequestError('Image request timed out after 10 minutes', {
      code: 'timeout'
    })
  }

  if (error instanceof Error && error.name === 'AbortError') {
    return new OpenAIImagesRequestError('Image request was cancelled', {
      code: 'request_aborted'
    })
  }

  if (error instanceof TypeError) {
    return new OpenAIImagesRequestError(
      `Network request failed while generating image. Please check your network, proxy, and Base URL settings. (${error.message})`,
      { code: 'network' }
    )
  }

  if (error instanceof OpenAIImagesRequestError) {
    return error
  }

  const message = error instanceof Error ? error.message : String(error)
  return new OpenAIImagesRequestError(message || 'Unknown image request error', {
    code: 'unknown'
  })
}

async function* streamOpenAIImageResponse(params: {
  response: Response
  signal: AbortSignal
  didTimeout: () => boolean
  completedEventType: string
  partialEventType: string
  emptyErrorMessage: string
}): AsyncIterable<GeneratedImageStreamEvent> {
  const { response, signal, didTimeout, completedEventType, partialEventType, emptyErrorMessage } =
    params
  let completedCount = 0

  try {
    for await (const sse of parseSSEStream(response)) {
      if (!sse.data || sse.data === '[DONE]') continue

      let data: OpenAiImageStreamEventPayload
      try {
        data = JSON.parse(sse.data) as OpenAiImageStreamEventPayload
      } catch {
        continue
      }

      const eventType = data.type || sse.event
      if (eventType !== partialEventType && eventType !== completedEventType) {
        continue
      }

      if (!data.b64_json) {
        continue
      }

      if (eventType === partialEventType) {
        yield {
          kind: 'partial',
          image: createBase64GeneratedImage(data.b64_json, data.output_format),
          ...(typeof data.partial_image_index === 'number'
            ? { partialImageIndex: data.partial_image_index }
            : {})
        }
        continue
      }

      completedCount += 1
      yield {
        kind: 'completed',
        image: createBase64GeneratedImage(data.b64_json, data.output_format)
      }
    }
  } catch (error) {
    if (signal.aborted || error instanceof TypeError || error instanceof Error) {
      throw mapFetchError(error, didTimeout())
    }
    throw error
  }

  if (completedCount === 0) {
    throw new OpenAIImagesRequestError(emptyErrorMessage, {
      code: 'api_error'
    })
  }
}

export async function generateImagesFromText(params: {
  config: ProviderConfig
  prompt: string
  size?: string
  quality?: 'standard' | 'hd'
  signal?: AbortSignal
}): Promise<GeneratedImage[]> {
  const { config, prompt, signal, size, quality } = params
  ensureApiKey(config)
  const url = `${getBaseUrl(config)}/images/generations`
  const normalizedSize = normalizeOptionalRequestString(size)
  const body = sanitizeImageRequestJsonBody(
    applyRequestOverridesToJsonBody(
      {
        model: config.model,
        prompt,
        ...(normalizedSize ? { size: normalizedSize } : {}),
        ...(quality ? { quality } : {})
      },
      config
    )
  )

  const requestSignal = createRequestSignal(signal)
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
        ...(config.organization ? { 'OpenAI-Organization': config.organization } : {}),
        ...(config.project ? { 'OpenAI-Project': config.project } : {})
      },
      body: JSON.stringify(body),
      signal: requestSignal.signal
    })
  } catch (error) {
    throw mapFetchError(error, requestSignal.didTimeout())
  } finally {
    requestSignal.cleanup()
  }

  if (!response.ok) {
    const errorMessage = await getOpenAIImagesErrorMessage(
      response,
      `Image generation failed: ${response.status}`
    )
    console.error('[OpenAI Images] Generation failed:', errorMessage)
    throw new OpenAIImagesRequestError(errorMessage, {
      code: 'api_error',
      statusCode: response.status
    })
  }

  const data = (await response.json()) as { data?: OpenAiImageResponseItem[] }
  const items = data.data ?? []
  if (items.length === 0) {
    throw new OpenAIImagesRequestError('Image generation returned no results', {
      code: 'api_error'
    })
  }

  console.log('[OpenAI Images] Generation response:', items)
  return normalizeImageResults(items)
}

export async function* streamImagesFromText(params: {
  config: ProviderConfig
  prompt: string
  signal?: AbortSignal
}): AsyncIterable<GeneratedImageStreamEvent> {
  const { config, prompt, signal } = params
  ensureApiKey(config)
  const url = `${getBaseUrl(config)}/images/generations`
  const partialImages = normalizeImageStreamPartialImages(
    config.imageGenerationStream?.partialImages
  )
  const body = sanitizeImageRequestJsonBody(
    applyRequestOverridesToJsonBody(
      {
        model: config.model,
        prompt,
        stream: true,
        partial_images: partialImages
      },
      config
    )
  )

  const requestSignal = createRequestSignal(signal)
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
        ...(config.organization ? { 'OpenAI-Organization': config.organization } : {}),
        ...(config.project ? { 'OpenAI-Project': config.project } : {})
      },
      body: JSON.stringify(body),
      signal: requestSignal.signal
    })
  } catch (error) {
    requestSignal.cleanup()
    throw mapFetchError(error, requestSignal.didTimeout())
  }

  try {
    if (!response.ok) {
      const errorMessage = await getOpenAIImagesErrorMessage(
        response,
        `Image generation failed: ${response.status}`
      )
      console.error('[OpenAI Images] Streaming generation failed:', errorMessage)
      throw new OpenAIImagesRequestError(errorMessage, {
        code: 'api_error',
        statusCode: response.status
      })
    }

    yield* streamOpenAIImageResponse({
      response,
      signal: requestSignal.signal,
      didTimeout: requestSignal.didTimeout,
      completedEventType: 'image_generation.completed',
      partialEventType: 'image_generation.partial_image',
      emptyErrorMessage: 'Image generation stream returned no final image'
    })
  } finally {
    requestSignal.cleanup()
  }
}

export async function editImageWithPrompt(params: {
  config: ProviderConfig
  prompt: string
  image: Base64ImageInput
  size?: string
  signal?: AbortSignal
}): Promise<GeneratedImage[]> {
  const { config, prompt, image, signal, size } = params
  ensureApiKey(config)
  const url = `${getBaseUrl(config)}/images/edits`
  const normalizedSize = normalizeOptionalRequestString(size)

  const formData = new FormData()
  formData.append('model', config.model)
  formData.append('prompt', prompt)
  if (normalizedSize) {
    formData.append('size', normalizedSize)
  }
  formData.append('image', dataUrlToBlob(image), 'image.png')
  applyRequestOverridesToFormData(formData, config)
  sanitizeImageRequestFormData(formData)

  const requestSignal = createRequestSignal(signal)
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        ...(config.organization ? { 'OpenAI-Organization': config.organization } : {}),
        ...(config.project ? { 'OpenAI-Project': config.project } : {})
      },
      body: formData,
      signal: requestSignal.signal
    })
  } catch (error) {
    throw mapFetchError(error, requestSignal.didTimeout())
  } finally {
    requestSignal.cleanup()
  }

  if (!response.ok) {
    const errorMessage = await getOpenAIImagesErrorMessage(
      response,
      `Image edit failed: ${response.status}`
    )
    console.error('[OpenAI Images] Edit failed:', errorMessage)
    throw new OpenAIImagesRequestError(errorMessage, {
      code: 'api_error',
      statusCode: response.status
    })
  }

  const data = (await response.json()) as { data?: OpenAiImageResponseItem[] }
  const items = data.data ?? []
  if (items.length === 0) {
    throw new OpenAIImagesRequestError('Image edit returned no results', {
      code: 'api_error'
    })
  }

  console.log('[OpenAI Images] Edit response:', items)
  return normalizeImageResults(items)
}

export async function* streamImageEditWithPrompt(params: {
  config: ProviderConfig
  prompt: string
  image: Base64ImageInput
  signal?: AbortSignal
}): AsyncIterable<GeneratedImageStreamEvent> {
  const { config, prompt, image, signal } = params
  ensureApiKey(config)
  const url = `${getBaseUrl(config)}/images/edits`
  const partialImages = normalizeImageStreamPartialImages(
    config.imageGenerationStream?.partialImages
  )

  const formData = new FormData()
  formData.append('model', config.model)
  formData.append('prompt', prompt)
  formData.append('image', dataUrlToBlob(image), 'image.png')
  formData.append('stream', 'true')
  formData.append('partial_images', String(partialImages))
  applyRequestOverridesToFormData(formData, config)
  sanitizeImageRequestFormData(formData)

  const requestSignal = createRequestSignal(signal)
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        ...(config.organization ? { 'OpenAI-Organization': config.organization } : {}),
        ...(config.project ? { 'OpenAI-Project': config.project } : {})
      },
      body: formData,
      signal: requestSignal.signal
    })
  } catch (error) {
    requestSignal.cleanup()
    throw mapFetchError(error, requestSignal.didTimeout())
  }

  try {
    if (!response.ok) {
      const errorMessage = await getOpenAIImagesErrorMessage(
        response,
        `Image edit failed: ${response.status}`
      )
      console.error('[OpenAI Images] Streaming edit failed:', errorMessage)
      throw new OpenAIImagesRequestError(errorMessage, {
        code: 'api_error',
        statusCode: response.status
      })
    }

    yield* streamOpenAIImageResponse({
      response,
      signal: requestSignal.signal,
      didTimeout: requestSignal.didTimeout,
      completedEventType: 'image_edit.completed',
      partialEventType: 'image_edit.partial_image',
      emptyErrorMessage: 'Image edit stream returned no final image'
    })
  } finally {
    requestSignal.cleanup()
  }
}
