import { MARKDOWN_GUTTER, clipMarkdownHead, countMarkdownLines } from './markdown-layout.js'
import { countWrappedLines } from './text.js'
import {
  estimateSubAgentGroupLines,
  isSubAgentToolMessage,
  subAgentGroupRange,
  type SubAgentToolMessage
} from './sub-agent-display.js'
import type { AssistantContentSegment, Message } from '../types.js'

/**
 * Estimated line heights for transcript messages, mirroring the layout rules in
 * components/transcript.tsx. Ink/Yoga cannot report heights before rendering, so the
 * viewport is windowed with these estimates instead of a per-message count heuristic.
 * Estimates wrap text the same way Ink does, so they are exact for the common
 * single-style rows and conservative for mixed-style rows.
 *
 * Callers that only need to know whether a message fits the viewport pass `cap`; heights
 * saturate at `cap + 1` so a streaming reply is never re-wrapped in full on every frame.
 */

const UNCAPPED = Number.MAX_SAFE_INTEGER

function wrappedLines(text: string, width: number, cap = UNCAPPED): number {
  if (!text) return 0
  return countWrappedLines(text, Math.max(1, width), cap)
}

/** Rows reserved for prompt / status / turn chrome outside the scrollable transcript. */
export function estimateChromeLines(args: {
  hasTurnStatus: boolean
  overlayOpen: boolean
  scrollLocked: boolean
}): number {
  // Overlays replace the prompt and need a large reserved band so the transcript cannot
  // push them off-screen and thrash the alt-screen / Ink dynamic frame.
  if (args.overlayOpen) return 20
  // Prompt (~3) + status metrics (~2) + trailing pad (1) + safety margin for wrap.
  let chrome = 9
  if (args.hasTurnStatus) chrome += 1
  if (args.scrollLocked) chrome += 1
  return chrome
}

function resolveAssistantSegments(
  message: Extract<Message, { kind: 'assistant' }>
): AssistantContentSegment[] {
  if (message.segments && message.segments.length > 0) return message.segments
  return message.text ? [{ kind: 'text', text: message.text }] : []
}

function estimateAssistantSegmentLines(
  segment: AssistantContentSegment,
  width: number,
  detailed: boolean,
  cap = UNCAPPED
): number {
  if (segment.kind === 'thinking') {
    let lines = 1
    if (detailed && segment.traceAvailable && segment.text.trim()) {
      lines += wrappedLines(segment.text.trim(), Math.max(1, width - 2), cap)
    }
    return lines
  }
  if (segment.kind === 'image') return 1
  // Assistant text is rendered as markdown beside a two-column bullet gutter.
  return Math.max(1, countMarkdownLines(segment.text, markdownBodyWidth(width), cap))
}

function markdownBodyWidth(width: number): number {
  return Math.max(1, width - MARKDOWN_GUTTER)
}

export function estimateMessageLines(
  message: Message,
  width: number,
  showDetails: boolean,
  expandedIds?: ReadonlySet<string>,
  cap = UNCAPPED
): number {
  if (isSubAgentToolMessage(message)) {
    return estimateSubAgentGroupLines([message], width, showDetails, expandedIds)
  }

  const detailed = showDetails || (expandedIds?.has(message.id) ?? false)
  // Every transcript message opens with marginTop={1}.
  let lines = 1

  if (message.kind === 'user') {
    lines += Math.max(1, wrappedLines(`❯ ${message.text}`, width, cap))
    if (message.images && message.images.length > 0) lines += 1
    if (message.references && message.references.length > 0) lines += 1
    return lines
  }

  if (message.kind === 'assistant') {
    const segments = resolveAssistantSegments(message)
    if (segments.length === 0) return lines + 1
    for (const segment of segments) {
      lines += estimateAssistantSegmentLines(segment, width, detailed, cap)
      if (lines > cap) return lines
    }
    if (detailed && (message.model || message.timestamp)) lines += 1
    return lines
  }

  if (message.kind === 'tool') {
    lines += 1
    if (message.summary) lines += 1
    if (detailed && message.detail) {
      lines += wrappedLines(message.detail, Math.max(1, width - 5), cap)
    }
    if (message.diff) lines += message.diff.lines.length
    return lines
  }

  return lines + Math.max(1, wrappedLines(`⎿ ${message.text}`, Math.max(1, width - 2), cap))
}

export interface TranscriptWindow {
  /** Visible slice, oldest first. The first entry may be a head-clipped copy. */
  messages: Message[]
  /** Index (into the source array) of the first visible message. */
  startIndex: number
  /** Estimated line height per visible message, parallel to `messages`. */
  heights: number[]
  hiddenAbove: number
  hiddenBelow: number
  /** Wrapped lines dropped from the head of the first visible message. */
  clippedLines: number
}

/**
 * Rows charged for a segment scrolled entirely out of view. Wrapping it would mean
 * measuring text nobody can see, so text is charged per source line — a floor, matching
 * how `tailWrappedLines` counts everything above its quota.
 */
function hiddenSegmentLines(segment: AssistantContentSegment): number {
  if (segment.kind !== 'text') return 1
  let lines = 1
  for (let index = 0; index < segment.text.length; index += 1) {
    if (segment.text[index] === '\n') lines += 1
  }
  return lines
}

