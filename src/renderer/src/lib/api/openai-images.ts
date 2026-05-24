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

type OpenAIImageQuality = 'auto' | 'low' | 'medium' | 'high' | 'standard' | 'hd'

interface OpenAIImageObject {
  b64_json?: unknown
  revised_prompt?: unknown
  url?: unknown
}

interface OpenAIImagesResponse {
  data?: unknown
  output_format?: unknown
}

interface OpenAIImageStreamEventPayload {
  type?: unknown
  b64_json?: unknown
  output_format?: unknown
  partial_image_index?: unknown
  error?: unknown
  message?: unknown
}

function getBaseUrl(config: ProviderConfig): string {
  return (config.baseUrl || 'https://api.openai.com/v1').trim().replace(/\/+$/, '')
}

function getOpenAIImagesHeaders(
  config: ProviderConfig,
  options?: { contentType?: string }
): Record<string, string> {
  return {
    ...(options?.contentType ? { 'Content-Type': options.contentType } : {}),
    Authorization: `Bearer ${config.apiKey}`,
    ...(config.organization ? { 'OpenAI-Organization': config.organization } : {}),
    ...(config.project ? { 'OpenAI-Project': config.project } : {}),
    ...(config.requestOverrides?.headers ?? {})
  }
}

function normalizeOptionalRequestString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized || undefined
}

function sanitizeJsonBody(body: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue

    if (typeof value === 'string' && key !== 'prompt') {
      const normalized = normalizeOptionalRequestString(value)
      if (normalized) {
        next[key] = normalized
      }
      continue
    }

    next[key] = value
  }

  return next
}

function buildJsonBody(
  body: Record<string, unknown>,
  config: ProviderConfig
): Record<string, unknown> {
  const next = {
    ...body,
    ...(config.requestOverrides?.body ?? {})
  }

  for (const key of config.requestOverrides?.omitBodyKeys ?? []) {
    delete next[key]
  }

  return sanitizeJsonBody(next)
}

function appendFormDataValue(formData: FormData, key: string, value: unknown): void {
  if (value === undefined || value === null) return

  if (value instanceof Blob) {
    formData.append(key, value)
    return
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      appendFormDataValue(formData, key, item)
    }
    return
  }

  if (typeof value === 'string') {
    const normalized = key === 'prompt' ? value : normalizeOptionalRequestString(value)
    if (normalized) {
      formData.append(key, normalized)
    }
    return
  }

  formData.append(key, String(value))
}

function applyRequestOverridesToFormData(formData: FormData, config: ProviderConfig): void {
  if (config.requestOverrides?.body) {
    for (const [key, value] of Object.entries(config.requestOverrides.body)) {
      formData.delete(key)
      appendFormDataValue(formData, key, value)
    }
  }

  for (const key of config.requestOverrides?.omitBodyKeys ?? []) {
    formData.delete(key)
  }
}

function ensureApiKey(config: ProviderConfig): void {
  if (!config.apiKey) {
    throw new Error('Missing API key for OpenAI image request')
  }
}

function getImageInputMediaType(input: Base64ImageInput): string {
  const [header] = input.dataUrl.split(',')
  const mimeMatch = /data:(.*?);base64/i.exec(header)
  return input.mediaType || mimeMatch?.[1] || 'application/octet-stream'
}

function dataUrlToBlob(input: Base64ImageInput): Blob {
  const [, data] = input.dataUrl.split(',')
  if (!data) {
    throw new Error('Invalid data URL for image attachment')
  }

  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }

  return new Blob([bytes], { type: getImageInputMediaType(input) })
}

function getImageFileName(input: Base64ImageInput, index: number): string {
  switch (getImageInputMediaType(input).toLowerCase()) {
    case 'image/jpeg':
    case 'image/jpg':
      return `image-${index + 1}.jpg`
    case 'image/webp':
      return `image-${index + 1}.webp`
    case 'image/png':
      return `image-${index + 1}.png`
    default:
      return `image-${index + 1}`
  }
}

