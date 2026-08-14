/**
 * Build the model-visible conversation after context compression.
 *
 * The UI/DB keep the full transcript. Request assembly must send only:
 *   compact boundary + summary + optional preserved tail + messages after the mark.
 * Without this cut, hosted session-open reloads every pre-compression message and
 * the next turn immediately refills the context window.
 */

export const LEGACY_COMPACT_SUMMARY_PREFIX = '[Context Memory Compressed Summary'

export type CompactRequestMeta = {
  compactBoundary?: {
    summaryId?: string
    preservedSegment?: {
      headId?: string
      tailId?: string
      anchorId?: string
    }
  }
  compactSummary?: {
    summarizerFailed?: boolean
  }
  compressionStatus?: unknown
}

export type CompactRequestMessage = {
  id: string
  role: string
  content?: unknown
  createdAt: number
  meta?: CompactRequestMeta | null
}

export type ActiveCompactArtifacts = {
  boundaryId: string | null
  boundaryIndex: number
  summaryId: string | null
  summaryIndex: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parsePersistedMessageContent(raw: string): unknown {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed === 'string' || Array.isArray(parsed)) return parsed
    return raw
  } catch {
    return raw
  }
}

export function parsePersistedMessageMeta(raw?: string | null): CompactRequestMeta | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as unknown
    return isRecord(parsed) ? (parsed as CompactRequestMeta) : undefined
  } catch {
    return undefined
  }
}

function compactSummaryText(message: CompactRequestMessage): string {
  if (typeof message.content === 'string') return message.content
  if (!Array.isArray(message.content)) return ''
  return message.content
    .map((block) => {
      if (!isRecord(block) || block.type !== 'text') return ''
      return typeof block.text === 'string' ? block.text : ''
    })
    .join('\n')
}

export function isCompactBoundaryMessage(message: CompactRequestMessage): boolean {
  return message.role === 'system' && !!message.meta?.compactBoundary
}

export function isCompactSummaryMessage(message: CompactRequestMessage): boolean {
  return message.role === 'user' && !!message.meta?.compactSummary
}

export function isLegacyCompactSummaryMessage(message: CompactRequestMessage): boolean {
  if (message.role !== 'user') return false
  return compactSummaryText(message).trimStart().startsWith(LEGACY_COMPACT_SUMMARY_PREFIX)
}

export function isCompactSummaryLikeMessage(message: CompactRequestMessage): boolean {
  return isCompactSummaryMessage(message) || isLegacyCompactSummaryMessage(message)
}

export function isCompactArtifactMessage(message: CompactRequestMessage): boolean {
  return isCompactBoundaryMessage(message) || isCompactSummaryLikeMessage(message)
}

export function isUiOnlyRequestMessage(message: CompactRequestMessage): boolean {
  if (message.role !== 'system') return false
  if (message.meta?.compressionStatus) return true
  if (message.meta?.compactBoundary) return false
  if (typeof message.content === 'string') return message.content.trim().length === 0
  return Array.isArray(message.content) && message.content.length === 0
}

function findCompactSummaryIndexAfterBoundary(
  messages: readonly CompactRequestMessage[],
  boundaryIndex: number
): number {
  for (let index = boundaryIndex + 1; index < messages.length; index += 1) {
    if (isCompactBoundaryMessage(messages[index]!)) return -1
    if (isCompactSummaryLikeMessage(messages[index]!)) return index
  }
  return -1
}

function findCompactSummaryIndexForBoundary(
  messages: readonly CompactRequestMessage[],
  boundaryIndex: number
): number {
  const boundaryMeta = messages[boundaryIndex]?.meta?.compactBoundary
  const summaryId = boundaryMeta?.summaryId ?? boundaryMeta?.preservedSegment?.anchorId
  if (summaryId) {
    const byId = messages.findIndex(
      (message) => message.id === summaryId && isCompactSummaryLikeMessage(message)
    )
    if (byId >= 0) return byId
  }
  return findCompactSummaryIndexAfterBoundary(messages, boundaryIndex)
}

export function resolveActiveCompactArtifacts(
  messages: readonly CompactRequestMessage[]
): ActiveCompactArtifacts | null {
  const items = [...messages]
  let active: ActiveCompactArtifacts | null = null
  let activeScore = Number.NEGATIVE_INFINITY

  for (let boundaryIndex = 0; boundaryIndex < items.length; boundaryIndex += 1) {
    const boundary = items[boundaryIndex]
    if (!boundary || !isCompactBoundaryMessage(boundary)) continue

    const summaryIndex = findCompactSummaryIndexForBoundary(items, boundaryIndex)
    if (summaryIndex < 0) continue

    const summary = items[summaryIndex]
    if (!summary) continue
    const score = Math.max(boundary.createdAt, summary.createdAt)
    if (score < activeScore) continue

    activeScore = score
    active = {
      boundaryId: boundary.id,
      boundaryIndex,
      summaryId: summary.id,
      summaryIndex
    }
  }

  if (active) return active

  for (let summaryIndex = 0; summaryIndex < items.length; summaryIndex += 1) {
    const summary = items[summaryIndex]
    if (!summary || !isCompactSummaryLikeMessage(summary)) continue
    if (summary.createdAt < activeScore) continue
    activeScore = summary.createdAt
    active = {
      boundaryId: null,
      boundaryIndex: -1,
      summaryId: summary.id,
      summaryIndex
    }
  }

  return active
}

