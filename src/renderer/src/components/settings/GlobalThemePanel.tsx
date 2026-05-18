import { Monitor, MoonStar, SunMedium } from 'lucide-react'
import { useTheme } from 'next-themes'
import { useTranslation } from 'react-i18next'
import {
  APP_THEME_PRESETS,
  resolveAppThemeMode,
  type AppThemeMode,
  type AppThemePreset,
  type ThemePresetDefinition
} from '@renderer/lib/theme-presets'
import { cn } from '@renderer/lib/utils'
import { useSettingsStore } from '@renderer/stores/settings-store'

const MODE_OPTIONS = [
  {
    value: 'light',
    icon: SunMedium,
    labelKey: 'general.light'
  },
  {
    value: 'dark',
    icon: MoonStar,
    labelKey: 'general.dark'
  },
  {
    value: 'system',
    icon: Monitor,
    labelKey: 'general.system'
  }
] as const

function PresetSwatches({ preset }: { preset: ThemePresetDefinition }): React.JSX.Element {
  return (
    <div className="flex items-center gap-1.5">
      {preset.swatches.map((color) => (
        <span
          key={color}
          className="size-4 rounded-full border border-black/10 shadow-sm dark:border-white/10"
          style={{ background: color }}
        />
      ))}
    </div>
  )
}

function AppPresetPreview({
  preset,
  mode
}: {
  preset: ThemePresetDefinition
  mode: AppThemeMode
}): React.JSX.Element {
  const preview = preset.preview[mode]

  return (
    <div
      className="mt-3 flex h-14 overflow-hidden rounded-xl border border-black/10 shadow-inner dark:border-white/10"
      style={{ background: preview.canvas }}
    >
      <div className="w-8 shrink-0" style={{ background: preview.rail }} />
      <div className="flex min-w-0 flex-1 items-center gap-2 p-2">
        <div className="h-8 w-10 rounded-lg" style={{ background: preview.card }} />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="h-2.5 rounded-full" style={{ background: preview.accent }} />
          <div className="h-2 rounded-full" style={{ background: preview.accentSoft }} />
        </div>
      </div>
    </div>
  )
}

function TerminalPresetPreview({
  preset,
  mode,
  previewText,
  connectedText
}: {
  preset: ThemePresetDefinition
  mode: AppThemeMode
  previewText: string
  connectedText: string
}): React.JSX.Element {
  const terminal = preset.terminal[mode]

  return (
    <div
      className="mt-3 h-14 overflow-hidden rounded-xl border border-black/10 px-3 py-2 font-mono text-[0.65rem] leading-5 shadow-inner dark:border-white/10"
      style={{ background: terminal.background, color: terminal.foreground }}
    >
      <div className="truncate" style={{ color: terminal.green }}>
        {previewText}
      </div>
      <div className="truncate" style={{ color: terminal.cyan }}>
        {connectedText}
      </div>
    </div>
  )
}

function PresetCard({
  preset,
  active,
  compact,
  mode,
  previewType,
  onClick
}: {
  preset: ThemePresetDefinition
  active: boolean
  compact?: boolean
  mode: AppThemeMode
  previewType: 'app' | 'terminal'
  onClick: () => void
}): React.JSX.Element {
  const { t } = useTranslation('settings')

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group flex min-h-[142px] flex-col rounded-[18px] border bg-card p-3 text-left transition-all hover:border-primary/35 hover:bg-accent/40',
        active
          ? 'border-primary shadow-[0_18px_38px_-28px_color-mix(in_srgb,var(--primary)_72%,transparent)]'
          : 'border-border',
        compact && 'min-h-[132px]'
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-foreground">{t(preset.labelKey)}</div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{t(preset.descriptionKey)}</p>
        </div>
        {active ? (
          <span className="shrink-0 rounded-full bg-primary px-2 py-1 text-[0.65rem] font-semibold text-primary-foreground">
            {t('general.themePreset.current')}
          </span>
        ) : null}
      </div>

      {previewType === 'terminal' ? (
        <TerminalPresetPreview
          preset={preset}
          mode={mode}
          previewText={t('general.themePreset.terminalPreview')}
          connectedText={t('general.themePreset.terminalConnectedPreview')}
        />
      ) : (
        <AppPresetPreview preset={preset} mode={mode} />
      )}

      <div className="mt-3 flex items-center justify-between gap-3">
        <PresetSwatches preset={preset} />
        {previewType === 'terminal' ? (
          <span className="text-[0.66rem] font-medium uppercase tracking-[0.16em] text-muted-foreground">
            SSH
          </span>
        ) : (
          <span className="text-[0.66rem] font-medium uppercase tracking-[0.16em] text-muted-foreground">
            {t('general.themePreset.globalHint')}
          </span>
        )}
      </div>
    </button>
  )
}