/**
 * Drops leading content from an assistant message so it renders in at most `maxLines`
 * rows, keeping the newest text visible. Text segments are cut at markdown block
 * boundaries so the survivors still parse — see `clipMarkdownHead`. Returns null when the
 * message cannot be reduced to fit.
 */
function clipAssistantMessageHead(
  message: Extract<Message, { kind: 'assistant' }>,
  width: number,
  maxLines: number,
  detailed: boolean
): { hiddenLines: number; message: Message } | null {
  const segments = resolveAssistantSegments(message)
  if (segments.length === 0) return null
  const footerLines = detailed && (message.model || message.timestamp) ? 1 : 0
  // marginTop={1} plus the optional model/timestamp footer are fixed message chrome.
  const segmentBudget = maxLines - 1 - footerLines
  if (segmentBudget < 1) return null

  const kept: AssistantContentSegment[] = []
  let hiddenLines = 0
  let used = 0
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index]!
    const room = segmentBudget - used
    if (room <= 0) {
      hiddenLines += hiddenSegmentLines(segment)
      continue
    }
    // Only "does it fit in `room`" matters here, so heights saturate just past it.
    const height = estimateAssistantSegmentLines(segment, width, detailed, room + 1)
    if (height <= room) {
      kept.unshift(segment)
      used += height
      continue
    }
    if (segment.kind === 'text') {
      const clip = clipMarkdownHead(segment.text, markdownBodyWidth(width), room)
      kept.unshift({ kind: 'text', text: clip.text })
      hiddenLines += clip.hiddenLines
      used += room
      continue
    }
    hiddenLines += height
  }

  // An empty segment list falls back to `message.text`, which is the unclipped reply, so
  // leave the message alone and let the transcript's height clamp bound it instead.
  if (hiddenLines === 0 || kept.length === 0) return null
  return { hiddenLines, message: { ...message, segments: kept } }
}

function estimateUnitLines(
  messages: Message[],
  width: number,
  showDetails: boolean,
  expandedIds?: ReadonlySet<string>,
  cap = UNCAPPED
): number {
  const first = messages[0]
  if (!first) return 0
  if (isSubAgentToolMessage(first)) {
    return estimateSubAgentGroupLines(
      messages as SubAgentToolMessage[],
      width,
      showDetails,
      expandedIds
    )
  }
  return estimateMessageLines(first, width, showDetails, expandedIds, cap)
}

/**
 * Selects the visible message window by walking heights backwards from the anchor
 * (bottom-most visible message; null follows the tail) until the line budget is
 * exhausted. Consecutive sub-agent tool rows are treated as one visual unit.
 * Always keeps at least the anchor unit so a single oversized message cannot blank
 * the transcript; when that unit alone overflows the budget its head is clipped, because
 * a dynamic frame taller than the terminal makes Ink hard-clear the screen and replay
 * its whole static buffer on every render.
 */
export function computeTranscriptWindow(args: {
  anchorIndex: number | null
  budgetLines: number
  expandedIds?: ReadonlySet<string>
  messages: Message[]
  showDetails: boolean
  width: number
}): TranscriptWindow {
  const { messages, width, showDetails, expandedIds } = args
  if (messages.length === 0) {
    return {
      messages: [],
      startIndex: 0,
      heights: [],
      hiddenAbove: 0,
      hiddenBelow: 0,
      clippedLines: 0
    }
  }

  const budget = Math.max(1, args.budgetLines)
  const requestedAnchor = Math.min(
    messages.length - 1,
    Math.max(0, args.anchorIndex ?? messages.length - 1)
  )
  const visibleEnd = subAgentGroupRange(messages, requestedAnchor).end
  const heights: number[] = []
  let start = visibleEnd
  let used = 0
  for (let index = visibleEnd; index >= 0; ) {
    const range = subAgentGroupRange(messages, index)
    const unit = messages.slice(range.start, range.end + 1)
    const height = estimateUnitLines(unit, width, showDetails, expandedIds, budget + 1)
    if (index !== visibleEnd && used + height > budget) break
    const unitHeights = unit.map((_, offset) => (offset === 0 ? height : 0))
    heights.unshift(...unitHeights)
    used += height
    start = range.start
    index = range.start - 1
  }

  const visible = messages.slice(start, visibleEnd + 1)
  let clippedLines = 0
  // Only the anchor unit can push `used` past the budget: every other unit is dropped by
  // the break above. Clip its head so the frame stops overflowing the terminal.
  const oversized = visible[0]
  if (used > budget && oversized?.kind === 'assistant') {
    const detailed = showDetails || (expandedIds?.has(oversized.id) ?? false)
    const clipped = clipAssistantMessageHead(oversized, width, budget, detailed)
    if (clipped) {
      visible[0] = clipped.message
      clippedLines = clipped.hiddenLines
      // Clipping lands at or under the budget, so measure the copy that will render
      // rather than assuming it fills the window exactly.
      heights[0] = estimateMessageLines(clipped.message, width, showDetails, expandedIds)
    }
  }

  return {
    messages: visible,
    startIndex: start,
    heights,
    hiddenAbove: start,
    hiddenBelow: messages.length - 1 - visibleEnd,
    clippedLines
  }
}
