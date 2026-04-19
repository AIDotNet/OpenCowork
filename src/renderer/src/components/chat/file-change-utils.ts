import type { AgentRunFileChange } from '@renderer/stores/agent-store'
import type { DiffViewerChunk, DiffViewerLine } from './CodeDiffViewer'

export interface AggregatedFileChange {
  id: string
  runId: string
  sessionId?: string
  toolUseId?: string
  toolName?: string
  filePath: string
  transport: AgentRunFileChange['transport']
  connectionId?: string
  op: AgentRunFileChange['op']
  status: AgentRunFileChange['status']
  before: AgentRunFileChange['before']
  after: AgentRunFileChange['after']
  createdAt: number
  acceptedAt?: number
  revertedAt?: number
  conflict?: string
  sourceChanges: AgentRunFileChange[]
  sourceIds: string[]
  firstChangeId: string
  lastChangeId: string
}

export function detectLang(filePath: string): string {
  const ext = filePath.includes('.') ? (filePath.split('.').pop()?.toLowerCase() ?? '') : ''
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    jsx: 'jsx',
    py: 'python',
    rs: 'rust',
    go: 'go',
    json: 'json',
    css: 'css',
    scss: 'scss',
    less: 'less',
    html: 'html',
    htm: 'html',
    xml: 'xml',
    svg: 'xml',
    md: 'markdown',
    mdx: 'markdown',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'toml',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    sql: 'sql',
    graphql: 'graphql',
    gql: 'graphql',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    cxx: 'cpp',
    cc: 'cpp',
    hpp: 'cpp',
    java: 'java',
    kt: 'kotlin',
    kts: 'kotlin',
    rb: 'ruby',
    php: 'php',
    swift: 'swift',
    dockerfile: 'docker',
    makefile: 'makefile',
    r: 'r',
    lua: 'lua',
    dart: 'dart',
    ini: 'ini',
    env: 'bash',
    conf: 'ini'
  }
  return map[ext] ?? 'text'
}

export function shortPath(filePath: string): string {
  return filePath.split(/[\\/]/).slice(-2).join('/')
}

export function fileName(filePath: string): string {
  const parts = filePath.split(/[\\/]/)
  return parts[parts.length - 1] || filePath
}

export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

export function lineCount(text: string): number {
  const normalized = normalizeLineEndings(text)
  return normalized.length === 0 ? 0 : normalized.split('\n').length
}

export function snapshotText(
  snapshot: AgentRunFileChange['before'] | AgentRunFileChange['after']
): string {
  return snapshot.text ?? snapshot.previewText ?? ''
}

export function snapshotLineTotal(
  snapshot: AgentRunFileChange['before'] | AgentRunFileChange['after']
): number {
  return typeof snapshot.lineCount === 'number'
    ? snapshot.lineCount
    : lineCount(snapshotText(snapshot))
}

export function canRenderInlineSnapshot(
  snapshot: AgentRunFileChange['before'] | AgentRunFileChange['after']
): boolean {
  return typeof snapshot.text === 'string'
}

type TrackedChangeLike = Pick<AgentRunFileChange, 'op' | 'before' | 'after'>

export function hasDisplayableTrackedChange(change: TrackedChangeLike): boolean {
  if (change.before.exists !== change.after.exists) return true
  if (!change.before.exists && !change.after.exists) return false

  if (change.before.hash !== null && change.after.hash !== null) {
    return change.before.hash !== change.after.hash
  }

  const beforeText = snapshotText(change.before)
  const afterText = snapshotText(change.after)
  if (
    change.before.text !== undefined ||
    change.after.text !== undefined ||
    change.before.previewText !== undefined ||
    change.after.previewText !== undefined
  ) {
    return normalizeLineEndings(beforeText) !== normalizeLineEndings(afterText)
  }

  return true
}

function changeGroupKey(
  change: Pick<AgentRunFileChange, 'filePath' | 'transport' | 'connectionId'>
): string {
  return [change.transport, change.connectionId ?? '', change.filePath].join('\u0000')
}

function aggregateStatus(changes: AgentRunFileChange[]): AgentRunFileChange['status'] {
  if (changes.some((change) => change.status === 'open')) return 'open'
  if (changes.some((change) => change.status === 'conflicted')) return 'conflicted'
  if (changes.every((change) => change.status === 'reverted')) return 'reverted'
  return 'accepted'
}

export function aggregateRunFileChanges(changes: AgentRunFileChange[]): AggregatedFileChange[] {
  const grouped = new Map<string, AggregatedFileChange>()
  const orderedKeys: string[] = []

  for (const change of changes) {
    const key = changeGroupKey(change)
    const existing = grouped.get(key)
    if (!existing) {
      grouped.set(key, {
        id: key,
        runId: change.runId,
        sessionId: change.sessionId,
        toolUseId: change.toolUseId,
        toolName: change.toolName,
        filePath: change.filePath,
        transport: change.transport,
        connectionId: change.connectionId,
        op: change.before.exists ? 'modify' : 'create',
        status: change.status,
        before: change.before,
        after: change.after,
        createdAt: change.createdAt,
        acceptedAt: change.acceptedAt,
        revertedAt: change.revertedAt,
        conflict: change.conflict,
        sourceChanges: [change],
        sourceIds: [change.id],
        firstChangeId: change.id,
        lastChangeId: change.id
      })
      orderedKeys.push(key)
      continue
    }

    existing.sessionId = change.sessionId ?? existing.sessionId
    existing.toolUseId = change.toolUseId ?? existing.toolUseId
    existing.toolName = change.toolName ?? existing.toolName
    existing.after = change.after
    existing.acceptedAt = change.acceptedAt ?? existing.acceptedAt
    existing.revertedAt = change.revertedAt ?? existing.revertedAt
    existing.conflict = change.conflict ?? existing.conflict
    existing.sourceChanges.push(change)
    existing.sourceIds.push(change.id)
    existing.lastChangeId = change.id
  }

  return orderedKeys.map((key) => {
    const aggregated = grouped.get(key)!
    aggregated.status = aggregateStatus(aggregated.sourceChanges)
    return aggregated
  })
}

