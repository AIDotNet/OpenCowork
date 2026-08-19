import { useTranslation } from 'react-i18next'
import { Sparkles } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Slider } from '@renderer/components/ui/slider'
import { Switch } from '@renderer/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { LANGUAGE_OPTIONS } from '@renderer/lib/i18n-language'
import {
  getLiveOutputCursorClass,
  getLiveOutputShimmerClass,
  getLiveOutputSurfaceClass
} from '@renderer/lib/live-output-animation'
import { GlobalThemePanel } from '../GlobalThemePanel'
import { SettingRow, SettingsPanel, SettingsSection } from '../settings-primitives'

const MIN_FONT_SIZE = 12
const MAX_FONT_SIZE = 20

function clampFontSize(value: number): number {
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, value))
}

export function GeneralPanel(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const settings = useSettingsStore()

  const fontOptions = [
    { label: t('general.appearance.fontSystem'), value: '__default__' },
    {
      label: 'Inter',
      value:
        "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif"
    },
    {
      label: 'Segoe UI',
      value:
        "'Segoe UI', system-ui, -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif"
    },
    {
      label: 'Noto Sans',
      value: "'Noto Sans', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif"
    },
    {
      label: 'Source Sans 3',
      value: "'Source Sans 3', system-ui, -apple-system, 'Segoe UI', sans-serif"
    },
    {
      label: 'Monospace',
      value: "ui-monospace, 'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', monospace"
    }
  ]

  return (
    <SettingsPanel title={t('general.title')} description={t('general.subtitle')}>
      <SettingsSection id="theme" variant="plain">
        <GlobalThemePanel />
      </SettingsSection>

      <SettingsSection
        id="appearance"
        title={t('general.appearance.title')}
        description={t('general.appearance.subtitle')}
      >
        <SettingRow
          layout="stack"
          label={t('general.appearance.background')}
          description={t('general.appearance.backgroundDesc')}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="color"
              value={settings.backgroundColor || '#111111'}
              onChange={(e) => settings.updateSettings({ backgroundColor: e.target.value })}
              className="h-8 w-12 cursor-pointer p-1"
            />
            <Input
              type="text"
              value={settings.backgroundColor}
              onChange={(e) => settings.updateSettings({ backgroundColor: e.target.value.trim() })}
              placeholder={t('general.appearance.backgroundPlaceholder')}
              className="max-w-40 text-xs"
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 text-xs"
              onClick={() => settings.updateSettings({ backgroundColor: '' })}
            >
              {t('general.appearance.reset')}
            </Button>
          </div>
        </SettingRow>

        <SettingRow
          layout="stack"
          label={t('general.appearance.font')}
          description={t('general.appearance.fontDesc')}
        >
          <Select
            value={settings.fontFamily || '__default__'}
            onValueChange={(value) =>
              settings.updateSettings({ fontFamily: value === '__default__' ? '' : value })
            }
          >
            <SelectTrigger className="w-80 max-w-full text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {fontOptions.map((option) => (
                <SelectItem key={option.label} value={option.value} className="text-xs">
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>

        <SettingRow
          label={t('general.appearance.fontSize')}
          description={t('general.appearance.fontSizeDesc')}
          control={
            <span className="font-mono text-sm text-muted-foreground">{settings.fontSize}px</span>
          }
        >
          <Slider
            value={[settings.fontSize]}
            onValueChange={([value]) => settings.updateSettings({ fontSize: clampFontSize(value) })}
            min={MIN_FONT_SIZE}
            max={MAX_FONT_SIZE}
            step={1}
            className="max-w-lg"
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection
        id="animation"
        title={t('general.animations')}
        description={t('general.animationsDesc')}
        actions={
          <Switch
            checked={settings.animationsEnabled}
            onCheckedChange={(checked) => settings.updateSettings({ animationsEnabled: checked })}
          />
        }
      >
        <SettingRow
          layout="stack"
          label={t('general.liveOutputAnimation.title')}
          description={t('general.liveOutputAnimation.desc')}
        >
          <div className="grid gap-2 sm:grid-cols-2">
            {(['agile', 'elegant'] as const).map((style) => {
              const active = settings.liveOutputAnimationStyle === style
              return (
                <button
                  key={style}
                  type="button"
                  onClick={() => settings.updateSettings({ liveOutputAnimationStyle: style })}
                  className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                    active
                      ? 'border-primary/50 bg-primary/10 text-foreground'
                      : 'border-border/60 bg-background/60 text-muted-foreground hover:bg-background'
                  }`}
                >
                  <div className="text-sm font-medium">
                    {t(`general.liveOutputAnimation.options.${style}.label`)}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {t(`general.liveOutputAnimation.options.${style}.desc`)}
                  </div>
                </button>
              )
            })}
          </div>
        </SettingRow>

        <div className="rounded-lg border border-border/60 bg-background/70 px-3 py-3">
          <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
            <Sparkles className="size-3.5 text-primary/80" />
            <span>{t('general.liveOutputAnimation.preview')}</span>
          </div>
          <div className="text-sm text-foreground">
            <span
              className={`${getLiveOutputSurfaceClass(settings.liveOutputAnimationStyle)} inline-block max-w-full whitespace-pre-wrap break-words leading-relaxed`}
            >
              {t('general.liveOutputAnimation.previewText')}
            </span>
            <span className={getLiveOutputCursorClass(settings.liveOutputAnimationStyle)} />
          </div>
          <div className="mt-3 flex items-center gap-2 text-xs">
            <span className={getLiveOutputShimmerClass(settings.liveOutputAnimationStyle)}>
              {t('general.liveOutputAnimation.previewStatus')}
            </span>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection id="interface" title={t('general.sections.interface')}>
        <SettingRow
          label={t('general.toolbarCollapsedByDefault')}
          description={t('general.toolbarCollapsedByDefaultDesc')}
          control={
            <Switch
              checked={settings.toolbarCollapsedByDefault}
              onCheckedChange={(checked) =>
                settings.updateSettings({ toolbarCollapsedByDefault: checked })
              }
            />
          }
        />
      </SettingsSection>

      <SettingsSection
        id="language"
        title={t('general.language')}
        description={t('general.languageDesc')}
      >
        <Select
          value={settings.language}
          onValueChange={(v) => settings.updateSettings({ language: v as typeof settings.language })}
        >
          <SelectTrigger className="w-60 max-w-full text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LANGUAGE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value} className="text-xs">
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsSection>
    </SettingsPanel>
  )
}
