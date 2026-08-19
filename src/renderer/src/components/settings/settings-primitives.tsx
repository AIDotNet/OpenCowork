import type { ReactNode } from 'react'
import { cn } from '@renderer/lib/utils'

export const SETTINGS_SECTION_DOM_ID_PREFIX = 'settings-section-'

export function settingsSectionDomId(sectionId: string): string {
  return `${SETTINGS_SECTION_DOM_ID_PREFIX}${sectionId}`
}

interface SettingsPanelProps {
  title: string
  description?: string
  /** Rendered on the right of the panel header, e.g. a refresh button. */
  actions?: ReactNode
  children: ReactNode
  className?: string
}

/**
 * Every settings panel shares this header/spacing contract so panels authored in
 * different files cannot drift apart visually.
 */
export function SettingsPanel({
  title,
  description,
  actions,
  children,
  className
}: SettingsPanelProps): React.JSX.Element {
  return (
    <div className={cn('space-y-5', className)}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
          {description ? (
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  )
}

interface SettingsSectionProps {
  /** Stable id used for search deep links and scroll anchoring. */
  id: string
  title?: string
  description?: string
  icon?: ReactNode
  actions?: ReactNode
  /** `plain` drops the card chrome for sections that render their own surface. */
  variant?: 'card' | 'plain'
  tone?: 'default' | 'danger'
  children: ReactNode
  className?: string
}

export function SettingsSection({
  id,
  title,
  description,
  icon,
  actions,
  variant = 'card',
  tone = 'default',
  children,
  className
}: SettingsSectionProps): React.JSX.Element {
  const hasHeader = Boolean(title || description || actions)

  return (
    <section
      id={settingsSectionDomId(id)}
      data-settings-section={id}
      className={cn(
        'scroll-mt-6',
        variant === 'card' && 'rounded-xl border p-4',
        variant === 'card' && tone === 'default' && 'border-border/60 bg-card/40',
        variant === 'card' && tone === 'danger' && 'border-destructive/35 bg-destructive/5',
        className
      )}
    >
      {hasHeader ? (
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3
              className={cn(
                'flex items-center gap-2 text-sm font-semibold',
                tone === 'danger' && 'text-destructive'
              )}
            >
              {icon ? <span className="shrink-0 text-muted-foreground">{icon}</span> : null}
              {title}
            </h3>
            {description ? (
              <p className="mt-1 text-xs text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      <div className="space-y-4">{children}</div>
    </section>
  )
}

interface SettingRowProps {
  label: ReactNode
  description?: ReactNode
  /** Compact controls (switch, small input) sit inline; wide ones stack below the label. */
  layout?: 'inline' | 'stack'
  control?: ReactNode
  /** Extra content under the row, e.g. an active-state hint or preset chips. */
  children?: ReactNode
  disabled?: boolean
  className?: string
}

export function SettingRow({
  label,
  description,
  layout = 'inline',
  control,
  children,
  disabled = false,
  className
}: SettingRowProps): React.JSX.Element {
  return (
    <div className={cn('space-y-2', disabled && 'opacity-60', className)}>
      <div
        className={cn(
          'gap-3',
          layout === 'inline' ? 'flex items-start justify-between' : 'flex flex-col'
        )}
      >
        <div className="min-w-0 space-y-0.5">
          <div className="text-sm font-medium leading-5">{label}</div>
          {description ? (
            <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {control ? (
          <div className={cn(layout === 'inline' ? 'shrink-0 pt-0.5' : 'w-full')}>{control}</div>
        ) : null}
      </div>
      {children}
    </div>
  )
}

interface SettingPresetsProps<T extends string | number> {
  values: readonly T[]
  active: T
  onSelect: (value: T) => void
  format?: (value: T) => string
  className?: string
}

/**
 * The chip row that used to be copy-pasted next to every numeric slider.
 */
export function SettingPresets<T extends string | number>({
  values,
  active,
  onSelect,
  format,
  className
}: SettingPresetsProps<T>): React.JSX.Element {
  return (
    <div className={cn('flex flex-wrap items-center gap-1', className)}>
      {values.map((value) => (
        <button
          key={String(value)}
          type="button"
          onClick={() => onSelect(value)}
          className={cn(
            'rounded px-2 py-0.5 text-[10px] transition-colors',
            active === value
              ? 'bg-primary text-primary-foreground'
              : 'bg-muted text-muted-foreground hover:text-foreground'
          )}
        >
          {format ? format(value) : String(value)}
        </button>
      ))}
    </div>
  )
}

interface SettingsSegmentedProps<T extends string> {
  options: ReadonlyArray<{ value: T; label: string; icon?: ReactNode }>
  value: T
  onChange: (value: T) => void
  className?: string
}

/**
 * Sub-navigation for tabs that host two closely related surfaces, so they can
 * share one sidebar entry instead of competing for two.
 */
export function SettingsSegmented<T extends string>({
  options,
  value,
  onChange,
  className
}: SettingsSegmentedProps<T>): React.JSX.Element {
  return (
    <div
      role="tablist"
      className={cn(
        'inline-flex items-center gap-1 rounded-lg border border-border/60 bg-muted/40 p-1',
        className
      )}
    >
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(option.value)}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
              active
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {option.icon}
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

interface SettingHintProps {
  tone?: 'muted' | 'success' | 'warning' | 'danger'
  children: ReactNode
  className?: string
}

export function SettingHint({
  tone = 'muted',
  children,
  className
}: SettingHintProps): React.JSX.Element {
  return (
    <p
      className={cn(
        'text-xs',
        tone === 'muted' && 'text-muted-foreground/70',
        tone === 'success' && 'rounded-md bg-emerald-500/10 px-3 py-2 text-emerald-500',
        tone === 'warning' && 'rounded-md bg-amber-500/10 px-3 py-2 text-amber-500',
        tone === 'danger' && 'text-destructive',
        className
      )}
    >
      {children}
    </p>
  )
}
