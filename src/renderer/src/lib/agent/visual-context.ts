import type { ContentBlock, ImageBlock, UnifiedMessage } from '@renderer/lib/api/types'
import { IPC } from '@renderer/lib/ipc/channels'

export type VisualArtifactSourceKind =
  | 'assistant_image'
  | 'tool_image'
  | 'read_image'
  | 'browser_screenshot'
  | 'desktop_screenshot'
  | 'image_generate'

export interface VisualArtifactReference {
  sourceMessageId: string
  sourceKind: VisualArtifactSourceKind
  filePath?: string
  url?: string
  mediaType?: string
  imageBlock: ImageBlock
  createdAt: number
}

export interface VisualContextInjectionOptions {
  ipc: {
    invoke(channel: string, args?: unknown): Promise<unknown>
  }
  supportsVision: boolean
  maxArtifacts?: number
  recentMessageLimit?: number
}

const DEFAULT_MAX_ARTIFACTS = 4
const DEFAULT_RECENT_MESSAGE_LIMIT = 16

const PRODUCT_DESIGN_CONTEXT_RE =
  /product\s*design|image-to-code|design\s*qa|visual\s+target|prototype|mockup|screenshot|原型|还原|视觉目标|截图|设计\s*qa/i
const VISUAL_INTENT_RE =
  /image|picture|photo|screenshot|visual|mockup|prototype|figma|ui|ux|layout|pixel|design|reference|inspect|compare|target|qa|图片|图像|截图|视觉|界面|页面|原型|还原|设计|参考图|对比|看图|这张图|这个图/i
const SHORT_VISUAL_REFERENCE_RE =
  /^(?:this|that|it|the image|the screenshot|full|static|option\s*\d+|direction\s*\d+|这个|这个图|这张|那张|上面这个|刚才的|上一张|第\s*[一二三四\d]\s*(?:个|张|种|版)?|方向\s*[一二三四\d]|选\s*[一二三四\d]?)$/i
const TITLE_LIKE_REFERENCE_RE = /^[A-Z][A-Za-z0-9]*(?:[ -]+[A-Z][A-Za-z0-9]*){0,5}$/
const SHORT_NAMED_REFERENCE_RE = /^[\p{L}\p{N}][\p{L}\p{N} _-]{1,60}$/u
const THANKS_RE = /^(?:thanks?|thank you|ok|okay|好的|谢谢|可以|明白|收到)$/i

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function getMessageText(message: UnifiedMessage): string {
  if (typeof message.content === 'string') return message.content
  return message.content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

function messageContainsImage(message: UnifiedMessage): boolean {
  return Array.isArray(message.content) && message.content.some((block) => block.type === 'image')
}

function messageContainsUserImage(message: UnifiedMessage): boolean {
  return message.role === 'user' && messageContainsImage(message)
}

function cloneImageBlock(block: ImageBlock): ImageBlock {
  return {
    type: 'image',
    source: { ...block.source }
  }
}

function getImageReferenceKey(block: ImageBlock): string | null {
  const filePath = block.source.filePath?.trim()
  if (filePath) return `file:${filePath}`

  if (block.source.type === 'url') {
    const url = block.source.url?.trim()
    if (url) return `url:${url}`
  }

  const data = block.source.data?.trim()
  if (data) return `data:${data.length}:${data.slice(0, 96)}`

  return null
}

function mediaTypeFromPath(filePath?: string): string | undefined {
  const normalized = filePath?.split(/[?#]/, 1)[0]?.toLowerCase() ?? ''
  if (normalized.endsWith('.jpg') || normalized.endsWith('.jpeg')) return 'image/jpeg'
  if (normalized.endsWith('.webp')) return 'image/webp'
  if (normalized.endsWith('.gif')) return 'image/gif'
  if (normalized.endsWith('.svg')) return 'image/svg+xml'
  if (normalized.endsWith('.png')) return 'image/png'
  return undefined
}

function sourceKindFromToolName(toolName?: string): VisualArtifactSourceKind {
  const normalized = toolName?.trim().toLowerCase() ?? ''
  if (normalized === 'read') return 'read_image'
  if (normalized === 'browserscreenshot') return 'browser_screenshot'
  if (normalized === 'desktopscreenshot') return 'desktop_screenshot'
  if (normalized === 'imagegenerate') return 'image_generate'
  return 'tool_image'
}

function sourceKindLabel(kind: VisualArtifactSourceKind): string {
  switch (kind) {
    case 'assistant_image':
      return 'assistant image'
    case 'read_image':
      return 'Read image'
    case 'browser_screenshot':
      return 'Browser screenshot'
    case 'desktop_screenshot':
      return 'Desktop screenshot'
    case 'image_generate':
      return 'ImageGenerate output'
    case 'tool_image':
      return 'tool image'
  }
}

function collectToolNames(messages: UnifiedMessage[]): Map<string, string> {
  const toolNames = new Map<string, string>()
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block.type === 'tool_use') {
        toolNames.set(block.id, block.name)
      }
    }
  }
  return toolNames
}

