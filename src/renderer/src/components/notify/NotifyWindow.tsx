import { useEffect, useRef, useState } from 'react'
import { Bell, X, CheckCircle2, AlertCircle, Info, XCircle, Pin } from 'lucide-react'
import { useNotifyStore, type NotifyItem, type NotifyType } from '@renderer/stores/notify-store'

// ── Single toast card ──────────────────────────────────────────────

function ToastCard({ item }: { item: NotifyItem }): React.JSX.Element {
  const dismiss = useNotifyStore((s) => s.dismiss)
  const [visible, setVisible] = useState(false)
  const [progress, setProgress] = useState(100)
  const closingRef = useRef(false)

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 30)
    return () => clearTimeout(t)
  }, [])

  useEffect(() => {
    if (item.persistent) return // Don't auto-dismiss persistent notifications
    const start = Date.now()
    const interval = setInterval(() => {
      const pct = Math.max(0, 100 - ((Date.now() - start) / item.duration) * 100)
      setProgress(pct)
      if (pct <= 0) clearInterval(interval)
    }, 16)
    const timer = setTimeout(() => handleClose(), item.duration)
    return () => { clearInterval(interval); clearTimeout(timer) }
  }, [])

  const handleClose = (): void => {
    if (closingRef.current) return
    closingRef.current = true
    setVisible(false)
    setTimeout(() => dismiss(item.id), 350)
  }

  const icons: Record<NotifyType, React.ReactNode> = {
    info: <Info className="size-4 text-blue-400" />,
    success: <CheckCircle2 className="size-4 text-emerald-400" />,
    warning: <AlertCircle className="size-4 text-amber-400" />,
    error: <XCircle className="size-4 text-red-400" />,
  }
  const borders: Record<NotifyType, string> = {
    info: 'border-blue-500/25',
    success: 'border-emerald-500/25',
    warning: 'border-amber-500/25',
    error: 'border-red-500/25',
  }
  const bars: Record<NotifyType, string> = {
    info: 'bg-blue-500',
    success: 'bg-emerald-500',
    warning: 'bg-amber-500',
    error: 'bg-red-500',
  }
  const glows: Record<NotifyType, string> = {
    info: 'shadow-blue-500/10',
    success: 'shadow-emerald-500/10',
    warning: 'shadow-amber-500/10',
    error: 'shadow-red-500/10',
  }

  return (
    <div
      style={{
        transition: 'opacity 0.3s ease, transform 0.3s ease',
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateX(0) scale(1)' : 'translateX(24px) scale(0.96)',
        willChange: 'transform, opacity',
      }}
    >
      <div
        className={[
          'relative w-[340px] overflow-hidden rounded-xl border shadow-xl',
          'bg-zinc-900/98',
          borders[item.type],
          glows[item.type],
        ].join(' ')}
      >
        {/* Top accent line */}
        <div className={`absolute top-0 left-0 right-0 h-[2px] ${bars[item.type]} opacity-70`} />

        <div className="flex items-start gap-3 px-4 pt-4 pb-3">
          <div className="mt-0.5 shrink-0 rounded-lg bg-white/5 p-1.5">
            {icons[item.type]}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2">
              <p className="text-[13px] font-semibold text-zinc-100 leading-snug">
                {item.title}
              </p>
              <button
                onClick={handleClose}
                className="shrink-0 mt-0.5 rounded p-0.5 text-zinc-600 hover:text-zinc-300 hover:bg-white/10 transition-colors"
              >
                <X className="size-3" />
              </button>
            </div>
            {item.body && (
              <p className="mt-1 text-[11px] text-zinc-400 leading-relaxed line-clamp-6 whitespace-pre-wrap">
                {item.body}
              </p>
            )}
          </div>
        </div>

        {/* Action buttons */}
        {item.actions && item.actions.length > 0 && (
          <div className="flex items-center gap-2 px-4 pb-2">
            {item.actions.map((action, i) => (
              <button
                key={i}
                onClick={() => { action.onClick(); handleClose() }}
                className="text-[10px] font-medium px-2 py-1 rounded-md bg-white/5 hover:bg-white/10 text-zinc-300 transition-colors"
              >
                {action.label}
              </button>
            ))}
          </div>
        )}

        <div className="flex items-center gap-1.5 px-4 pb-2.5">
          {item.persistent ? (
            <Pin className="size-2.5 text-zinc-600" />
          ) : (
            <Bell className="size-2.5 text-zinc-700" />
          )}
          <span className="text-[9px] text-zinc-700 font-medium tracking-widest uppercase">OpenCowork</span>
          {item.persistent && (
            <span className="text-[8px] text-zinc-600 ml-auto">click × to dismiss</span>
          )}
        </div>

        {/* Progress bar (hidden for persistent) */}
        {!item.persistent && (
          <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-white/5">
            <div
              className={`h-full ${bars[item.type]}`}
              style={{ width: `${progress}%`, transition: 'none' }}
            />
          </div>
        )}
      </div>
    </div>
  )
}

// ── Toast container (rendered in App) ─────────────────────────────

export function NotifyToastContainer(): React.JSX.Element {
  const items = useNotifyStore((s) => s.items)
  return (
    <div
      style={{
        position: 'fixed',
        bottom: 20,
        right: 20,
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column-reverse',
        gap: 10,
        pointerEvents: 'none',
      }}
    >
      {items.map((item) => (
        <div key={item.id} style={{ pointerEvents: 'auto' }}>
          <ToastCard item={item} />
        </div>
      ))}
    </div>
  )
}

// ── Legacy: kept for hash-based routing (unused now) ──────────────
export function NotifyWindow(): React.JSX.Element {
  return <NotifyToastContainer />
}
