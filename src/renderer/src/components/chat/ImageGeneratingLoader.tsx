import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import { motion } from 'motion/react'
import { ImageIcon, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDurationMs } from '@renderer/lib/format-duration'
import {
  buildImageDimensionCacheKey,
  cacheImageDimensions,
  getCachedImageDimensions,
  useImageDisplaySrc,
  type ImageDimensions
} from './use-image-display-src'

interface ImageGeneratingLoaderProps {
  previewSrc?: string
  previewFilePath?: string
  startedAt?: number
}

interface PlaceholderBarProps {
  widthClass: string
  delay?: number
}

const GRID_STYLE = {
  backgroundImage:
    'linear-gradient(color-mix(in srgb, var(--border) 48%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in srgb, var(--border) 48%, transparent) 1px, transparent 1px)',
  backgroundSize: '24px 24px'
} satisfies CSSProperties

const PREVIEW_FRAME_STYLE = {
  borderColor: 'color-mix(in srgb, var(--border) 62%, transparent)',
  background: 'color-mix(in srgb, var(--background) 88%, var(--muted) 12%)'
} satisfies CSSProperties

const PREVIEW_FALLBACK_STYLE = {
  background:
    'linear-gradient(180deg, color-mix(in srgb, var(--foreground) 2%, transparent), color-mix(in srgb, var(--foreground) 6%, transparent))'
} satisfies CSSProperties

const PREVIEW_IMAGE_OVERLAY_STYLE = {
  background:
    'linear-gradient(180deg, color-mix(in srgb, var(--background) 18%, transparent), color-mix(in srgb, var(--background) 70%, transparent))'
} satisfies CSSProperties

const SWEEP_STYLE = {
  background:
    'linear-gradient(90deg, transparent, color-mix(in srgb, var(--foreground) 5%, transparent) 24%, color-mix(in srgb, var(--primary) 18%, transparent) 48%, color-mix(in srgb, var(--foreground) 7%, transparent) 58%, transparent)'
} satisfies CSSProperties

const SCAN_LINE_STYLE = {
  backgroundColor: 'color-mix(in srgb, var(--primary) 68%, var(--foreground) 32%)',
  boxShadow: '0 0 20px color-mix(in srgb, var(--primary) 30%, transparent)'
} satisfies CSSProperties

const SHIMMER_BAR_STYLE = {
  backgroundColor: 'color-mix(in srgb, var(--foreground) 8%, transparent)'
} satisfies CSSProperties

const SHIMMER_BAR_SWEEP_STYLE = {
  background:
    'linear-gradient(90deg, transparent, color-mix(in srgb, var(--foreground) 34%, transparent), transparent)'
} satisfies CSSProperties

const PROGRESS_TRACK_STYLE = {
  backgroundColor: 'color-mix(in srgb, var(--foreground) 8%, transparent)'
} satisfies CSSProperties

const PROGRESS_FILL_STYLE = {
  background:
    'linear-gradient(90deg, color-mix(in srgb, var(--primary) 32%, transparent), color-mix(in srgb, var(--primary) 52%, transparent), transparent)'
} satisfies CSSProperties

const SWEEP_TRANSITION = {
  duration: 2.8,
  repeat: Infinity,
  ease: 'linear' as const
}

const SHIMMER_TRANSITION = {
  duration: 1.9,
  repeat: Infinity,
  ease: 'linear' as const
}

function PlaceholderBar({ widthClass, delay = 0 }: PlaceholderBarProps): React.JSX.Element {
  return (
    <div
      className={`relative h-2 overflow-hidden rounded-full ${widthClass}`}
      style={SHIMMER_BAR_STYLE}
    >
      <motion.div
        className="absolute inset-y-0 left-[-38%] w-[38%]"
        style={SHIMMER_BAR_SWEEP_STYLE}
        animate={{ x: ['0%', '420%'] }}
        transition={{ ...SHIMMER_TRANSITION, delay }}
      />
    </div>
  )
}

