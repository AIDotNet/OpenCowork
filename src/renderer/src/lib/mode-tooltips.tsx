import type { ReactNode } from 'react'
import type { AppMode } from '@renderer/stores/ui-store'

export type SelectableMode = Exclude<AppMode, 'chat'>

export interface ModeOption {
  value: SelectableMode
  labelKey: string
  icon: ReactNode
}

interface ModeTooltipConfig {
  summaryKey: string
  solvesKeys: [string, string, string]
}

export const modeTooltipConfigs: Record<SelectableMode, ModeTooltipConfig> = {
  clarify: {
    summaryKey: 'modeTooltip.clarify.summary',
    solvesKeys: [
      'modeTooltip.clarify.solves.0',
      'modeTooltip.clarify.solves.1',
      'modeTooltip.clarify.solves.2'
    ]
  },
  cowork: {
    summaryKey: 'modeTooltip.cowork.summary',
    solvesKeys: [
      'modeTooltip.cowork.solves.0',
      'modeTooltip.cowork.solves.1',
      'modeTooltip.cowork.solves.2'
    ]
  },
  code: {
    summaryKey: 'modeTooltip.code.summary',
    solvesKeys: [
      'modeTooltip.code.solves.0',
      'modeTooltip.code.solves.1',
      'modeTooltip.code.solves.2'
    ]
  }
}

interface RenderModeTooltipContentOptions {
  mode: SelectableMode
  labelKey: string
  icon: ReactNode
  shortcutIndex: number
  isActive: boolean
  t: (key: string, options?: Record<string, unknown>) => string
  tCommon: (key: string, options?: Record<string, unknown>) => string
}

export function renderModeTooltipContent({
  mode,
  labelKey,
  icon,
  shortcutIndex,
  isActive,
  t,
  tCommon
}: RenderModeTooltipContentOptions): ReactNode {
  const tooltipConfig = modeTooltipConfigs[mode]

  return (
    <div className="max-w-[320px] space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm font-semibold">
            {icon}
            <span>{tCommon(labelKey)}</span>
          </div>
          <p className="text-xs leading-5 text-background/80">
            {t(`layout.${tooltipConfig.summaryKey}`)}
          </p>
        </div>
        <span className="rounded border border-background/20 px-1.5 py-0.5 text-[10px] font-medium text-background/70">
          Ctrl+{shortcutIndex + 1}
        </span>
      </div>

      <div className="space-y-1">
        <div className="text-[11px] font-medium uppercase tracking-wide text-background/60">
          {t('layout.modeTooltip.solvesTitle')}
        </div>
        <ul className="space-y-1 text-xs leading-5 text-background/85">
          {tooltipConfig.solvesKeys.map((key) => (
            <li key={key} className="flex items-start gap-1.5">
              <span className="mt-1 size-1 rounded-full bg-background/70" />
              <span>{t(`layout.${key}`)}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="text-[11px] text-background/65">
        {isActive
          ? t('layout.modeTooltip.current')
          : t('layout.modeTooltip.switchHint', {
              shortcut: `Ctrl+${shortcutIndex + 1}`,
              mode: tCommon(labelKey)
            })}
      </div>
    </div>
  )
}
