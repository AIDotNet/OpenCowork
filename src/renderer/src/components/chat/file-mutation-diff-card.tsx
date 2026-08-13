import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import type { ToolCallStatus } from '@renderer/lib/agent/types'
import type { ToolResultContent } from '@renderer/lib/api/types'
import { decodeStructuredToolResult } from '@renderer/lib/tools/tool-result-format'
import type { AgentRunFileChange } from '@renderer/stores/agent-store'
import { useAgentStore } from '@renderer/stores/agent-store'
import { MONO_FONT } from '@renderer/lib/constants'
import { IPC } from '@renderer/lib/ipc/channels'
import { invokeMessagePackBinary } from '@renderer/lib/ipc/messagepack-ipc-client'
import { Button } from '@renderer/components/ui/button'
import { confirm } from '@renderer/components/ui/confirm-dialog'
import { toMessagePackChannel } from '../../../../shared/messagepack/binary-ipc'
import { ChatFileDiff } from './chat-file-diff'
import { LazySyntaxHighlighter } from './LazySyntaxHighlighter'
import type { FileDiffStatus } from '@renderer/components/agents/file-diff'
import {
  canRenderInlineSnapshot,
  resolveEditTexts,
  resolveWritePreview,
  snapshotText,
  toAgentCodeLanguage
} from '@renderer/lib/chat/file-diff-model'

interface FileMutationDiffCardProps {
  name: 'Edit' | 'Write' | string
  input: Record<string, unknown>
  output?: ToolResultContent
  status: ToolCallStatus | 'completed'
  error?: string
  startedAt?: number
  completedAt?: number
  trackedChange?: AgentRunFileChange
  forceOpen?: boolean
}

function detectLang(filePath: string): string {
  return toAgentCodeLanguage(filePath)
}

function SnapshotSummaryNotice({
  before,
  after,
  filePath,
  children
}: {
  before?: AgentRunFileChange['before']
  after: AgentRunFileChange['after']
  filePath?: string
  children?: React.ReactNode
}): React.JSX.Element {
  const details = [
    typeof before?.lineCount === 'number' ? `before ${before.lineCount} lines` : null,
    typeof after.lineCount === 'number' ? `after ${after.lineCount} lines` : null,
    `${after.size} bytes`,
    after.hash ? `sha ${after.hash.slice(0, 12)}` : null
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="space-y-3 px-1 py-2 text-[11px] text-muted-foreground">
      <div className="space-y-1">
        <p>Large file snapshot summarized to avoid storing full before/after text in memory.</p>
        <p
          className="font-mono text-[10px] text-muted-foreground/70"
          style={{ fontFamily: MONO_FONT }}
        >
          {details}
        </p>
      </div>
      {children}
      {after.previewText && (
        <LazySyntaxHighlighter
          language={detectLang(filePath ?? '')}
          showLineNumbers
          wrapLongLines
          customStyle={{
            margin: 0,
            padding: '0.5rem',
            borderRadius: '0.375rem',
            fontSize: '11px',
            maxHeight: '180px',
            overflow: 'auto',
            fontFamily: MONO_FONT
          }}
          codeTagProps={{ style: { fontFamily: 'inherit' } }}
        >
          {`${after.previewText}${after.tailPreviewText ? '\n…\n' : ''}${after.tailPreviewText ?? ''}`}
        </LazySyntaxHighlighter>
      )}
    </div>
  )
}

