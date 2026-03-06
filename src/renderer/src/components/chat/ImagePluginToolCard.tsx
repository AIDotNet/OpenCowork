import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronDown, ImageIcon, Loader2, TriangleAlert } from 'lucide-react'
import type { ToolCallStatus } from '@renderer/lib/agent/types'
import type { ImageBlock, TextBlock, ToolResultContent } from '@renderer/lib/api/types'
import { ImagePreview } from './ImagePreview'

interface ImagePluginToolCardProps {
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

export function ImagePluginToolCard({
  input,
  output,
  status,
  error
}: ImagePluginToolCardProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  const [collapsed, setCollapsed] = useState(false)
  const prompt = typeof input.prompt === 'string' ? input.prompt : ''
  const requestedCount =
    typeof input.count === 'number' ? input.count : Number(input.count ?? 1) || 1

  const { images, notes } = useMemo(() => {
    if (!Array.isArray(output)) {
      return { images: [] as ImageBlock[], notes: [] as TextBlock[] }
    }

    return {
      images: output.filter((block): block is ImageBlock => block.type === 'image'),
      notes: output.filter((block): block is TextBlock => block.type === 'text')
    }
  }, [output])

  const parsedError = error || parseErrorMessage(output)
  const isRunning = status === 'streaming' || status === 'pending_approval' || status === 'running'
  const hasError = status === 'error' || (!!parsedError && images.length === 0)

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
                : {
                    scale: 1,
                    rotate: 0
                  }
            }
            transition={
              isRunning
                ? {
                    duration: 1.8,
                    repeat: Infinity,
                    ease: 'easeInOut'
                  }
                : ITEM_TRANSITION
            }
          >
            <ImageIcon className="size-4" />
          </motion.span>
          <div>
            <p className="text-sm font-medium">{t('toolCall.imagePlugin.title')}</p>
            <motion.p
              key={`${status}-${images.length}-${hasError ? 'error' : 'ok'}`}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={ITEM_TRANSITION}
              className="text-[11px] text-muted-foreground"
            >
              {isRunning
                ? t('toolCall.imagePlugin.running')
                : hasError
                  ? t('toolCall.imagePlugin.failed')
                  : t('toolCall.imagePlugin.completed')}
            </motion.p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <motion.span
            layout
            className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground"
          >
            {t('toolCall.imagePlugin.countValue', { count: requestedCount })}
          </motion.span>
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
            key="image-plugin-content"
            layout
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={CONTENT_TRANSITION}
            className="overflow-hidden"
          >
            <div className="space-y-4 px-4 py-4">
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">
                  {t('toolCall.imagePlugin.prompt')}
                </p>
                <p className="rounded-lg bg-muted/20 px-3 py-2 text-sm leading-relaxed text-foreground whitespace-pre-wrap break-words">
                  {prompt || '-'}
                </p>
              </div>

              {isRunning ? (
                <motion.div
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={ITEM_TRANSITION}
                  className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-3 text-sm text-muted-foreground"
                >
                  <Loader2 className="size-4 animate-spin" />
                  <span>{t('toolCall.imagePlugin.generating')}</span>
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
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={ITEM_TRANSITION}
                  className="space-y-3"
                >
                  <p className="text-xs font-medium text-muted-foreground">
                    {t('toolCall.imagePlugin.result', { count: images.length })}
                  </p>
                  <div className="grid gap-3 md:grid-cols-2">
                    {images.map((image, index) => {
                      const src =
                        image.source.type === 'base64'
                          ? `data:${image.source.mediaType || 'image/png'};base64,${image.source.data}`
                          : (image.source.url ?? '')
                      if (!src) return null
                      return (
                        <motion.div
                          key={`${src}-${index}`}
                          initial={{ opacity: 0, y: 10, scale: 0.98 }}
                          animate={{ opacity: 1, y: 0, scale: 1 }}
                          transition={{ ...ITEM_TRANSITION, delay: index * 0.06 }}
                        >
                          <ImagePreview src={src} alt={`Generated image ${index + 1}`} />
                        </motion.div>
                      )
                    })}
                  </div>
                </motion.div>
              ) : null}

              {notes.length > 0 ? (
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={ITEM_TRANSITION}
                  className="space-y-2"
                >
                  <p className="text-xs font-medium text-muted-foreground">
                    {t('toolCall.imagePlugin.notes')}
                  </p>
                  {notes.map((note, index) => (
                    <motion.p
                      key={`${note.text}-${index}`}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ ...ITEM_TRANSITION, delay: index * 0.04 }}
                      className="rounded-lg bg-muted/20 px-3 py-2 text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap break-words"
                    >
                      {note.text}
                    </motion.p>
                  ))}
                </motion.div>
              ) : null}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.div>
  )
}
