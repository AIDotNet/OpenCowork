import { Fingerprint, Plus } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'

// Shared building blocks for the SSH support workspaces.

export function readStorage<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function writeStorage<T>(key: string, value: T): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(key, JSON.stringify(value))
}

export function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}
export function SectionCard({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="rounded-[24px] border border-border bg-card/88 p-4 shadow-[0_18px_40px_-28px_color-mix(in_srgb,var(--foreground)_18%,transparent)]">
      <div className="mb-3 text-[0.98rem] font-semibold text-foreground">{title}</div>
      <div className="space-y-3">{children}</div>
    </section>
  )
}

export function Field({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div>
      <div className="mb-1.5 text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  )
}

export function EmptyState({
  icon: Icon,
  title,
  body,
  actionLabel,
  onAction
}: {
  icon: typeof Fingerprint
  title: string
  body: string
  actionLabel?: string
  onAction?: () => void
}): React.JSX.Element {
  return (
    <div className="mt-5 flex min-h-[320px] flex-col items-center justify-center rounded-[28px] border border-dashed border-border bg-card/62 px-8 text-center">
      <div className="flex size-16 items-center justify-center rounded-[22px] bg-primary/12 text-primary shadow-[0_14px_30px_-20px_color-mix(in_srgb,var(--primary)_25%,transparent)]">
        <Icon className="size-7" />
      </div>
      <div className="mt-5 text-[1.1rem] font-semibold text-foreground">{title}</div>
      <div className="mt-2 max-w-sm text-[0.88rem] text-muted-foreground">{body}</div>
      {actionLabel && onAction ? (
        <Button
          size="sm"
          className="mt-6 h-11 rounded-2xl bg-primary px-5 text-[0.88rem] font-semibold text-primary-foreground hover:bg-primary/90"
          onClick={onAction}
        >
          <Plus className="size-4" />
          {actionLabel}
        </Button>
      ) : null}
    </div>
  )
}
