import { useCallback, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X, Download, Copy, Check } from 'lucide-react'
import { motion, AnimatePresence } from 'motion/react'
import { toast } from 'sonner'
import { IPC } from '@renderer/lib/ipc/channels'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import {
  buildImageDimensionCacheKey,
  cacheImageDimensions,
  dataUrlToBlob,
  getCachedImageDimensions,
  useImageDisplaySrc,
  type ImageDimensions
} from './use-image-display-src'

interface ImagePreviewProps {
  src: string
  alt?: string
  filePath?: string
  actions?: ImagePreviewAction[]
}

export interface ImagePreviewAction {
  key: string
  label: string
  icon: ReactNode
  onClick: () => void
}

function getDownloadExtension(imageSrc: string): string {
  if (imageSrc.startsWith('data:')) {
    const mimeType = imageSrc.slice(5, imageSrc.indexOf(';'))
    if (mimeType === 'image/jpeg') return '.jpg'
    if (mimeType === 'image/webp') return '.webp'
    if (mimeType === 'image/gif') return '.gif'
    if (mimeType === 'image/bmp') return '.bmp'
    if (mimeType === 'image/svg+xml') return '.svg'
    return '.png'
  }

  const fileExt = imageSrc.split('?')[0].split('.').pop()?.toLowerCase()
  return fileExt ? `.${fileExt}` : '.png'
}

function getFileName(filePath: string): string {
  const parts = filePath.split(/[\\/]/)
  return parts[parts.length - 1] || `image-${Date.now()}.png`
}

async function readFilePathBase64(filePath: string): Promise<string | null> {
  try {
    const result = (await ipcClient.invoke(IPC.FS_READ_FILE_BINARY, {
      path: filePath
    })) as { data?: string; error?: string }
    if (result.error || !result.data) return null
    return result.data
  } catch {
    return null
  }
}

function dataUrlBase64(value: string): string | null {
  if (!value.startsWith('data:')) return null
  const parts = value.split(',', 2)
  return parts.length === 2 ? parts[1] : null
}

const IMAGE_SAVE_FILTERS = [
  {
    name: 'Images',
    extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg']
  }
]

// Save a local file by copying it inside the main process — works for files
// beyond the fs:read-file-binary size limit. Returns null if the source file
// is unavailable so callers can fall back to base64 paths.
async function downloadLocalFileCopy(
  sourcePath: string,
  defaultName: string
): Promise<{ canceled?: boolean } | null> {
  try {
    const result = (await ipcClient.invoke(IPC.FS_DOWNLOAD_FILE_COPY, {
      sourcePath,
      defaultName,
      filters: IMAGE_SAVE_FILTERS
    })) as { success?: boolean; canceled?: boolean; error?: string }
    if (result.canceled) return { canceled: true }
    if (result.success) return { canceled: false }
    return null
  } catch {
    return null
  }
}

async function saveImageBase64(data: string, defaultName: string): Promise<{ canceled?: boolean }> {
  const saveResult = (await ipcClient.invoke(IPC.FS_SELECT_SAVE_FILE, {
    defaultPath: defaultName,
    filters: IMAGE_SAVE_FILTERS
  })) as { path?: string; canceled?: boolean }

  if (saveResult.canceled || !saveResult.path) {
    return { canceled: true }
  }

  const writeResult = (await ipcClient.invoke(IPC.FS_WRITE_FILE_BINARY, {
    path: saveResult.path,
    data
  })) as { success?: boolean; error?: string }

  if (writeResult.error) {
    throw new Error(writeResult.error)
  }

  return { canceled: false }
}

