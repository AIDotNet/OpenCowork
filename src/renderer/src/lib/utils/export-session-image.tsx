import * as React from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { StaticMessageTranscript } from '@renderer/components/chat/MessageList'
import { useChatStore, type Session } from '@renderer/stores/chat-store'
import type { UnifiedMessage } from '@renderer/lib/api/types'
import { loadHtmlToImage } from './html-to-image-loader'
import { writeImageBlobToClipboard } from './image-clipboard'

const EXPORT_IMAGE_PLACEHOLDER_DATA_URL = 'data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA='
const DEFAULT_EXPORT_WIDTH = 860
const MIN_EXPORT_WIDTH = 420
const MAX_EXPORT_WIDTH = 920
const MAX_FINAL_CANVAS_SIDE = 32767
const MAX_FINAL_CANVAS_PIXELS = 64_000_000
const MAX_TILE_OUTPUT_HEIGHT = 8192
const MAX_TILE_CSS_HEIGHT = 12000
const IMAGE_INLINE_CONCURRENCY = 4

interface CopySessionImageOptions {
  sessionId: string
  width?: number
}

interface ExportStage {
  stage: HTMLDivElement
  viewport: HTMLDivElement
  content: HTMLElement
  root: Root
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function waitForFrames(count = 1): Promise<void> {
  return new Promise((resolve) => {
    let remaining = Math.max(1, count)
    const tick = (): void => {
      remaining -= 1
      if (remaining <= 0) {
        resolve()
        return
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function getThemeBackgroundColor(): string {
  const bodyColor = window.getComputedStyle(document.body).backgroundColor
  if (bodyColor && bodyColor !== 'rgba(0, 0, 0, 0)') return bodyColor

  const bgRaw = window
    .getComputedStyle(document.documentElement)
    .getPropertyValue('--background')
    .trim()
  return bgRaw ? `hsl(${bgRaw})` : '#ffffff'
}

function resolveExportWidth(width?: number): number {
  const rawWidth = Number.isFinite(width) && width ? width : DEFAULT_EXPORT_WIDTH
  return Math.round(clamp(rawWidth, MIN_EXPORT_WIDTH, MAX_EXPORT_WIDTH))
}

function getOutputPixelRatio(width: number, height: number): number {
  const preferredRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
  const sideRatio = Math.min(MAX_FINAL_CANVAS_SIDE / width, MAX_FINAL_CANVAS_SIDE / height)
  const pixelBudgetRatio = Math.sqrt(MAX_FINAL_CANVAS_PIXELS / Math.max(1, width * height))
  return Math.max(Number.EPSILON, Math.min(preferredRatio, sideRatio, pixelBudgetRatio))
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob)
        return
      }
      reject(new Error('Failed to encode exported image'))
    }, 'image/png')
  })
}

function loadImageSource(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Failed to decode exported image tile'))
    image.src = src
  })
}

function isRemoteImageSrc(value: string | null): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value)
}

function isLoadedImage(image: HTMLImageElement): boolean {
  return image.complete && image.naturalWidth > 0
}

async function waitForImageReady(image: HTMLImageElement): Promise<void> {
  if (isLoadedImage(image)) return

  await new Promise<void>((resolve) => {
    const cleanup = (): void => {
      image.removeEventListener('load', handleDone)
      image.removeEventListener('error', handleDone)
    }

    const handleDone = (): void => {
      cleanup()
      resolve()
    }

    image.addEventListener('load', handleDone, { once: true })
    image.addEventListener('error', handleDone, { once: true })
  })
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  handler: (item: T) => Promise<void>
): Promise<void> {
  let index = 0
  const workerCount = Math.min(Math.max(1, concurrency), items.length)
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (index < items.length) {
        const item = items[index]
        index += 1
        await handler(item)
      }
    })
  )
}

async function waitForImageDomToSettle(root: HTMLElement): Promise<void> {
  const startedAt = window.performance.now()
  let previousSignature = ''
  let stableTicks = 0

  while (window.performance.now() - startedAt < 2000) {
    const images = Array.from(root.querySelectorAll('img'))
    const signature = images.map((image) => image.getAttribute('src') ?? '').join('\u0001')
    const hasPendingImage = images.some((image) => !isLoadedImage(image))
    const hasLoadingPlaceholder = root.textContent?.includes('Loading image...') ?? false

    if (signature === previousSignature && !hasPendingImage && !hasLoadingPlaceholder) {
      stableTicks += 1
      if (stableTicks >= 2) return
    } else {
      stableTicks = 0
      previousSignature = signature
    }

    await delay(80)
  }
}

