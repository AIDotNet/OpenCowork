import * as React from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import type { ToolCallStatus } from '@renderer/lib/agent/types'

export type CompactBadgeTone = 'default' | 'blue' | 'amber' | 'green' | 'red' | 'violet'

export interface CompactToolHeaderBadge {
  label: string
  tone?: CompactBadgeTone
}

export interface CompactToolHeaderModel {
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

/** Metric text stays neutral; only outcomes the reader must notice keep a hue. */
function badgeToneClassName(tone: CompactBadgeTone = 'default'): string {
  switch (tone) {
    case 'amber':
      return 'text-amber-600/90 dark:text-amber-400/80'
    case 'green':
      return 'text-emerald-600/90 dark:text-emerald-400/80'
    case 'red':
      return 'text-rose-600 dark:text-rose-400'
    default:
      return 'text-muted-foreground/50'
  }
}

function statusToneClassName(status: ToolCallStatus | 'completed'): string {
  if (status === 'error') return 'text-destructive/85'
  if (status === 'pending_approval') return 'text-amber-600 dark:text-amber-400'
  return 'text-muted-foreground/55'
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
  const isShellTool = model.namespace === 'shell'
  const isActive = status === 'running' || status === 'streaming'
  const toolLabel = model.toolLabel ?? model.primary
  const primaryDetail = model.toolLabel && model.primary !== model.toolLabel ? model.primary : ''
  const detailText = [primaryDetail, model.secondary].filter(Boolean).join(' · ')

  return (
    <div
      className={cn(
        'flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-0 text-[12.5px] leading-snug transition-colors duration-150',
        status === 'error' ? 'text-destructive/85' : 'text-muted-foreground'
      )}
      title={hasError ? (errorTitle ?? model.title) : model.title}
    >
      <span
        className={cn(
          'shrink-0 font-medium tracking-tight',
          isActive
            ? cn(
                'tool-name-live-pulse',
                status === 'running'
                  ? `tool-name-live-pulse--${isShellTool ? 'shell' : 'running'}`
                  : `tool-name-live-pulse--${isShellTool ? 'shell' : 'streaming'}`
              )
            : status === 'error'
              ? 'text-destructive/85'
              : 'text-foreground/75'
        )}
      >
        {toolLabel}
      </span>
      {detailText ? (
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-muted-foreground/60',
            isShellTool && 'font-mono text-[11.5px]'
          )}
        >
          {detailText}
        </span>
      ) : (
        <span className="min-w-0 flex-1" />
      )}
      {statusLabel ? (
        <span
          className={cn(
            'shrink-0 text-[11px]',
            isActive
              ? cn(
                  'tool-name-live-pulse',
                  status === 'running'
                    ? `tool-name-live-pulse--${isShellTool ? 'shell' : 'running'}`
                    : `tool-name-live-pulse--${isShellTool ? 'shell' : 'streaming'}`
                )
              : statusToneClassName(status)
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
            'hidden shrink-0 text-[11px] tabular-nums md:inline',
            badgeToneClassName(badge.tone)
          )}
        >
          {badge.label}
        </span>
      ))}
      {elapsed ? (
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/40">
          {elapsed}
        </span>
      ) : null}
      <ChevronDown
        className={cn(
          'size-3 shrink-0 text-muted-foreground/35 transition-transform duration-200 group-hover:text-muted-foreground/70',
          !open && '-rotate-90'
        )}
      />
    </div>
  )
}
