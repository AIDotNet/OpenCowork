import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Check,
  ChevronDown,
  ChevronRight,
  ImageIcon,
  Loader2,
  TriangleAlert,
  X
} from 'lucide-react'
import type { ToolCallStatus } from '@renderer/lib/agent/types'
import type { ImageBlock, TextBlock, ToolResultContent } from '@renderer/lib/api/types'
import {
  resolveImageGenerateRetry,
  type ImageGenerateRetryState
} from '@renderer/lib/app-plugin/image-tool-retry'
import { decodeStructuredToolResult } from '@renderer/lib/tools/tool-result-format'
import { Button } from '@renderer/components/ui/button'
import { confirm } from '@renderer/components/ui/confirm-dialog'
import { cn } from '@renderer/lib/utils'
import { ImagePreview } from './ImagePreview'

interface ImagePluginToolCardProps {
  toolUseId?: string
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
  const parsed = decodeStructuredToolResult(output)
  if (parsed && !Array.isArray(parsed) && typeof parsed.error === 'string' && parsed.error.trim()) {
    return parsed.error
  }
  return output.trim() || null
}

function parseRetryState(input: Record<string, unknown>): ImageGenerateRetryState | null {
  const value = input._retryState
  if (!value || typeof value !== 'object') return null

  const status = (value as { status?: unknown }).status
  const errorMessage = (value as { errorMessage?: unknown }).errorMessage
  const attempt = (value as { attempt?: unknown }).attempt
  const completedCount = (value as { completedCount?: unknown }).completedCount
  const totalCount = (value as { totalCount?: unknown }).totalCount

  if (
    status !== 'awaiting_retry' ||
    typeof errorMessage !== 'string' ||
    typeof attempt !== 'number' ||
    typeof completedCount !== 'number' ||
    typeof totalCount !== 'number'
  ) {
    return null
  }

  return {
    status,
    errorMessage,
    attempt,
    completedCount,
    totalCount
  }
}

function lifecycleIcon({
  isRunning,
  hasError
}: {
  isRunning: boolean
  hasError: boolean
}): React.JSX.Element {
  if (isRunning) return <Loader2 className="size-3 animate-spin" />
  if (hasError) return <X className="size-3" />
  return <Check className="size-3" />
}

function lifecycleShellClassName({
  isRunning,
  hasError
}: {
  isRunning: boolean
  hasError: boolean
}): string {
  if (hasError) return 'border-destructive/25 text-destructive'
  if (isRunning) return 'border-sky-500/25 text-sky-600 dark:text-sky-300'
  return 'border-lime-500/25 text-lime-600 dark:text-lime-400'
}

function SectionHeader({ label }: { label: string }): React.JSX.Element {
  return (
    <div className="border-b border-border/45 pb-2 pt-0.5 text-[12px] font-semibold text-foreground/88 dark:border-white/[0.08]">
      {label}
    </div>
  )
}

