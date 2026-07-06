import { useCallback, useRef } from 'react'
import { cn } from '@renderer/lib/utils'
import type { ReasoningEffortLevel } from '@renderer/lib/api/types'

interface ReasoningEffortSliderProps {
  levels: ReasoningEffortLevel[]
  value: ReasoningEffortLevel
  onChange: (level: ReasoningEffortLevel) => void
  /** Dim the control (e.g. thinking is off) while keeping it interactive. */
  dimmed?: boolean
  fasterLabel: string
  smarterLabel: string
  /** Accessible name for the slider; falls back to the endpoint labels. */
  ariaLabel?: string
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n)

// Max-level comet trail: a gradient streak over the right half of the rail plus
// hand-placed particles that drift away from the thumb, fade out and respawn.
// Everything animates on transform/opacity only. `.dark` swaps in brighter tones.
const MAX_TRAIL_CSS = `
.reasoningEffortStreak {
  background: linear-gradient(90deg, rgba(147, 51, 234, 0) 0%, rgba(147, 51, 234, 0.26) 55%, rgba(192, 38, 211, 0.52) 100%);
}
.dark .reasoningEffortStreak {
  background: linear-gradient(90deg, rgba(168, 85, 247, 0) 0%, rgba(168, 85, 247, 0.32) 55%, rgba(217, 70, 239, 0.58) 100%);
}
.reasoningEffortParticle {
  position: absolute;
  border-radius: 9999px;
  opacity: 0;
  animation: reasoningEffortDrift var(--dur) ease-out var(--delay) infinite;
}
.reasoningEffortParticleViolet { background: rgba(139, 92, 246, 0.9); }
.reasoningEffortParticleFuchsia { background: rgba(192, 38, 211, 0.85); }
.reasoningEffortParticleBright { background: rgba(124, 58, 237, 0.85); }
.dark .reasoningEffortParticleViolet { background: rgba(216, 180, 254, 0.95); }
.dark .reasoningEffortParticleFuchsia { background: rgba(232, 121, 249, 0.9); }
.dark .reasoningEffortParticleBright { background: rgba(245, 235, 255, 0.92); }
@keyframes reasoningEffortDrift {
  0% { transform: translateX(0) scale(1); opacity: 0; }
  14% { opacity: var(--peak); }
  100% { transform: translateX(var(--dx)) scale(0.55); opacity: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .reasoningEffortParticle { animation: none; opacity: calc(var(--peak) * 0.6); }
}
`.trim()

type TrailTone = 'violet' | 'fuchsia' | 'bright'

interface TrailParticle {
  /** % from the left of the trail band; 100 = at the thumb. */
  x: number
  /** px from the top of the 18px particle band (rail center is 9). */
  y: number
  size: number
  /** Leftward drift distance in px over one cycle. */
  dx: number
  dur: number
  delay: number
  peak: number
  tone: TrailTone
}

