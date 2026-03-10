import { nanoid } from 'nanoid'
import { createProvider } from './api/provider'
import type { ProviderConfig, UnifiedMessage, ContentBlock } from './api/types'
import type { ImageAttachment } from './image-attachments'
import { imageAttachmentToContentBlock } from './image-attachments'

const DRAW_OPTIMIZER_SYSTEM_PROMPT = `You are a professional image-generation prompt optimizer.

Your job is to lightly improve the user's image prompt from the perspective of an expert image model operator.

Rules:
- Preserve the user's original intent, subject, and mood.
- Do NOT over-rewrite, do NOT invent a different scene, and do NOT add unrelated themes.
- Only expand the positive prompt with missing but helpful visual details such as subject clarity, scene detail, composition, lighting, camera/lens language, materials, atmosphere, style cues, and rendering quality.
- Keep the result concise and usable. Avoid turning it into a long template.
- Return exactly one final optimized prompt.
- Do not include explanations, bullet points, titles, quotes, or markdown.
- Keep the output language aligned with the user's original prompt language.
- If reference images are provided, use them only as supporting visual context and still preserve the user's text intent as primary.
`

export interface DrawPromptOptimizationResult {
  prompt: string
}

function buildUserContent(prompt: string, images: ImageAttachment[]): string | ContentBlock[] {
  if (images.length === 0) {
    return `Please lightly optimize this image-generation prompt and return only the final prompt:\n\n${prompt}`
  }

  return [
    ...images.map(imageAttachmentToContentBlock),
    {
      type: 'text',
      text: `Please lightly optimize this image-generation prompt. Reference images are provided as optional visual context. Preserve the user's intent and return only the final prompt:\n\n${prompt}`
    }
  ]
}

export async function optimizeDrawPrompt(
  prompt: string,
  providerConfig: ProviderConfig,
  images: ImageAttachment[] = [],
  signal?: AbortSignal
): Promise<DrawPromptOptimizationResult> {
  const provider = createProvider(providerConfig)
  const messages: UnifiedMessage[] = [
    {
      id: nanoid(),
      role: 'user',
      content: buildUserContent(prompt, images),
      createdAt: Date.now()
    }
  ]

  let output = ''

  for await (const event of provider.sendMessage(
    messages,
    [],
    {
      ...providerConfig,
      systemPrompt: DRAW_OPTIMIZER_SYSTEM_PROMPT,
      temperature: 0.4,
      maxTokens: 600
    },
    signal
  )) {
    if (event.type === 'text_delta' && event.text) {
      output += event.text
    }

    if (event.type === 'error') {
      throw new Error(event.error?.message || 'Prompt optimization failed')
    }
  }

  const optimized = output.trim()
  if (!optimized) {
    throw new Error('Prompt optimization returned empty content')
  }

  return { prompt: optimized }
}
