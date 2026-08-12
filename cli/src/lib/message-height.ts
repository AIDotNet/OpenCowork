import { wrapText } from './text.js'
import type { Message } from '../types.js'

/**
 * Estimated line heights for transcript messages, mirroring the layout rules in
 * components/transcript.tsx. Ink/Yoga cannot report heights before rendering, so the
 * fullscreen viewport is windowed with these estimates instead of a per-message count
 * heuristic. Estimates use the same grapheme/east-asian width logic as the renderer
 * (wrapText), so they are exact for the common single-style rows and conservative for
 * mixed-style rows.
 */

function wrappedLines(text: string, width: number): number {
  if (!text) return 0
  return wrapText(text, Math.max(1, width)).length
}

export function estimateMessageLines(
  message: Message,
  width: number,
  showDetails: boolean,
  expandedIds?: ReadonlySet<string>
): number {
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

/**
 * Selects the fullscreen-visible message window by walking heights backwards from the
 * anchor (bottom-most visible message; null follows the tail) until the line budget is
 * exhausted. Always keeps at least the anchor message so a single oversized message
 * cannot blank the transcript.
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

  const anchor = Math.min(messages.length - 1, Math.max(0, args.anchorIndex ?? messages.length - 1))
  const heights: number[] = []
  let start = anchor
  let used = 0
  for (let index = anchor; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message) break
    const height = estimateMessageLines(message, width, showDetails, expandedIds)
    if (index !== anchor && used + height > args.budgetLines) break
    heights.unshift(height)
    used += height
    start = index
  }

  return {
    messages: messages.slice(start, anchor + 1),
    startIndex: start,
    heights,
    hiddenAbove: start,
    hiddenBelow: messages.length - 1 - anchor
  }
}
