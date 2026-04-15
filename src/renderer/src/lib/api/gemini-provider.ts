import type {
  APIProvider,
  ContentBlock,
  ImageBlock,
  ImageErrorCode,
  ProviderConfig,
  StreamEvent,
  ToolDefinition,
  UnifiedMessage
} from './types'
import { ipcStreamRequest, maskHeaders } from '../ipc/api-stream'
import { ipcClient } from '../ipc/ipc-client'
import { IPC } from '../ipc/channels'
import { registerProvider } from './provider'

const REQUEST_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'
const DEFAULT_VERTEX_BASE_URL = 'https://aiplatform.googleapis.com/v1'

type GeminiProviderKind = 'gemini' | 'vertex-ai'

type GeminiRole = 'user' | 'model'

interface GeminiInlineData {
  mimeType?: string
  mime_type?: string
  data?: string
}

interface GeminiFunctionCall {
  name?: string
  args?: Record<string, unknown>
}

interface GeminiFunctionResponse {
  name?: string
  response?: {
    name?: string
    content?: unknown
  }
}

interface GeminiPart {
  text?: string
  inlineData?: GeminiInlineData
  inline_data?: GeminiInlineData
  thought?: boolean
  thoughtSignature?: string
  thought_signature?: string
  functionCall?: GeminiFunctionCall
  function_call?: GeminiFunctionCall
  functionResponse?: GeminiFunctionResponse
  function_response?: GeminiFunctionResponse
  fileData?: {
    mimeType?: string
    fileUri?: string
  }
}

interface GeminiContent {
  role?: GeminiRole
  parts?: GeminiPart[]
}

interface GeminiCandidate {
  content?: GeminiContent
  finishReason?: string
  finish_reason?: string
}

interface GeminiUsageMetadata {
  promptTokenCount?: number
  candidatesTokenCount?: number
  totalTokenCount?: number
  thoughtsTokenCount?: number
}

interface GeminiGenerateContentResponse {
  candidates?: GeminiCandidate[]
  usageMetadata?: GeminiUsageMetadata
}

class GeminiRequestError extends Error {
  readonly code: ImageErrorCode
  readonly statusCode?: number

  constructor(message: string, options: { code: ImageErrorCode; statusCode?: number }) {
    super(message)
    this.name = 'GeminiRequestError'
    this.code = options.code
    this.statusCode = options.statusCode
  }
}

async function persistGeneratedImage(data: string, mediaType?: string): Promise<ImageBlock> {
  const fallback: ImageBlock = {
    type: 'image',
    source: {
      type: 'base64',
      mediaType: mediaType || 'image/png',
      data
    }
  }

  try {
    const result = (await ipcClient.invoke(IPC.IMAGE_PERSIST_GENERATED, {
      data,
      mediaType
    })) as {
      filePath?: string
      mediaType?: string
      data?: string
      error?: string
    }

    if (result?.error || !result?.data) {
      if (result?.error) {
        console.warn('[Gemini Provider] Failed to persist generated image:', result.error)
      }
      return fallback
    }

    return {
      type: 'image',
      source: {
        type: 'base64',
        mediaType: result.mediaType || mediaType || 'image/png',
        data: result.data,
        filePath: result.filePath
      }
    }
  } catch (error) {
    console.warn('[Gemini Provider] Failed to persist generated image:', error)
    return fallback
  }
}

function resolveHeaderTemplate(value: string, config: ProviderConfig): string {
  return value
    .replace(/\{\{\s*sessionId\s*\}\}/g, config.sessionId ?? '')
    .replace(/\{\{\s*model\s*\}\}/g, config.model ?? '')
}

function applyHeaderOverrides(
  headers: Record<string, string>,
  config: ProviderConfig
): Record<string, string> {
  const overrides = config.requestOverrides?.headers
  if (!overrides) return headers
  for (const [key, rawValue] of Object.entries(overrides)) {
    const value = resolveHeaderTemplate(String(rawValue), config).trim()
    if (value) headers[key] = value
  }
  return headers
}

