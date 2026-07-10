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
  const openRef = React.useRef(open)

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
        const measured = panelRef.current?.scrollHeight ?? 0
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

  // Content may resize while open (tool output arrives); keep a px lock when still on auto.
  React.useLayoutEffect(() => {
    if (!enabled || !open || !mounted) return
    if (height !== 'auto') return
    const measured = panelRef.current?.scrollHeight ?? 0
    if (measured > 0) setHeight(measured)
  }, [children, enabled, height, mounted, open])

  if (!enabled) {
    return <div className={className}>{children}</div>
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
        if (!open && height === 0) {
          setMounted(false)
          return
        }
        if (open && typeof height === 'number' && height > 0) {
          setHeight('auto')
        }
      }}
    >
      <div className={contentClassName}>{children}</div>
    </motion.div>
  )
}