export function ImagePluginToolCard({
  toolUseId,
  input,
  output,
  status,
  error
}: ImagePluginToolCardProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  const prompt = typeof input.prompt === 'string' ? input.prompt : ''
  const requestedCount =
    typeof input.count === 'number' ? input.count : Number(input.count ?? 1) || 1
  const retryState = parseRetryState(input)

  const { images, notes } = useMemo(() => {
    if (!Array.isArray(output)) {
      return { images: [] as ImageBlock[], notes: [] as TextBlock[] }
    }

    return {
      images: output.filter((block): block is ImageBlock => block.type === 'image'),
      notes: output.filter((block): block is TextBlock => block.type === 'text')
    }
  }, [output])

  const parsedError = error || retryState?.errorMessage || parseErrorMessage(output)
  const isAwaitingRetry = retryState?.status === 'awaiting_retry'
  const isRunning =
    status === 'streaming' ||
    status === 'pending_approval' ||
    status === 'running' ||
    isAwaitingRetry
  const hasError =
    !isAwaitingRetry && (status === 'error' || (!!parsedError && images.length === 0))
  const [collapsed, setCollapsed] = useState(!isRunning)

  useEffect(() => {
    if (isRunning) setCollapsed(false)
  }, [isRunning])

  const statusLabel = isAwaitingRetry
    ? t('toolCall.imagePlugin.waitingRetry')
    : isRunning
      ? t('toolCall.imagePlugin.running')
      : hasError
        ? t('toolCall.imagePlugin.failed')
        : t('toolCall.imagePlugin.completed')
  const promptSummary = prompt.trim() || t('toolCall.receivingArgs')

  const handleRetry = async (): Promise<void> => {
    if (!toolUseId || !retryState) return

    const confirmed = await confirm({
      title: t('toolCall.imagePlugin.retryConfirmTitle'),
      description: t('toolCall.imagePlugin.retryConfirmDesc', {
        completed: retryState.completedCount,
        total: retryState.totalCount
      }),
      confirmLabel: t('toolCall.imagePlugin.retryConfirmAction'),
      cancelLabel: t('action.cancel', { ns: 'common' })
    })

    if (!confirmed) return
    resolveImageGenerateRetry(toolUseId)
  }

  return (
    <motion.div layout className="my-1 min-w-0 overflow-hidden" transition={CONTENT_TRANSITION}>
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((value) => !value)}
        className={cn(
          'group flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[12px] transition-colors hover:bg-muted/35 hover:text-foreground dark:hover:bg-white/[0.035]',
          hasError
            ? 'text-destructive/85'
            : isRunning
              ? 'text-sky-600 dark:text-sky-300'
              : 'text-muted-foreground'
        )}
      >
        <span
          className={cn(
            'flex size-5 shrink-0 items-center justify-center rounded-full border bg-transparent',
            lifecycleShellClassName({ isRunning, hasError })
          )}
        >
          {lifecycleIcon({ isRunning, hasError })}
        </span>
        <span className="shrink-0 text-muted-foreground/55">image</span>
        <span className="shrink-0 text-muted-foreground/40">&gt;</span>
        <span className="shrink-0 font-mono font-medium text-foreground/82">ImageGenerate</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground/60">({promptSummary})</span>
        <span className="hidden shrink-0 rounded-full border border-border/55 bg-background/70 px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground sm:inline-flex dark:bg-white/[0.035]">
          {t('toolCall.imagePlugin.countValue', { count: requestedCount })}
        </span>
        {collapsed ? (
          <ChevronRight className="size-3 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-foreground" />
        ) : (
          <ChevronDown className="size-3 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-foreground" />
        )}
      </button>

      <AnimatePresence initial={false}>
        {!collapsed ? (
          <motion.div
            key="image-plugin-content"
            layout
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={CONTENT_TRANSITION}
            className="ml-3 mt-1.5 overflow-hidden border-l border-border/45 pl-5 dark:border-white/[0.08]"
          >
            <div className="space-y-3 rounded-lg border border-border/55 bg-background/55 px-3 py-3 dark:border-white/[0.08] dark:bg-[#0d0d0e]">
              <div className="space-y-2">
                <SectionHeader label={t('toolCall.parameters')} />
                <div className="space-y-1.5 rounded-md bg-muted/20 px-3 py-2 text-xs">
                  <div className="flex items-center gap-2 text-muted-foreground/70">
                    <ImageIcon className="size-3.5 shrink-0" />
                    <span>{statusLabel}</span>
                  </div>
                  <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground/85">
                    {prompt || '-'}
                  </p>
                </div>
              </div>

              {isAwaitingRetry ? (
                <motion.div
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={ITEM_TRANSITION}
                  className="space-y-3 rounded-lg border border-amber-500/25 bg-amber-500/[0.045] px-3 py-3 text-sm"
                >
                  <div className="flex items-start gap-2 text-amber-700 dark:text-amber-300">
                    <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                    <div className="space-y-1">
                      <p className="font-medium">{t('toolCall.imagePlugin.retryRequired')}</p>
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        {t('toolCall.imagePlugin.retryHint', {
                          completed: retryState?.completedCount ?? images.length,
                          total: retryState?.totalCount ?? requestedCount
                        })}
                      </p>
                      <p className="text-xs leading-relaxed text-amber-700/90 dark:text-amber-200/90">
                        {t('toolCall.imagePlugin.retryCaveat')}
                      </p>
                      {parsedError ? (
                        <p className="break-all rounded-md bg-background/70 px-2 py-1.5 text-[11px] text-muted-foreground">
                          {parsedError}
                        </p>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <Button size="sm" onClick={() => void handleRetry()} disabled={!toolUseId}>
                      {t('action.retry', { ns: 'common' })}
                    </Button>
                  </div>
                </motion.div>
              ) : isRunning ? (
                <motion.div
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={ITEM_TRANSITION}
                  className="flex items-center gap-2 rounded-lg border border-dashed border-sky-500/20 bg-sky-500/[0.035] px-3 py-3 text-sm text-muted-foreground"
                >
                  <Loader2 className="size-4 animate-spin text-sky-500" />
                  <span>{t('toolCall.imagePlugin.generating')}</span>
                </motion.div>
              ) : null}

              {hasError ? (
                <motion.div
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={ITEM_TRANSITION}
                  className="rounded-lg border border-destructive/30 bg-destructive/[0.035] px-3 py-3 text-sm text-destructive"
                >
                  <div className="flex items-center gap-2">
                    <TriangleAlert className="size-4 shrink-0" />
                    <span className="min-w-0 break-words">{parsedError}</span>
                  </div>
                </motion.div>
              ) : null}

              {images.length > 0 || notes.length > 0 ? (
                <div className="space-y-3">
                  <SectionHeader
                    label={
                      images.length > 0
                        ? t('toolCall.imagePlugin.result', { count: images.length })
                        : t('toolCall.result')
                    }
                  />
                  {images.length > 0 ? (
                    <motion.div
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={ITEM_TRANSITION}
                      className="grid gap-3 md:grid-cols-2"
                    >
                      {images.map((image, index) => {
                        const src =
                          image.source.type === 'base64' && image.source.data
                            ? `data:${image.source.mediaType || 'image/png'};base64,${image.source.data}`
                            : (image.source.url ?? '')
                        if (!src && !image.source.filePath) return null
                        return (
                          <motion.div
                            key={`${image.source.filePath ?? src}-${index}`}
                            initial={{ opacity: 0, y: 10, scale: 0.98 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            transition={{ ...ITEM_TRANSITION, delay: index * 0.06 }}
                          >
                            <ImagePreview
                              src={src}
                              alt={`Generated image ${index + 1}`}
                              filePath={image.source.filePath}
                            />
                          </motion.div>
                        )
                      })}
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
                          className="whitespace-pre-wrap break-words rounded-lg bg-muted/20 px-3 py-2 text-xs leading-relaxed text-muted-foreground"
                        >
                          {note.text}
                        </motion.p>
                      ))}
                    </motion.div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.div>
  )
}