function appendImageInputs(formData: FormData, images: Base64ImageInput[]): void {
  const fieldName = images.length > 1 ? 'image[]' : 'image'
  images.forEach((image, index) => {
    formData.append(fieldName, dataUrlToBlob(image), getImageFileName(image, index))
  })
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

function normalizeBase64ImageData(data: string): string {
  const trimmed = data.trim()
  const dataUrlMatch = /^data:[^;,]+;base64,(.+)$/i.exec(trimmed)
  return (dataUrlMatch?.[1] ?? trimmed).replace(/\s+/g, '')
}

function detectImageMediaTypeFromBase64(data: string): string {
  const normalized = normalizeBase64ImageData(data)

  try {
    const binary = atob(normalized.slice(0, 32))
    if (binary.length >= 4 && binary.charCodeAt(0) === 0x89 && binary.charCodeAt(1) === 0x50) {
      return 'image/png'
    }
    if (binary.length >= 3 && binary.charCodeAt(0) === 0xff && binary.charCodeAt(1) === 0xd8) {
      return 'image/jpeg'
    }
    if (binary.length >= 12 && binary.slice(0, 4) === 'RIFF' && binary.slice(8, 12) === 'WEBP') {
      return 'image/webp'
    }
  } catch (error) {
    console.warn('[OpenAI Images] Failed to detect image type, defaulting to PNG:', error)
  }

  return 'image/png'
}

function createBase64GeneratedImage(data: string, outputFormat?: string | null): GeneratedImage {
  const normalized = normalizeBase64ImageData(data)

  return {
    sourceType: 'base64',
    data: normalized,
    mediaType: mediaTypeFromOutputFormat(outputFormat) ?? detectImageMediaTypeFromBase64(normalized)
  }
}

function createUrlGeneratedImage(url: string): GeneratedImage {
  return {
    sourceType: 'url',
    data: url,
    mediaType: 'url'
  }
}

function normalizeImageResults(responseData: OpenAIImagesResponse): GeneratedImage[] {
  const data = Array.isArray(responseData.data) ? responseData.data : []
  const outputFormat =
    typeof responseData.output_format === 'string' ? responseData.output_format : undefined

  return data
    .map((item): GeneratedImage | null => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null

      const image = item as OpenAIImageObject
      if (typeof image.b64_json === 'string' && image.b64_json.trim()) {
        return createBase64GeneratedImage(image.b64_json, outputFormat)
      }
      if (typeof image.url === 'string' && image.url.trim()) {
        return createUrlGeneratedImage(image.url.trim())
      }
      return null
    })
    .filter((item): item is GeneratedImage => Boolean(item))
}

function describeImageResponseData(responseData: OpenAIImagesResponse): string {
  if (!Array.isArray(responseData.data)) {
    return 'missing data array'
  }
  if (responseData.data.length === 0) {
    return 'empty data array'
  }

  const firstItem = responseData.data[0]
  if (!firstItem || typeof firstItem !== 'object' || Array.isArray(firstItem)) {
    return `first item type: ${typeof firstItem}`
  }

  const keys = Object.keys(firstItem as Record<string, unknown>)
  return keys.length > 0 ? `first item keys: ${keys.join(', ')}` : 'first item is empty object'
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
  const responseText = await response.text().catch(() => '')
  if (!responseText) return fallbackMessage

  try {
    const errorData = JSON.parse(responseText)
    const message = extractOpenAIErrorMessage(errorData)
    return message ?? JSON.stringify(errorData)
  } catch {
    return responseText
  }
}

function extractOpenAIErrorMessage(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) {
    return value.trim()
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const record = value as {
    error?: unknown
    message?: unknown
    code?: unknown
    type?: unknown
  }

  for (const candidate of [record.message, record.code, record.type]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }

  return extractOpenAIErrorMessage(record.error)
}

function mapFetchError(error: unknown, didTimeout: boolean): OpenAIImagesRequestError {
  if (error instanceof OpenAIImagesRequestError) {
    return error
  }

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

  const message = error instanceof Error ? error.message : String(error)
  return new OpenAIImagesRequestError(message || 'Unknown image request error', {
    code: 'unknown'
  })
}

