import type { ToolHandler } from '@renderer/lib/tools/tool-types'
import { IMAGE_GENERATE_TOOL_NAME } from './types'

function nativeOnlyImageGenerateResult(): string {
  return JSON.stringify({
    error: 'ImageGenerate executes in the .NET Native Worker and is unavailable through the renderer boundary.'
  })
}

export const imageGenerateTool: ToolHandler = {
  definition: {
    name: IMAGE_GENERATE_TOOL_NAME,
    description:
      'Generate images when the user needs visual content. Use proactively whenever an image would help—whether they explicitly ask for one or imply a need (e.g. "show me", "what does X look like", creating illustrations/icons/diagrams, visualizing concepts). When writing the prompt: align with user intent, include subject/style/composition/mood, be specific and concrete, infer style from user wording. count defaults to 1, max 4.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description:
            'Complete visual prompt aligned with user intent. Include: subject, style (e.g. realistic, cartoon, minimalist), composition, lighting/mood. Be specific and concrete; infer style from user wording (e.g. "cute" → cute/kawaii style). Prefer concise, descriptive English; avoid vague or abstract phrasing.'
        },
        count: {
          type: 'number',
          description: 'How many images to generate. Defaults to 1 and is capped at 4.'
        },
        reference_images: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional local image paths to use as visual references. Each path may be absolute or relative to the working folder. Up to 6 images are used.'
        },
        size: {
          type: 'string',
          enum: ['auto', '1024x1024', '1024x1536', '1536x1024'],
          description:
            'Optional image size. Use auto or omit to keep the configured provider default.'
        },
        quality: {
          type: 'string',
          enum: ['auto', 'low', 'medium', 'high'],
          description:
            'Optional image quality. Use auto or omit to keep the configured provider default.'
        }
      },
      required: ['prompt']
    }
  },
  execute: async () => nativeOnlyImageGenerateResult(),
  requiresApproval: () => false
}