function addArtifact(
  artifacts: VisualArtifactReference[],
  seenKeys: Set<string>,
  args: {
    message: UnifiedMessage
    block: ImageBlock
    sourceKind: VisualArtifactSourceKind
  }
): void {
  const key = getImageReferenceKey(args.block)
  if (!key || seenKeys.has(key)) return
  seenKeys.add(key)

  artifacts.push({
    sourceMessageId: args.message.id,
    sourceKind: args.sourceKind,
    filePath: args.block.source.filePath,
    url: args.block.source.type === 'url' ? args.block.source.url : undefined,
    mediaType: args.block.source.mediaType ?? mediaTypeFromPath(args.block.source.filePath),
    imageBlock: cloneImageBlock(args.block),
    createdAt: args.message.createdAt
  })
}

export function collectRecentVisualArtifacts(
  messages: UnifiedMessage[],
  beforeIndex: number,
  options?: { maxArtifacts?: number; recentMessageLimit?: number }
): VisualArtifactReference[] {
  const maxArtifacts = options?.maxArtifacts ?? DEFAULT_MAX_ARTIFACTS
  const recentMessageLimit = options?.recentMessageLimit ?? DEFAULT_RECENT_MESSAGE_LIMIT
  const start = Math.max(0, beforeIndex - recentMessageLimit)
  const windowMessages = messages.slice(start, beforeIndex)
  const toolNames = collectToolNames(windowMessages)
  const artifacts: VisualArtifactReference[] = []
  const seenKeys = new Set<string>()

  for (let index = windowMessages.length - 1; index >= 0; index -= 1) {
    const message = windowMessages[index]
    if (!message || !Array.isArray(message.content)) continue

    for (const block of message.content) {
      if (artifacts.length >= maxArtifacts) return artifacts

      if (message.role === 'assistant' && block.type === 'image') {
        addArtifact(artifacts, seenKeys, {
          message,
          block,
          sourceKind: 'assistant_image'
        })
        continue
      }

      if (block.type === 'tool_result' && Array.isArray(block.content)) {
        const toolName = toolNames.get(block.toolUseId)
        for (const resultBlock of block.content) {
          if (artifacts.length >= maxArtifacts) return artifacts
          if (resultBlock.type !== 'image') continue
          addArtifact(artifacts, seenKeys, {
            message,
            block: resultBlock,
            sourceKind: sourceKindFromToolName(toolName)
          })
        }
      }
    }
  }

  return artifacts
}

function blockContainsImage(block: ContentBlock): boolean {
  return (
    block.type === 'image' ||
    (block.type === 'tool_result' &&
      Array.isArray(block.content) &&
      block.content.some((resultBlock) => resultBlock.type === 'image'))
  )
}

function hasRecentVisualMessage(messages: UnifiedMessage[], lastUserIndex: number): boolean {
  for (let index = lastUserIndex - 1; index >= Math.max(0, lastUserIndex - 4); index -= 1) {
    const message = messages[index]
    if (!message || message.role === 'system') continue
    if (Array.isArray(message.content) && message.content.some(blockContainsImage)) return true
    if (message.role === 'user' && !isToolResultOnlyMessage(message)) return false
  }
  return false
}

function isToolResultOnlyMessage(message: UnifiedMessage): boolean {
  return (
    Array.isArray(message.content) &&
    message.content.length > 0 &&
    message.content.every((block) => block.type === 'tool_result')
  )
}

function shouldInjectVisualContext(args: {
  messages: UnifiedMessage[]
  lastUserIndex: number
  userText: string
}): boolean {
  const text = normalizeText(args.userText)
  if (!text) return false
  if (PRODUCT_DESIGN_CONTEXT_RE.test(text)) return true
  if (VISUAL_INTENT_RE.test(text)) return true

  if (!hasRecentVisualMessage(args.messages, args.lastUserIndex)) return false
  if (text.length > 80) return false
  if (THANKS_RE.test(text)) return false

  return (
    SHORT_VISUAL_REFERENCE_RE.test(text) ||
    TITLE_LIKE_REFERENCE_RE.test(text) ||
    SHORT_NAMED_REFERENCE_RE.test(text)
  )
}