async function inlineImagesForExport(root: HTMLElement): Promise<void> {
  const images = Array.from(root.querySelectorAll('img'))
  if (images.length === 0) return

  const dataUrlCache = new Map<string, string>()

  await mapWithConcurrency(images, IMAGE_INLINE_CONCURRENCY, async (image) => {
    const src = image.getAttribute('src')?.trim() || ''
    if (!src) return

    image.removeAttribute('srcset')
    image.setAttribute('loading', 'eager')
    image.setAttribute('decoding', 'sync')

    if (!isRemoteImageSrc(src)) {
      await waitForImageReady(image)
      return
    }

    let dataUrl = dataUrlCache.get(src)
    if (!dataUrl) {
      try {
        const result = (await window.api.fetchImageBase64({ url: src })) as {
          data?: string
          mimeType?: string
          error?: string
        }
        if (result.error) throw new Error(result.error)
        dataUrl = result.data
          ? `data:${result.mimeType || 'image/png'};base64,${result.data}`
          : EXPORT_IMAGE_PLACEHOLDER_DATA_URL
      } catch {
        dataUrl = EXPORT_IMAGE_PLACEHOLDER_DATA_URL
      }
      dataUrlCache.set(src, dataUrl)
    }

    image.setAttribute('src', dataUrl)
    await waitForImageReady(image)
  })
}

const EXPORT_CSS = `
  [data-session-image-export] {
    background: hsl(var(--background));
    color: hsl(var(--foreground));
    font-synthesis: none;
  }
  [data-session-image-export],
  [data-session-image-export] * {
    box-sizing: border-box !important;
    animation: none !important;
    transition: none !important;
    caret-color: transparent !important;
  }
  [data-session-image-export] .opacity-0 {
    display: none !important;
  }
  [data-session-image-export] [data-message-content] * {
    max-width: 100% !important;
    overflow-wrap: anywhere !important;
    word-break: break-word !important;
  }
  [data-session-image-export] pre,
  [data-session-image-export] code,
  [data-session-image-export] [class*="whitespace-pre-wrap"],
  [data-session-image-export] [class*="font-mono"] {
    max-height: none !important;
    overflow: visible !important;
    white-space: pre-wrap !important;
    word-break: break-word !important;
  }
  [data-session-image-export] table {
    table-layout: fixed !important;
    width: 100% !important;
  }
  [data-session-image-export] img,
  [data-session-image-export] svg,
  [data-session-image-export] canvas {
    max-width: 100% !important;
  }
  [data-session-image-export] [data-message-id] {
    break-inside: avoid;
  }
`

function SessionImageExportDocument({
  session,
  messages
}: {
  session: Session
  messages: UnifiedMessage[]
}): React.JSX.Element {
  return (
    <div
      data-session-image-export
      className="w-full overflow-visible bg-background text-foreground"
    >
      <style>{EXPORT_CSS}</style>
      <div className="border-b border-border/60 px-5 pb-4 pt-5">
        <div className="truncate text-[15px] font-semibold leading-6 text-foreground">
          {session.title}
        </div>
        <div className="mt-1 truncate text-[11px] leading-4 text-muted-foreground/70">
          {new Date(session.updatedAt).toLocaleString()}
        </div>
      </div>
      <StaticMessageTranscript sessionId={session.id} messages={messages} className="pt-6" />
    </div>
  )
}

function renderExportStage(
  session: Session,
  messages: UnifiedMessage[],
  width: number
): ExportStage {
  const stage = document.createElement('div')
  stage.setAttribute('data-session-image-stage', '')
  stage.style.cssText = [
    'position: fixed',
    'left: -100000px',
    'top: 0',
    'z-index: -1',
    'opacity: 0',
    'pointer-events: none',
    'overflow: hidden',
    `width: ${width}px`
  ].join(';')

  const viewport = document.createElement('div')
  viewport.style.cssText = [
    'position: relative',
    'overflow: hidden',
    `width: ${width}px`,
    `background: ${getThemeBackgroundColor()}`
  ].join(';')
  stage.appendChild(viewport)
  document.body.appendChild(stage)

  const root = createRoot(viewport)
  flushSync(() => {
    root.render(<SessionImageExportDocument session={session} messages={messages} />)
  })

  const content = viewport.querySelector('[data-session-image-export]') as HTMLElement | null
  if (!content) {
    root.unmount()
    stage.remove()
    throw new Error('Export image content failed to render')
  }

  content.style.width = `${width}px`
  content.style.maxWidth = `${width}px`
  content.style.transformOrigin = 'top left'
  content.style.willChange = 'transform'

  return { stage, viewport, content, root }
}

