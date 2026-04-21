import { Check, Monitor, MoonStar, SunMedium } from 'lucide-react'
import { useTheme } from 'next-themes'
import { useTranslation } from 'react-i18next'
import {
  APP_THEME_PRESETS,
  getThemePresetDefinition,
  resolveAppThemeMode,
  type AppThemePreset
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

function ThemePresetCard({
  preset,
  compact,
  active,
  onClick
}: {
  preset: AppThemePreset
  compact?: boolean
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  const { t } = useTranslation('settings')
  const { resolvedTheme } = useTheme()
  const definition = getThemePresetDefinition(preset)
  const preview = definition.preview[resolveAppThemeMode(resolvedTheme)]

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group w-full rounded-[24px] border bg-card p-3 text-left transition-all',
        'hover:-translate-y-0.5 hover:border-foreground/15 hover:shadow-[0_18px_40px_-28px_color-mix(in_srgb,var(--foreground)_18%,transparent)]',
        active
          ? 'border-primary shadow-[0_0_0_1px_var(--primary),0_24px_44px_-28px_color-mix(in_srgb,var(--primary)_35%,transparent)]'
          : 'border-border'
      )}
    >
      <div
        className={cn(
          'overflow-hidden rounded-[18px] p-3',
          compact ? 'min-h-[88px]' : 'min-h-[108px]'
        )}
        style={{
          background: `linear-gradient(135deg, ${preview.rail} 0%, ${preview.canvas} 100%)`
        }}
      >
        <div className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-white/75" />
          <span className="size-2 rounded-full bg-white/45" />
          <span className="size-2 rounded-full bg-white/25" />
        </div>

        <div className="mt-3 flex items-stretch gap-3">
          <div
            className="w-12 rounded-[14px] border border-white/10"
            style={{ background: preview.card }}
          />
          <div className="flex min-w-0 flex-1 flex-col justify-between gap-2">
            <div className="space-y-1.5">
              <div
                className="h-2.5 rounded-full"
                style={{ width: compact ? '54%' : '58%', background: preview.text, opacity: 0.92 }}
              />
              <div
                className="h-2 rounded-full"
                style={{ width: compact ? '76%' : '82%', background: preview.text, opacity: 0.34 }}
              />
            </div>
            <div className="flex items-center gap-2">
              <div
                className="h-8 flex-1 rounded-[12px]"
                style={{ background: preview.card, opacity: 0.9 }}
              />
              <div className="h-8 w-8 rounded-[12px]" style={{ background: preview.accentSoft }} />
            </div>
            <div
              className="h-2.5 rounded-full"
              style={{ width: compact ? '28%' : '32%', background: preview.accent }}
            />
          </div>
        </div>
      </div>

      <div className="mt-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[0.95rem] font-semibold text-foreground">
            {t(definition.labelKey)}
          </div>
          <div className="mt-1 text-[0.78rem] leading-5 text-muted-foreground">
            {t(definition.descriptionKey)}
          </div>
        </div>
        {active ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary px-2.5 py-1 text-[0.68rem] font-semibold text-primary-foreground">
            <Check className="size-3" />
            {t('general.themePreset.current')}
          </span>
        ) : null}
      </div>

      <div className="mt-3 flex gap-2">
        {definition.swatches.map((swatch) => (
          <span
            key={`${definition.id}:${swatch}`}
            className="h-2.5 flex-1 rounded-full"
            style={{ background: swatch }}
          />
        ))}
      </div>
    </button>
  )
}

export function GlobalThemePanel({
  compact = false,
  className
}: {
  compact?: boolean
  className?: string
}): React.JSX.Element {
  const { t } = useTranslation('settings')
  const { setTheme } = useTheme()
  const settings = useSettingsStore()

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

      <section className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-foreground">
              {t('general.themePreset.title')}
            </div>
            <p className="text-xs text-muted-foreground">{t('general.themePreset.desc')}</p>
          </div>
          <span className="rounded-full bg-secondary px-3 py-1 text-[0.7rem] font-medium text-secondary-foreground">
            {t('general.themePreset.globalHint')}
          </span>
        </div>

        <div className={cn('grid gap-3', compact ? 'grid-cols-1' : 'grid-cols-1 xl:grid-cols-2')}>
          {APP_THEME_PRESETS.map((preset) => (
            <ThemePresetCard
              key={preset.id}
              preset={preset.id}
              compact={compact}
              active={settings.themePreset === preset.id}
              onClick={() => settings.updateSettings({ themePreset: preset.id })}
            />
          ))}
        </div>
      </section>
    </div>
  )
}