async function hydrateImageForVision(
  artifact: VisualArtifactReference,
  ipc: VisualContextInjectionOptions['ipc']
): Promise<ImageBlock | null> {
  const block = artifact.imageBlock
  if (block.source.type === 'base64' && block.source.data) return cloneImageBlock(block)
  if (block.source.type === 'url' && block.source.url) return cloneImageBlock(block)

  const filePath = artifact.filePath?.trim()
  if (!filePath) return null

  const result = (await ipc.invoke(IPC.FS_READ_FILE_BINARY, { path: filePath })) as {
    data?: unknown
    error?: unknown
  }
  if (typeof result?.data !== 'string' || !result.data) return null

  return {
    type: 'image',
    source: {
      type: 'base64',
      data: result.data,
      mediaType: artifact.mediaType ?? mediaTypeFromPath(filePath) ?? 'image/png',
      filePath
    }
  }
}

async function hydrateImagesForVision(
  artifacts: VisualArtifactReference[],
  ipc: VisualContextInjectionOptions['ipc']
): Promise<ImageBlock[]> {
  const images: ImageBlock[] = []
  for (const artifact of artifacts) {
    try {
      const image = await hydrateImageForVision(artifact, ipc)
      if (image) images.push(image)
    } catch {
      // Keep the textual file path/URL reference even when binary hydration fails.
    }
  }
  return images
}

function formatArtifactLine(artifact: VisualArtifactReference, index: number): string {
  const parts = [`- image ${index + 1}: ${sourceKindLabel(artifact.sourceKind)}`]
  if (artifact.filePath) parts.push(`file path: ${artifact.filePath}`)
  if (artifact.url) parts.push(`URL: ${artifact.url}`)
  if (artifact.mediaType) parts.push(`media type: ${artifact.mediaType}`)
  return parts.join('; ')
}

function buildVisualContextText(
  artifacts: VisualArtifactReference[],
  imageBlocks: ImageBlock[],
  supportsVision: boolean
): string {
  const lines = [
    '<system-reminder>',
    'Recent visual artifacts from this conversation are available for this turn.',
    ...artifacts.map(formatArtifactLine)
  ]

  if (supportsVision && imageBlocks.length > 0) {
    lines.push(
      'The corresponding image blocks are attached after this note. Use them directly when the user refers to the recent/generated/screenshot image.'
    )
  } else {
    lines.push(
      'This model is not marked as vision-capable or the image data could not be attached. Use the listed file paths/URLs as references; when file tools are available, call Read on a file path before visual reconstruction or QA.'
    )
  }

  lines.push('</system-reminder>')
  return lines.join('\n')
}

function toContentBlocks(content: UnifiedMessage['content']): ContentBlock[] {
  if (typeof content === 'string') {
    return content.trim() ? [{ type: 'text', text: content }] : []
  }
  return content.slice()
}

export async function applyRecentVisualContext(
  messages: UnifiedMessage[],
  options: VisualContextInjectionOptions
): Promise<UnifiedMessage[]> {
  const lastUserIndex = messages.findLastIndex((message) => message.role === 'user')
  if (lastUserIndex < 0) return messages

  const lastUserMessage = messages[lastUserIndex]
  if (!lastUserMessage || messageContainsUserImage(lastUserMessage)) return messages

  const artifacts = collectRecentVisualArtifacts(messages, lastUserIndex, {
    maxArtifacts: options.maxArtifacts,
    recentMessageLimit: options.recentMessageLimit
  })
  if (artifacts.length === 0) return messages

  const userText = getMessageText(lastUserMessage)
  if (!shouldInjectVisualContext({ messages, lastUserIndex, userText })) return messages

  const imageBlocks = options.supportsVision
    ? await hydrateImagesForVision(artifacts, options.ipc)
    : []
  const contextBlock: ContentBlock = {
    type: 'text',
    text: buildVisualContextText(artifacts, imageBlocks, options.supportsVision)
  }
  const nextContent = [...toContentBlocks(lastUserMessage.content), contextBlock, ...imageBlocks]

  return [
    ...messages.slice(0, lastUserIndex),
    { ...lastUserMessage, content: nextContent },
    ...messages.slice(lastUserIndex + 1)
  ]
}
