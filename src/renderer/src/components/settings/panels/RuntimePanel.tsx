import { useTranslation } from 'react-i18next'
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
import {
  clampApiRequestTimeoutSeconds,
  clampMaxConcurrentSubAgents,
  clampMaxParallelToolCalls,
  DEFAULT_API_REQUEST_TIMEOUT_SECONDS,
  DEFAULT_MAX_CONCURRENT_SUB_AGENTS,
  DEFAULT_MAX_PARALLEL_TOOL_CALLS,
  MAX_API_REQUEST_TIMEOUT_SECONDS,
  MAX_MAX_CONCURRENT_SUB_AGENTS,
  MAX_MAX_PARALLEL_TOOL_CALLS,
  MIN_API_REQUEST_TIMEOUT_SECONDS,
  MIN_MAX_CONCURRENT_SUB_AGENTS,
  MIN_MAX_PARALLEL_TOOL_CALLS,
  useSettingsStore
} from '@renderer/stores/settings-store'
import {
  clampCompressionThreshold,
  MAX_CONTEXT_COMPRESSION_THRESHOLD,
  MIN_CONTEXT_COMPRESSION_THRESHOLD
} from '@renderer/lib/agent/context-compression'
import { ChatModelSelect } from '../chat-model-select'
import {
  SettingHint,
  SettingPresets,
  SettingRow,
  SettingsPanel,
  SettingsSection
} from '../settings-primitives'

const PARALLEL_TOOL_PRESETS = [1, 4, 8, 12, 16] as const
const SUB_AGENT_PRESETS = [1, 2, 4, 6, 8] as const
const TIMEOUT_PRESETS = [0, 100, 300, 600, 1800] as const