export function ImagePreview({
  src,
  alt = 'Generated image',
  filePath,
  actions = []
}: ImagePreviewProps): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const displaySrc = useImageDisplaySrc(src, filePath)
  const effectiveSrc = displaySrc || src
  const imageDimensionKey = buildImageDimensionCacheKey(src, filePath)
  const cachedImageDimensions = getCachedImageDimensions(src, filePath, effectiveSrc)
  const [imageDimensionState, setImageDimensionState] = useState<{
    key: string
    dimensions: ImageDimensions | null
  }>(() => ({
    key: imageDimensionKey,
    dimensions: cachedImageDimensions
  }))
  const imageDimensions =
    imageDimensionState.key === imageDimensionKey
      ? (imageDimensionState.dimensions ?? cachedImageDimensions)
      : cachedImageDimensions

  const handleImageLoad = useCallback(
    (event: React.SyntheticEvent<HTMLImageElement>) => {
      const { naturalWidth, naturalHeight, currentSrc } = event.currentTarget
      if (!naturalWidth || !naturalHeight) return

      const nextDimensions = { width: naturalWidth, height: naturalHeight }
      setImageDimensionState((current) => {
        if (
          current.key === imageDimensionKey &&
          current.dimensions?.width === nextDimensions.width &&
          current.dimensions?.height === nextDimensions.height
        ) {
          return current
        }
        return {
          key: imageDimensionKey,
          dimensions: cacheImageDimensions(src, nextDimensions, {
            filePath,
            displaySrc: currentSrc
          })
        }
      })
    },
    [filePath, imageDimensionKey, src]
  )

  // Resolve image bytes as base64, preferring the persisted file but falling back
  // to the source/display data URL when that file is missing (e.g. deleted on disk).
  const resolveImageBase64 = async (): Promise<string> => {
    if (filePath) {
      const data = await readFilePathBase64(filePath)
      if (data) return data
    }
    const fromSrc = dataUrlBase64(src) ?? dataUrlBase64(effectiveSrc)
    if (fromSrc) return fromSrc
    if (/^https?:\/\//i.test(src)) {
      const result = await window.api.fetchImageBase64({ url: src })
      if (result.error || !result.data) {
        throw new Error(result.error || 'Failed to fetch image data')
      }
      return result.data
    }
    throw new Error('Failed to read image data')
  }

  const handleDownload = async (): Promise<void> => {
    try {
      const defaultName = filePath
        ? getFileName(filePath)
        : `image-${Date.now()}${getDownloadExtension(src)}`

      const copyResult = filePath ? await downloadLocalFileCopy(filePath, defaultName) : null
      const persistedData = filePath && !copyResult ? await readFilePathBase64(filePath) : null
      if (copyResult) {
        if (copyResult.canceled) return
      } else if (persistedData) {
        const result = await saveImageBase64(persistedData, defaultName)
        if (result.canceled) return
      } else if (src.startsWith('data:')) {
        const blob = dataUrlToBlob(src)
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = defaultName
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      } else if (/^https?:\/\//i.test(src)) {
        const result = await window.api.downloadImage({ url: src, defaultName })
        if (result.error) throw new Error(result.error)
        if (result.canceled) return
      } else if (effectiveSrc.startsWith('blob:')) {
        const response = await fetch(effectiveSrc)
        const blob = await response.blob()
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = defaultName
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      } else {
        const a = document.createElement('a')
        a.href = effectiveSrc
        a.download = defaultName
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
      }

      toast.success('Image downloaded')
    } catch (error) {
      console.error('Download failed:', error)
      toast.error('Failed to download image')
    }
  }

  const handleCopy = async (): Promise<void> => {
    try {
      const imageBase64 = await resolveImageBase64()

      const result = await window.api.writeImageToClipboard({ data: imageBase64 })
      if (result.error) throw new Error(result.error)

      setCopied(true)
      toast.success('Image copied to clipboard')
      setTimeout(() => setCopied(false), 2000)
    } catch (error) {
      console.error('Copy failed:', error)
      toast.error('Failed to copy image. Please try downloading instead.')
    }
  }

  return (
    <>
      {/* Thumbnail */}
      <div
        className="relative max-w-lg overflow-hidden rounded-lg border border-border/50 transition-colors group hover:border-primary/50"
        style={
          imageDimensions
            ? { aspectRatio: `${imageDimensions.width} / ${imageDimensions.height}` }
            : undefined
        }
        onClick={() => {
          if (effectiveSrc) setIsOpen(true)
        }}
      >
        {actions.length > 0 && (
          <div className="absolute right-2 top-2 z-10 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
            {actions.map((action) => (
              <button
                key={action.key}
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  action.onClick()
                }}
                className="flex size-8 items-center justify-center rounded-md bg-black/55 text-white transition-colors hover:bg-black/70"
                title={action.label}
                aria-label={action.label}
              >
                {action.icon}
              </button>
            ))}
          </div>
        )}
        {effectiveSrc ? (
          <img
            src={effectiveSrc}
            alt={alt}
            className="block w-full h-auto"
            loading="lazy"
            onLoad={handleImageLoad}
            {...(imageDimensions
              ? { width: imageDimensions.width, height: imageDimensions.height }
              : {})}
          />
        ) : (
          <div className="flex aspect-square w-full items-center justify-center bg-muted/20 text-xs text-muted-foreground">
            Loading image...
          </div>
        )}
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors flex items-center justify-center">
          <div className="opacity-0 group-hover:opacity-100 transition-opacity text-white text-sm font-medium bg-black/50 px-3 py-1.5 rounded-full">
            Click to enlarge
          </div>
        </div>
      </div>

      {/* Full screen preview */}
      {createPortal(
        <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 px-4 pb-12 pt-16"
            onClick={() => setIsOpen(false)}
          >
            {/* Toolbar */}
            <div className="absolute right-4 top-4 z-20 flex items-center gap-2">
              {actions.map((action) => (
                <button
                  key={action.key}
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation()
                    action.onClick()
                  }}
                  className="p-2 rounded-lg bg-white/10 hover:bg-white/20 text-white transition-colors"
                  title={action.label}
                  aria-label={action.label}
                >
                  {action.icon}
                </button>
              ))}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  handleCopy()
                }}
                className="p-2 rounded-lg bg-white/10 hover:bg-white/20 text-white transition-colors"
                title="Copy to clipboard"
              >
                {copied ? <Check className="size-5" /> : <Copy className="size-5" />}
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  handleDownload()
                }}
                className="p-2 rounded-lg bg-white/10 hover:bg-white/20 text-white transition-colors"
                title="Download"
              >
                <Download className="size-5" />
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  setIsOpen(false)
                }}
                className="p-2 rounded-lg bg-white/10 hover:bg-white/20 text-white transition-colors"
                title="Close"
              >
                <X className="size-5" />
              </button>
            </div>

            {/* Image */}
            <motion.img
              initial={{ scale: 0.9 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0.9 }}
              src={effectiveSrc}
              alt={alt}
              className="h-full w-full object-contain"
              onLoad={handleImageLoad}
              onClick={(e) => e.stopPropagation()}
            />

            {/* Close hint */}
            <div className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2 text-sm text-white/60">
              Click outside to close
            </div>
          </motion.div>
        )}
        </AnimatePresence>,
        document.body
      )}
    </>
  )
}
