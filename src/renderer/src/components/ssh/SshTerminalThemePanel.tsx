import { Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  APP_THEME_PRESETS,
  getTerminalTheme,
  getThemePresetDefinition,
  type SshTerminalThemePreset
} from '@renderer/lib/theme-presets'
import { cn } from '@renderer/lib/utils'
import { useSettingsStore } from '@renderer/stores/settings-store'

function TerminalThemeCard({
  preset,
  active,
  onClick
}: {
  preset: SshTerminalThemePreset
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  const { t } = useTranslation(['ssh', 'settings'])
  const definition = getThemePresetDefinition(preset)
  const preview = getTerminalTheme(preset, 'dark')

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group w-full rounded-[22px] border bg-card p-3 text-left transition-all',
        'hover:-translate-y-0.5 hover:border-foreground/15 hover:shadow-[0_18px_40px_-28px_color-mix(in_srgb,var(--foreground)_18%,transparent)]',
        active
          ? 'border-primary shadow-[0_0_0_1px_var(--primary),0_24px_44px_-28px_color-mix(in_srgb,var(--primary)_35%,transparent)]'
          : 'border-border'
      )}
    >
      <div
        className="overflow-hidden rounded-[18px] border border-white/5 p-3"
        style={{ background: preview.background }}
      >
        <div className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-white/75" />
          <span className="size-2 rounded-full bg-white/45" />
          <span className="size-2 rounded-full bg-white/25" />
        </div>

        <div className="mt-4 space-y-2 font-mono text-[0.72rem] leading-5">
          <div style={{ color: preview.foreground ?? '#ffffff' }}>
            ssh root@host<span style={{ color: preview.blue ?? preview.foreground }}> ~/srv</span>
          </div>
          <div style={{ color: preview.green ?? preview.foreground }}>git status</div>
          <div style={{ color: preview.yellow ?? preview.foreground }}>
            3 files changed, 14 insertions(+)
          </div>
          <div className="flex items-center gap-1.5 pt-2">
            <span
              className="h-2 w-12 rounded-full"
              style={{ background: preview.cyan ?? preview.foreground }}
            />
            <span
              className="h-2 w-8 rounded-full"
              style={{ background: preview.magenta ?? preview.foreground }}
            />
            <span
              className="h-2 flex-1 rounded-full opacity-75"
              style={{ background: preview.selectionBackground ?? preview.white ?? '#ffffff' }}
            />
          </div>
        </div>
      </div>

      <div className="mt-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[0.95rem] font-semibold text-foreground">
            {t(definition.labelKey, { ns: 'settings' })}
          </div>
          <div className="mt-1 text-[0.78rem] leading-5 text-muted-foreground">
            {t(definition.descriptionKey, { ns: 'settings' })}
          </div>
        </div>
        {active ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary px-2.5 py-1 text-[0.68rem] font-semibold text-primary-foreground">
            <Check className="size-3" />
            {t('workspace.terminalTheme.active', { ns: 'ssh' })}
          </span>
        ) : null}
      </div>
    </button>
  )
}

export function SshTerminalThemePanel(): React.JSX.Element {
  const { t } = useTranslation('ssh')
  const sshTerminalThemePreset = useSettingsStore((state) => state.sshTerminalThemePreset)
  const updateSettings = useSettingsStore((state) => state.updateSettings)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-foreground">
            {t('workspace.terminalTheme.presetsTitle')}
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            {t('workspace.terminalTheme.description')}
          </p>
        </div>
        <span className="rounded-full bg-secondary px-3 py-1 text-[0.7rem] font-medium text-secondary-foreground">
          {t('workspace.terminalTheme.scope')}
        </span>
      </div>

      <div className="grid gap-3">
        {APP_THEME_PRESETS.map((preset) => (
          <TerminalThemeCard
            key={preset.id}
            preset={preset.id}
            active={sshTerminalThemePreset === preset.id}
            onClick={() => updateSettings({ sshTerminalThemePreset: preset.id })}
          />
        ))}
      </div>

      <div className="rounded-[18px] border border-dashed border-border bg-muted/40 px-4 py-3 text-[0.78rem] leading-6 text-muted-foreground">
        {t('workspace.terminalTheme.globalHint')}
      </div>
    </div>
  )
}