async function readOpenAIImagesJson(
  response: Response,
  invalidJsonMessage: string
): Promise<OpenAIImagesResponse> {
  try {
    return (await response.json()) as OpenAIImagesResponse
  } catch (error) {
    throw new OpenAIImagesRequestError(
      `${invalidJsonMessage}: ${error instanceof Error ? error.message : String(error)}`,
      { code: 'api_error' }
    )
  }
}

function parseOpenAIImagesResponse(
  responseData: OpenAIImagesResponse,
  emptyErrorMessage: string
): GeneratedImage[] {
  const images = normalizeImageResults(responseData)
  if (images.length > 0) return images

  throw new OpenAIImagesRequestError(
    `${emptyErrorMessage}. Response shape: ${describeImageResponseData(responseData)}.`,
    { code: 'api_error' }
  )
}

function getStreamEventType(payload: OpenAIImageStreamEventPayload, sseEvent?: string): string {
  return typeof payload.type === 'string' && payload.type.trim()
    ? payload.type.trim()
    : (sseEvent ?? '')
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

  if (!response.body) {
    throw new OpenAIImagesRequestError('Image stream response did not include a body', {
      code: 'api_error'
    })
  }

  try {
    for await (const sse of parseSSEStream(response)) {
      if (!sse.data || sse.data === '[DONE]') continue

      let data: OpenAIImageStreamEventPayload
      try {
        data = JSON.parse(sse.data) as OpenAIImageStreamEventPayload
      } catch {
        continue
      }

      const errorMessage = extractOpenAIErrorMessage(data.error) ?? extractOpenAIErrorMessage(data)
      if (errorMessage && getStreamEventType(data, sse.event) === 'error') {
        throw new OpenAIImagesRequestError(errorMessage, { code: 'api_error' })
      }

      const eventType = getStreamEventType(data, sse.event)
      if (eventType !== partialEventType && eventType !== completedEventType) {
        continue
      }

      if (typeof data.b64_json !== 'string' || !data.b64_json.trim()) {
        continue
      }

      const outputFormat = typeof data.output_format === 'string' ? data.output_format : undefined
      if (eventType === partialEventType) {
        yield {
          kind: 'partial',
          image: createBase64GeneratedImage(data.b64_json, outputFormat),
          ...(typeof data.partial_image_index === 'number'
            ? { partialImageIndex: data.partial_image_index }
            : {})
        }
        continue
      }

      completedCount += 1
      yield {
        kind: 'completed',
        image: createBase64GeneratedImage(data.b64_json, outputFormat)
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
  quality?: OpenAIImageQuality
  signal?: AbortSignal
}): Promise<GeneratedImage[]> {
  const { config, prompt, signal, size, quality } = params
  ensureApiKey(config)
  const normalizedSize = normalizeOptionalRequestString(size)

  const requestSignal = createRequestSignal(signal)
  try {
    const response = await fetch(`${getBaseUrl(config)}/images/generations`, {
      method: 'POST',
      headers: getOpenAIImagesHeaders(config, { contentType: 'application/json' }),
      body: JSON.stringify(
        buildJsonBody(
          {
            model: config.model,
            prompt,
            ...(normalizedSize ? { size: normalizedSize } : {}),
            ...(quality ? { quality } : {})
          },
          config
        )
      ),
      signal: requestSignal.signal
    })

    if (!response.ok) {
      const errorMessage = await getOpenAIImagesErrorMessage(
        response,
        `Image generation failed: ${response.status}`
      )
      throw new OpenAIImagesRequestError(errorMessage, {
        code: 'api_error',
        statusCode: response.status
      })
    }

    const responseData = await readOpenAIImagesJson(
      response,
      'Image generation returned invalid JSON'
    )
    return parseOpenAIImagesResponse(responseData, 'Image generation returned no image output')
  } catch (error) {
    throw mapFetchError(error, requestSignal.didTimeout())
  } finally {
    requestSignal.cleanup()
  }
}

export async function* streamImagesFromText(params: {
  config: ProviderConfig
  prompt: string
  signal?: AbortSignal
}): AsyncIterable<GeneratedImageStreamEvent> {
  const { config, prompt, signal } = params
  ensureApiKey(config)

  const partialImages = normalizeImageStreamPartialImages(
    config.imageGenerationStream?.partialImages
  )
  const requestSignal = createRequestSignal(signal)
  try {
    const response = await fetch(`${getBaseUrl(config)}/images/generations`, {
      method: 'POST',
      headers: getOpenAIImagesHeaders(config, { contentType: 'application/json' }),
      body: JSON.stringify(
        buildJsonBody(
          {
            model: config.model,
            prompt,
            stream: true,
            partial_images: partialImages
          },
          config
        )
      ),
      signal: requestSignal.signal
    })

    if (!response.ok) {
      const errorMessage = await getOpenAIImagesErrorMessage(
        response,
        `Image generation failed: ${response.status}`
      )
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
  } catch (error) {
    throw mapFetchError(error, requestSignal.didTimeout())
  } finally {
    requestSignal.cleanup()
  }
}

export async function editImageWithPrompt(params: {
  config: ProviderConfig
  prompt: string
  images: Base64ImageInput[]
  size?: string
  signal?: AbortSignal
}): Promise<GeneratedImage[]> {
  const { config, prompt, images, signal, size } = params
  ensureApiKey(config)

  if (images.length === 0) {
    throw new OpenAIImagesRequestError('Image edit requires at least one input image', {
      code: 'api_error'
    })
  }

  const formData = new FormData()
  appendFormDataValue(formData, 'model', config.model)
  appendFormDataValue(formData, 'prompt', prompt)
  appendImageInputs(formData, images)
  appendFormDataValue(formData, 'size', normalizeOptionalRequestString(size))
  applyRequestOverridesToFormData(formData, config)

  const requestSignal = createRequestSignal(signal)
  try {
    const response = await fetch(`${getBaseUrl(config)}/images/edits`, {
      method: 'POST',
      headers: getOpenAIImagesHeaders(config),
      body: formData,
      signal: requestSignal.signal
    })

    if (!response.ok) {
      const errorMessage = await getOpenAIImagesErrorMessage(
        response,
        `Image edit failed: ${response.status}`
      )
      throw new OpenAIImagesRequestError(errorMessage, {
        code: 'api_error',
        statusCode: response.status
      })
    }

    const responseData = await readOpenAIImagesJson(response, 'Image edit returned invalid JSON')
    return parseOpenAIImagesResponse(responseData, 'Image edit returned no image output')
  } catch (error) {
    throw mapFetchError(error, requestSignal.didTimeout())
  } finally {
    requestSignal.cleanup()
  }
}

export async function* streamImageEditWithPrompt(params: {
  config: ProviderConfig
  prompt: string
  images: Base64ImageInput[]
  signal?: AbortSignal
}): AsyncIterable<GeneratedImageStreamEvent> {
  const { config, prompt, images, signal } = params
  ensureApiKey(config)

  if (images.length === 0) {
    throw new OpenAIImagesRequestError('Image edit requires at least one input image', {
      code: 'api_error'
    })
  }

  const partialImages = normalizeImageStreamPartialImages(
    config.imageGenerationStream?.partialImages
  )
  const formData = new FormData()
  appendFormDataValue(formData, 'model', config.model)
  appendFormDataValue(formData, 'prompt', prompt)
  appendImageInputs(formData, images)
  appendFormDataValue(formData, 'stream', true)
  appendFormDataValue(formData, 'partial_images', partialImages)
  applyRequestOverridesToFormData(formData, config)

  const requestSignal = createRequestSignal(signal)
  try {
    const response = await fetch(`${getBaseUrl(config)}/images/edits`, {
      method: 'POST',
      headers: getOpenAIImagesHeaders(config),
      body: formData,
      signal: requestSignal.signal
    })

    if (!response.ok) {
      const errorMessage = await getOpenAIImagesErrorMessage(
        response,
        `Image edit failed: ${response.status}`
      )
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
  } catch (error) {
    throw mapFetchError(error, requestSignal.didTimeout())
  } finally {
    requestSignal.cleanup()
  }
}
