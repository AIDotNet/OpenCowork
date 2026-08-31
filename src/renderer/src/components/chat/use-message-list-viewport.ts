import * as React from 'react'
import { useChatStore } from '@renderer/stores/chat-store'
import { EXECUTION_RESIZE_EVENT } from './CollapsibleHeightPanel'
import {
  VIEWPORT,
  type HistoryScrollAnchor,
  type MessageWindowPhase,
  type OlderLoadIntent,
  type ViewportMode,
  type ViewportRow,
  estimateTurnHeight,
  findNestedVerticalScroller,
  getDistanceToBottom,
  isPhysicallyAtBottom,
  measureRenderedTurnHeight,
  readVisibleMessageAnchor,
  resolveTurnSpacer,
  shouldFinishPositioning,
  waitAnimationFrames
} from './message-list-viewport'

export interface ViewportVirtualizer {
  options: {
    count: number
    getItemKey?: (index: number) => unknown
  }
  getTotalSize: () => number
  measureElement: (node: Element | null) => void
  scrollToIndex: (index: number, options?: { align?: 'start' | 'center' | 'end' }) => void
}

interface UseMessageListViewportArgs {
  sessionId: string | null
  messagesLength: number
  storeMessagesLength: number
  sessionLoaded: boolean
  sessionMessageCount: number
  loadedRangeStart: number
  hasOlder: boolean
  hasNewer: boolean
  rows: ViewportRow[]
  lastUserMessageId: string | null
  messageLookupHas: (id: string) => boolean
  streamingMessageId: string | null
  isSessionOutputting: boolean
  canStreamFollow: boolean
  pendingAskUserQuestion: boolean
  measuredHeightsRef: React.MutableRefObject<Map<string, number>>
  virtualizerRef: React.RefObject<ViewportVirtualizer | null>
  virtualListTotalSize: number
  onScrollProjection?: () => void
}