function applyBodyOverrides(body: Record<string, unknown>, config: ProviderConfig): void {
  const overrides = config.requestOverrides
  if (overrides?.body) {
    for (const [key, value] of Object.entries(overrides.body)) {
      body[key] = value
    }
  }
  if (overrides?.omitBodyKeys) {
    for (const key of overrides.omitBodyKeys) {
      delete body[key]
    }
  }
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
      timeoutController.abort(new DOMException('Gemini request timed out', 'TimeoutError'))
    }, REQUEST_TIMEOUT_MS)
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

function mapFetchError(error: unknown, didTimeout: boolean): GeminiRequestError {
  if (didTimeout) {
    return new GeminiRequestError('Gemini request timed out after 10 minutes', {
      code: 'timeout'
    })
  }

  if (error instanceof Error && error.name === 'AbortError') {
    return new GeminiRequestError('Gemini request was cancelled', {
      code: 'request_aborted'
    })
  }

  if (error instanceof TypeError) {
    return new GeminiRequestError(
      `Network request failed while calling Gemini. Please check your network, proxy, and Base URL settings. (${error.message})`,
      { code: 'network' }
    )
  }

  if (error instanceof GeminiRequestError) {
    return error
  }

  const message = error instanceof Error ? error.message : String(error)
  return new GeminiRequestError(message || 'Unknown Gemini request error', {
    code: 'unknown'
  })
}

function normalizeGeminiError(error: unknown): { code: ImageErrorCode; message: string } {
  const normalized = mapFetchError(error, false)
  return {
    code: normalized.code,
    message: normalized.message
  }
}

function computeTps(
  outputTokens: number,
  firstTokenAt: number | null,
  completedAt: number
): number | undefined {
  if (!firstTokenAt || outputTokens <= 0) return undefined
  const durationMs = completedAt - firstTokenAt
  if (durationMs <= 0) return undefined
  return outputTokens / (durationMs / 1000)
}

function resolveApiRoot(kind: GeminiProviderKind, baseUrl?: string): string {
  const fallback = kind === 'vertex-ai' ? DEFAULT_VERTEX_BASE_URL : DEFAULT_GEMINI_BASE_URL
  return (baseUrl || fallback)
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/openai$/i, '')
}

function buildApiUrl(
  kind: GeminiProviderKind,
  baseUrl: string | undefined,
  model: string,
  stream: boolean
): string {
  const action = stream ? 'streamGenerateContent' : 'generateContent'
  const root = resolveApiRoot(kind, baseUrl)

  if (kind === 'vertex-ai') {
    const versionMatch = root.match(/^(.*?\/v[^/]+)(?:\/(.*))?$/i)
    if (!versionMatch) {
      throw new GeminiRequestError(
        'Vertex AI Base URL must include an API version, for example https://aiplatform.googleapis.com/v1/projects/PROJECT/locations/LOCATION',
        { code: 'api_error' }
      )
    }

    const versionRoot = versionMatch[1]
    const resourcePath = (versionMatch[2] || '').replace(/^\/+|\/+$/g, '')
    if (!resourcePath) {
      throw new GeminiRequestError(
        'Vertex AI Base URL must include projects/PROJECT/locations/LOCATION',
        { code: 'api_error' }
      )
    }

    const normalizedResourcePath = /\/publishers\/google$/i.test(resourcePath)
      ? resourcePath
      : `${resourcePath}/publishers/google`

    return `${versionRoot}/${normalizedResourcePath}/models/${encodeURIComponent(model)}:${action}`
  }

  return `${root}/models/${encodeURIComponent(model)}:${action}`
}

function isImageModelRequest(messages: UnifiedMessage[], config: ProviderConfig): boolean {
  const modality = config.requestOverrides?.body?.responseModalities
  if (Array.isArray(modality) && modality.includes('IMAGE')) return true
  if (config.category === 'image') return true
  if (/image/i.test(config.model)) return true

  const latestUserMessage = [...messages].reverse().find((message) => message.role === 'user')
  if (!latestUserMessage || typeof latestUserMessage.content === 'string') return false

  return latestUserMessage.content.some((block) => block.type === 'image')
}

function extractInlineData(part: GeminiPart): GeminiInlineData | undefined {
  return part.inlineData ?? part.inline_data
}

function extractThoughtSignature(part: GeminiPart): string | undefined {
  const signature = part.thoughtSignature ?? part.thought_signature
  return typeof signature === 'string' && signature.trim() ? signature : undefined
}

