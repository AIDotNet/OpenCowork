import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AnimatePresence, motion } from 'framer-motion'
import {
  ChevronDown,
  Keyboard,
  Loader2,
  Monitor,
  MousePointerClick,
  TriangleAlert
} from 'lucide-react'
import type { ToolCallStatus } from '@renderer/lib/agent/types'
import type { ImageBlock, TextBlock, ToolResultContent } from '@renderer/lib/api/types'
import { ImagePreview } from './ImagePreview'

interface DesktopActionToolCardProps {
  name: string
  input: Record<string, unknown>
  output?: ToolResultContent
  status: ToolCallStatus | 'completed'
  error?: string
}

const CONTENT_TRANSITION = {
  duration: 0.22,
  ease: 'easeInOut' as const
}

const ITEM_TRANSITION = {
  duration: 0.2,
  ease: 'easeOut' as const
}

function parseErrorMessage(output: ToolResultContent | undefined): string | null {
  if (typeof output !== 'string') return null
  try {
    const parsed = JSON.parse(output) as { error?: unknown }
    if (typeof parsed.error === 'string' && parsed.error.trim()) {
      return parsed.error
    }
  } catch {
    return output.trim() || null
  }
  return output.trim() || null
}

function parseJsonOutput(output: ToolResultContent | undefined): Record<string, unknown> | null {
  if (typeof output !== 'string') return null
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function getToolIcon(name: string): React.JSX.Element {
  if (name === 'DesktopScreenshot') return <Monitor className="size-4" />
  if (name === 'DesktopClick') return <MousePointerClick className="size-4" />
  return <Keyboard className="size-4" />
}

export function DesktopActionToolCard({
  name,
  input,
  output,
  status,
  error
}: DesktopActionToolCardProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  const [collapsed, setCollapsed] = useState(false)
  const parsedError = error || parseErrorMessage(output)
  const isRunning = status === 'streaming' || status === 'pending_approval' || status === 'running'
  const hasError = status === 'error' || Boolean(parsedError)
  const jsonOutput = parseJsonOutput(output)

  const { images, notes } = useMemo(() => {
    if (!Array.isArray(output)) {
      return { images: [] as ImageBlock[], notes: [] as TextBlock[] }
    }

    return {
      images: output.filter((block): block is ImageBlock => block.type === 'image'),
      notes: output.filter((block): block is TextBlock => block.type === 'text')
    }
  }, [output])

  const summary = (() => {
    if (name === 'DesktopScreenshot') {
      return t('toolCall.desktop.screenshot.summary', {
        width: notes[0]?.text.match(/(\d+)x(\d+)/)?.[1] ?? '?',
        height: notes[0]?.text.match(/(\d+)x(\d+)/)?.[2] ?? '?'
      })
    }
    if (name === 'DesktopClick') {
      return t('toolCall.desktop.click.summary', {
        x: jsonOutput?.x ?? input.x ?? '?',
        y: jsonOutput?.y ?? input.y ?? '?',
        action: jsonOutput?.action ?? input.action ?? 'click'
      })
    }
    return t('toolCall.desktop.type.summary', {
      mode: jsonOutput?.mode ?? (input.text ? 'text' : input.key ? 'key' : 'hotkey')
    })
  })()

  return (
    <motion.div
      layout
      className="overflow-hidden rounded-xl border bg-background shadow-sm transition-shadow hover:shadow-md"
      transition={CONTENT_TRANSITION}
    >
      <div className="flex items-center justify-between border-b bg-muted/30 px-4 py-3">
        <div className="flex items-center gap-2">
          <motion.span
            className="rounded-lg bg-primary/10 p-2 text-primary"
            animate={
              isRunning
                ? {
                    scale: [1, 1.06, 1],
                    rotate: [0, -4, 4, 0]
                  }
                : { scale: 1, rotate: 0 }
            }
            transition={
              isRunning
                ? { duration: 1.8, repeat: Infinity, ease: 'easeInOut' }
                : ITEM_TRANSITION
            }
          >
            {getToolIcon(name)}
          </motion.span>
          <div>
            <p className="text-sm font-medium">{t(`toolCall.desktop.${name}.title`)}</p>
            <motion.p
              key={`${name}-${status}-${hasError ? 'error' : 'ok'}`}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={ITEM_TRANSITION}
              className="text-[11px] text-muted-foreground"
            >
              {isRunning
                ? t('toolCall.desktop.running')
                : hasError
                  ? t('toolCall.desktop.failed')
                  : t('toolCall.desktop.completed')}
            </motion.p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
            {summary}
          </span>
          <motion.button
            type="button"
            whileTap={{ scale: 0.96 }}
            onClick={() => setCollapsed((value) => !value)}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <span>
              {collapsed ? t('showMore', { ns: 'common' }) : t('showLess', { ns: 'common' })}
            </span>
            <motion.span animate={{ rotate: collapsed ? 0 : 180 }} transition={ITEM_TRANSITION}>
              <ChevronDown className="size-3" />
            </motion.span>
          </motion.button>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {!collapsed ? (
          <motion.div
            key="desktop-tool-content"
            layout
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={CONTENT_TRANSITION}
            className="overflow-hidden"
          >
            <div className="space-y-4 px-4 py-4">
              {isRunning ? (
                <motion.div
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={ITEM_TRANSITION}
                  className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-3 text-sm text-muted-foreground"
                >
                  <Loader2 className="size-4 animate-spin" />
                  <span>{t('toolCall.desktop.executing')}</span>
                </motion.div>
              ) : null}

              {hasError ? (
                <motion.div
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={ITEM_TRANSITION}
                  className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-3 text-sm text-destructive"
                >
                  <div className="flex items-center gap-2">
                    <TriangleAlert className="size-4" />
                    <span>{parsedError}</span>
                  </div>
                </motion.div>
              ) : null}

              {images.length > 0 ? (
                <div className="space-y-3">
                  <p className="text-xs font-medium text-muted-foreground">
                    {t('toolCall.desktop.screenshot.preview')}
                  </p>
                  {images.map((image, index) => {
                    const src =
                      image.source.type === 'base64'
                        ? `data:${image.source.mediaType || 'image/png'};base64,${image.source.data}`
                        : (image.source.url ?? '')
                    if (!src) return null
                    return <ImagePreview key={`${src}-${index}`} src={src} alt={`Desktop screenshot ${index + 1}`} />
                  })}
                </div>
              ) : null}

              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">
                  {t('toolCall.desktop.input')}
                </p>
                <pre className="overflow-x-auto rounded-lg bg-muted/20 px-3 py-2 text-xs text-foreground whitespace-pre-wrap break-words">
                  {JSON.stringify(input, null, 2)}
                </pre>
              </div>

              {jsonOutput ? (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">
                    {t('toolCall.desktop.output')}
                  </p>
                  <pre className="overflow-x-auto rounded-lg bg-muted/20 px-3 py-2 text-xs text-foreground whitespace-pre-wrap break-words">
                    {JSON.stringify(jsonOutput, null, 2)}
                  </pre>
                </div>
              ) : null}

              {notes.length > 0 ? (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">
                    {t('toolCall.desktop.notes')}
                  </p>
                  {notes.map((note, index) => (
                    <p
                      key={`${note.text}-${index}`}
                      className="rounded-lg bg-muted/20 px-3 py-2 text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap break-words"
                    >
                      {note.text}
                    </p>
                  ))}
                </div>
              ) : null}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.div>
  )
}