export function compactRequestFence(messages: readonly CompactRequestMessage[]): string {
  const active = resolveActiveCompactArtifacts(messages)
  if (!active) return ''
  return `${active.boundaryId ?? ''}:${active.summaryId ?? ''}`
}

function stripThinkingBlocksForCompactRequest<T extends CompactRequestMessage>(message: T): T {
  if (!Array.isArray(message.content)) return message

  const content = message.content.filter((block) => {
    return !isRecord(block) || block.type !== 'thinking'
  })
  if (content.length === message.content.length) return message

  return { ...message, content }
}

function appendCompactRequestMessage<T extends CompactRequestMessage>(
  result: T[],
  seenIds: Set<string>,
  message: T | undefined,
  activeCompact: ActiveCompactArtifacts
): void {
  if (!message || seenIds.has(message.id) || isUiOnlyRequestMessage(message)) return
  if (isCompactArtifactMessage(message)) {
    if (isCompactBoundaryMessage(message)) {
      if (message.id !== activeCompact.boundaryId) return
    } else if (message.id !== activeCompact.summaryId) {
      return
    }
  }

  result.push(stripThinkingBlocksForCompactRequest(message))
  seenIds.add(message.id)
}

function collectCompactPreservedMessages<T extends CompactRequestMessage>(
  messages: readonly T[],
  boundaryMessage: T | undefined,
  activeCompact: ActiveCompactArtifacts
): T[] {
  const preservedSegment = boundaryMessage?.meta?.compactBoundary?.preservedSegment
  const preservedHeadId = preservedSegment?.headId?.trim() ?? ''
  const preservedTailId = preservedSegment?.tailId?.trim() ?? ''
  if (!preservedHeadId || !preservedTailId) return []

  const headIndex = messages.findIndex((message) => message.id === preservedHeadId)
  if (headIndex < 0) return []

  let tailIndex = -1
  for (let index = headIndex; index < messages.length; index += 1) {
    if (messages[index]?.id === preservedTailId) {
      tailIndex = index
      break
    }
  }
  if (tailIndex < headIndex) return []

  const preservedMessages: T[] = []
  const seenIds = new Set<string>()
  for (const message of messages.slice(headIndex, tailIndex + 1)) {
    appendCompactRequestMessage(preservedMessages, seenIds, message, activeCompact)
  }
  return preservedMessages
}

function passThroughWithoutArtifacts<T extends CompactRequestMessage>(messages: readonly T[]): T[] {
  return messages.filter((message) => !isUiOnlyRequestMessage(message) && !isCompactArtifactMessage(message))
}

/**
 * Reduce a keep-history transcript to the model-visible compact view.
 * Uses the latest boundary/summary pair so older compressed ranges stay dropped.
 */
export function applyLatestCompactRequestView<T extends CompactRequestMessage>(
  messages: readonly T[]
): T[] {
  const activeCompact = resolveActiveCompactArtifacts(messages)
  if (!activeCompact) {
    return passThroughWithoutArtifacts(messages)
  }

  if (activeCompact.boundaryIndex < 0) {
    const summaryMessage = messages[activeCompact.summaryIndex]
    if (summaryMessage?.meta?.compactSummary?.summarizerFailed === true) {
      return passThroughWithoutArtifacts(messages)
    }
    console.warn('[CompactRequestView] Compact boundary missing; truncating request at summary', {
      summaryId: activeCompact.summaryId
    })
    const tail = messages
      .slice(activeCompact.summaryIndex + 1)
      .filter((message) => !isUiOnlyRequestMessage(message) && !isCompactArtifactMessage(message))
    return summaryMessage ? [summaryMessage, ...tail] : tail
  }

  const activeSummary = activeCompact.summaryId
    ? messages.find((message) => message.id === activeCompact.summaryId)
    : undefined
  if (activeSummary?.meta?.compactSummary?.summarizerFailed === true) {
    return passThroughWithoutArtifacts(messages)
  }

  const compactMessages: T[] = []
  const seenIds = new Set<string>()
  const boundaryMessage = activeCompact.boundaryId
    ? messages.find((message) => message.id === activeCompact.boundaryId)
    : undefined
  const summaryMessage = activeCompact.summaryId
    ? messages.find((message) => message.id === activeCompact.summaryId)
    : undefined

  appendCompactRequestMessage(compactMessages, seenIds, boundaryMessage, activeCompact)
  appendCompactRequestMessage(compactMessages, seenIds, summaryMessage, activeCompact)

  const preservedMessages = collectCompactPreservedMessages(
    messages,
    boundaryMessage,
    activeCompact
  )
  for (const message of preservedMessages) {
    appendCompactRequestMessage(compactMessages, seenIds, message, activeCompact)
  }

  const trailingStartIndex = Math.max(activeCompact.summaryIndex, activeCompact.boundaryIndex) + 1
  for (const message of messages.slice(Math.max(0, trailingStartIndex))) {
    if (seenIds.has(message.id)) continue
    appendCompactRequestMessage(compactMessages, seenIds, message, activeCompact)
  }

  return compactMessages
}