export function useMessageListViewport({
  sessionId,
  messagesLength,
  storeMessagesLength,
  sessionLoaded,
  sessionMessageCount,
  loadedRangeStart,
  hasOlder,
  hasNewer,
  rows,
  lastUserMessageId,
  messageLookupHas,
  streamingMessageId,
  isSessionOutputting,
  canStreamFollow,
  pendingAskUserQuestion,
  measuredHeightsRef,
  virtualizerRef,
  virtualListTotalSize,
  onScrollProjection
}: UseMessageListViewportArgs) {
  const listRef = React.useRef<HTMLDivElement | null>(null)
  const contentRef = React.useRef<HTMLDivElement | null>(null)
  const topSentinelRef = React.useRef<HTMLDivElement | null>(null)
  const renderedSessionIdRef = React.useRef<string | null>(sessionId)
  const pendingInitialSessionRef = React.useRef<string | null>(sessionId)
  if (renderedSessionIdRef.current !== sessionId) {
    renderedSessionIdRef.current = sessionId
    pendingInitialSessionRef.current = sessionId
  }

  const modeRef = React.useRef<ViewportMode>(sessionId ? 'positioning' : 'browsing')
  const restoringRef = React.useRef(false)
  const lastScrollTopRef = React.useRef(0)
  const programmaticUntilRef = React.useRef(0)
  const userIntentUntilRef = React.useRef(0)
  const olderCooldownUntilRef = React.useRef(0)
  const stalledOlderStartRef = React.useRef<number | null>(null)
  const loadedRangeStartRef = React.useRef(loadedRangeStart)
  loadedRangeStartRef.current = loadedRangeStart
  const lastPinnedUserMessageIdRef = React.useRef<string | null | undefined>(undefined)
  const wasOutputtingRef = React.useRef(isSessionOutputting)
  const isLoadingOlderRef = React.useRef(false)
  const loadOlderRef = React.useRef<(intent?: OlderLoadIntent) => Promise<number>>(async () => 0)
  const scheduledPinRef = React.useRef<number | null>(null)
  const initialStableFramesRef = React.useRef(0)
  const initialLastHeightRef = React.useRef<number | null>(null)
  const initialFrameCountRef = React.useRef(0)
  const initialStartedAtRef = React.useRef<number | null>(null)
  const fillPagesRef = React.useRef(0)

  const [phase, setPhase] = React.useState<MessageWindowPhase>(sessionId ? 'loading' : 'ready')
  const [isFollowing, setIsFollowing] = React.useState(true)
  const [turnSpacerHeight, setTurnSpacerHeight] = React.useState(0)
  const [isLoadingOlder, setIsLoadingOlder] = React.useState(false)
  const [isLoadingNewer, setIsLoadingNewer] = React.useState(false)

  const hasLoadOlderRow = phase === 'ready' && hasOlder && loadedRangeStart > 0
  const isAwaitingInitialMessages =
    Boolean(sessionId) &&
    storeMessagesLength === 0 &&
    (phase === 'loading' || !sessionLoaded || sessionMessageCount > 0 || loadedRangeStart > 0)
  const isInitialLoading = Boolean(sessionId) && (phase === 'loading' || phase === 'positioning')

  const markProgrammatic = React.useCallback(() => {
    programmaticUntilRef.current = window.performance.now() + VIEWPORT.programmaticGuardMs
  }, [])

  const markUserIntent = React.useCallback(() => {
    userIntentUntilRef.current = window.performance.now() + VIEWPORT.userIntentMs
  }, [])

  const setMode = React.useCallback((next: ViewportMode) => {
    modeRef.current = next
    setIsFollowing(next !== 'browsing')
  }, [])

  const canPinBottom = React.useCallback(() => {
    if (restoringRef.current) return false
    const mode = modeRef.current
    if (mode === 'positioning') return true
    if (mode !== 'following') return false
    if (isSessionOutputting) return canStreamFollow
    return true
  }, [canStreamFollow, isSessionOutputting])

  const pinBottom = React.useCallback(
    (behavior: ScrollBehavior = 'auto') => {
      const scroller = listRef.current
      if (!scroller || rows.length === 0) return
      const top = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
      const minDelta =
        modeRef.current === 'positioning' ? VIEWPORT.scrollEpsilon : VIEWPORT.autoScrollMinDelta
      if (Math.abs(scroller.scrollTop - top) <= minDelta) return
      markProgrammatic()
      if (behavior === 'auto') {
        scroller.scrollTop = top
        lastScrollTopRef.current = scroller.scrollTop
        return
      }
      scroller.scrollTo({ top, behavior })
    },
    [markProgrammatic, rows.length]
  )

  const requestPinBottom = React.useCallback(
    ({ force = false, maxFrames = 1 }: { force?: boolean; maxFrames?: number } = {}) => {
      if (scheduledPinRef.current !== null) {
        window.cancelAnimationFrame(scheduledPinRef.current)
      }
      let framesLeft = Math.max(1, maxFrames)
      const run = (): void => {
        scheduledPinRef.current = null
        if (!listRef.current) return
        if (!force && !canPinBottom()) return
        const scroller = listRef.current
        if (force || getDistanceToBottom(scroller) > VIEWPORT.autoScrollMinDelta) {
          pinBottom()
        }
        framesLeft -= 1
        if (framesLeft > 0) {
          scheduledPinRef.current = window.requestAnimationFrame(run)
          return
        }
        onScrollProjection?.()
      }
      scheduledPinRef.current = window.requestAnimationFrame(run)
    },
    [canPinBottom, onScrollProjection, pinBottom]
  )

  const syncTurnSpacer = React.useCallback(() => {
    if (modeRef.current === 'browsing' && !restoringRef.current && phase === 'ready') return
    const scroller = listRef.current
    if (!scroller || !lastUserMessageId || rows.length === 0) {
      setTurnSpacerHeight((prev) => (prev === 0 ? prev : 0))
      return
    }
    const rendered = measureRenderedTurnHeight(scroller, lastUserMessageId)
    const estimated = estimateTurnHeight(rows, lastUserMessageId, measuredHeightsRef.current)
    setTurnSpacerHeight((prev) =>
      resolveTurnSpacer({
        clientHeight: scroller.clientHeight,
        measuredTurnHeight: rendered,
        estimatedTurnHeight: estimated,
        previousSpacer: prev
      })
    )
  }, [lastUserMessageId, measuredHeightsRef, phase, rows])

  const shouldAdjustScrollOnItemSizeChange = React.useCallback(
    (item: { end: number }, _delta: number, instance: { scrollOffset: number | null }): boolean => {
      if (restoringRef.current) return false
      if (canPinBottom()) return false
      const scrollOffset = instance.scrollOffset ?? 0
      return item.end < scrollOffset
    },
    [canPinBottom]
  )

  const readNow = (): number => window.performance.now()

  const canStartOlderLoad = React.useCallback(
    (intent: OlderLoadIntent, source: 'explicit' | 'auto'): boolean => {
      if (!sessionId || isLoadingOlderRef.current) return false
      if (!hasOlder || loadedRangeStart <= 0) return false
      if (restoringRef.current) return false
      if (readNow() < olderCooldownUntilRef.current) return false
      if (stalledOlderStartRef.current === loadedRangeStart) return false
      if (intent === 'visibility') {
        return phase === 'ready' || phase === 'positioning'
      }
      if (phase !== 'ready') return false
      if (intent === 'fill') {
        return modeRef.current === 'following' && fillPagesRef.current < VIEWPORT.maxFillPages
      }
      if (source === 'explicit') return true
      if (modeRef.current !== 'browsing') return false
      if (readNow() < programmaticUntilRef.current) return false
      return true
    },
    [hasOlder, loadedRangeStart, phase, sessionId]
  )

  const restoreAnchor = React.useCallback(
    async (scroller: HTMLDivElement, anchor: HistoryScrollAnchor): Promise<void> => {
      const apply = (): boolean => {
        const element = scroller.querySelector<HTMLElement>(
          `[data-message-id="${CSS.escape(anchor.messageId)}"]`
        )
        if (!element) return false
        const delta =
          element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.offset
        if (Math.abs(delta) <= VIEWPORT.scrollEpsilon) return true
        markProgrammatic()
        scroller.scrollTop = Math.max(0, scroller.scrollTop + delta)
        lastScrollTopRef.current = scroller.scrollTop
        return false
      }

      if (apply()) return

      const virtualizer = virtualizerRef.current
      const getItemKey = virtualizer?.options.getItemKey
      const count = virtualizer?.options.count ?? 0
      let virtualIndex = -1
      if (getItemKey) {
        for (let index = 0; index < count; index += 1) {
          if (String(getItemKey(index)) === anchor.messageId) {
            virtualIndex = index
            break
          }
        }
      }
      if (virtualIndex >= 0 && virtualizer) {
        markProgrammatic()
        virtualizer.scrollToIndex(virtualIndex, { align: 'start' })
        await waitAnimationFrames(2)
      }
      for (let attempt = 0; attempt < VIEWPORT.historyCorrectFrames; attempt += 1) {
        if (apply()) return
        await waitAnimationFrames(1)
      }
    },
    [markProgrammatic, virtualizerRef]
  )

  const loadOlderMessages = React.useCallback(
    async (intent: OlderLoadIntent = 'history'): Promise<number> => {
      if (!canStartOlderLoad(intent, intent === 'history' ? 'explicit' : 'auto') || !sessionId) {
        return 0
      }

      const scroller = listRef.current
      const previousHeight = scroller?.scrollHeight ?? 0
      const previousTop = scroller?.scrollTop ?? 0
      const viewingHistory = intent === 'history'
      const fillingVisibility = intent === 'visibility'
      const keepFollowing =
        !viewingHistory && (modeRef.current === 'following' || modeRef.current === 'positioning')
      const anchor =
        scroller && !keepFollowing && !fillingVisibility ? readVisibleMessageAnchor(scroller) : null
      const startBefore = loadedRangeStart
      const sessionAtLoad = sessionId

      isLoadingOlderRef.current = true
      if (intent === 'fill') fillPagesRef.current += 1
      if (viewingHistory) {
        setMode('browsing')
        restoringRef.current = true
      }
      setIsLoadingOlder(true)
      try {
        const loaded = await useChatStore
          .getState()
          .loadOlderSessionMessages(sessionId, undefined, {
            preserve: viewingHistory || fillingVisibility || !keepFollowing ? 'head' : 'tail'
          })
        const startAfter =
          useChatStore.getState().sessions.find((session) => session.id === sessionId)
            ?.loadedRangeStart ?? startBefore
        if (renderedSessionIdRef.current !== sessionAtLoad) return loaded > 0 ? loaded : 0
        if (loaded <= 0 || startAfter >= startBefore) {
          stalledOlderStartRef.current = startBefore
          return loaded > 0 ? loaded : 0
        }
        stalledOlderStartRef.current = null
        if (viewingHistory) {
          olderCooldownUntilRef.current = readNow() + VIEWPORT.olderLoadCooldownMs
        }

        await waitAnimationFrames(2)
        const next = listRef.current
        if (!next) return loaded
        if (keepFollowing) {
          markProgrammatic()
          next.scrollTop = Math.max(0, next.scrollHeight - next.clientHeight)
          lastScrollTopRef.current = next.scrollTop
        } else if (anchor) {
          await restoreAnchor(next, anchor)
        } else {
          const delta = next.scrollHeight - previousHeight
          if (delta !== 0) {
            markProgrammatic()
            next.scrollTop = Math.max(0, previousTop + delta)
            lastScrollTopRef.current = next.scrollTop
          }
        }
        onScrollProjection?.()
        return loaded
      } finally {
        restoringRef.current = false
        isLoadingOlderRef.current = false
        setIsLoadingOlder(false)
      }
    },
    [
      canStartOlderLoad,
      loadedRangeStart,
      markProgrammatic,
      onScrollProjection,
      restoreAnchor,
      sessionId,
      setMode
    ]
  )
  loadOlderRef.current = loadOlderMessages

  const loadNewerMessages = React.useCallback(async (): Promise<number> => {
    if (!sessionId || phase !== 'ready' || isLoadingNewer || !hasNewer) return 0
    const followAfter = modeRef.current === 'following'
    setIsLoadingNewer(true)
    try {
      const loaded = await useChatStore.getState().loadNewerSessionMessages(sessionId)
      if (loaded > 0) {
        await waitAnimationFrames(2)
        if (followAfter && listRef.current) {
          markProgrammatic()
          listRef.current.scrollTop = Math.max(
            0,
            listRef.current.scrollHeight - listRef.current.clientHeight
          )
          lastScrollTopRef.current = listRef.current.scrollTop
        }
        onScrollProjection?.()
      }
      return loaded
    } finally {
      setIsLoadingNewer(false)
    }
  }, [hasNewer, isLoadingNewer, markProgrammatic, onScrollProjection, phase, sessionId])

  const scrollToBottom = React.useCallback(() => {
    userIntentUntilRef.current = 0
    setMode('following')
    const pin = (): void => {
      requestPinBottom({ force: true, maxFrames: VIEWPORT.followPinFrames })
    }
    if (hasNewer && sessionId) {
      void useChatStore.getState().ensureSessionWindow(sessionId, true).finally(pin)
      return
    }
    pin()
  }, [hasNewer, requestPinBottom, sessionId, setMode])

  const retryInitialLoad = React.useCallback(() => {
    if (!sessionId) return
    setPhase('loading')
    void useChatStore
      .getState()
      .ensureSessionWindow(sessionId, true)
      .then((loaded) => {
        const current = useChatStore.getState().sessions.find((session) => session.id === sessionId)
        setPhase(loaded ? (current?.messages.length ? 'positioning' : 'ready') : 'error')
      })
      .catch(() => setPhase('error'))
  }, [sessionId])

  const handleListScroll = React.useCallback(() => {
    const scroller = listRef.current
    if (!scroller) return

    const previous = lastScrollTopRef.current
    const current = scroller.scrollTop
    const scrolledUp = current < previous - VIEWPORT.scrollEpsilon
    const scrolledDown = current > previous
    const programmatic = readNow() < programmaticUntilRef.current
    const userIntent = readNow() < userIntentUntilRef.current
    lastScrollTopRef.current = current

    if (scrolledUp && !programmatic && userIntent && modeRef.current !== 'positioning') {
      setMode('browsing')
    } else if (
      scrolledDown &&
      !programmatic &&
      modeRef.current === 'browsing' &&
      getDistanceToBottom(scroller) <= VIEWPORT.scrollEpsilon
    ) {
      setMode('following')
    }

    onScrollProjection?.()

    if (phase !== 'ready') return
    if (
      hasNewer &&
      !isLoadingNewer &&
      getDistanceToBottom(scroller) <= VIEWPORT.newerLoadScrollThreshold
    ) {
      void loadNewerMessages()
    }
    if (
      canStartOlderLoad('history', 'auto') &&
      scroller.scrollTop <= VIEWPORT.olderLoadScrollThreshold
    ) {
      void loadOlderMessages('history')
    }
  }, [
    canStartOlderLoad,
    hasNewer,
    isLoadingNewer,
    loadNewerMessages,
    loadOlderMessages,
    onScrollProjection,
    phase,
    setMode
  ])

  const bindUserScrollIntent = React.useCallback(
    (scroller: HTMLDivElement) => {
      const onWheel = (event: WheelEvent): void => {
        if (event.ctrlKey || event.deltaY === 0) return
        const target = event.target
        if (!(target instanceof Element) || !scroller.contains(target)) return
        const nested = findNestedVerticalScroller(target, scroller)
        if (!nested) {
          if (event.deltaY < 0) markUserIntent()
          return
        }
        if (event.defaultPrevented) return
        const overflowY = getComputedStyle(nested).overflowY
        if (overflowY === 'hidden') {
          event.preventDefault()
          if (event.deltaY < 0) markUserIntent()
          scroller.scrollTop += event.deltaY
          return
        }
        const atTop = nested.scrollTop <= 0
        const atBottom = nested.scrollTop + nested.clientHeight >= nested.scrollHeight - 1
        if ((event.deltaY < 0 && atTop) || (event.deltaY > 0 && atBottom)) {
          event.preventDefault()
          if (event.deltaY < 0) markUserIntent()
          scroller.scrollTop += event.deltaY
        }
      }

      const onPointerDown = (event: PointerEvent): void => {
        const scrollbarWidth = scroller.offsetWidth - scroller.clientWidth
        if (scrollbarWidth <= 0) return
        const rect = scroller.getBoundingClientRect()
        if (event.clientX < rect.right - scrollbarWidth - 2) return
        markUserIntent()
        const onMove = (): void => markUserIntent()
        const onUp = (): void => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
      }

      let lastTouchY: number | null = null
      const onTouchStart = (event: TouchEvent): void => {
        lastTouchY = event.touches[0]?.clientY ?? null
      }
      const onTouchMove = (event: TouchEvent): void => {
        const y = event.touches[0]?.clientY
        if (lastTouchY == null || y == null) return
        if (y - lastTouchY > 2) markUserIntent()
        lastTouchY = y
      }
      const onKeyDown = (event: KeyboardEvent): void => {
        if (event.key !== 'ArrowUp' && event.key !== 'PageUp' && event.key !== 'Home') return
        if (scroller.contains(document.activeElement) || document.activeElement === scroller) {
          markUserIntent()
        }
      }

      scroller.addEventListener('wheel', onWheel, { passive: false })
      scroller.addEventListener('pointerdown', onPointerDown)
      scroller.addEventListener('touchstart', onTouchStart, { passive: true })
      scroller.addEventListener('touchmove', onTouchMove, { passive: true })
      window.addEventListener('keydown', onKeyDown)
      return () => {
        scroller.removeEventListener('wheel', onWheel)
        scroller.removeEventListener('pointerdown', onPointerDown)
        scroller.removeEventListener('touchstart', onTouchStart)
        scroller.removeEventListener('touchmove', onTouchMove)
        window.removeEventListener('keydown', onKeyDown)
      }
    },
    [markUserIntent]
  )

  const handleRailWheel = React.useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      const scroller = listRef.current
      if (!scroller || event.deltaY === 0) return
      if (event.deltaY < 0) markUserIntent()
      const multiplier =
        event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroller.clientHeight : 1
      scroller.scrollTop += event.deltaY * multiplier
    },
    [markUserIntent]
  )

  const releaseFollow = React.useCallback(() => {
    markUserIntent()
    setMode('browsing')
  }, [markUserIntent, setMode])

  React.useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    setPhase('loading')
    void useChatStore
      .getState()
      .ensureSessionWindow(sessionId)
      .then((loaded) => {
        if (cancelled) return
        const current = useChatStore.getState().sessions.find((session) => session.id === sessionId)
        if (!loaded && current && current.messageCount > 0) {
          setPhase('error')
          return
        }
        setPhase(current?.messages.length ? 'positioning' : 'ready')
      })
      .catch((error) => {
        console.error('[MessageList] Failed to initialize message window:', error)
        if (!cancelled) setPhase('error')
      })
    return () => {
      cancelled = true
    }
  }, [sessionId])

  React.useEffect(() => {
    if (!sessionId || !streamingMessageId) return
    if (modeRef.current === 'browsing') return
    if (rows.some((row) => row.key === streamingMessageId)) return
    void useChatStore.getState().ensureSessionWindow(sessionId, true)
  }, [rows, sessionId, streamingMessageId])

  React.useLayoutEffect(() => {
    pendingInitialSessionRef.current = sessionId
    setPhase(sessionId ? 'loading' : 'ready')
    modeRef.current = sessionId ? 'positioning' : 'browsing'
    setIsFollowing(Boolean(sessionId))
    restoringRef.current = false
    lastScrollTopRef.current = 0
    programmaticUntilRef.current = 0
    userIntentUntilRef.current = 0
    olderCooldownUntilRef.current = 0
    stalledOlderStartRef.current = null
    isLoadingOlderRef.current = false
    setIsLoadingOlder(false)
    lastPinnedUserMessageIdRef.current = undefined
    setTurnSpacerHeight(0)
    initialStableFramesRef.current = 0
    initialLastHeightRef.current = null
    initialFrameCountRef.current = 0
    initialStartedAtRef.current = sessionId ? window.performance.now() : null
    fillPagesRef.current = 0
    measuredHeightsRef.current.clear()
  }, [measuredHeightsRef, sessionId])

  React.useLayoutEffect(() => {
    if (!sessionId || phase !== 'positioning') return
    if (pendingInitialSessionRef.current !== sessionId) return
    if (!(messagesLength > 0 || streamingMessageId)) return
    setMode('positioning')
    pinBottom()
  }, [messagesLength, phase, pinBottom, sessionId, setMode, streamingMessageId])

  React.useEffect(() => {
    const wasOutputting = wasOutputtingRef.current
    if (
      !wasOutputting &&
      isSessionOutputting &&
      modeRef.current === 'following' &&
      !pendingAskUserQuestion
    ) {
      setMode('following')
    }
    wasOutputtingRef.current = isSessionOutputting
  }, [isSessionOutputting, pendingAskUserQuestion, setMode])

  React.useLayoutEffect(() => {
    if (pendingAskUserQuestion) return
    if (!canPinBottom()) return
    pinBottom()
  }, [canPinBottom, pendingAskUserQuestion, pinBottom, rows.length])

  React.useLayoutEffect(() => {
    if (pendingAskUserQuestion) return
    if (!canPinBottom()) return
    pinBottom()
  }, [canPinBottom, pendingAskUserQuestion, pinBottom, virtualListTotalSize])

  React.useLayoutEffect(() => {
    syncTurnSpacer()
  }, [lastUserMessageId, phase, rows.length, syncTurnSpacer])

  React.useLayoutEffect(() => {
    if (phase !== 'ready') return
    if (lastPinnedUserMessageIdRef.current === undefined) {
      lastPinnedUserMessageIdRef.current = lastUserMessageId
      return
    }
    if (lastUserMessageId === lastPinnedUserMessageIdRef.current) return
    const previousId = lastPinnedUserMessageIdRef.current
    lastPinnedUserMessageIdRef.current = lastUserMessageId
    if (!lastUserMessageId) return
    if (modeRef.current === 'browsing' || restoringRef.current) return
    if (previousId && !messageLookupHas(previousId)) return
    setMode('following')
    syncTurnSpacer()
    pinBottom()
    requestPinBottom({ force: true, maxFrames: VIEWPORT.followSettleFrames })
  }, [
    lastUserMessageId,
    messageLookupHas,
    phase,
    pinBottom,
    requestPinBottom,
    setMode,
    syncTurnSpacer
  ])

  React.useLayoutEffect(() => {
    const scroller = listRef.current
    const content = contentRef.current
    if (!sessionId || !scroller || !content) return

    let cancelled = false
    let frame: number | null = null
    const settle = (): void => {
      if (cancelled) return
      if (phase !== 'positioning') {
        if (canPinBottom()) pinBottom()
        return
      }

      initialFrameCountRef.current += 1
      const height = content.scrollHeight
      if (initialLastHeightRef.current === height) {
        initialStableFramesRef.current += 1
      } else {
        initialLastHeightRef.current = height
        initialStableFramesRef.current = 0
      }

      const needsVisibleBackfill = rows.length === 0 && hasOlder && loadedRangeStart > 0
      if (
        needsVisibleBackfill &&
        !isLoadingOlderRef.current &&
        stalledOlderStartRef.current !== loadedRangeStart &&
        readNow() >= olderCooldownUntilRef.current
      ) {
        void loadOlderRef.current('visibility')
      }

      pinBottom()
      const atBottom = getDistanceToBottom(scroller) <= VIEWPORT.scrollEpsilon
      const stable = initialStableFramesRef.current >= VIEWPORT.windowStableFrames && atBottom
      const finished = shouldFinishPositioning({
        stable,
        frameCount: initialFrameCountRef.current,
        startedAt: initialStartedAtRef.current,
        now: readNow()
      })

      if (finished) {
        syncTurnSpacer()
        pinBottom()
        pendingInitialSessionRef.current = null
        setMode('following')
        setPhase('ready')
        initialStartedAtRef.current = null
        return
      }

      frame = window.requestAnimationFrame(settle)
    }

    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            if (phase === 'positioning') {
              initialStableFramesRef.current = 0
            } else {
              syncTurnSpacer()
              if (canPinBottom()) pinBottom()
            }
            onScrollProjection?.()
          })
    observer?.observe(scroller)
    observer?.observe(content)
    frame = window.requestAnimationFrame(settle)
    return () => {
      cancelled = true
      observer?.disconnect()
      if (frame !== null) window.cancelAnimationFrame(frame)
    }
  }, [
    canPinBottom,
    hasOlder,
    loadedRangeStart,
    onScrollProjection,
    phase,
    pinBottom,
    rows.length,
    sessionId,
    setMode,
    syncTurnSpacer
  ])

  React.useEffect(() => {
    const scroller = listRef.current
    if (!scroller) return
    return bindUserScrollIntent(scroller)
  }, [bindUserScrollIntent, phase, sessionId])

  React.useEffect(() => {
    const scroller = listRef.current
    if (!scroller) return
    const remasure = (): void => {
      for (const element of scroller.querySelectorAll<HTMLElement>('[data-index]')) {
        virtualizerRef.current?.measureElement(element)
      }
      if (canPinBottom()) requestPinBottom({ maxFrames: 4 })
    }
    scroller.addEventListener(EXECUTION_RESIZE_EVENT, remasure)
    return () => scroller.removeEventListener(EXECUTION_RESIZE_EVENT, remasure)
  }, [canPinBottom, requestPinBottom, virtualizerRef])

  React.useEffect(() => {
    if (!canStreamFollow || pendingAskUserQuestion) return
    const intervalId = window.setInterval(() => {
      if (!canPinBottom()) return
      requestPinBottom({ maxFrames: VIEWPORT.followSettleFrames })
    }, VIEWPORT.streamPollMs)
    return () => window.clearInterval(intervalId)
  }, [canPinBottom, canStreamFollow, pendingAskUserQuestion, requestPinBottom])

  React.useEffect(() => {
    const scroller = listRef.current
    const sentinel = topSentinelRef.current
    if (
      !scroller ||
      !sentinel ||
      !sessionId ||
      phase !== 'ready' ||
      !hasOlder ||
      loadedRangeStart <= 0 ||
      typeof IntersectionObserver === 'undefined'
    ) {
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        if (!canStartOlderLoad('history', 'auto')) return
        void loadOlderRef.current('history')
      },
      { root: scroller, rootMargin: '160px 0px 0px 0px', threshold: 0 }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [canStartOlderLoad, hasOlder, loadedRangeStart, phase, sessionId])

  React.useEffect(() => {
    if (!sessionId || isAwaitingInitialMessages || isLoadingOlder) return
    if (phase !== 'ready' && phase !== 'positioning') return
    if (readNow() < olderCooldownUntilRef.current) return
    if (loadedRangeStart <= 0) return
    if (stalledOlderStartRef.current === loadedRangeStart) return
    if (rows.length === 0 && hasOlder) {
      void loadOlderMessages('visibility')
      return
    }
    if (phase !== 'ready' || modeRef.current !== 'following') return
    const scroller = listRef.current
    if (!scroller || virtualListTotalSize <= 0) return
    const needsFill =
      virtualListTotalSize < scroller.clientHeight * VIEWPORT.initialViewportFillMultiplier
    if (!needsFill) return
    void loadOlderMessages('fill')
  }, [
    hasOlder,
    isAwaitingInitialMessages,
    isLoadingOlder,
    loadOlderMessages,
    loadedRangeStart,
    phase,
    rows.length,
    sessionId,
    virtualListTotalSize
  ])

  React.useEffect(() => {
    return () => {
      if (scheduledPinRef.current !== null) {
        window.cancelAnimationFrame(scheduledPinRef.current)
      }
    }
  }, [])

  return {
    listRef,
    contentRef,
    topSentinelRef,
    phase,
    isFollowing,
    isAtBottom: isFollowing,
    turnSpacerHeight,
    hasLoadOlderRow,
    isAwaitingInitialMessages,
    isInitialLoading,
    isLoadingOlder,
    isLoadingNewer,
    shouldAdjustScrollOnItemSizeChange,
    handleListScroll,
    handleRailWheel,
    releaseFollow,
    loadOlderMessages,
    loadNewerMessages,
    scrollToBottom,
    retryInitialLoad,
    requestPinBottom,
    markUserIntent,
    isPhysicallyAtBottom: () => {
      const scroller = listRef.current
      return scroller ? isPhysicallyAtBottom(scroller, isSessionOutputting) : true
    },
    pendingInitialSessionId: pendingInitialSessionRef
  }
}
