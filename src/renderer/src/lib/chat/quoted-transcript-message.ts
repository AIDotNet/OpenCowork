import type { UnifiedMessage } from '@renderer/lib/api/types'

export function isLiveQuotedTranscriptMessage(
  message: Pick<UnifiedMessage, 'role' | 'source'> | null | undefined
): boolean {
  return message?.role === 'user' && message.source === 'quoted'
}

/**
 * A quoted prompt is appended to the resident window before SQLite may have
 * the row. Tail reloads report a window that already covers its sortOrder
 * (session.messageCount moved), so the usual "local tail not in DB yet"
 * keep-rules miss it and drop the optimistic bubble until the session is
 * reopened.
 */
export function shouldKeepUnfetchedQuotedResident(input: {
  isPendingLocalWrite: boolean
  isLiveQuoted: boolean
  logicalIndex: number
  residentStart: number
  windowStart: number
  fetchedWindowEnd: number
  knownCount: number
  residentEnd: number
  sessionMessageCount: number
  fetchedCount: number
}): boolean {
  if (input.isPendingLocalWrite || input.isLiveQuoted) return true

  const isResidentPrefixOutsideFetchedWindow =
    input.logicalIndex < input.windowStart &&
    input.logicalIndex >= input.residentStart &&
    input.logicalIndex < input.knownCount
  const isLocalTailNotInDbYet =
    input.logicalIndex >= input.windowStart &&
    input.logicalIndex >= input.fetchedWindowEnd &&
    input.logicalIndex < input.knownCount &&
    input.residentEnd > input.fetchedWindowEnd
  const isMissingFromShortDbSnapshot =
    input.logicalIndex >= input.windowStart &&
    input.logicalIndex < input.knownCount &&
    input.sessionMessageCount > input.fetchedCount &&
    input.residentEnd > input.fetchedWindowEnd

  return (
    isResidentPrefixOutsideFetchedWindow || isLocalTailNotInDbYet || isMissingFromShortDbSnapshot
  )
}
