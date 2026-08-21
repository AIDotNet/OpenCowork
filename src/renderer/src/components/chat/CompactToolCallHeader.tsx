import * as React from 'react'
import { Check, ChevronDown, Loader2, X } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import type { ToolCallStatus } from '@renderer/lib/agent/types'

export type CompactBadgeTone = 'default' | 'blue' | 'amber' | 'green' | 'red' | 'violet'

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
      return 'border-sky-500/25 bg-sky-500/[0.08] text-sky-700 dark:text-sky-300'
    case 'amber':
      return 'border-amber-500/25 bg-amber-500/[0.08] text-amber-700 dark:text-amber-300'
    case 'green':
      return 'border-emerald-500/25 bg-emerald-500/[0.08] text-emerald-700 dark:text-emerald-300'
    case 'red':
      return 'border-rose-500/25 bg-rose-500/[0.08] text-rose-600 dark:text-rose-400'
    case 'violet':
      return 'border-violet-500/25 bg-violet-500/[0.08] text-violet-700 dark:text-violet-300'
    default:
      return 'border-border/50 bg-muted/40 text-muted-foreground dark:bg-white/[0.04]'
  }
}

function compactStatusBadgeClassName(status: ToolCallStatus | 'completed'): string {
  if (status === 'error') return compactBadgeClassName('red')
  if (status === 'canceled') return compactBadgeClassName('default')
  if (status === 'pending_approval') return compactBadgeClassName('amber')
  if (status === 'running') return compactBadgeClassName('blue')
  if (status === 'streaming') return compactBadgeClassName('violet')
  return compactBadgeClassName('green')
}

function compactHeaderStateClassName(
  status: ToolCallStatus | 'completed',
  open: boolean,
  isShellTool: boolean
): string {
  const showOpenBackground = open && !isShellTool
  if (status === 'error') {
    return cn(
      'text-destructive/90 hover:bg-destructive/[0.05]',
      showOpenBackground && 'bg-destructive/[0.04]'
    )
  }
  if (status === 'running') {
    return cn('text-sky-600 dark:text-sky-300', showOpenBackground && 'bg-sky-500/[0.04]')
  }
  if (status === 'streaming') {
    return isShellTool
      ? cn('text-sky-600 dark:text-sky-300', showOpenBackground && 'bg-sky-500/[0.04]')
      : cn('text-violet-600 dark:text-violet-300', showOpenBackground && 'bg-violet-500/[0.04]')
  }
  if (status === 'pending_approval') {
    return cn('text-amber-600 dark:text-amber-300', showOpenBackground && 'bg-amber-500/[0.05]')
  }
  return cn('text-muted-foreground', showOpenBackground && 'bg-muted/30 dark:bg-white/[0.03]')
}

function compactIconShellClassName(
  status: ToolCallStatus | 'completed',
  isShellTool: boolean
): string {
  if (status === 'error') {
    return 'border-rose-500/30 bg-rose-500/[0.08] text-rose-600 dark:text-rose-400'
  }
  if (status === 'canceled') {
    return 'border-muted-foreground/30 bg-muted/40 text-muted-foreground'
  }
  if (status === 'running') {
    return 'border-sky-500/35 bg-sky-500/[0.1] text-sky-600 dark:text-sky-300'
  }
  if (status === 'streaming') {
    return isShellTool
      ? 'border-sky-500/35 bg-sky-500/[0.1] text-sky-600 dark:text-sky-300'
      : 'border-violet-500/35 bg-violet-500/[0.1] text-violet-600 dark:text-violet-300'
  }
  if (status === 'pending_approval') {
    return 'border-amber-500/35 bg-amber-500/[0.1] text-amber-600 dark:text-amber-300'
  }
  return 'border-emerald-500/30 bg-emerald-500/[0.08] text-emerald-600 dark:text-emerald-400'
}