// Hand-tuned constellation: dense sparks near the thumb thinning into strays at the tail.
const TRAIL_PARTICLES: TrailParticle[] = [
  { x: 98, y: 13, size: 2.5, dx: -12, dur: 1.3, delay: 0.7, peak: 0.95, tone: 'fuchsia' },
  { x: 97, y: 8, size: 3, dx: -14, dur: 1.4, delay: 0, peak: 0.95, tone: 'bright' },
  { x: 95, y: 3, size: 2, dx: -18, dur: 1.5, delay: 1.2, peak: 0.9, tone: 'violet' },
  { x: 94, y: 10, size: 2.5, dx: -16, dur: 1.6, delay: 0.5, peak: 0.9, tone: 'bright' },
  { x: 93, y: 15, size: 2, dx: -20, dur: 1.8, delay: 0.35, peak: 0.85, tone: 'fuchsia' },
  { x: 92, y: 6, size: 2.5, dx: -18, dur: 1.7, delay: 0.9, peak: 0.9, tone: 'violet' },
  { x: 91, y: 1, size: 2, dx: -14, dur: 1.5, delay: 1.45, peak: 0.85, tone: 'bright' },
  { x: 90, y: 12, size: 2, dx: -20, dur: 1.5, delay: 0.2, peak: 0.9, tone: 'fuchsia' },
  { x: 89, y: 8, size: 3, dx: -15, dur: 1.8, delay: 1.1, peak: 0.85, tone: 'violet' },
  { x: 88, y: 4, size: 2, dx: -22, dur: 1.4, delay: 0.6, peak: 0.85, tone: 'bright' },
  { x: 87, y: 14, size: 2.5, dx: -16, dur: 1.9, delay: 1.0, peak: 0.85, tone: 'violet' },
  { x: 86, y: 10, size: 2, dx: -20, dur: 1.6, delay: 1.35, peak: 0.85, tone: 'fuchsia' },
  { x: 84, y: 2, size: 2, dx: -18, dur: 1.7, delay: 0.15, peak: 0.85, tone: 'bright' },
  { x: 83, y: 7, size: 2.5, dx: -18, dur: 1.9, delay: 0.85, peak: 0.9, tone: 'violet' },
  { x: 82, y: 12, size: 2, dx: -16, dur: 1.5, delay: 1.55, peak: 0.8, tone: 'fuchsia' },
  { x: 80, y: 5, size: 2.5, dx: -24, dur: 2.0, delay: 0.45, peak: 0.85, tone: 'bright' },
  { x: 79, y: 15, size: 2, dx: -14, dur: 1.6, delay: 1.25, peak: 0.8, tone: 'violet' },
  { x: 78, y: 9, size: 2.5, dx: -16, dur: 1.8, delay: 0.05, peak: 0.85, tone: 'fuchsia' },
  { x: 74, y: 8, size: 2.5, dx: -20, dur: 1.7, delay: 0.1, peak: 0.8, tone: 'violet' },
  { x: 71, y: 13, size: 2, dx: -16, dur: 2.1, delay: 0.95, peak: 0.75, tone: 'bright' },
  { x: 68, y: 4, size: 2, dx: -22, dur: 1.8, delay: 0.45, peak: 0.75, tone: 'fuchsia' },
  { x: 64, y: 10, size: 2.2, dx: -18, dur: 2.2, delay: 1.25, peak: 0.7, tone: 'violet' },
  { x: 60, y: 2, size: 2, dx: -24, dur: 1.9, delay: 0.6, peak: 0.7, tone: 'bright' },
  { x: 57, y: 7, size: 1.8, dx: -16, dur: 2.0, delay: 1.5, peak: 0.65, tone: 'fuchsia' },
  { x: 54, y: 12, size: 2, dx: -20, dur: 2.3, delay: 0.3, peak: 0.65, tone: 'violet' },
  { x: 51, y: 5, size: 1.8, dx: -14, dur: 1.7, delay: 1.05, peak: 0.6, tone: 'bright' },
  { x: 46, y: 9, size: 1.8, dx: -18, dur: 2.1, delay: 0.75, peak: 0.55, tone: 'fuchsia' },
  { x: 42, y: 3, size: 1.6, dx: -22, dur: 2.4, delay: 0.15, peak: 0.55, tone: 'violet' },
  { x: 37, y: 13, size: 1.6, dx: -16, dur: 2.2, delay: 1.35, peak: 0.5, tone: 'bright' },
  { x: 32, y: 6, size: 1.6, dx: -20, dur: 2.5, delay: 0.55, peak: 0.45, tone: 'fuchsia' },
  { x: 26, y: 10, size: 1.5, dx: -14, dur: 2.3, delay: 1.0, peak: 0.4, tone: 'violet' },
  { x: 19, y: 4, size: 1.5, dx: -18, dur: 2.6, delay: 0.4, peak: 0.38, tone: 'fuchsia' },
  { x: 12, y: 8, size: 1.5, dx: -14, dur: 2.4, delay: 1.2, peak: 0.35, tone: 'violet' }
]

const TRAIL_TONE_CLASS: Record<TrailTone, string> = {
  violet: 'reasoningEffortParticleViolet',
  fuchsia: 'reasoningEffortParticleFuchsia',
  bright: 'reasoningEffortParticleBright'
}

