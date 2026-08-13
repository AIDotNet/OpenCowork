import type { AgentCodeLanguage } from '@renderer/components/agents/agent-code'
import type { FileDiffLine, FileDiffLineType } from '@renderer/components/agents/file-diff'
import type { AgentFileSnapshot } from '@renderer/stores/agent-store'

type DiffOp = 'add' | 'del' | 'keep'

interface InternalDiffLine {
  type: DiffOp
  text: string
  oldNum?: number
  newNum?: number
}

const CONTEXT_LINES = 2

export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

export function lineCount(text: string): number {
  const normalized = normalizeLineEndings(text)
  return normalized.length === 0 ? 0 : normalized.split('\n').length
}

export function fileName(filePath: string): string {
  const parts = filePath.split(/[\\/]/)
  return parts[parts.length - 1] || filePath
}

export function shortPath(filePath: string): string {
  return filePath.split(/[\\/]/).slice(-2).join('/')
}

export function snapshotText(snapshot: AgentFileSnapshot): string {
  return snapshot.text ?? snapshot.previewText ?? ''
}

export function canRenderInlineSnapshot(snapshot: AgentFileSnapshot): boolean {
  return typeof snapshot.text === 'string'
}

export function toAgentCodeLanguage(filePath: string): AgentCodeLanguage {
  const ext = filePath.includes('.') ? (filePath.split('.').pop()?.toLowerCase() ?? '') : ''
  if (ext === 'ts' || ext === 'mts' || ext === 'cts') return 'typescript'
  if (ext === 'tsx') return 'tsx'
  if (ext === 'js' || ext === 'jsx' || ext === 'mjs' || ext === 'cjs') return 'tsx'
  if (ext === 'json') return 'json'
  if (ext === 'sh' || ext === 'bash' || ext === 'zsh') return 'bash'
  return 'text'
}

export function toFileDiffLineType(type: DiffOp): FileDiffLineType {
  if (type === 'add') return 'added'
  if (type === 'del') return 'removed'
  return 'context'
}

function computeLargeDiff(a: string[], b: string[]): InternalDiffLine[] {
  const result: InternalDiffLine[] = []
  const m = a.length
  const n = b.length

  let start = 0
  while (start < m && start < n && a[start] === b[start]) {
    result.push({ type: 'keep', text: a[start], oldNum: start + 1, newNum: start + 1 })
    start += 1
  }

  let endA = m - 1
  let endB = n - 1
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA -= 1
    endB -= 1
  }

  for (let index = start; index <= endA; index += 1) {
    result.push({ type: 'del', text: a[index], oldNum: index + 1 })
  }

  for (let index = start; index <= endB; index += 1) {
    result.push({ type: 'add', text: b[index], newNum: index + 1 })
  }

  for (let offset = 1; endA + offset < m && endB + offset < n; offset += 1) {
    result.push({
      type: 'keep',
      text: a[endA + offset],
      oldNum: endA + offset + 1,
      newNum: endB + offset + 1
    })
  }

  return result
}

export function computeDiff(oldStr: string, newStr: string): InternalDiffLine[] {
  const a = normalizeLineEndings(oldStr).split('\n')
  const b = normalizeLineEndings(newStr).split('\n')
  const m = a.length
  const n = b.length

  if (m * n > 100000) {
    return computeLargeDiff(a, b)
  }

  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }

  const result: InternalDiffLine[] = []
  let i = m
  let j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      result.push({ type: 'keep', text: a[i - 1], oldNum: i, newNum: j })
      i--
      j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push({ type: 'add', text: b[j - 1], newNum: j })
      j--
    } else {
      result.push({ type: 'del', text: a[i - 1], oldNum: i })
      i--
    }
  }
  return result.reverse()
}

function foldContext(lines: InternalDiffLine[], ctx: number = CONTEXT_LINES): FileDiffLine[] {
  const result: FileDiffLine[] = []
  let keepRun: InternalDiffLine[] = []
  let collapsedIndex = 0

  const pushLine = (line: InternalDiffLine, index: number): void => {
    result.push({
      id: `${line.type}-${line.oldNum ?? 'x'}-${line.newNum ?? 'x'}-${index}`,
      type: toFileDiffLineType(line.type),
      oldLine: line.oldNum,
      newLine: line.newNum,
      content: line.text
    })
  }

  const flushKeep = (): void => {
    if (keepRun.length <= ctx * 2 + 1) {
      keepRun.forEach((line, index) => pushLine(line, result.length + index))
    } else {
      keepRun.slice(0, ctx).forEach((line, index) => pushLine(line, result.length + index))
      const hidden = keepRun.length - ctx * 2
      result.push({
        id: `collapsed-${collapsedIndex}`,
        type: 'context',
        content: `··· ${hidden} unchanged lines ···`
      })
      collapsedIndex += 1
      keepRun.slice(-ctx).forEach((line, index) => pushLine(line, result.length + index))
    }
    keepRun = []
  }

  for (const line of lines) {
    if (line.type === 'keep') {
      keepRun.push(line)
    } else {
      if (keepRun.length > 0) flushKeep()
      pushLine(line, result.length)
    }
  }
  if (keepRun.length > 0) flushKeep()
  return result
}

export function buildDiffFileLines(oldStr: string, newStr: string): FileDiffLine[] {
  if (!oldStr && !newStr) return []
  return foldContext(computeDiff(oldStr, newStr))
}

export function buildAddedFileLines(content: string): FileDiffLine[] {
  if (!content) return []
  return normalizeLineEndings(content)
    .split('\n')
    .map((text, index) => ({
      id: `added-${index + 1}`,
      type: 'added' as const,
      newLine: index + 1,
      content: text
    }))
}

export function buildDiffCopyText(oldStr: string, newStr: string): string {
  return computeDiff(oldStr, newStr)
    .map((line) => {
      const lineNumber = line.type === 'del' ? line.oldNum : (line.newNum ?? line.oldNum)
      const marker = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '
      return `${lineNumber ?? ''}\t${marker}${line.text}`
    })
    .join('\n')
}

export function resolveWritePreview(input: Record<string, unknown>): string {
  const content = typeof input.content === 'string' ? input.content : null
  const preview = typeof input.content_preview === 'string' ? input.content_preview : null
  const previewTail =
    typeof input.content_preview_tail === 'string' ? input.content_preview_tail : null
  const previewBase =
    content ?? (previewTail ? `${preview ?? ''}\n...\n${previewTail}` : preview) ?? ''
  if (
    previewBase &&
    input.content_truncated &&
    !previewTail &&
    content === null &&
    !previewBase.startsWith('…')
  ) {
    return `${previewBase}\n...`
  }
  return previewBase
}

export function resolveEditTexts(input: Record<string, unknown>): {
  oldText: string
  newText: string
} {
  const oldText = typeof input.old_string === 'string' ? input.old_string : ''
  const newText = typeof input.new_string === 'string' ? input.new_string : ''
  const oldPreview =
    typeof input.old_string_preview === 'string' ? input.old_string_preview : oldText
  const newPreview =
    typeof input.new_string_preview === 'string' ? input.new_string_preview : newText
  return {
    oldText: oldText || oldPreview,
    newText: newText || newPreview
  }
}
