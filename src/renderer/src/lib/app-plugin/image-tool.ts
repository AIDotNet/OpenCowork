import { nanoid } from 'nanoid'
import { createProvider } from '@renderer/lib/api/provider'
import type {
  ImageBlock,
  TextBlock,
  ToolResultContent,
  UnifiedMessage
} from '@renderer/lib/api/types'
import type { ToolHandler } from '@renderer/lib/tools/tool-types'
import { useAppPluginStore } from '@renderer/stores/app-plugin-store'
import { IMAGE_GENERATE_TOOL_NAME } from './types'

function normalizeCount(input: unknown): number {
  const parsed = typeof input === 'number' ? input : Number(input)
  if (!Number.isFinite(parsed)) return 1
  return Math.max(1, Math.min(4, Math.floor(parsed)))
}

export const imageGenerateTool: ToolHandler = {
  definition: {
    name: IMAGE_GENERATE_TOOL_NAME,
    description:
      'Generate images with the configured image plugin. Only use this when the user explicitly asks for an image, illustration, poster, render, icon, or artwork. Write prompt as a complete visual description. count defaults to 1 and is capped at 4.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'A complete image-generation prompt describing the desired visual result'
        },
        count: {
          type: 'number',
          description: 'How many images to generate. Defaults to 1 and is capped at 4.'
        }
      },
      required: ['prompt']
    }
  },
  execute: async (input, ctx): Promise<ToolResultContent> => {
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
    const count = normalizeCount(input.count)

    if (!prompt) {
      return JSON.stringify({ error: 'ImageGenerate requires a non-empty prompt.' })
    }

    const providerConfig = useAppPluginStore.getState().getResolvedImagePluginConfig()
    if (!providerConfig) {
      return JSON.stringify({
        error: 'Image plugin is disabled or has no valid image model configured.'
      })
    }

    const provider = createProvider(providerConfig)
    const images: ImageBlock[] = []
    const notes: TextBlock[] = []

    for (let index = 0; index < count; index += 1) {
      const userMessage: UnifiedMessage = {
        id: nanoid(),
        role: 'user',
        content: prompt,
        createdAt: Date.now()
      }

      let iterationFailed = false
      let iterationError = 'Unknown image generation error.'
      const iterationImages: ImageBlock[] = []

      for await (const event of provider.sendMessage(
        [userMessage],
        [],
        providerConfig,
        ctx.signal
      )) {
        if (event.type === 'image_generated' && event.imageBlock) {
          iterationImages.push(event.imageBlock)
        }

        if (event.type === 'image_error' && event.imageError) {
          iterationFailed = true
          iterationError = event.imageError.message
        }
      }

      if (iterationFailed) {
        if (images.length === 0) {
          return JSON.stringify({ error: iterationError })
        }

        notes.push({
          type: 'text',
          text: `Stopped after ${images.length} image(s). Request ${index + 1} failed: ${iterationError}`
        })
        break
      }

      images.push(...iterationImages)
    }

    if (images.length === 0) {
      return JSON.stringify({ error: 'Image generation returned no images.' })
    }

    return [...images, ...notes]
  },
  requiresApproval: () => false
}