export function ReasoningEffortSlider(props: ReasoningEffortSliderProps): React.JSX.Element {
  const { levels, value, onChange, dimmed = false, fasterLabel, smarterLabel, ariaLabel } = props

  const railRef = useRef<HTMLDivElement | null>(null)
  const draggingRef = useRef(false)

  const lastIndex = Math.max(0, levels.length - 1)
  const index = Math.max(0, levels.indexOf(value))
  const isMax = index === lastIndex && lastIndex > 0
  const active = isMax && !dimmed
  const pct = lastIndex > 0 ? (index / lastIndex) * 100 : 0

  const commit = useCallback(
    (next: number): void => {
      const clamped = next < 0 ? 0 : next > lastIndex ? lastIndex : next
      const level = levels[clamped]
      if (level && level !== value) onChange(level)
    },
    [lastIndex, levels, value, onChange]
  )

  const commitFromClientX = useCallback(
    (clientX: number): void => {
      const rail = railRef.current
      if (!rail) return
      const rect = rail.getBoundingClientRect()
      if (rect.width <= 0) return
      const ratio = clamp01((clientX - rect.left) / rect.width)
      commit(Math.round(ratio * lastIndex))
    },
    [commit, lastIndex]
  )

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    // preventDefault suppresses native focus, so restore it for keyboard follow-up.
    e.currentTarget.focus()
    draggingRef.current = true
    e.currentTarget.setPointerCapture(e.pointerId)
    commitFromClientX(e.clientX)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!draggingRef.current) return
    commitFromClientX(e.clientX)
  }

  const endDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    draggingRef.current = false
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowUp':
        e.preventDefault()
        commit(index + 1)
        break
      case 'ArrowLeft':
      case 'ArrowDown':
        e.preventDefault()
        commit(index - 1)
        break
      case 'Home':
        e.preventDefault()
        commit(0)
        break
      case 'End':
        e.preventDefault()
        commit(lastIndex)
        break
      default:
        break
    }
  }

  return (
    <div className={cn('flex w-full select-none flex-col gap-1.5', dimmed && 'opacity-60')}>
      {active ? <style>{MAX_TRAIL_CSS}</style> : null}

      <div className="flex items-center justify-between px-0.5 text-[10px] leading-none text-muted-foreground">
        <span>{fasterLabel}</span>
        <span>{smarterLabel}</span>
      </div>

      <div
        role="slider"
        tabIndex={0}
        aria-label={ariaLabel ?? `${fasterLabel} – ${smarterLabel}`}
        aria-valuemin={0}
        aria-valuemax={lastIndex}
        aria-valuenow={index}
        aria-valuetext={String(value).toUpperCase()}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
        className="relative flex h-6 cursor-pointer touch-none items-center outline-none focus-visible:rounded-full focus-visible:ring-2 focus-visible:ring-violet-500/50"
      >
        {/* Inner rail inset by half the thumb width so the thumb sits flush at both ends. */}
        <div
          ref={railRef}
          className="absolute inset-x-[6px] top-1/2 h-3 -translate-y-1/2 rounded-full bg-muted"
        >
          {/* Max level only: comet trail over the right half of the rail — a gradient
              streak into the thumb, with particles drifting off the tail. */}
          {active ? (
            <>
              <div
                aria-hidden
                className="reasoningEffortStreak absolute inset-y-0 left-1/2 right-0 rounded-r-full"
              />
              <div
                aria-hidden
                className="absolute left-1/2 right-0 top-1/2 z-[5] h-[18px] -translate-y-1/2"
              >
                {TRAIL_PARTICLES.map((p, i) => (
                  <span
                    key={i}
                    className={cn('reasoningEffortParticle', TRAIL_TONE_CLASS[p.tone])}
                    style={
                      {
                        left: `${p.x}%`,
                        top: p.y,
                        width: p.size,
                        height: p.size,
                        '--dx': `${p.dx}px`,
                        '--dur': `${p.dur}s`,
                        '--delay': `${p.delay}s`,
                        '--peak': p.peak
                      } as React.CSSProperties
                    }
                  />
                ))}
              </div>
            </>
          ) : null}

          {levels.map((lvl, i) => {
            const tickPct = lastIndex > 0 ? (i / lastIndex) * 100 : 0
            return (
              <span
                key={`${lvl}-${i}`}
                aria-hidden
                className={cn(
                  'absolute top-1/2 z-10 size-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full',
                  i <= index
                    ? 'bg-violet-400/70 dark:bg-violet-200/80'
                    : i === lastIndex
                      ? 'bg-violet-500'
                      : 'bg-muted-foreground/45'
                )}
                style={{ left: `${tickPct}%` }}
              />
            )
          })}

          {/* Light capsule thumb. */}
          <div
            aria-hidden
            className={cn(
              'absolute top-1/2 z-20 h-5 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-black/25 bg-zinc-300 shadow-md',
              'transition-[left,box-shadow] duration-150 ease-out motion-reduce:transition-none'
            )}
            style={{
              left: `${pct}%`,
              boxShadow: isMax
                ? '0 0 9px 2px rgba(216, 180, 254, 0.55), 0 1px 3px rgba(0, 0, 0, 0.45)'
                : undefined
            }}
          />
        </div>
      </div>

      {/* Clickable level labels aligned with the ticks (endpoints edge-aligned). */}
      <div className="relative mx-[6px] h-[11px] text-[9px] font-medium uppercase leading-none tracking-wide">
        {levels.map((lvl, i) => {
          const tickPct = lastIndex > 0 ? (i / lastIndex) * 100 : 0
          return (
            <button
              key={`${lvl}-${i}`}
              type="button"
              tabIndex={-1}
              aria-hidden
              onClick={() => commit(i)}
              className={cn(
                'absolute top-0 cursor-pointer transition-colors',
                i === lastIndex ? '-translate-x-full' : i !== 0 && '-translate-x-1/2',
                i === index
                  ? isMax
                    ? 'font-semibold text-fuchsia-500 dark:text-fuchsia-400'
                    : 'font-semibold text-violet-600 dark:text-violet-400'
                  : 'text-muted-foreground/60 hover:text-foreground/80'
              )}
              style={{ left: `${tickPct}%` }}
            >
              {lvl}
            </button>
          )
        })}
      </div>
    </div>
  )
}