export function ImageGeneratingLoader({
  previewSrc,
  previewFilePath,
  startedAt
}: ImageGeneratingLoaderProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  const previewDisplaySrc = useImageDisplaySrc(previewSrc, previewFilePath)
  const previewCacheSrc = previewSrc || previewDisplaySrc
  const previewDimensionKey = previewCacheSrc
    ? buildImageDimensionCacheKey(previewCacheSrc, previewFilePath)
    : ''
  const cachedPreviewDimensions = previewCacheSrc
    ? getCachedImageDimensions(previewCacheSrc, previewFilePath, previewDisplaySrc)
    : null
  const [previewDimensionState, setPreviewDimensionState] = useState<{
    key: string
    dimensions: ImageDimensions | null
  }>(() => ({
    key: previewDimensionKey,
    dimensions: cachedPreviewDimensions
  }))
  const previewDimensions =
    previewDimensionState.key === previewDimensionKey
      ? (previewDimensionState.dimensions ?? cachedPreviewDimensions)
      : cachedPreviewDimensions
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!startedAt) return

    const interval = window.setInterval(() => setNow(Date.now()), 1000)

    return () => window.clearInterval(interval)
  }, [startedAt])

  const liveElapsedMs = startedAt ? Math.max(0, now - startedAt) : 0
  const elapsedLabel =
    startedAt && liveElapsedMs > 0
      ? t('toolCall.imagePlugin.elapsed', { duration: formatDurationMs(liveElapsedMs) })
      : null

  const handlePreviewLoad = useCallback(
    (event: React.SyntheticEvent<HTMLImageElement>) => {
      if (!previewCacheSrc) return

      const { naturalWidth, naturalHeight, currentSrc } = event.currentTarget
      if (!naturalWidth || !naturalHeight) return

      const nextDimensions = { width: naturalWidth, height: naturalHeight }
      setPreviewDimensionState((current) => {
        if (
          current.key === previewDimensionKey &&
          current.dimensions?.width === nextDimensions.width &&
          current.dimensions?.height === nextDimensions.height
        ) {
          return current
        }
        return {
          key: previewDimensionKey,
          dimensions: cacheImageDimensions(previewCacheSrc, nextDimensions, {
            filePath: previewFilePath,
            displaySrc: currentSrc
          })
        }
      })
    },
    [previewCacheSrc, previewDimensionKey, previewFilePath]
  )

  return (
    <motion.div
      layout
      role="status"
      aria-live="polite"
      className="my-2 w-full max-w-[560px]"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
    >
      <div className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[12px] text-sky-600 transition-colors dark:text-sky-300">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-sky-500/25 bg-transparent">
          <Loader2 className="size-3 animate-spin" />
        </span>
        <span className="shrink-0 text-muted-foreground/55">gpt-image</span>
        <span className="shrink-0 text-muted-foreground/40">&gt;</span>
        <span className="shrink-0 font-mono font-medium text-foreground/82">image_generation</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground/60">
          ({t('toolCall.imagePlugin.generating')})
        </span>
        {elapsedLabel ? (
          <span className="shrink-0 text-[9px] tabular-nums text-muted-foreground/60">
            {elapsedLabel}
          </span>
        ) : null}
      </div>

      <div className="ml-3 mt-1.5 overflow-hidden border-l border-border/45 pl-5 dark:border-white/[0.08]">
        <div
          className="overflow-hidden rounded-lg border bg-background/55 dark:bg-[#0d0d0e]"
          style={PREVIEW_FRAME_STYLE}
        >
          <div className="flex items-center justify-between gap-3 border-b border-border/45 px-3 py-2 dark:border-white/[0.08]">
            <div className="flex min-w-0 items-center gap-2">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-sky-500/20 bg-sky-500/[0.08] text-sky-600 dark:text-sky-300">
                <ImageIcon className="size-3.5" />
              </span>
              <div className="min-w-0">
                <p className="truncate text-[12px] font-semibold text-foreground/88">
                  {t('toolCall.imagePlugin.builtinTitle')}
                </p>
                <p className="mt-0.5 truncate text-[10px] text-muted-foreground/65">
                  {t('toolCall.imagePlugin.running')}
                </p>
              </div>
            </div>
          </div>

          <div
            className="relative overflow-hidden"
            style={{
              aspectRatio: previewDimensions
                ? `${previewDimensions.width} / ${previewDimensions.height}`
                : '4 / 3',
              minHeight: 240
            }}
          >
            {previewDisplaySrc ? (
              <>
                <img
                  src={previewDisplaySrc}
                  alt="Generating image preview"
                  className="absolute inset-0 h-full w-full scale-[1.03] object-cover opacity-35"
                  onLoad={handlePreviewLoad}
                />
                <div className="absolute inset-0" style={PREVIEW_IMAGE_OVERLAY_STYLE} />
              </>
            ) : (
              <div className="absolute inset-0" style={PREVIEW_FALLBACK_STYLE} />
            )}

            <div className="absolute inset-0 opacity-50" style={GRID_STYLE} />

            <motion.div
              className="absolute inset-y-0 left-[-42%] w-[46%] -skew-x-12 blur-2xl"
              style={SWEEP_STYLE}
              animate={{ x: ['0%', '320%'] }}
              transition={SWEEP_TRANSITION}
            />

            <motion.div
              className="absolute inset-y-6 left-[-8%] w-px"
              style={SCAN_LINE_STYLE}
              animate={{
                x: ['0%', '620%'],
                opacity: [0, 1, 1, 0]
              }}
              transition={SWEEP_TRANSITION}
            />

            <div className="relative flex h-full flex-col justify-between p-4">
              <div className="space-y-2.5">
                <PlaceholderBar widthClass="w-[42%]" />
                <PlaceholderBar widthClass="w-[58%]" delay={0.12} />
                <PlaceholderBar widthClass="w-[34%]" delay={0.24} />
              </div>

              <div className="space-y-2.5">
                <div
                  className="relative h-1.5 overflow-hidden rounded-full"
                  style={PROGRESS_TRACK_STYLE}
                >
                  <motion.div
                    className="absolute inset-y-0 left-0 origin-left rounded-full"
                    style={{ ...PROGRESS_FILL_STYLE, width: '100%' }}
                    animate={{ scaleX: [0.2, 0.66, 0.4, 0.86, 0.52] }}
                    transition={{ duration: 3.2, repeat: Infinity, ease: 'easeInOut' }}
                  />
                </div>
                <div className="flex items-center justify-between gap-3 text-[10px] uppercase tracking-[0.14em] text-muted-foreground/70">
                  <span className="tool-name-live-pulse tool-name-live-pulse--streaming">
                    {t('thinking.pending')}
                  </span>
                  <span className="tool-name-live-pulse tool-name-live-pulse--running">
                    {t('toolCall.imagePlugin.generating')}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  )
}
