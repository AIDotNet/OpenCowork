import * as React from 'react'
import { motion } from 'motion/react'
import { cn } from '@renderer/lib/utils'

const SCROLL_UP_MS = 360
const HEIGHT_MS = 280
const CLOSE_EASE = [0.4, 0, 0.2, 1] as const

export const EXECUTION_RESIZE_EVENT = 'opencowork:execution-resize'

export function notifyExecutionResize(node: EventTarget | null): void {
  if (!node || typeof EventTarget === 'undefined') return
  node.dispatchEvent(new CustomEvent(EXECUTION_RESIZE_EVENT, { bubbles: true }))
}

interface CollapsibleHeightPanelProps {
  open: boolean
  children: React.ReactNode
  className?: string
  /** When false, content is always shown without animation (e.g. non-collapsible groups). */
  enabled?: boolean
  contentClassName?: string
  /**
   * `scroll-up` keeps the previous box size, rolls content out the top, then
   * drops the empty space. `clip` shrinks the box itself.
   */
  collapseMotion?: 'clip' | 'scroll-up'
}

type ScrollPhase = 'open' | 'opening' | 'closing' | 'collapsing' | 'closed'

/**
 * Collapse / expand for Thought, Exploring, and tool details.
 * Scroll-up closes in place: lock height → content rolls up and fades → height goes to 0.
 */
export function CollapsibleHeightPanel({
  open,
  children,
  className,
  enabled = true,
  contentClassName,
  collapseMotion = 'clip'
}: CollapsibleHeightPanelProps): React.JSX.Element {
  const [canTween, setCanTween] = React.useState(false)

  React.useEffect(() => {
    setCanTween(true)
  }, [])

  if (!enabled) {
    return <div className={className}>{children}</div>
  }

  if (collapseMotion === 'scroll-up') {
    return (
      <ScrollUpPanel className={className} contentClassName={contentClassName} open={open}>
        {children}
      </ScrollUpPanel>
    )
  }

  return (
    <div
      className={cn('execution-collapse', !canTween && 'execution-collapse--boot', className)}
      data-open={open ? 'true' : 'false'}
    >
      <div className="execution-collapse-clip">
        <div className={contentClassName}>{children}</div>
      </div>
    </div>
  )
}

function ScrollUpPanel({
  open,
  children,
  className,
  contentClassName
}: {
  open: boolean
  children: React.ReactNode
  className?: string
  contentClassName?: string
}): React.JSX.Element {
  const panelRef = React.useRef<HTMLDivElement>(null)
  const contentRef = React.useRef<HTMLDivElement>(null)
  const openRef = React.useRef(open)
  const [phase, setPhase] = React.useState<ScrollPhase>(open ? 'open' : 'closed')
  const [lockPx, setLockPx] = React.useState<number | null>(null)

  const publishResize = React.useCallback(() => {
    notifyExecutionResize(panelRef.current)
  }, [])

  React.useLayoutEffect(() => {
    if (open === openRef.current) return
    const wasOpen = openRef.current
    openRef.current = open

    if (open && !wasOpen) {
      setPhase('opening')
      setLockPx(0)
      return
    }

    if (!open && wasOpen) {
      const measured = panelRef.current?.getBoundingClientRect().height ?? 0
      if (measured <= 0) {
        setLockPx(0)
        setPhase('closed')
        publishResize()
        return
      }
      setLockPx(measured)
      setPhase('closing')
    }
  }, [open, publishResize])

  React.useLayoutEffect(() => {
    if (phase !== 'opening') return
    const measured = contentRef.current?.scrollHeight ?? 0
    if (measured <= 0) {
      setLockPx(null)
      setPhase('open')
      publishResize()
      return
    }
    setLockPx(measured)
  }, [phase, publishResize])

  React.useEffect(() => {
    if (phase !== 'closing') return
    const timer = window.setTimeout(() => {
      setPhase('collapsing')
      setLockPx(0)
    }, SCROLL_UP_MS)
    return () => window.clearTimeout(timer)
  }, [phase])

  React.useEffect(() => {
    if (phase !== 'opening' && phase !== 'collapsing') return
    const timer = window.setTimeout(() => {
      if (phase === 'opening') {
        setLockPx(null)
        setPhase('open')
      } else {
        setPhase('closed')
      }
      publishResize()
    }, HEIGHT_MS)
    return () => window.clearTimeout(timer)
  }, [phase, publishResize])

  const handleTransitionEnd = (event: React.TransitionEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget) return
    if (
      phase === 'closing' &&
      (event.propertyName === 'transform' || event.propertyName === 'opacity')
    ) {
      setPhase('collapsing')
      setLockPx(0)
      return
    }
    if (event.propertyName !== 'height') return
    if (phase === 'opening') {
      setLockPx(null)
      setPhase('open')
      publishResize()
      return
    }
    if (phase === 'collapsing') {
      setPhase('closed')
      publishResize()
    }
  }

  const showChildren = phase !== 'closed' || open

  return (
    <div
      ref={panelRef}
      className={cn('execution-collapse', className)}
      data-motion="scroll-up"
      data-phase={phase}
      style={{
        height: phase === 'open' ? 'auto' : (lockPx ?? 0),
        overflow: phase === 'open' ? 'visible' : 'hidden'
      }}
      onTransitionEnd={handleTransitionEnd}
    >
      <div className="execution-collapse-clip">
        <div ref={contentRef} className={cn('execution-collapse-shift', contentClassName)}>
          {showChildren ? children : null}
        </div>
      </div>
    </div>
  )
}

/** Presence child that leaves by scrolling up in place, then unmounting. */
export function ScrollUpExitItem({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <motion.div
      className="overflow-hidden"
      initial={false}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: '-100%', opacity: 0 }}
      transition={{ duration: SCROLL_UP_MS / 1000, ease: CLOSE_EASE }}
    >
      {children}
    </motion.div>
  )
}