export function RuntimePanel(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const settings = useSettingsStore()

  return (
    <SettingsPanel title={t('runtime.title')} description={t('runtime.subtitle')}>
      <SettingsSection
        id="concurrency"
        title={t('runtime.sections.concurrency')}
        description={t('runtime.sections.concurrencyDesc')}
      >
        <SettingRow
          label={t('general.maxParallelToolCalls')}
          description={t('general.maxParallelToolCallsDesc')}
          control={
            <span className="font-mono text-sm text-muted-foreground">
              {settings.maxParallelToolCalls}
            </span>
          }
        >
          <Slider
            value={[settings.maxParallelToolCalls]}
            onValueChange={([value]) =>
              settings.updateSettings({ maxParallelToolCalls: clampMaxParallelToolCalls(value) })
            }
            min={MIN_MAX_PARALLEL_TOOL_CALLS}
            max={MAX_MAX_PARALLEL_TOOL_CALLS}
            step={1}
          />
          <div className="flex items-center justify-between text-[10px] text-muted-foreground/60">
            <span>{MIN_MAX_PARALLEL_TOOL_CALLS}</span>
            <span>{DEFAULT_MAX_PARALLEL_TOOL_CALLS}</span>
            <span>{MAX_MAX_PARALLEL_TOOL_CALLS}</span>
          </div>
          <SettingPresets
            values={PARALLEL_TOOL_PRESETS}
            active={settings.maxParallelToolCalls}
            onSelect={(value) => settings.updateSettings({ maxParallelToolCalls: value })}
          />
          <SettingHint>{t('general.maxParallelToolCallsHint')}</SettingHint>
        </SettingRow>

        <SettingRow
          label={t('general.maxConcurrentSubAgents', { defaultValue: 'Max Concurrent Sub-Agents' })}
          description={t('general.maxConcurrentSubAgentsDesc', {
            defaultValue:
              'How many Task sub-agents (and background teammates per team) may run at once. Extra launches queue until a slot frees.'
          })}
          control={
            <span className="font-mono text-sm text-muted-foreground">
              {settings.maxConcurrentSubAgents}
            </span>
          }
        >
          <Slider
            value={[settings.maxConcurrentSubAgents]}
            onValueChange={([value]) =>
              settings.updateSettings({ maxConcurrentSubAgents: clampMaxConcurrentSubAgents(value) })
            }
            min={MIN_MAX_CONCURRENT_SUB_AGENTS}
            max={MAX_MAX_CONCURRENT_SUB_AGENTS}
            step={1}
          />
          <div className="flex items-center justify-between text-[10px] text-muted-foreground/60">
            <span>{MIN_MAX_CONCURRENT_SUB_AGENTS}</span>
            <span>{DEFAULT_MAX_CONCURRENT_SUB_AGENTS}</span>
            <span>{MAX_MAX_CONCURRENT_SUB_AGENTS}</span>
          </div>
          <SettingPresets
            values={SUB_AGENT_PRESETS}
            active={settings.maxConcurrentSubAgents}
            onSelect={(value) => settings.updateSettings({ maxConcurrentSubAgents: value })}
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection id="timeout" title={t('general.apiRequestTimeout')}>
        <SettingRow
          label={t('general.apiRequestTimeout', { defaultValue: 'API Request Timeout' })}
          description={t('general.apiRequestTimeoutDesc', {
            defaultValue:
              'How long to wait for a model to start responding, in seconds. Raise this for local models (e.g. Ollama) that need a long warm-up. Set 0 to wait indefinitely until you cancel.'
          })}
          control={
            <Input
              type="number"
              min={MIN_API_REQUEST_TIMEOUT_SECONDS}
              max={MAX_API_REQUEST_TIMEOUT_SECONDS}
              step={10}
              value={settings.apiRequestTimeoutSeconds}
              onChange={(e) =>
                settings.updateSettings({
                  apiRequestTimeoutSeconds: clampApiRequestTimeoutSeconds(Number(e.target.value))
                })
              }
              className="w-24 text-sm"
            />
          }
        >
          <SettingPresets
            values={TIMEOUT_PRESETS}
            active={settings.apiRequestTimeoutSeconds}
            onSelect={(value) => settings.updateSettings({ apiRequestTimeoutSeconds: value })}
            format={(value) =>
              value === 0
                ? t('general.apiRequestTimeoutNoLimit', { defaultValue: 'No limit' })
                : `${value}s`
            }
          />
          <SettingHint>
            {t('general.apiRequestTimeoutHint', {
              defaultValue:
                'Only bounds the wait before the first response; an active stream is never cut off. Default {{default}}s.',
              default: DEFAULT_API_REQUEST_TIMEOUT_SECONDS
            })}
          </SettingHint>
        </SettingRow>
      </SettingsSection>

      <SettingsSection
        id="compression"
        title={t('general.contextCompression')}
        description={t('general.contextCompressionDesc')}
        actions={
          <Switch
            checked={settings.contextCompressionEnabled}
            onCheckedChange={(checked) =>
              settings.updateSettings({ contextCompressionEnabled: checked })
            }
          />
        }
      >
        {settings.contextCompressionEnabled ? (
          <>
            <SettingHint>{t('general.contextCompressionEnabled')}</SettingHint>
            <SettingRow
              label={t('general.contextCompressionThreshold')}
              description={t('general.contextCompressionThresholdDesc')}
              control={
                <span className="font-mono text-sm text-muted-foreground">
                  {Math.round(settings.contextCompressionThreshold * 100)}%
                </span>
              }
            >
              <Slider
                value={[settings.contextCompressionThreshold * 100]}
                onValueChange={([value]) =>
                  settings.updateSettings({
                    contextCompressionThreshold: clampCompressionThreshold(value / 100)
                  })
                }
                min={MIN_CONTEXT_COMPRESSION_THRESHOLD * 100}
                max={MAX_CONTEXT_COMPRESSION_THRESHOLD * 100}
                step={1}
              />
            </SettingRow>
            <SettingRow
              layout="stack"
              label={t('model.contextCompressionModel')}
              description={t('model.contextCompressionModelDesc')}
            >
              <ChatModelSelect
                value={settings.contextCompressionModel}
                onChange={(next) => settings.updateSettings({ contextCompressionModel: next })}
                inheritLabel={t('model.useCurrentSessionModel')}
                placeholder={t('model.selectContextCompressionModel')}
              />
            </SettingRow>
          </>
        ) : null}
      </SettingsSection>

      <SettingsSection
        id="tooling"
        title={t('runtime.sections.tooling')}
        description={t('runtime.sections.toolingDesc')}
      >
        <SettingRow
          label={t('general.teamTools')}
          description={t('general.teamToolsDesc')}
          control={
            <Switch
              checked={settings.teamToolsEnabled}
              onCheckedChange={(checked) => settings.updateSettings({ teamToolsEnabled: checked })}
            />
          }
        >
          {settings.teamToolsEnabled ? (
            <SettingHint>{t('general.teamToolsEnabled')}</SettingHint>
          ) : null}
        </SettingRow>

        <SettingRow
          label={t('general.clarifyAutoAcceptRecommended')}
          description={t('general.clarifyAutoAcceptRecommendedDesc')}
          control={
            <Switch
              checked={settings.clarifyAutoAcceptRecommended}
              onCheckedChange={(checked) =>
                settings.updateSettings({ clarifyAutoAcceptRecommended: checked })
              }
            />
          }
        />
      </SettingsSection>

      <SettingsSection
        id="advanced"
        title={t('runtime.sections.advanced')}
        description={t('runtime.sections.advancedDesc')}
      >
        <SettingRow
          layout="stack"
          label={t('general.toolResultFormat')}
          description={t('general.toolResultFormatDesc')}
        >
          <Select
            value={settings.toolResultFormat}
            onValueChange={(v: 'toon' | 'json') => settings.updateSettings({ toolResultFormat: v })}
          >
            <SelectTrigger className="w-60 max-w-full text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="toon" className="text-xs">
                {t('general.toolResultFormatToon')}
              </SelectItem>
              <SelectItem value="json" className="text-xs">
                {t('general.toolResultFormatJson')}
              </SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>

        <SettingRow
          label={t('general.devMode')}
          description={t('general.devModeDesc')}
          control={
            <Switch
              checked={settings.devMode}
              onCheckedChange={(checked) => settings.updateSettings({ devMode: checked })}
            />
          }
        />
      </SettingsSection>
    </SettingsPanel>
  )
}