function extractGeneratedImages(
  data: GeminiGenerateContentResponse
): Array<{ data: string; mediaType: string }> {
  const images: Array<{ data: string; mediaType: string }> = []

  for (const candidate of data.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      const inlineData = extractInlineData(part)
      if (!inlineData?.data) continue
      images.push({
        data: inlineData.data,
        mediaType: inlineData.mimeType || inlineData.mime_type || 'image/png'
      })
    }
  }

  return images
}

function parseToolResponseContent(content: unknown): unknown {
  if (typeof content === 'string') return { text: content }
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (!item || typeof item !== 'object') return item
      const block = item as ContentBlock
      if (block.type === 'text') return { text: block.text }
      if (block.type === 'image' && block.source.data) {
        return {
          inlineData: {
            mimeType: block.source.mediaType || 'image/png',
            data: block.source.data
          }
        }
      }
      return item
    })
  }
  return content
}

class GeminiNativeProvider implements APIProvider {
  readonly name: string
  readonly type: GeminiProviderKind

  constructor(kind: GeminiProviderKind) {
    this.type = kind
    this.name = kind === 'vertex-ai' ? 'Vertex AI Gemini' : 'Gemini API'
  }

  async *sendMessage(
    messages: UnifiedMessage[],
    tools: ToolDefinition[],
    config: ProviderConfig,
    signal?: AbortSignal
  ): AsyncIterable<StreamEvent> {
    const requestStartedAt = Date.now()
    let firstTokenAt: number | null = null
    let outputTokens = 0
    const imageMode = isImageModelRequest(messages, config)

    try {
      if (!config.apiKey) {
        throw new GeminiRequestError(`Missing API key for ${this.type} request`, {
          code: 'api_error'
        })
      }

      const body: Record<string, unknown> = {
        contents: this.formatMessages(messages) as GeminiContent[]
      }

      const formattedTools = this.formatTools(tools) as Array<Record<string, unknown>>
      if (formattedTools.length > 0) {
        body.tools = formattedTools
      }

      const generationConfig: Record<string, unknown> = {}
      if (config.temperature !== undefined) generationConfig.temperature = config.temperature
      if (config.maxTokens) generationConfig.maxOutputTokens = config.maxTokens
      if (imageMode) generationConfig.responseModalities = ['IMAGE']
      if (Object.keys(generationConfig).length > 0) {
        body.generationConfig = generationConfig
      }

      if (config.systemPrompt?.trim()) {
        body.systemInstruction = {
          parts: [{ text: config.systemPrompt.trim() }]
        }
      }

      if (config.thinkingEnabled && config.thinkingConfig) {
        Object.assign(body, config.thinkingConfig.bodyParams)
      } else if (!config.thinkingEnabled && config.thinkingConfig?.disabledBodyParams) {
        Object.assign(body, config.thinkingConfig.disabledBodyParams)
      }

      applyBodyOverrides(body, config)

      const url = buildApiUrl(this.type, config.baseUrl, config.model, true)
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-goog-api-key': config.apiKey
      }
      if (config.userAgent) headers['User-Agent'] = config.userAgent
      applyHeaderOverrides(headers, config)

      const bodyStr = JSON.stringify(body)
      yield {
        type: 'request_debug',
        debugInfo: {
          url,
          method: 'POST',
          headers: maskHeaders(headers),
          body: bodyStr,
          timestamp: Date.now()
        }
      }
      yield { type: 'message_start' }

      const emittedToolCalls = new Set<string>()
      const emittedThinkingEncrypted = new Set<string>()
      let pendingStopReason: string | undefined
      let usageMetadata: GeminiUsageMetadata | undefined
      let emittedAnything = false

      for await (const sse of ipcStreamRequest({
        url,
        method: 'POST',
        headers,
        body: bodyStr,
        signal,
        useSystemProxy: config.useSystemProxy,
        allowInsecureTls: config.allowInsecureTls ?? true,
        providerId: config.providerId,
        providerBuiltinId: config.providerBuiltinId
      })) {
        if (!sse.data || sse.data === '[DONE]') continue

        let data: GeminiGenerateContentResponse
        try {
          data = JSON.parse(sse.data) as GeminiGenerateContentResponse
        } catch {
          continue
        }

        usageMetadata = data.usageMetadata ?? usageMetadata

        for (const candidate of data.candidates ?? []) {
          pendingStopReason = candidate.finishReason ?? candidate.finish_reason ?? pendingStopReason

          for (const part of candidate.content?.parts ?? []) {
            const thoughtSignature = extractThoughtSignature(part)
            if (thoughtSignature && !emittedThinkingEncrypted.has(thoughtSignature)) {
              emittedThinkingEncrypted.add(thoughtSignature)
              yield {
                type: 'thinking_encrypted',
                thinkingEncryptedContent: thoughtSignature,
                thinkingEncryptedProvider: 'google'
              }
            }

            if (part.text) {
              if (firstTokenAt === null) firstTokenAt = Date.now()
              emittedAnything = true
              if (part.thought) {
                yield { type: 'thinking_delta', thinking: part.text }
              } else {
                yield { type: 'text_delta', text: part.text }
              }
            }

            const functionCall = part.functionCall ?? part.function_call
            if (functionCall?.name) {
              const toolCallId = `${functionCall.name}:${JSON.stringify(functionCall.args ?? {})}`
              if (!emittedToolCalls.has(toolCallId)) {
                emittedToolCalls.add(toolCallId)
                if (firstTokenAt === null) firstTokenAt = Date.now()
                const args = functionCall.args ?? {}
                const argumentsDelta = JSON.stringify(args)
                yield {
                  type: 'tool_call_start',
                  toolCallId,
                  toolName: functionCall.name,
                  ...(thoughtSignature
                    ? { toolCallExtraContent: { google: { thought_signature: thoughtSignature } } }
                    : {})
                }
                yield {
                  type: 'tool_call_delta',
                  toolCallId,
                  argumentsDelta
                }
                yield {
                  type: 'tool_call_end',
                  toolCallId,
                  toolName: functionCall.name,
                  toolCallInput: args,
                  ...(thoughtSignature
                    ? { toolCallExtraContent: { google: { thought_signature: thoughtSignature } } }
                    : {})
                }
              }
            }

            const inlineData = extractInlineData(part)
            if (inlineData?.data) {
              if (firstTokenAt === null) firstTokenAt = Date.now()
              emittedAnything = true
              const imageBlock = await persistGeneratedImage(
                inlineData.data,
                inlineData.mimeType || inlineData.mime_type || 'image/png'
              )
              yield {
                type: 'image_generated',
                imageBlock
              }
            }
          }
        }
      }

      if (!emittedAnything && imageMode) {
        const fallbackResponse = await this.fetchNonStream(messages, tools, config, signal)
        for (const event of fallbackResponse.events) {
          yield event
        }
        return
      }

      const requestCompletedAt = Date.now()
      const promptTokenCount = usageMetadata?.promptTokenCount ?? 0
      outputTokens =
        usageMetadata?.candidatesTokenCount ??
        Math.max((usageMetadata?.totalTokenCount ?? 0) - promptTokenCount, 0)

      yield {
        type: 'message_end',
        stopReason: pendingStopReason || 'stop',
        ...(usageMetadata
          ? {
              usage: {
                inputTokens: promptTokenCount,
                outputTokens,
                ...(usageMetadata.thoughtsTokenCount
                  ? { reasoningTokens: usageMetadata.thoughtsTokenCount }
                  : {})
              }
            }
          : {}),
        timing: {
          totalMs: requestCompletedAt - requestStartedAt,
          ttftMs: firstTokenAt ? firstTokenAt - requestStartedAt : undefined,
          tps: computeTps(outputTokens, firstTokenAt, requestCompletedAt)
        }
      }
    } catch (error) {
      const normalizedError = normalizeGeminiError(error)
      console.error('[Gemini Provider] Error:', normalizedError.message, error)

      yield {
        type: imageMode ? 'image_error' : 'error',
        ...(imageMode
          ? {
              imageError: {
                code: normalizedError.code,
                message: normalizedError.message
              }
            }
          : {
              error: {
                type: normalizedError.code,
                message: normalizedError.message
              }
            })
      }

      const requestCompletedAt = Date.now()
      yield {
        type: 'message_end',
        stopReason: 'error',
        timing: {
          totalMs: requestCompletedAt - requestStartedAt,
          ttftMs: firstTokenAt
            ? firstTokenAt - requestStartedAt
            : requestCompletedAt - requestStartedAt
        }
      }
    }
  }

  private async fetchNonStream(
    messages: UnifiedMessage[],
    tools: ToolDefinition[],
    config: ProviderConfig,
    signal?: AbortSignal
  ): Promise<{ events: StreamEvent[] }> {
    const body: Record<string, unknown> = {
      contents: this.formatMessages(messages) as GeminiContent[]
    }

    const formattedTools = this.formatTools(tools) as Array<Record<string, unknown>>
    if (formattedTools.length > 0) {
      body.tools = formattedTools
    }

    const generationConfig: Record<string, unknown> = {
      responseModalities: ['IMAGE']
    }
    if (config.temperature !== undefined) generationConfig.temperature = config.temperature
    if (config.maxTokens) generationConfig.maxOutputTokens = config.maxTokens
    body.generationConfig = generationConfig

    if (config.systemPrompt?.trim()) {
      body.systemInstruction = {
        parts: [{ text: config.systemPrompt.trim() }]
      }
    }

    if (config.thinkingEnabled && config.thinkingConfig) {
      Object.assign(body, config.thinkingConfig.bodyParams)
    } else if (!config.thinkingEnabled && config.thinkingConfig?.disabledBodyParams) {
      Object.assign(body, config.thinkingConfig.disabledBodyParams)
    }

    applyBodyOverrides(body, config)

    const url = buildApiUrl(this.type, config.baseUrl, config.model, false)
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-goog-api-key': config.apiKey
    }
    if (config.userAgent) headers['User-Agent'] = config.userAgent
    applyHeaderOverrides(headers, config)

    const requestSignal = createRequestSignal(signal)
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: requestSignal.signal
      })
    } catch (error) {
      throw mapFetchError(error, requestSignal.didTimeout())
    } finally {
      requestSignal.cleanup()
    }

    if (!response.ok) {
      let errorMessage = `Gemini request failed: ${response.status}`
      try {
        const errorData = (await response.json()) as {
          error?: { message?: string }
          message?: string
        }
        if (errorData.error?.message) {
          errorMessage = errorData.error.message
        } else if (errorData.message) {
          errorMessage = errorData.message
        }
      } catch {
        errorMessage = await response.text().catch(() => errorMessage)
      }
      throw new GeminiRequestError(errorMessage, {
        code: 'api_error',
        statusCode: response.status
      })
    }

    const data = (await response.json()) as GeminiGenerateContentResponse
    const events: StreamEvent[] = []
    for (const image of extractGeneratedImages(data)) {
      events.push({
        type: 'image_generated',
        imageBlock: await persistGeneratedImage(image.data, image.mediaType)
      })
    }

    const usageMetadata = data.usageMetadata
    const promptTokenCount = usageMetadata?.promptTokenCount ?? 0
    const outputTokens =
      usageMetadata?.candidatesTokenCount ??
      Math.max((usageMetadata?.totalTokenCount ?? 0) - promptTokenCount, 0)

    events.push({
      type: 'message_end',
      stopReason:
        data.candidates?.[0]?.finishReason ?? data.candidates?.[0]?.finish_reason ?? 'stop',
      ...(usageMetadata
        ? {
            usage: {
              inputTokens: promptTokenCount,
              outputTokens,
              ...(usageMetadata.thoughtsTokenCount
                ? { reasoningTokens: usageMetadata.thoughtsTokenCount }
                : {})
            }
          }
        : {})
    })

    return { events }
  }

  formatMessages(messages: UnifiedMessage[]): unknown {
    const formatted: GeminiContent[] = []
    const toolCallNameById = new Map<string, string>()

    for (const message of messages) {
      if (message.role === 'system') continue

      const parts: GeminiPart[] = []
      const blocks =
        typeof message.content === 'string'
          ? ([{ type: 'text', text: message.content }] as ContentBlock[])
          : (message.content as ContentBlock[])

      for (const block of blocks) {
        switch (block.type) {
          case 'text':
            if (block.text) parts.push({ text: block.text })
            break
          case 'thinking':
            if (block.thinking) {
              parts.push({
                text: block.thinking,
                thought: true,
                ...(block.encryptedContent &&
                (block.encryptedContentProvider === 'google' || !block.encryptedContentProvider)
                  ? { thoughtSignature: block.encryptedContent }
                  : {})
              })
            }
            break
          case 'image':
            if (block.source.type === 'base64' && block.source.data) {
              parts.push({
                inlineData: {
                  mimeType: block.source.mediaType || 'image/png',
                  data: block.source.data
                }
              })
            } else if (block.source.type === 'url' && block.source.url) {
              parts.push({
                fileData: {
                  mimeType: block.source.mediaType || 'image/png',
                  fileUri: block.source.url
                }
              })
            }
            break
          case 'tool_use':
            toolCallNameById.set(block.id, block.name)
            parts.push({
              functionCall: {
                name: block.name,
                args: block.input
              },
              ...(block.extraContent?.google?.thought_signature
                ? { thoughtSignature: block.extraContent.google.thought_signature }
                : {})
            })
            break
          case 'tool_result': {
            const toolName = toolCallNameById.get(block.toolUseId) ?? block.toolUseId
            parts.push({
              functionResponse: {
                name: toolName,
                response: {
                  name: toolName,
                  content: parseToolResponseContent(block.content)
                }
              }
            })
            break
          }
          default:
            break
        }
      }

      if (parts.length === 0) continue

      const role: GeminiRole = message.role === 'assistant' ? 'model' : 'user'
      formatted.push({ role, parts })
    }

    return formatted
  }

  formatTools(tools: ToolDefinition[]): unknown {
    if (tools.length === 0) return []
    return [
      {
        functionDeclarations: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: this.normalizeToolSchema(tool.inputSchema)
        }))
      }
    ]
  }

  private normalizeToolSchema(schema: ToolDefinition['inputSchema']): Record<string, unknown> {
    if ('properties' in schema) {
      return this.sanitizeGeminiSchema({
        type: 'object',
        properties: schema.properties,
        ...(schema.required ? { required: schema.required } : {})
      })
    }

    const mergedProperties: Record<string, unknown> = {}
    let requiredIntersection: string[] | null = null

    for (const variant of schema.oneOf) {
      for (const [key, value] of Object.entries(variant.properties ?? {})) {
        if (!(key in mergedProperties)) {
          mergedProperties[key] = value
        }
      }

      const required = variant.required ?? []
      if (requiredIntersection === null) {
        requiredIntersection = [...required]
      } else {
        requiredIntersection = requiredIntersection.filter((key) => required.includes(key))
      }
    }

    return this.sanitizeGeminiSchema({
      type: 'object',
      properties: mergedProperties,
      ...(requiredIntersection && requiredIntersection.length > 0
        ? { required: requiredIntersection }
        : {})
    })
  }

  private sanitizeGeminiSchema(value: unknown): Record<string, unknown> {
    return (this.sanitizeGeminiSchemaNode(value) as Record<string, unknown>) ?? { type: 'object' }
  }

  private sanitizeGeminiSchemaNode(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value
        .map((item) => this.sanitizeGeminiSchemaNode(item))
        .filter((item) => item !== undefined)
    }

    if (!value || typeof value !== 'object') {
      return value
    }

    const record = value as Record<string, unknown>
    const sanitized: Record<string, unknown> = {}

    for (const [key, child] of Object.entries(record)) {
      if (
        key === 'additionalProperties' ||
        key === 'const' ||
        key === 'oneOf' ||
        key === 'anyOf' ||
        key === 'allOf' ||
        key === '$schema' ||
        key === '$defs' ||
        key === 'definitions' ||
        key === 'patternProperties' ||
        key === 'unevaluatedProperties'
      ) {
        continue
      }

      const normalizedChild = this.sanitizeGeminiSchemaNode(child)
      if (normalizedChild !== undefined) {
        sanitized[key] = normalizedChild
      }
    }

    if (sanitized.type === 'object' && !('properties' in sanitized)) {
      sanitized.properties = {}
    }

    return sanitized
  }
}

export function registerGeminiProvider(): void {
  registerProvider('gemini', () => new GeminiNativeProvider('gemini'))
  registerProvider('vertex-ai', () => new GeminiNativeProvider('vertex-ai'))
}