function CompactLifecycleGlyph({
  status
}: {
  status: ToolCallStatus | 'completed'
}): React.JSX.Element | null {
  if (status === 'running' || status === 'streaming' || status === 'pending_approval') {
    return <Loader2 className="size-3 animate-spin" />
  }
  if (status === 'error' || status === 'canceled') {
    return <X className="size-3 animate-in zoom-in-75 duration-200" />
  }
  if (status === 'completed') {
    return <Check className="size-3 animate-in zoom-in-75 duration-200" />
  }
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
  const isShellTool = model.namespace === 'shell'
  const lifecycleGlyph = hasLifecycleGlyph ? <CompactLifecycleGlyph status={status} /> : null
  const toolLabel = model.toolLabel ?? model.primary
  const primaryDetail = model.toolLabel && model.primary !== model.toolLabel ? model.primary : ''
  const detailText = [primaryDetail, model.secondary].filter(Boolean).join(' · ')
  const shouldPulseToolName = status === 'running' || status === 'streaming'
  const isActiveStatus = status === 'running' || status === 'streaming'

  return (
    <div
      className={cn(
        'flex min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-[12px] transition-all duration-150 hover:bg-muted/45 hover:text-foreground dark:hover:bg-white/[0.04]',
        compactHeaderStateClassName(status, open, isShellTool),
        'group-hover:text-foreground'
      )}
      title={model.title}
    >
      <span
        className={cn(
          'relative flex size-5 shrink-0 items-center justify-center rounded-md border shadow-xs transition-colors',
          compactIconShellClassName(status, isShellTool)
        )}
        aria-hidden="true"
      >
        {lifecycleGlyph ?? (
          <span className="flex size-3 items-center justify-center">{model.icon}</span>
        )}
      </span>
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        {model.namespace ? (
          <span className="shrink-0 rounded border border-border/50 bg-muted/50 px-1 py-0.2 font-mono text-[10px] text-muted-foreground/75">
            {model.namespace}
          </span>
        ) : null}
        <span
          className={cn(
            'shrink-0 font-mono text-[12px] font-medium tracking-tight',
            shouldPulseToolName
              ? [
                  'tool-name-live-pulse',
                  status === 'running'
                    ? `tool-name-live-pulse--${isShellTool ? 'shell' : 'running'}`
                    : `tool-name-live-pulse--${isShellTool ? 'shell' : 'streaming'}`
                ]
              : 'text-foreground/85'
          )}
        >
          {toolLabel}
        </span>
        {detailText ? (
          <span className="min-w-0 truncate font-mono text-[11.5px] text-muted-foreground/65">
            {detailText}
          </span>
        ) : null}
      </span>
      {statusLabel ? (
        <span
          className={cn(
            isActiveStatus
              ? 'hidden shrink-0 text-[10px] font-semibold sm:inline-flex'
              : 'hidden shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-medium sm:inline-flex',
            !isActiveStatus && compactStatusBadgeClassName(status),
            isActiveStatus && 'tool-name-live-pulse',
            status === 'running' && `tool-name-live-pulse--${isShellTool ? 'shell' : 'running'}`,
            status === 'streaming' && `tool-name-live-pulse--${isShellTool ? 'shell' : 'streaming'}`
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
            'hidden shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-medium md:inline-flex',
            compactBadgeClassName(badge.tone)
          )}
        >
          {badge.label}
        </span>
      ))}
      {hasError ? (
        <span
          className="size-1.5 shrink-0 rounded-full bg-rose-500 dark:bg-rose-400"
          title={errorTitle ?? undefined}
        />
      ) : null}
      {elapsed ? (
        <span className="shrink-0 rounded border border-border/40 bg-muted/30 px-1 py-0.2 font-mono text-[10px] tabular-nums text-muted-foreground/60 dark:bg-white/[0.03]">
          {elapsed}
        </span>
      ) : null}
      <ChevronDown
        className={cn(
          'size-3.5 shrink-0 text-muted-foreground/50 transition-transform duration-200 group-hover:text-foreground/75',
          !open && '-rotate-90'
        )}
      />
    </div>
  )
}
