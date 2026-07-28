import * as React from 'react'
import { motion } from 'motion/react'

const PANEL_TRANSITION = { duration: 0.2, ease: 'easeInOut' as const }

interface CollapsibleHeightPanelProps {
  open: boolean
  children: React.ReactNode
  className?: string
  /** When false, content is always shown without animation (e.g. non-collapsible groups). */
  enabled?: boolean
  contentClassName?: string
}

/**
 * Height collapse/expand that matches ThinkingBlock:
 * measure pixel height first, tween number→0 / 0→number, unmount only after close finishes.
 * Avoids height:'auto' exit jank and AnimatePresence last-frame unmount jolt.
 */
export function CollapsibleHeightPanel({
  open,
  children,
  className,
  enabled = true,
  contentClassName
}: CollapsibleHeightPanelProps): React.JSX.Element | null {
  const [mounted, setMounted] = React.useState(open || !enabled)
  const [height, setHeight] = React.useState<number | 'auto'>(open || !enabled ? 'auto' : 0)
  const panelRef = React.useRef<HTMLDivElement>(null)
  const contentRef = React.useRef<HTMLDivElement>(null)
  const openRef = React.useRef(open)
  const heightRef = React.useRef<number | 'auto'>(height)
  const lastMeasuredHeightRef = React.useRef<number | null>(null)

  React.useEffect(() => {
    heightRef.current = height
  }, [height])

  React.useLayoutEffect(() => {
    if (!enabled) {
      setMounted(true)
      setHeight('auto')
      openRef.current = open
      return
    }

    const wasOpen = openRef.current
    openRef.current = open

    if (open && !wasOpen) {
      setMounted(true)
      setHeight(0)
      requestAnimationFrame(() => {
        const measured = contentRef.current?.scrollHeight ?? 0
        setHeight(measured > 0 ? measured : 'auto')
      })
      return
    }

    if (!open && wasOpen) {
      const measured = panelRef.current?.getBoundingClientRect().height ?? 0
      setHeight(measured)
      requestAnimationFrame(() => {
        setHeight(0)
      })
    }
  }, [enabled, open])

  // Content may resize while open (tool output arrives or a nested block expands).
  // Keep the animated wrapper in sync with the real content instead of relying on
  // React children identity (which can stay stable while a nested component changes).
  React.useLayoutEffect(() => {
    if (!enabled || !open || !mounted) return
    const measured = contentRef.current?.scrollHeight ?? 0
    if (measured <= 0) return
    if (lastMeasuredHeightRef.current === measured) return
    lastMeasuredHeightRef.current = measured
    setHeight((current) => (current === measured ? current : measured))
  }, [children, enabled, mounted, open])

  React.useLayoutEffect(() => {
    if (!enabled || !open || !mounted || typeof ResizeObserver === 'undefined') return

    let frame: number | null = null
    const syncToContent = (): void => {
      frame = null
      const measured = contentRef.current?.scrollHeight ?? 0
      if (measured <= 0 || !openRef.current) return
      if (lastMeasuredHeightRef.current === measured) return
      lastMeasuredHeightRef.current = measured
      setHeight((current) => (current === measured ? current : measured))
    }
    const observer = new ResizeObserver(() => {
      if (frame !== null) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(syncToContent)
    })
    if (contentRef.current) observer.observe(contentRef.current)
    syncToContent()

    return () => {
      observer.disconnect()
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [enabled, mounted, open])

  if (!enabled) {
    return (
      <div ref={contentRef} className={className}>
        {children}
      </div>
    )
  }

  if (!mounted) return null

  const visible = open || height === 'auto' || (typeof height === 'number' && height > 0)

  return (
    <motion.div
      ref={panelRef}
      initial={false}
      animate={{
        height,
        opacity: visible ? 1 : 0
      }}
      transition={PANEL_TRANSITION}
      className={className}
      onAnimationComplete={() => {
        if (!openRef.current && heightRef.current === 0) {
          setMounted(false)
          return
        }
        if (openRef.current && typeof heightRef.current === 'number' && heightRef.current > 0) {
          setHeight('auto')
        }
      }}
    >
      <div ref={contentRef} className={contentClassName}>
        {children}
      </div>
    </motion.div>
  )
}
