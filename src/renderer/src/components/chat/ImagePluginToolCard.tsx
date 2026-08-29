import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { motion } from 'motion/react'
import { ChevronDown, Loader2 } from 'lucide-react'
import type { ToolCallStatus } from '@renderer/lib/agent/types'
import type { ImageBlock, TextBlock, ToolResultContent } from '@renderer/lib/api/types'
import {
  resolveImageGenerateRetry,
  type ImageGenerateRetryState
} from '@renderer/lib/app-plugin/image-tool-retry'
import { decodeStructuredToolResult } from '@renderer/lib/tools/tool-result-format'
import { countLabel } from '@renderer/lib/chat/execution-labels'
import { Button } from '@renderer/components/ui/button'
import { confirm } from '@renderer/components/ui/confirm-dialog'
import { cn } from '@renderer/lib/utils'
import { CollapsibleHeightPanel } from './CollapsibleHeightPanel'
import { ImagePreview } from './ImagePreview'

interface ImagePluginToolCardProps {
  toolUseId?: string
  input: Record<string, unknown>
  output?: ToolResultContent
  status: ToolCallStatus | 'completed'
  error?: string
  forceOpen?: boolean
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

function SectionHeader({ label }: { label: string }): React.JSX.Element {
  return (
    <div className="border-b border-border/40 pb-1.5 pt-0.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/75 dark:border-white/[0.08]">
      {label}
    </div>
  )
}

export function ImagePluginToolCard({
  toolUseId,
  input,
  output,
  status,
  error,
  forceOpen = false
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

  const canceledMessage =
    status === 'canceled'
      ? t('toolCall.noResult', { defaultValue: 'No tool result available' })
      : null
  const parsedError =
    error || retryState?.errorMessage || parseErrorMessage(output) || canceledMessage
  const isAwaitingRetry = retryState?.status === 'awaiting_retry'
  const isRunning =
    status === 'streaming' ||
    status === 'pending_approval' ||
    status === 'running' ||
    isAwaitingRetry
  const hasError =
    !isAwaitingRetry &&
    (status === 'error' || status === 'canceled' || (!!parsedError && images.length === 0))
  // Collapsed by default even while running; users expand manually.
  const [collapsed, setCollapsed] = useState(!forceOpen)

  useEffect(() => {
    if (forceOpen) setCollapsed(false)
  }, [forceOpen])

  // The execution transcript reads in English in every locale — see `execution-labels`.
  const statusLabel = isAwaitingRetry
    ? 'Awaiting retry'
    : isRunning
      ? 'Running'
      : hasError
        ? 'Failed'
        : 'Completed'
  const promptSummary = prompt.trim() || 'Receiving arguments'

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
        onClick={() => {
          if (forceOpen) return
          setCollapsed((value) => !value)
        }}
        className={cn(
          'group flex w-full cursor-pointer items-center gap-2 rounded-md bg-transparent px-1.5 py-1 text-left text-[12.5px] transition-colors duration-150 hover:bg-transparent',
          hasError ? 'text-destructive/85' : 'text-muted-foreground'
        )}
      >
        <span
          className={cn(
            'shrink-0 font-medium tracking-tight',
            isRunning
              ? 'tool-name-live-pulse tool-name-live-pulse--running'
              : hasError
                ? 'text-destructive/85'
                : 'text-foreground/75'
          )}
        >
          ImageGenerate
        </span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground/60">{promptSummary}</span>
        <span className="hidden shrink-0 text-[11px] tabular-nums text-muted-foreground/50 sm:inline">
          {countLabel(requestedCount, 'image')}
        </span>
        <ChevronDown
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground/35 transition-transform duration-200 group-hover:text-muted-foreground/70',
            collapsed && '-rotate-90'
          )}
        />
      </button>

      <CollapsibleHeightPanel
        open={!collapsed}
        collapseMotion="scroll-up"
        className="ml-3.5 mt-1 overflow-hidden border-l border-border/50 pl-4.5 dark:border-white/[0.08]"
      >
        <div className="space-y-3 rounded-xl border border-border/60 bg-muted/20 p-3 shadow-xs dark:border-white/[0.08] dark:bg-white/[0.02]">
          <div className="space-y-2">
            <SectionHeader label={t('toolCall.parameters')} />
            <div className="space-y-1.5 rounded-md bg-muted/20 px-3 py-2 text-xs">
              <div className="flex items-center gap-2 text-muted-foreground/70">
                <span
                  className={
                    isRunning ? 'tool-name-live-pulse tool-name-live-pulse--running' : undefined
                  }
                >
                  {statusLabel}
                </span>
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
              <div className="text-amber-700 dark:text-amber-300">
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
              <span className="tool-name-live-pulse tool-name-live-pulse--running">
                {t('toolCall.imagePlugin.generating')}
              </span>
            </motion.div>
          ) : null}

          {hasError ? (
            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={ITEM_TRANSITION}
              className="rounded-lg border border-destructive/30 bg-destructive/[0.035] px-3 py-3 text-sm text-destructive"
            >
              <span className="min-w-0 break-words">{parsedError}</span>
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
      </CollapsibleHeightPanel>
    </motion.div>
  )
}
