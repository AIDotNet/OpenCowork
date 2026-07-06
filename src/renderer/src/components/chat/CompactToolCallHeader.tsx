import * as React from 'react'
import { Check, ChevronDown, ChevronRight, Loader2, X } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import type { ToolCallStatus } from '@renderer/lib/agent/types'

export type CompactBadgeTone = 'default' | 'blue' | 'amber' | 'green' | 'red'

export interface CompactToolHeaderBadge {
  label: string
  tone?: CompactBadgeTone
}

export interface CompactToolHeaderModel {
  icon: React.ReactNode
  primary: string
  secondary?: string
  badges: CompactToolHeaderBadge[]
  statusBadge?: React.ReactNode
  title: string
  toolLabel?: string
  namespace?: string
}

interface CompactToolCallHeaderProps {
  model: CompactToolHeaderModel
  status: ToolCallStatus | 'completed'
  statusLabel: string | null
  hasError: boolean
  errorTitle?: string | null
  elapsed: string | null
  open: boolean
}

function compactBadgeClassName(tone: CompactBadgeTone = 'default'): string {
  switch (tone) {
    case 'blue':
      return 'border-sky-500/20 bg-sky-500/[0.08] text-sky-700 dark:text-sky-300'
    case 'amber':
      return 'border-amber-500/20 bg-amber-500/[0.08] text-amber-700 dark:text-amber-300'
    case 'green':
      return 'border-emerald-500/20 bg-emerald-500/[0.08] text-emerald-700 dark:text-emerald-300'
    case 'red':
      return 'border-destructive/25 bg-destructive/[0.08] text-destructive'
    default:
      return 'border-border/55 bg-background/70 text-muted-foreground dark:bg-white/[0.035]'
  }
}

function compactStatusBadgeClassName(status: ToolCallStatus | 'completed'): string {
  if (status === 'error') return compactBadgeClassName('red')
  if (status === 'canceled') return compactBadgeClassName('default')
  if (status === 'pending_approval') return compactBadgeClassName('amber')
  if (status === 'running') return compactBadgeClassName('blue')
  if (status === 'streaming') return compactBadgeClassName('default')
  return compactBadgeClassName('green')
}

function compactHeaderStateClassName(status: ToolCallStatus | 'completed', open: boolean): string {
  if (status === 'error') {
    return cn('text-destructive/85 hover:bg-destructive/[0.035]', open && 'bg-destructive/[0.025]')
  }
  if (status === 'running') {
    return cn('text-sky-600 dark:text-sky-300', open && 'bg-sky-500/[0.025]')
  }
  if (status === 'streaming') {
    return cn('text-violet-600 dark:text-violet-300', open && 'bg-violet-500/[0.025]')
  }
  if (status === 'pending_approval') {
    return cn('text-amber-600 dark:text-amber-300', open && 'bg-amber-500/[0.035]')
  }
  return cn('text-muted-foreground', open && 'bg-muted/25 dark:bg-white/[0.025]')
}

function compactIconShellClassName(status: ToolCallStatus | 'completed'): string {
  if (status === 'error') return 'border-destructive/25 bg-transparent text-destructive'
  if (status === 'canceled') {
    return 'border-muted-foreground/25 bg-transparent text-muted-foreground'
  }
  if (status === 'running') return 'border-sky-500/25 bg-transparent text-sky-600 dark:text-sky-300'
  if (status === 'streaming') {
    return 'border-violet-500/25 bg-transparent text-violet-600 dark:text-violet-300'
  }
  if (status === 'pending_approval') {
    return 'border-amber-500/30 bg-transparent text-amber-600 dark:text-amber-300'
  }
  return 'border-lime-500/25 bg-transparent text-lime-600 dark:text-lime-400'
}

function CompactLifecycleGlyph({
  status
}: {
  status: ToolCallStatus | 'completed'
}): React.JSX.Element | null {
  if (status === 'running' || status === 'streaming' || status === 'pending_approval') {
    return <Loader2 className="size-3 animate-spin" />
  }
  if (status === 'error') return <X className="size-3" />
  if (status === 'canceled') return <X className="size-3" />
  if (status === 'completed') return <Check className="size-3" />
  return null
}

export function CompactToolCallHeader({
  model,
  status,
  statusLabel,
  hasError,
  errorTitle,
  elapsed,
  open
}: CompactToolCallHeaderProps): React.JSX.Element {
  const hasLifecycleGlyph =
    status === 'running' ||
    status === 'streaming' ||
    status === 'pending_approval' ||
    status === 'error' ||
    status === 'canceled' ||
    status === 'completed'
  const lifecycleGlyph = hasLifecycleGlyph ? <CompactLifecycleGlyph status={status} /> : null
  const toolLabel = model.toolLabel ?? model.primary
  const primaryDetail = model.toolLabel && model.primary !== model.toolLabel ? model.primary : ''
  const detailText = [primaryDetail, model.secondary].filter(Boolean).join(' · ')
  const shouldPulseToolName = status === 'running' || status === 'streaming'

  return (
    <div
      className={cn(
        'flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] transition-colors duration-200 hover:bg-muted/35 hover:text-foreground dark:hover:bg-white/[0.035]',
        compactHeaderStateClassName(status, open),
        'group-hover:text-foreground'
      )}
      title={model.title}
    >
      <span
        className={cn(
          'relative flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors',
          compactIconShellClassName(status)
        )}
        aria-hidden="true"
      >
        {lifecycleGlyph ?? (
          <span className="flex size-3 items-center justify-center">{model.icon}</span>
        )}
      </span>
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        {model.namespace ? (
          <>
            <span className="shrink-0 text-[12px] text-muted-foreground/55">{model.namespace}</span>
            <span className="shrink-0 text-muted-foreground/40">&gt;</span>
          </>
        ) : null}
        <span
          className={cn(
            'shrink-0 font-mono text-[12px] font-medium',
            shouldPulseToolName
              ? [
                  'tool-name-live-pulse',
                  status === 'running'
                    ? 'tool-name-live-pulse--running'
                    : 'tool-name-live-pulse--streaming'
                ]
              : 'text-foreground/82'
          )}
        >
          {toolLabel}
        </span>
        {detailText ? (
          <span className="min-w-0 truncate text-[12px] text-muted-foreground/55">
            ({detailText})
          </span>
        ) : null}
      </span>
      {statusLabel ? (
        <span
          className={cn(
            'hidden shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-medium sm:inline-flex',
            compactStatusBadgeClassName(status)
          )}
        >
          {statusLabel}
        </span>
      ) : null}
      {model.statusBadge}
      {model.badges.slice(0, 2).map((badge) => (
        <span
          key={badge.label}
          className={cn(
            'hidden shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-medium md:inline-flex',
            compactBadgeClassName(badge.tone)
          )}
        >
          {badge.label}
        </span>
      ))}
      {hasError ? (
        <span
          className="size-1.5 shrink-0 rounded-full bg-red-500 dark:bg-red-400"
          title={errorTitle ?? undefined}
        />
      ) : null}
      {elapsed ? (
        <span className="shrink-0 text-[9px] tabular-nums text-muted-foreground/60">{elapsed}</span>
      ) : null}
      {open ? (
        <ChevronDown className="size-3 shrink-0 text-muted-foreground/60" />
      ) : (
        <ChevronRight className="size-3 shrink-0 text-muted-foreground/60" />
      )}
    </div>
  )
}