export function GlobalThemePanel({
  compact,
  className
}: {
  compact?: boolean
  className?: string
}): React.JSX.Element {
  const { t } = useTranslation('settings')
  const { resolvedTheme, setTheme } = useTheme()
  const settings = useSettingsStore()
  const resolvedMode = resolveAppThemeMode(
    settings.theme === 'system' ? resolvedTheme : settings.theme
  )
  const presetGridClass = compact ? 'grid-cols-1' : 'sm:grid-cols-2 xl:grid-cols-3'

  const updateThemePreset = (preset: AppThemePreset): void => {
    const terminalWasMatched = settings.sshTerminalThemePreset === settings.themePreset
    settings.updateSettings({
      themePreset: preset,
      ...(terminalWasMatched ? { sshTerminalThemePreset: preset } : {})
    })
  }

  return (
    <div className={cn('space-y-5', className)}>
      <section className="space-y-3">
        <div>
          <div className="text-sm font-medium text-foreground">{t('general.theme')}</div>
          <p className="text-xs text-muted-foreground">{t('general.themeDesc')}</p>
        </div>

        <div className="grid grid-cols-3 gap-2">
          {MODE_OPTIONS.map((option) => {
            const active = settings.theme === option.value
            const Icon = option.icon

            return (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  settings.updateSettings({ theme: option.value })
                  setTheme(option.value)
                }}
                className={cn(
                  'flex items-center justify-center gap-2 rounded-[16px] border px-3 py-3 text-sm transition-all',
                  active
                    ? 'border-primary bg-primary text-primary-foreground shadow-[0_16px_32px_-24px_color-mix(in_srgb,var(--primary)_75%,transparent)]'
                    : 'border-border bg-card text-foreground hover:border-foreground/15 hover:bg-accent'
                )}
              >
                <Icon className="size-4" />
                <span>{t(option.labelKey)}</span>
              </button>
            )
          })}
        </div>
      </section>

      <section className={cn('space-y-3', compact && 'hidden')}>
        <div>
          <div className="text-sm font-medium text-foreground">
            {t('general.themePreset.title')}
          </div>
          <p className="text-xs text-muted-foreground">{t('general.themePreset.desc')}</p>
        </div>

        <div className={cn('grid gap-3', presetGridClass)}>
          {APP_THEME_PRESETS.map((preset) => (
            <PresetCard
              key={preset.id}
              preset={preset}
              active={settings.themePreset === preset.id}
              compact={compact}
              mode={resolvedMode}
              previewType="app"
              onClick={() => updateThemePreset(preset.id)}
            />
          ))}
        </div>
      </section>

      <section className={cn('space-y-3', compact && 'hidden')}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-foreground">
              {t('general.themePreset.terminalTitle')}
            </div>
            <p className="text-xs text-muted-foreground">{t('general.themePreset.terminalDesc')}</p>
          </div>
          <button
            type="button"
            className="shrink-0 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-default disabled:opacity-60"
            disabled={settings.sshTerminalThemePreset === settings.themePreset}
            onClick={() =>
              settings.updateSettings({ sshTerminalThemePreset: settings.themePreset })
            }
          >
            {settings.sshTerminalThemePreset === settings.themePreset
              ? t('general.themePreset.matched')
              : t('general.themePreset.matchApp')}
          </button>
        </div>

        <div className={cn('grid gap-3', presetGridClass)}>
          {APP_THEME_PRESETS.map((preset) => (
            <PresetCard
              key={preset.id}
              preset={preset}
              active={settings.sshTerminalThemePreset === preset.id}
              compact={compact}
              mode={resolvedMode}
              previewType="terminal"
              onClick={() => settings.updateSettings({ sshTerminalThemePreset: preset.id })}
            />
          ))}
        </div>
      </section>
    </div>
  )
}
