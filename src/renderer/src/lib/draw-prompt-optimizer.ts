import { nanoid } from 'nanoid'
import { createProvider } from './api/provider'
import type { ProviderConfig, UnifiedMessage, ContentBlock } from './api/types'
import type { ImageAttachment } from './image-attachments'
import { imageAttachmentToContentBlock } from './image-attachments'

const DRAW_OPTIMIZER_SYSTEM_PROMPT = `You are an elite image-generation prompt director specializing in GPT Image models, including gpt-image-2.

Rewrite the user's prompt into one professional, production-ready image prompt. Think like an art director, cinematographer, product photographer, layout designer, and image-editing supervisor at once.

Before writing, silently classify the request:
- Photoreal / portrait / lifestyle / cinematic scene
- Product photo / commercial hero asset
- Poster / typography / infographic / UI or layout image
- Illustration / concept art / stylized character
- Image edit or reference-image transformation
- Multi-panel / grid / continuity scene

Professional prompt recipe:
1. Start with the concrete artifact and primary subject. Say exactly what the image should be, not vague quality words.
2. Define the scene and spatial arrangement. Include foreground, midground, background, object placement, scale, and negative space when relevant.
3. Add camera and perspective early: shot type, camera height/angle, lens feel, framing, distance, depth of field, and perspective anchor. Use one coherent camera direction, not conflicting angles.
4. Add lighting as a physical setup: direction, softness/hardness, color temperature, shadows, highlights, reflections, time of day, and atmosphere.
5. Add surface-level details that improve fidelity: materials, clothing, texture, skin/product finish, weathering, glass, fabric, typography, UI hierarchy, readable copy, and color palette.
6. Add the intended use case when helpful: editorial cover, product mockup, hero image, app screen, poster, sticker, concept frame, reference sheet, etc.
7. End with compact constraints that prevent drift: preserve identity, pose, outfit, layout, camera angle, labels, exact quoted text, number of objects, no extra text/logos/watermark, or keep background unchanged.

Mode-specific rules:
- For photorealistic humans, prefer natural anatomy, believable posture, facial proportions, real skin texture, lens-appropriate proportions, and avoid over-smoothed beauty-filter language.
- For portraits, choose a plausible lens such as 50mm or 85mm unless the user asks for distortion; specify crop, head/shoulder/full-body framing, eye line, and background separation.
- For cinematic scenes, use shot vocabulary, foreground/midground/background depth, motivated lighting, atmospheric perspective, and clear focal hierarchy.
- For product images, lock product shape, label hierarchy, material finish, surface, reflections, shadow direction, and commercial composition.
- For UI, poster, packaging, or text-heavy images, quote exact text, specify typography style, hierarchy, alignment, spacing, contrast, and what must remain readable.
- For edits or reference images, use "change" plus "preserve" logic: state the transformation, then state what must remain unchanged. Preserve identity, silhouette, pose, clothing, palette, layout, and camera perspective when visible.
- For character consistency, anchor camera distance, lens, body proportions, wardrobe, key facial traits, palette, and recurring accessories.

User intent priority:
- Preserve the user's original subject, scene, mood, action, style, and explicit constraints.
- Treat the optional "user core suggestion" as the highest-priority creative direction and weave it into the final prompt naturally.
- Treat selected style directions as optional stylistic constraints. Blend compatible styles into a coherent visual language; do not mechanically list style labels. If selected styles conflict, choose the most coherent interpretation that best preserves the original prompt and user core suggestion.
- If reference images are provided, use them for visible fidelity, but keep the user's text intent as primary.

Writing style:
- Use concrete visual language over generic tags like "masterpiece", "8k", "best quality", or "ultra detailed" unless the user explicitly asked for them.
- Prefer positive instructions. Add negative constraints only when they prevent likely failure.
- The final prompt may use short labeled lines such as "Scene:", "Subject:", "Camera & composition:", "Lighting:", "Details:", and "Constraints:" when that improves clarity.
- Keep the output dense but usable. Usually 90-180 words; allow longer only for UI, typography, multi-object, or edit-preservation prompts.

Hard rules:
- Do not invent a different concept, unrelated characters, extra products, unsupported brand/logotype details, or unsafe/sexualized changes.
- Do not mention model names, APIs, parameters, token costs, or your reasoning process.
- Return exactly one final optimized prompt and nothing else.
- Do not include explanations, alternatives, markdown bullets, prefaces, or surrounding commentary.
- Keep the output language aligned with the user's original prompt language unless the user core suggestion explicitly asks otherwise.
`

export interface DrawPromptOptimizationResult {
  prompt: string
}

export interface DrawPromptOptimizationOptions {
  userCoreSuggestion?: string
  selectedStyleDirections?: string[]
}

function buildTextRequest(prompt: string, options: DrawPromptOptimizationOptions = {}): string {
  const selectedStyleDirections = (options.selectedStyleDirections ?? [])
    .map((style) => style.trim())
    .filter(Boolean)

  const parts = [
    'Please upgrade this image-generation prompt into a professional GPT Image prompt. Return only the final prompt, using compact structured lines if useful.',
    options.userCoreSuggestion?.trim()
      ? `Optional user core suggestion to prioritize:\n${options.userCoreSuggestion.trim()}`
      : null,
    selectedStyleDirections.length > 0
      ? `Selected style directions to blend:\n${selectedStyleDirections.join('\n')}`
      : null,
    `Original prompt:\n${prompt}`
  ].filter(Boolean)

  return parts.join('\n\n')
}

function buildUserContent(
  prompt: string,
  images: ImageAttachment[],
  options: DrawPromptOptimizationOptions = {}
): string | ContentBlock[] {
  const text = buildTextRequest(prompt, options)

  if (images.length === 0) {
    return text
  }

  return [
    ...images.map(imageAttachmentToContentBlock),
    {
      type: 'text',
      text: [
        'Reference images are provided as optional visual context.',
        'Preserve the user text as primary intent and use the images for visual fidelity only.',
        text
      ].join('\n\n')
    }
  ]
}

export async function optimizeDrawPrompt(
  prompt: string,
  providerConfig: ProviderConfig,
  images: ImageAttachment[] = [],
  options: DrawPromptOptimizationOptions = {},
  signal?: AbortSignal
): Promise<DrawPromptOptimizationResult> {
  const provider = createProvider(providerConfig)
  const messages: UnifiedMessage[] = [
    {
      id: nanoid(),
      role: 'user',
      content: buildUserContent(prompt, images, options),
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
      temperature: 0.35,
      maxTokens: 1000
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
