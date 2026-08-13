import { wrapText } from './text.js'
import {
  estimateSubAgentGroupLines,
  isSubAgentToolMessage,
  subAgentGroupRange,
  type SubAgentToolMessage
} from './sub-agent-display.js'
import type { Message } from '../types.js'

/**
 * Estimated line heights for transcript messages, mirroring the layout rules in
 * components/transcript.tsx. Ink/Yoga cannot report heights before rendering, so the
 * viewport is windowed with these estimates instead of a per-message count heuristic.
 * Estimates use the same grapheme/east-asian width logic as the renderer (wrapText), so
 * they are exact for the common single-style rows and conservative for mixed-style rows.
 */

function wrappedLines(text: string, width: number): number {
  if (!text) return 0
  return wrapText(text, Math.max(1, width)).length
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

export function estimateMessageLines(
  message: Message,
  width: number,
  showDetails: boolean,
  expandedIds?: ReadonlySet<string>
): number {
  if (isSubAgentToolMessage(message)) {
    return estimateSubAgentGroupLines([message], width, showDetails, expandedIds)
  }

  const detailed = showDetails || (expandedIds?.has(message.id) ?? false)
  // Every transcript message opens with marginTop={1}.
  let lines = 1

  if (message.kind === 'user') {
    lines += Math.max(1, wrappedLines(`❯ ${message.text}`, width))
    if (message.images && message.images.length > 0) lines += 1
    if (message.references && message.references.length > 0) lines += 1
    return lines
  }

  if (message.kind === 'assistant') {
    const segments =
      message.segments && message.segments.length > 0
        ? message.segments
        : message.text
          ? [{ kind: 'text' as const, text: message.text }]
          : []
    if (segments.length === 0) return lines + 1
    for (const segment of segments) {
      if (segment.kind === 'thinking') {
        lines += 1
        if (detailed && segment.traceAvailable && segment.text.trim()) {
          lines += wrappedLines(segment.text.trim(), Math.max(1, width - 2))
        }
        continue
      }
      if (segment.kind === 'image') {
        lines += 1
        continue
      }
      lines += Math.max(1, wrappedLines(`● ${segment.text}`, width))
    }
    if (detailed && (message.model || message.timestamp)) lines += 1
    return lines
  }

  if (message.kind === 'tool') {
    lines += 1
    if (message.summary) lines += 1
    if (detailed && message.detail) lines += wrappedLines(message.detail, Math.max(1, width - 5))
    if (message.diff) lines += message.diff.lines.length
    return lines
  }

  return lines + Math.max(1, wrappedLines(`⎿ ${message.text}`, Math.max(1, width - 2)))
}

export interface TranscriptWindow {
  /** Visible slice, oldest first. */
  messages: Message[]
  /** Index (into the source array) of the first visible message. */
  startIndex: number
  /** Estimated line height per visible message, parallel to `messages`. */
  heights: number[]
  hiddenAbove: number
  hiddenBelow: number
}

function estimateUnitLines(
  messages: Message[],
  width: number,
  showDetails: boolean,
  expandedIds?: ReadonlySet<string>
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
  return estimateMessageLines(first, width, showDetails, expandedIds)
}

/**
 * Selects the visible message window by walking heights backwards from the anchor
 * (bottom-most visible message; null follows the tail) until the line budget is
 * exhausted. Consecutive sub-agent tool rows are treated as one visual unit.
 * Always keeps at least the anchor unit so a single oversized message cannot blank
 * the transcript.
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
    return { messages: [], startIndex: 0, heights: [], hiddenAbove: 0, hiddenBelow: 0 }
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
    const height = estimateUnitLines(unit, width, showDetails, expandedIds)
    if (index !== visibleEnd && used + height > budget) break
    const unitHeights = unit.map((_, offset) => (offset === 0 ? height : 0))
    heights.unshift(...unitHeights)
    used += height
    start = range.start
    index = range.start - 1
  }

  return {
    messages: messages.slice(start, visibleEnd + 1),
    startIndex: start,
    heights,
    hiddenAbove: start,
    hiddenBelow: messages.length - 1 - visibleEnd
  }
}
