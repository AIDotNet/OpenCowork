import * as React from 'react'
import {
  FileDiff,
  type FileDiffLine,
  type FileDiffStatus
} from '@renderer/components/agents/file-diff'
import {
  buildAddedFileLines,
  buildDiffCopyText,
  buildDiffFileLines,
  shortPath,
  toAgentCodeLanguage
} from '@renderer/lib/chat/file-diff-model'

export function ChatFileDiff({
  filePath,
  lines,
  oldText,
  newText,
  addedText,
  status,
  forceOpen = false,
  copyText
}: {
  filePath: string
  lines?: FileDiffLine[]
  oldText?: string
  newText?: string
  addedText?: string
  status: FileDiffStatus
  forceOpen?: boolean
  copyText?: string
}): React.JSX.Element {
  const resolvedLines = React.useMemo(() => {
    if (lines) return lines
    if (typeof addedText === 'string') return buildAddedFileLines(addedText)
    return buildDiffFileLines(oldText ?? '', newText ?? '')
  }, [addedText, lines, newText, oldText])

  const resolvedCopyText = React.useMemo(() => {
    if (copyText) return copyText
    if (typeof addedText === 'string') return addedText
    return buildDiffCopyText(oldText ?? '', newText ?? '')
  }, [addedText, copyText, newText, oldText])

  const fileLabel = shortPath(filePath) || filePath || 'file'

  return (
    <FileDiff
      file={<span title={filePath || undefined}>{fileLabel}</span>}
      lines={resolvedLines}
      status={status}
      language={toAgentCodeLanguage(filePath)}
      copyText={resolvedCopyText}
      collapseOnComplete={!forceOpen}
      defaultOpen={forceOpen || status === 'streaming'}
      open={forceOpen ? true : undefined}
      maxHeight={280}
    />
  )
}
