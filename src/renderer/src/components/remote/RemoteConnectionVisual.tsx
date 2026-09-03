import { Monitor, Smartphone } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@renderer/lib/utils'
import type { RemoteControlPhase } from '../../../../shared/remote-control'

type VisualKind = 'idle' | 'live' | 'online' | 'error'

function visualKind(phase: RemoteControlPhase): VisualKind {
  if (phase === 'connecting' || phase === 'reconnecting') return 'live'
  if (phase === 'online') return 'online'
  if (phase === 'error') return 'error'
  return 'idle'
}

function toneClass(kind: VisualKind): string {
  switch (kind) {
    case 'live':
      return 'text-amber-500'
    case 'online':
      return 'text-emerald-500'
    case 'error':
      return 'text-destructive/80'
    default:
      return 'text-muted-foreground/55'
  }
}

function ConnectionBeam({ kind }: { kind: VisualKind }): React.JSX.Element {
  if (kind === 'error') {
    return (
      <div className="flex w-14 items-center gap-1" aria-hidden>
        <span className="h-px flex-1 bg-destructive/35" />
        <span className="text-[10px] leading-none text-destructive/70">×</span>
        <span className="h-px flex-1 bg-destructive/35" />
      </div>
    )
  }

  const moving = kind === 'live' || kind === 'online'
  return (
    <div className="relative h-4 w-14" aria-hidden>
      <span
        className={cn(
          'absolute top-1/2 h-px w-full -translate-y-1/2',
          kind === 'online' ? 'bg-emerald-500/45' : 'bg-border'
        )}
      />
      {moving &&
        [0, 1, 2].map((index) => (
          <span
            key={index}
            className={cn(
              'absolute top-1/2 size-1.5 -translate-y-1/2 rounded-full motion-reduce:hidden',
              kind === 'online'
                ? 'bg-emerald-400 animate-remote-dot'
                : 'bg-amber-400 animate-remote-dot'
            )}
            style={{ animationDelay: `${index * 0.45}s` }}
          />
        ))}
    </div>
  )
}

function Ripples({ kind }: { kind: VisualKind }): React.JSX.Element | null {
  if (kind !== 'live' && kind !== 'online') return null
  const ring = kind === 'online' ? 'border-emerald-400/30' : 'border-amber-400/35'
  return (
    <>
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute size-[4.5rem] rounded-full border animate-remote-ripple motion-reduce:hidden',
          ring
        )}
      />
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute size-[4.5rem] rounded-full border animate-remote-ripple motion-reduce:hidden',
          ring
        )}
        style={{ animationDelay: '0.7s' }}
      />
    </>
  )
}

export function QrOnlineFrame({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="relative">
      <span
        aria-hidden
        className="pointer-events-none absolute inset-[-10px] rounded-2xl border border-emerald-400/25 animate-remote-ripple motion-reduce:hidden"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-[-10px] rounded-2xl border border-emerald-400/15 animate-remote-ripple motion-reduce:hidden"
        style={{ animationDelay: '0.9s' }}
      />
      {children}
    </div>
  )
}

export function RemoteConnectionVisual({
  phase
}: {
  phase: RemoteControlPhase
}): React.JSX.Element {
  const { t } = useTranslation('layout')
  const kind = visualKind(phase)
  const tone = toneClass(kind)
  const label =
    kind === 'idle'
      ? t('remoteControl.qrUnavailable', {
          defaultValue: 'Enable remote control to show a QR code.'
        })
      : t(`remoteControl.status.${phase}`)

  return (
    <div
      className="relative flex size-[192px] flex-col items-center justify-center overflow-hidden rounded-lg border border-dashed border-border/70 bg-muted/20"
      aria-live="polite"
    >
      <Ripples kind={kind} />
      <div className={cn('relative z-10 flex items-center gap-2.5', tone)}>
        <Monitor className="size-6" />
        <ConnectionBeam kind={kind} />
        <Smartphone className="size-6" />
      </div>
      <p className="relative z-10 mt-3 max-w-[11rem] text-center text-[11px] leading-snug text-muted-foreground">
        {label}
      </p>
    </div>
  )
}
