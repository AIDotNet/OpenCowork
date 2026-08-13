import type { ReactNode } from 'react'
import type { AppMode } from '@renderer/stores/ui-store'

export type SelectableMode = Exclude<AppMode, 'chat'>

interface ModeTooltipConfig {
  summaryKey: string
  flowKey: string
  solvesKeys: [string, string, string]
}

export const modeTooltipConfigs: Record<SelectableMode, ModeTooltipConfig> = {
  clarify: {
    summaryKey: 'modeTooltip.clarify.summary',
    flowKey: 'modeTooltip.clarify.flow',
    solvesKeys: [
      'modeTooltip.clarify.solves.0',
      'modeTooltip.clarify.solves.1',
      'modeTooltip.clarify.solves.2'
    ]
  },
  cowork: {
    summaryKey: 'modeTooltip.cowork.summary',
    flowKey: 'modeTooltip.cowork.flow',
    solvesKeys: [
      'modeTooltip.cowork.solves.0',
      'modeTooltip.cowork.solves.1',
      'modeTooltip.cowork.solves.2'
    ]
  },
  code: {
    summaryKey: 'modeTooltip.code.summary',
    flowKey: 'modeTooltip.code.flow',
    solvesKeys: [
      'modeTooltip.code.solves.0',
      'modeTooltip.code.solves.1',
      'modeTooltip.code.solves.2'
    ]
  },
  acp: {
    summaryKey: 'modeTooltip.acp.summary',
    flowKey: 'modeTooltip.acp.flow',
    solvesKeys: ['modeTooltip.acp.solves.0', 'modeTooltip.acp.solves.1', 'modeTooltip.acp.solves.2']
  }
}

export function isSelectableMode(mode: AppMode): mode is SelectableMode {
  return mode !== 'chat'
}

interface RenderModeTooltipContentOptions {
  mode: SelectableMode
  label: string
  shortcut?: string
  isActive: boolean
  t: (key: string, options?: Record<string, unknown>) => string
}

export function renderModeTooltipContent({
  mode,
  label,
  shortcut,
  isActive,
  t
}: RenderModeTooltipContentOptions): ReactNode {
  const tooltipConfig = modeTooltipConfigs[mode]

  return (
    <div className="space-y-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1.5">
          <div className="text-[13px] font-semibold leading-none text-foreground">{label}</div>
          <p className="text-[12px] leading-5 text-muted-foreground">
            {t(`layout.${tooltipConfig.summaryKey}`)}
          </p>
        </div>
        {shortcut ? (
          <span className="shrink-0 rounded border border-border/70 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            {shortcut}
          </span>
        ) : null}
      </div>

      <div className="space-y-1">
        <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/80">
          {t('layout.modeTooltip.flowTitle')}
        </div>
        <p className="text-[12px] leading-5 text-foreground/85">
          {t(`layout.${tooltipConfig.flowKey}`)}
        </p>
      </div>

      <div className="space-y-1">
        <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/80">
          {t('layout.modeTooltip.solvesTitle')}
        </div>
        <ul className="space-y-1 text-[12px] leading-5 text-foreground/85">
          {tooltipConfig.solvesKeys.map((key) => (
            <li key={key} className="flex items-start gap-1.5">
              <span className="mt-2 size-1 shrink-0 rounded-full bg-muted-foreground/70" />
              <span>{t(`layout.${key}`)}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="text-[11px] text-muted-foreground/80">
        {isActive
          ? t('layout.modeTooltip.current')
          : t('layout.modeTooltip.switchHint', {
              shortcut: shortcut ?? '',
              mode: label
            })}
      </div>
    </div>
  )
}