function TrackedMutationDiff({
  change,
  filePath,
  status,
  forceOpen
}: {
  change: AgentRunFileChange
  filePath: string
  status: FileDiffStatus
  forceOpen: boolean
}): React.JSX.Element {
  const { t } = useTranslation('chat')
  const canRenderInline =
    canRenderInlineSnapshot(change.before) && canRenderInlineSnapshot(change.after)
  const [content, setContent] = React.useState<{ beforeText: string; afterText: string } | null>(
    () =>
      canRenderInline
        ? {
            beforeText: snapshotText(change.before),
            afterText: snapshotText(change.after)
          }
        : null
  )
  const [isLoading, setIsLoading] = React.useState(!canRenderInline)
  const [loadError, setLoadError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (canRenderInline) {
      setContent({
        beforeText: snapshotText(change.before),
        afterText: snapshotText(change.after)
      })
      setIsLoading(false)
      setLoadError(null)
      return
    }

    let cancelled = false
    const load = async (): Promise<void> => {
      setIsLoading(true)
      setLoadError(null)
      try {
        const result = await invokeMessagePackBinary(
          toMessagePackChannel(IPC.AGENT_CHANGES_DIFF_CONTENT),
          {
            runId: change.runId,
            changeId: change.id
          }
        )
        if (cancelled) return
        if (
          result &&
          typeof result === 'object' &&
          'beforeText' in result &&
          'afterText' in result &&
          typeof result.beforeText === 'string' &&
          typeof result.afterText === 'string'
        ) {
          setContent({ beforeText: result.beforeText, afterText: result.afterText })
          return
        }
        if (
          result &&
          typeof result === 'object' &&
          'error' in result &&
          typeof result.error === 'string'
        ) {
          setLoadError(result.error)
          return
        }
        setLoadError('Failed to load full diff')
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false)
        }
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [canRenderInline, change])

  if (isLoading && !content) {
    return (
      <SnapshotSummaryNotice before={change.before} after={change.after} filePath={filePath}>
        <div className="flex items-center gap-2">
          <Loader2 className="size-3.5 animate-spin" />
          <span>{t('thinking.thinkingEllipsis')}</span>
        </div>
      </SnapshotSummaryNotice>
    )
  }

  if (loadError && !content) {
    return (
      <SnapshotSummaryNotice before={change.before} after={change.after} filePath={filePath}>
        <div className="text-destructive/80">{loadError}</div>
      </SnapshotSummaryNotice>
    )
  }

  if (!content) {
    return <SnapshotSummaryNotice before={change.before} after={change.after} filePath={filePath} />
  }

  return (
    <ChatFileDiff
      filePath={filePath}
      oldText={content.beforeText}
      newText={content.afterText}
      status={status}
      forceOpen={forceOpen}
    />
  )
}

function toDiffStatus(status: FileMutationDiffCardProps['status']): FileDiffStatus {
  if (status === 'streaming' || status === 'running' || status === 'pending_approval') {
    return 'streaming'
  }
  return 'complete'
}

