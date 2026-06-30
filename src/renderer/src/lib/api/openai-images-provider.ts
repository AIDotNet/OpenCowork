import type {
  ImageErrorCode,
  ProviderConfig,
  StreamEvent,
  UnifiedMessage,
  ContentBlock,
  ImageBlock
} from './types'
import { ipcClient } from '../ipc/ipc-client'
import { IPC } from '../ipc/channels'
import { agentBridge } from '../ipc/agent-bridge'

const OPENAI_IMAGES_NATIVE_TIMEOUT_MS = 10 * 60 * 1000

interface Base64ImageInput {
  dataUrl: string
  mediaType?: string
}

interface GeneratedImage {
  sourceType: 'base64' | 'url'
  data: string
  mediaType: string
}

interface NativeOpenAIImagesResult {
  images?: Array<{
    sourceType?: string
    data?: string
    mediaType?: string
  }>
}

function normalizeImageProviderError(error: unknown): { code: ImageErrorCode; message: string } {
  return {
    code: 'unknown',
    message: error instanceof Error ? error.message : String(error)
  }
}

function normalizeNativeImagesResult(result: unknown): GeneratedImage[] {
  const payload = result as NativeOpenAIImagesResult | null
  const images = Array.isArray(payload?.images) ? payload.images : []
  return images
    .map((image): GeneratedImage | null => {
      if (!image || typeof image.data !== 'string' || !image.data.trim()) return null
      const sourceType = image.sourceType === 'url' ? 'url' : 'base64'
      return {
        sourceType,
        data: image.data,
        mediaType:
          typeof image.mediaType === 'string' && image.mediaType ? image.mediaType : 'image/png'
      }
    })
    .filter((image): image is GeneratedImage => Boolean(image))
}

async function requestNativeImages(args: {
  config: ProviderConfig
  prompt: string
  images: Base64ImageInput[]
}): Promise<GeneratedImage[]> {
  const initialized = await agentBridge.initialize()
  if (!initialized) {
    throw new Error('Native worker unavailable for image generation.')
  }

  const result = await agentBridge.request(
    'openai-images/generate',
    {
      provider: args.config,
      prompt: args.prompt,
      images: args.images
    },
    OPENAI_IMAGES_NATIVE_TIMEOUT_MS
  )
  const images = normalizeNativeImagesResult(result)
  if (images.length === 0) {
    throw new Error('Native image generation returned no image output.')
  }
  return images
}

async function persistGeneratedImage(image: GeneratedImage): Promise<ImageBlock> {
  const fallback: ImageBlock = {
    type: 'image',
    source:
      image.sourceType === 'base64'
        ? { type: 'base64', mediaType: image.mediaType, data: image.data }
        : { type: 'url', url: image.data }
  }

  try {
    const result = (await ipcClient.invoke(IPC.IMAGE_PERSIST_GENERATED, {
      ...(image.sourceType === 'base64'
        ? { data: image.data, mediaType: image.mediaType }
        : { url: image.data })
    })) as {
      filePath?: string
      mediaType?: string
      data?: string
      error?: string
    }

    if (result?.error || !result?.data) {
      if (result?.error) {
        console.warn('[OpenAI Images Provider] Failed to persist generated image:', result.error)
      }
      return fallback
    }

    return {
      type: 'image',
      source: {
        type: 'base64',
        mediaType: result.mediaType || image.mediaType || 'image/png',
        data: result.data,
        filePath: result.filePath
      }
    }
  } catch (error) {
    console.warn('[OpenAI Images Provider] Failed to persist generated image:', error)
    return fallback
  }
}

export async function* streamNativeOpenAIImages(args: {
  messages: UnifiedMessage[]
  config: ProviderConfig
  signal?: AbortSignal
}): AsyncIterable<StreamEvent> {
  const requestStartedAt = Date.now()
  let firstImageAt: number | null = null

  console.log('[OpenAI Images Provider] native image request start:', {
    type: args.config.type,
    model: args.config.model,
    baseUrl: args.config.baseUrl
  })

  try {
    yield { type: 'message_start' }

    const lastUserMessage = [...args.messages].reverse().find((m) => m.role === 'user')
    if (!lastUserMessage) {
      throw new Error('No user message found')
    }

    let textPrompt = ''
    const imageInputs: Base64ImageInput[] = []

    if (typeof lastUserMessage.content === 'string') {
      textPrompt = lastUserMessage.content
    } else {
      const contentBlocks = lastUserMessage.content as ContentBlock[]
      for (const block of contentBlocks) {
        if (block.type === 'text') {
          textPrompt += block.text
        } else if (block.type === 'image') {
          const imgBlock = block as ImageBlock
          if (imgBlock.source.type === 'base64') {
            imageInputs.push({
              dataUrl: `data:${imgBlock.source.mediaType || 'image/png'};base64,${imgBlock.source.data}`,
              mediaType: imgBlock.source.mediaType
            })
          }
        }
      }
    }

    if (!textPrompt.trim()) {
      textPrompt = 'Edit this image'
    }

    if (args.signal?.aborted) {
      throw new Error('Image request was cancelled')
    }

    const results = await requestNativeImages({
      config: args.config,
      prompt: textPrompt,
      images: imageInputs
    })

    for (const img of results) {
      if (firstImageAt === null) firstImageAt = Date.now()
      const imageBlock = await persistGeneratedImage(img)
      yield { type: 'image_generated', imageBlock }
    }

    const requestCompletedAt = Date.now()
    yield {
      type: 'message_end',
      stopReason: 'stop',
      timing: {
        totalMs: requestCompletedAt - requestStartedAt,
        ttftMs: firstImageAt
          ? firstImageAt - requestStartedAt
          : requestCompletedAt - requestStartedAt
      }
    }
  } catch (error) {
    const normalizedError = normalizeImageProviderError(error)
    console.error('[OpenAI Images Provider] Error:', normalizedError.message, error)

    yield {
      type: 'image_error',
      imageError: {
        code: normalizedError.code,
        message: normalizedError.message
      }
    }

    const requestCompletedAt = Date.now()
    yield {
      type: 'message_end',
      stopReason: 'error',
      timing: {
        totalMs: requestCompletedAt - requestStartedAt,
        ttftMs: firstImageAt
          ? firstImageAt - requestStartedAt
          : requestCompletedAt - requestStartedAt
      }
    }

    return
  }
}
