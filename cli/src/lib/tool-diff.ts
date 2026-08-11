import type { ToolDiff, ToolDiffLine } from '../types.js'

type JsonRecord = Record<string, unknown>

const CONTEXT_LINE_COUNT = 2
const MAX_CHANGED_LINES_PER_KIND = 12

function splitLines(value: string): string[] {
  if (!value) return []
  const normalized = value.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n')
  const lines = normalized.split('\n')
  if (normalized.endsWith('\n')) lines.pop()
  return lines
}

function changedLines(lines: string[], kind: 'removed' | 'added'): ToolDiffLine[] {
  if (lines.length <= MAX_CHANGED_LINES_PER_KIND) {
    return lines.map((text) => ({ kind, text }))
  }

  const headCount = Math.ceil(MAX_CHANGED_LINES_PER_KIND / 2)
  const tailCount = Math.floor(MAX_CHANGED_LINES_PER_KIND / 2)
  const omitted = lines.length - headCount - tailCount
  return [
    ...lines.slice(0, headCount).map((text): ToolDiffLine => ({ kind, text })),
    {
      kind: 'meta',
      text: `… ${omitted} ${kind === 'removed' ? 'removed' : 'added'} lines omitted`
    },
    ...lines.slice(-tailCount).map((text): ToolDiffLine => ({ kind, text }))
  ]
}

/** Build a compact line diff from the exact replacement payload sent to the Edit tool. */
export function buildEditDiff(toolName: string, input: JsonRecord): ToolDiff | undefined {
  if (toolName !== 'Edit') return undefined
  const path = typeof input.file_path === 'string' ? input.file_path.trim() : ''
  const oldString = typeof input.old_string === 'string' ? input.old_string : undefined
  const newString = typeof input.new_string === 'string' ? input.new_string : undefined
  if (!path || oldString === undefined || newString === undefined || oldString === newString) {
    return undefined
  }

  const oldLines = splitLines(oldString)
  const newLines = splitLines(newString)
  let prefixLength = 0
  while (
    prefixLength < oldLines.length &&
    prefixLength < newLines.length &&
    oldLines[prefixLength] === newLines[prefixLength]
  ) {
    prefixLength += 1
  }

  let suffixLength = 0
  while (
    suffixLength < oldLines.length - prefixLength &&
    suffixLength < newLines.length - prefixLength &&
    oldLines[oldLines.length - suffixLength - 1] === newLines[newLines.length - suffixLength - 1]
  ) {
    suffixLength += 1
  }

  const removed = oldLines.slice(prefixLength, oldLines.length - suffixLength)
  const added = newLines.slice(prefixLength, newLines.length - suffixLength)
  if (removed.length === 0 && added.length === 0) return undefined

  const contextBefore = oldLines.slice(Math.max(0, prefixLength - CONTEXT_LINE_COUNT), prefixLength)
  const contextAfter = oldLines.slice(
    oldLines.length - suffixLength,
    oldLines.length - suffixLength + CONTEXT_LINE_COUNT
  )
  const lines: ToolDiffLine[] = [
    ...contextBefore.map((text): ToolDiffLine => ({ kind: 'context', text })),
    ...changedLines(removed, 'removed'),
    ...changedLines(added, 'added'),
    ...contextAfter.map((text): ToolDiffLine => ({ kind: 'context', text }))
  ]

  return {
    additions: added.length,
    deletions: removed.length,
    lines,
    path,
    replaceAll: input.replace_all === true
  }
}