export function FileMutationDiffCard({
  name,
  input,
  output,
  status,
  error,
  trackedChange,
  forceOpen = false
}: FileMutationDiffCardProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  const undoFileChange = useAgentStore((state) => state.undoFileChange)
  const [isUndoingFile, setIsUndoingFile] = React.useState(false)
  const filePath = String(input.file_path ?? input.path ?? '')
  const diffStatus = toDiffStatus(status)
  const outputStr = typeof output === 'string' ? output : undefined
  const parsedOutput = outputStr ? decodeStructuredToolResult(outputStr) : null
  const parsedOutputError =
    parsedOutput && !Array.isArray(parsedOutput) && typeof parsedOutput.error === 'string'
      ? parsedOutput.error.trim()
      : null
  const canceledMessage =
    status === 'canceled'
      ? t('toolCall.noResult', { defaultValue: 'No tool result available' })
      : null
  const isSuccess = !!(
    parsedOutput &&
    !Array.isArray(parsedOutput) &&
    parsedOutput.success === true
  )
  const isOutputError = outputStr
    ? Boolean(parsedOutputError) || (!parsedOutput && outputStr.length > 0)
    : false
  const isFileActionable = trackedChange?.status === 'open'
  const editTexts = React.useMemo(() => resolveEditTexts(input), [input])
  const writePreview = React.useMemo(() => resolveWritePreview(input), [input])
  const showTrackedModifyDiff =
    !!trackedChange && (name === 'Edit' || (name === 'Write' && trackedChange.op === 'modify'))
  const showTrackedCreate = name === 'Write' && !!trackedChange && trackedChange.op === 'create'
  const showTrackedCreateInline = Boolean(
    showTrackedCreate && trackedChange && canRenderInlineSnapshot(trackedChange.after)
  )
  const showTrackedCreateSummary = Boolean(
    showTrackedCreate && trackedChange && !showTrackedCreateInline
  )
  const showEditFromInput =
    name === 'Edit' && !trackedChange && (!!editTexts.oldText || !!editTexts.newText)
  const showWriteFromInput = name === 'Write' && !trackedChange && !!writePreview

  const handleUndoFile = async (): Promise<void> => {
    if (!trackedChange || !isFileActionable) return
    const confirmed = await confirm({
      title: t('fileChange.undoFileConfirmTitle'),
      description: t('fileChange.undoFileConfirmDesc', { path: filePath }),
      confirmLabel: t('fileChange.undoConfirmAction'),
      variant: 'destructive'
    })
    if (!confirmed) return
    setIsUndoingFile(true)
    try {
      await undoFileChange(trackedChange.runId, trackedChange.id)
    } finally {
      setIsUndoingFile(false)
    }
  }

  return (
    <div className="my-1 w-full">
      {showTrackedModifyDiff && trackedChange ? (
        <TrackedMutationDiff
          change={trackedChange}
          filePath={filePath}
          status={diffStatus}
          forceOpen={forceOpen}
        />
      ) : showTrackedCreateInline && trackedChange ? (
        <ChatFileDiff
          filePath={filePath}
          addedText={snapshotText(trackedChange.after)}
          status={diffStatus}
          forceOpen={forceOpen}
        />
      ) : showTrackedCreateSummary && trackedChange ? (
        <SnapshotSummaryNotice after={trackedChange.after} filePath={filePath} />
      ) : showEditFromInput ? (
        <ChatFileDiff
          filePath={filePath}
          oldText={editTexts.oldText}
          newText={editTexts.newText}
          status={diffStatus}
          forceOpen={forceOpen}
        />
      ) : showWriteFromInput ? (
        <ChatFileDiff
          filePath={filePath}
          addedText={writePreview}
          status={diffStatus}
          forceOpen={forceOpen}
        />
      ) : (
        <ChatFileDiff filePath={filePath} lines={[]} status={diffStatus} forceOpen={forceOpen} />
      )}

      {trackedChange ? (
        <div className="flex items-center justify-between gap-2 px-1 py-2">
          <p className="text-[10px] text-muted-foreground">
            {trackedChange.status === 'reverted'
              ? t('fileChange.restored')
              : t('fileChange.individualActions')}
          </p>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={handleUndoFile}
            disabled={!isFileActionable || isUndoingFile}
          >
            {isUndoingFile ? <Loader2 className="size-3 animate-spin" /> : null}
            {t('action.undo', { ns: 'common' })}
          </Button>
        </div>
      ) : null}

      {(error || (parsedOutputError && !error) || canceledMessage) && (
        <div className="px-1 py-2">
          <p
            className="whitespace-pre-wrap break-words font-mono text-[11px] text-destructive"
            style={{ fontFamily: MONO_FONT }}
          >
            {error || parsedOutputError || canceledMessage}
          </p>
        </div>
      )}
      {outputStr && !error && !parsedOutputError && isOutputError && !isSuccess && (
        <div className="px-1 py-2">
          <p
            className="whitespace-pre-wrap break-words font-mono text-[11px] text-destructive/80"
            style={{ fontFamily: MONO_FONT }}
          >
            {outputStr.length > 500 ? `${outputStr.slice(0, 500)}...` : outputStr}
          </p>
        </div>
      )}
    </div>
  )
}
