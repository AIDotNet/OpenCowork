import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@renderer/lib/utils'

// Windowed rendering for long flat lists (fixed row height + overscan).
// Small lists render plainly so the common case stays simple; the window
// only kicks in past `threshold` rows, where full DOM rendering of remote
// directories (10k+ entries) becomes the bottleneck.
export function SshVirtualList<T>({
  items,
  rowHeight,
  rowKey,
  overscan = 10,
  threshold = 150,
  className,
  renderRow,
  footer
}: {
  items: T[]
  rowHeight: number
  rowKey: (item: T) => string
  overscan?: number
  threshold?: number
  className?: string
  renderRow: (item: T, index: number) => React.ReactNode
  footer?: React.ReactNode
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)

  useEffect(() => {
    const node = containerRef.current
    if (!node) return
    const observer = new ResizeObserver(() => {
      setViewportHeight(node.clientHeight)
    })
    observer.observe(node)
    setViewportHeight(node.clientHeight)
    return () => observer.disconnect()
  }, [])

  const handleScroll = useCallback(() => {
    const node = containerRef.current
    if (node) setScrollTop(node.scrollTop)
  }, [])

  if (items.length <= threshold) {
    return (
      <div className={className}>
        {items.map((item, index) => (
          <div key={rowKey(item)} style={{ height: rowHeight }}>
            {renderRow(item, index)}
          </div>
        ))}
        {footer}
      </div>
    )
  }

  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
  const end = Math.min(items.length, Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan)

  return (
    <div ref={containerRef} className={cn('overflow-y-auto', className)} onScroll={handleScroll}>
      <div style={{ height: items.length * rowHeight, position: 'relative' }}>
        <div style={{ transform: `translateY(${start * rowHeight}px)` }}>
          {items.slice(start, end).map((item, index) => (
            <div key={rowKey(item)} style={{ height: rowHeight }}>
              {renderRow(item, start + index)}
            </div>
          ))}
        </div>
      </div>
      {footer}
    </div>
  )
}