function cleanupExportStage(exportStage: ExportStage): void {
  exportStage.root.unmount()
  exportStage.stage.remove()
}

async function captureSessionImageBlob(exportStage: ExportStage): Promise<Blob> {
  const { viewport, content } = exportStage
  const htmlToImage = await loadHtmlToImage()
  const backgroundColor = getThemeBackgroundColor()
  const width = Math.ceil(content.scrollWidth || content.offsetWidth || viewport.clientWidth)
  const height = Math.ceil(content.scrollHeight || content.offsetHeight)

  if (width <= 0 || height <= 0) {
    throw new Error('Exported conversation has no visible content')
  }

  const pixelRatio = getOutputPixelRatio(width, height)
  const outputWidth = Math.max(1, Math.round(width * pixelRatio))
  const outputHeight = Math.max(1, Math.round(height * pixelRatio))
  const tileCssHeight = Math.max(
    256,
    Math.min(MAX_TILE_CSS_HEIGHT, Math.floor(MAX_TILE_OUTPUT_HEIGHT / pixelRatio))
  )
  const finalCanvas = document.createElement('canvas')
  finalCanvas.width = outputWidth
  finalCanvas.height = outputHeight

  const context = finalCanvas.getContext('2d')
  if (!context) throw new Error('Canvas context unavailable')
  context.fillStyle = backgroundColor
  context.fillRect(0, 0, outputWidth, outputHeight)

  let fontEmbedCSS: string | undefined
  try {
    fontEmbedCSS = await htmlToImage.getFontEmbedCSS(viewport, {
      width,
      height: Math.min(height, tileCssHeight),
      pixelRatio
    })
  } catch (error) {
    console.warn('[ExportSessionImage] Failed to pre-embed fonts:', error)
  }

  for (let offset = 0; offset < height; offset += tileCssHeight) {
    const tileHeight = Math.min(tileCssHeight, height - offset)
    viewport.style.width = `${width}px`
    viewport.style.height = `${tileHeight}px`
    content.style.transform = offset === 0 ? 'none' : `translateY(-${offset}px)`

    await waitForFrames(1)

    const dataUrl = await htmlToImage.toPng(viewport, {
      backgroundColor,
      width,
      height: tileHeight,
      pixelRatio,
      skipAutoScale: true,
      ...(fontEmbedCSS ? { fontEmbedCSS } : {}),
      style: {
        width: `${width}px`,
        height: `${tileHeight}px`,
        overflow: 'hidden'
      }
    })
    const image = await loadImageSource(dataUrl)
    const targetY = Math.round(offset * pixelRatio)
    const targetHeight = Math.min(image.naturalHeight || image.height, outputHeight - targetY)
    if (targetHeight > 0) {
      context.drawImage(
        image,
        0,
        0,
        image.naturalWidth || image.width,
        targetHeight,
        0,
        targetY,
        outputWidth,
        targetHeight
      )
    }
  }

  content.style.transform = 'none'
  return canvasToPngBlob(finalCanvas)
}

export async function copySessionAsImageToClipboard({
  sessionId,
  width
}: CopySessionImageOptions): Promise<void> {
  const store = useChatStore.getState()
  const session = store.sessions.find((item) => item.id === sessionId)
  if (!session) throw new Error('Session not found')

  const messages = await store.getFullSessionMessagesForMutation(sessionId)
  if (messages.length === 0) throw new Error('Session has no messages to export')

  const exportWidth = resolveExportWidth(width)
  const exportStage = renderExportStage(session, messages, exportWidth)

  try {
    await waitForFrames(3)
    await (document as Document & { fonts?: FontFaceSet }).fonts?.ready
    await waitForImageDomToSettle(exportStage.content)
    await inlineImagesForExport(exportStage.content)
    await waitForFrames(2)
    const blob = await captureSessionImageBlob(exportStage)
    await writeImageBlobToClipboard(blob)
  } finally {
    cleanupExportStage(exportStage)
  }
}