export function aggregateDisplayableRunFileChanges(
  changes: AgentRunFileChange[]
): AggregatedFileChange[] {
  return aggregateRunFileChanges(changes).filter((change) => hasDisplayableTrackedChange(change))
}

export function matchesAggregatedChangeId(
  change: AggregatedFileChange,
  changeId?: string | null
): boolean {
  if (!changeId) return false
  return change.id === changeId || change.sourceIds.includes(changeId)
}

export function actionableSourceChanges(change: AggregatedFileChange): AgentRunFileChange[] {
  return change.sourceChanges.filter(
    (entry) => entry.status === 'open' || entry.status === 'conflicted'
  )
}

export type DiffLine = DiffViewerLine
export type DiffChunk = DiffViewerChunk

function computeLargeDiff(a: string[], b: string[]): DiffLine[] {
  const result: DiffLine[] = []
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

export function computeDiff(oldStr: string, newStr: string): DiffLine[] {
  const a = normalizeLineEndings(oldStr).split('\n')
  const b = normalizeLineEndings(newStr).split('\n')
  const m = a.length
  const n = b.length

  if (m * n > 100000) {
    return computeLargeDiff(a, b)
  }

  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1))
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }

  const result: DiffLine[] = []
  let i = m
  let j = n

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      result.push({ type: 'keep', text: a[i - 1], oldNum: i, newNum: j })
      i -= 1
      j -= 1
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push({ type: 'add', text: b[j - 1], newNum: j })
      j -= 1
    } else {
      result.push({ type: 'del', text: a[i - 1], oldNum: i })
      i -= 1
    }
  }

  return result.reverse()
}

export function summarizeDiff(lines: DiffLine[]): { added: number; deleted: number } {
  return lines.reduce(
    (acc, line) => {
      if (line.type === 'add') acc.added += 1
      if (line.type === 'del') acc.deleted += 1
      return acc
    },
    { added: 0, deleted: 0 }
  )
}

export function summarizeTrackedChange(change: TrackedChangeLike): {
  added: number
  deleted: number
} {
  if (change.op === 'create') {
    return { added: snapshotLineTotal(change.after), deleted: 0 }
  }

  if (canRenderInlineSnapshot(change.before) && canRenderInlineSnapshot(change.after)) {
    return summarizeDiff(computeDiff(snapshotText(change.before), snapshotText(change.after)))
  }

  const beforeLines = snapshotLineTotal(change.before)
  const afterLines = snapshotLineTotal(change.after)
  const summary = {
    added: Math.max(afterLines - beforeLines, 0),
    deleted: Math.max(beforeLines - afterLines, 0)
  }

  const hashesMatch = change.before.hash !== null && change.before.hash === change.after.hash
  if (!hashesMatch && summary.added === 0 && summary.deleted === 0) {
    return { added: 1, deleted: 1 }
  }

  return summary
}

export function foldContext(lines: DiffLine[], ctx: number = 2): DiffChunk[] {
  const chunks: DiffChunk[] = []
  let keepRun: DiffLine[] = []

  const flushKeep = (): void => {
    if (keepRun.length <= ctx * 2 + 1) {
      chunks.push({ type: 'lines', lines: keepRun })
    } else {
      chunks.push({ type: 'lines', lines: keepRun.slice(0, ctx) })
      chunks.push({
        type: 'collapsed',
        count: keepRun.length - ctx * 2,
        lines: keepRun.slice(ctx, -ctx)
      })
      chunks.push({ type: 'lines', lines: keepRun.slice(-ctx) })
    }
    keepRun = []
  }

  for (const line of lines) {
    if (line.type === 'keep') {
      keepRun.push(line)
    } else {
      if (keepRun.length > 0) flushKeep()
      if (chunks.length > 0 && chunks[chunks.length - 1].type === 'lines') {
        ;(chunks[chunks.length - 1] as { type: 'lines'; lines: DiffLine[] }).lines.push(line)
      } else {
        chunks.push({ type: 'lines', lines: [line] })
      }
    }
  }

  if (keepRun.length > 0) flushKeep()
  return chunks
}

export function diffDisplayLineNumber(line: DiffLine): number | undefined {
  if (line.type === 'del') return line.oldNum
  return line.newNum ?? line.oldNum
}

export function buildDiffCopyText(lines: DiffLine[]): string {
  return lines
    .map((line) => {
      const lineNumber = diffDisplayLineNumber(line)
      const marker = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '
      return `${lineNumber ?? ''}\t${marker}${line.text}`
    })
    .join('\n')
}
