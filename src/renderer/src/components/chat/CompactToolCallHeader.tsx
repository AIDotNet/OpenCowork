import * as React from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
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
      return 'border-sky-500/20 bg-sky-500/10 text-sky-600 dark:text-sky-300'
    case 'amber':
      return 'border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-300'
    case 'green':
      return 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'
    case 'red':
      return 'border-destructive/25 bg-destructive/10 text-destructive'
    default:
      return 'border-border/60 bg-muted/45 text-muted-foreground'
  }
}

function compactStatusBadgeClassName(status: ToolCallStatus | 'completed'): string {
  if (status === 'error') return compactBadgeClassName('red')
  if (status === 'pending_approval') return compactBadgeClassName('amber')
  if (status === 'running') return compactBadgeClassName('blue')
  if (status === 'streaming') return compactBadgeClassName('default')
  return compactBadgeClassName('green')
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
  return (
    <div
      className="flex min-w-0 items-center gap-2 rounded-md px-1 py-1 text-muted-foreground transition-colors group-hover:text-foreground"
      title={model.title}
    >
      <span
        className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground/70"
        aria-hidden="true"
      >
        {model.icon}
      </span>
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className="min-w-0 truncate text-[12px] font-semibold text-foreground/85 transition-colors group-hover:text-foreground">
          {model.primary}
        </span>
        {model.secondary ? (
          <span className="hidden min-w-0 truncate text-[10px] text-muted-foreground/60 sm:inline">
            {model.secondary}
          </span>
        ) : null}
      </span>
      {statusLabel ? (
        <span
          className={cn(
            'shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-medium',
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
