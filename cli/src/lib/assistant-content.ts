import type { AssistantContentSegment } from '../types.js'

type StreamableAssistantKind = Extract<AssistantContentSegment, { text: string }>['kind']

export function appendAssistantSegment(
  current: AssistantContentSegment[] | undefined,
  kind: StreamableAssistantKind,
  delta: string,
  timestamp: number
): AssistantContentSegment[] {
  const segments = current ?? []
  if (!delta) return segments

  const last = segments.at(-1)
  if (last?.kind === kind && 'text' in last) {
    return [
      ...segments.slice(0, -1),
      {
        ...last,
        text: last.text + delta
      }
    ]
  }

  const completed = completeActiveThinking(segments, timestamp)
  return [
    ...completed,
    kind === 'thinking'
      ? {
          kind,
          startedAt: timestamp,
          text: delta,
          traceAvailable: true
        }
      : { kind: 'text', text: delta }
  ]
}

export function finalizeAssistantSegments(
  current: AssistantContentSegment[] | undefined,
  reasoningTokens: number | undefined,
  timestamp: number
): AssistantContentSegment[] {
  const completed = completeActiveThinking(current ?? [], timestamp)
  if (
    !reasoningTokens ||
    reasoningTokens <= 0 ||
    completed.some((segment) => segment.kind === 'thinking')
  ) {
    return completed
  }

  const hiddenTrace: AssistantContentSegment = {
    completedAt: timestamp,
    kind: 'thinking',
    startedAt: timestamp,
    text: '',
    traceAvailable: false
  }
  const firstTextIndex = completed.findIndex((segment) => segment.kind === 'text')
  if (firstTextIndex < 0) return [...completed, hiddenTrace]
  return [...completed.slice(0, firstTextIndex), hiddenTrace, ...completed.slice(firstTextIndex)]
}

function completeActiveThinking(
  segments: AssistantContentSegment[],
  timestamp: number
): AssistantContentSegment[] {
  const last = segments.at(-1)
  if (last?.kind !== 'thinking' || last.completedAt !== undefined) return segments
  return [...segments.slice(0, -1), { ...last, completedAt: timestamp }]
}
