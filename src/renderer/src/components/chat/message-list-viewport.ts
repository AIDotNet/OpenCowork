/**
 * Message list viewport contract.
 *
 * Two facts, one owner each:
 *   Window  — which rows are in memory (chat-store). This file does not write it
 *             except by calling store load/ensure APIs.
 *   Viewport — where the scroller is looking. Only `pinBottom` and a bounded
 *             prepend restore may write `scrollTop`.
 *
 * Viewport mode:
 *   positioning — session just opened; list is hidden; keep pinning the tail
 *   following   — stick to the latest turn (user send or live stream)
 *   browsing    — the user owns the scrollbar; we never chase the tail
 *
 * Older-message loads:
 *   history     — user asked (button, top sentinel, scrolled to top). Always
 *                 preserve the newly loaded head. Restore the visible anchor,
 *                 then stay in browsing.
 *   visibility  — the resident window has no renderable rows, but older pages
 *                 exist. Preserve the newly loaded head so a heavy hidden tail
 *                 cannot evict the page that actually paints. Stays in the
 *                 current mode. Used while positioning or ready.
 *   fill        — only while following, and only if the painted tail is shorter
 *                 than the viewport. Preserve the tail. Never used while
 *                 browsing, and never to chase a row-count quota.
 */

export type MessageWindowPhase = 'loading' | 'positioning' | 'ready' | 'error'
export type ViewportMode = 'positioning' | 'following' | 'browsing'
export type OlderLoadIntent = 'history' | 'fill' | 'visibility'

export interface HistoryScrollAnchor {
  messageId: string
  offset: number
}

export interface ViewportRow {
  key: string
}

export const VIEWPORT = {
  bottomThreshold: 24,
  streamBottomThreshold: 144,
  turnSpacerMinHeight: 64,
  followSettleFrames: 3,
  followPinFrames: 8,
  scrollEpsilon: 2,
  autoScrollMinDelta: 24,
  programmaticGuardMs: 320,
  userIntentMs: 240,
  historyCorrectFrames: 8,
  olderLoadCooldownMs: 1000,
  streamPollMs: 200,
  olderLoadScrollThreshold: 72,
  newerLoadScrollThreshold: 72,
  estimatedRowHeight: 180,
  initialTailRenderCount: 32,
  windowStableFrames: 2,
  initialViewportFillMultiplier: 1.75,
  positionFrameLimit: 90,
  positionTimeLimitMs: 1600,
  maxFillPages: 2
} as const

export function shouldFinishPositioning(input: {
  stable: boolean
  frameCount: number
  startedAt: number | null
  now: number
}): boolean {
  if (input.stable) return true
  if (input.frameCount >= VIEWPORT.positionFrameLimit) return true
  return input.startedAt !== null && input.now - input.startedAt >= VIEWPORT.positionTimeLimitMs
}

export function resolveTurnSpacer(input: {
  clientHeight: number
  measuredTurnHeight: number | null
  estimatedTurnHeight: number
  previousSpacer: number
}): number {
  if (input.clientHeight <= 0) return input.previousSpacer
  if (input.measuredTurnHeight == null) {
    if (input.previousSpacer > 0) return input.previousSpacer
    return Math.max(
      VIEWPORT.turnSpacerMinHeight,
      Math.round(input.clientHeight - input.estimatedTurnHeight)
    )
  }
  const next = Math.max(
    VIEWPORT.turnSpacerMinHeight,
    Math.round(input.clientHeight - input.measuredTurnHeight)
  )
  return Math.abs(next - input.previousSpacer) <= 2 ? input.previousSpacer : next
}

export function getDistanceToBottom(scroller: HTMLElement): number {
  return Math.max(0, scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight)
}

export function waitAnimationFrames(count: number): Promise<void> {
  return new Promise((resolve) => {
    const step = (left: number): void => {
      if (left <= 0) {
        resolve()
        return
      }
      window.requestAnimationFrame(() => step(left - 1))
    }
    step(count)
  })
}

export function findNestedVerticalScroller(start: Element, root: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = start instanceof HTMLElement ? start : start.parentElement
  while (node && node !== root) {
    if (node.scrollHeight > node.clientHeight + 1) {
      const overflowY = getComputedStyle(node).overflowY
      if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'hidden') {
        return node
      }
    }
    node = node.parentElement
  }
  return null
}

export function readVisibleMessageAnchor(scroller: HTMLElement): HistoryScrollAnchor | null {
  const scrollerRect = scroller.getBoundingClientRect()
  const visible = Array.from(scroller.querySelectorAll<HTMLElement>('[data-message-id]')).find(
    (element) => {
      const rect = element.getBoundingClientRect()
      return rect.bottom > scrollerRect.top && rect.top < scrollerRect.bottom
    }
  )
  const messageId = visible?.dataset.messageId
  if (!messageId || !visible) return null
  return {
    messageId,
    offset: visible.getBoundingClientRect().top - scrollerRect.top
  }
}

export function measureRenderedTurnHeight(
  list: HTMLElement,
  lastUserMessageId: string
): number | null {
  const userEl = list.querySelector<HTMLElement>(
    `[data-message-id="${CSS.escape(lastUserMessageId)}"]`
  )
  if (!userEl) return null

  const userTop = userEl.getBoundingClientRect().top
  let bottom = userEl.getBoundingClientRect().bottom
  for (const el of list.querySelectorAll<HTMLElement>('[data-message-id]')) {
    const rect = el.getBoundingClientRect()
    if (rect.bottom <= userTop + 1) continue
    bottom = Math.max(bottom, rect.bottom)
  }
  return Math.max(0, Math.round(bottom - userTop))
}

export function estimateTurnHeight(
  rows: ViewportRow[],
  lastUserMessageId: string,
  measuredHeights: Map<string, number>
): number {
  const start = rows.findIndex((row) => row.key === lastUserMessageId)
  if (start < 0) return VIEWPORT.estimatedRowHeight
  let height = 0
  for (let i = start; i < rows.length; i += 1) {
    height += measuredHeights.get(rows[i].key) ?? VIEWPORT.estimatedRowHeight
  }
  return height
}

export function isPhysicallyAtBottom(scroller: HTMLElement, streaming: boolean): boolean {
  const threshold = streaming ? VIEWPORT.streamBottomThreshold : VIEWPORT.bottomThreshold
  return getDistanceToBottom(scroller) <= threshold
}
