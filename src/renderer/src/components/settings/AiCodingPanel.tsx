import { useEffect, useMemo, useState } from 'react'
import type React from 'react'
import { Copy, Plus, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { Input } from '@renderer/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import {
  getClaudeCodeProviderGroups,
  getCodexProviderGroups,
  validateClaudeCodeConfig,
  validateCodexConfig,
  type AiCodingConfigStatus,
  type AiCodingProviderModelGroup
} from '@renderer/lib/ai-coding-terminal'
import { useProviderStore } from '@renderer/stores/provider-store'
import {
  createDefaultClaudeCodeConfig,
  createDefaultCodexConfig,
  type ClaudeCodeConfig,
  type ClaudeCodePermissionOption,
  type CodexConfig,
  useSettingsStore
} from '@renderer/stores/settings-store'
import { ModelIcon, ProviderIcon } from './provider-icons'

type AiCodingPanelKind = 'claude' | 'codex'
type ClaudeCodeModelField = 'smallFastModelId' | 'sonnetModelId' | 'opusModelId' | 'haikuModelId'

function createId(prefix: string): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${prefix}-${crypto.randomUUID()}`
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function maskSecret(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return '-'
  if (trimmed.length <= 8) return '••••'
  return `${trimmed.slice(0, 4)}••••${trimmed.slice(-4)}`
}

function statusLabelKey(status: AiCodingConfigStatus): string {
  if (status.valid) return 'aiCoding.status.ready'
  return `aiCoding.status.${status.reason}`
}

function ConfigList({
  configs,
  activeId,
  onSelect,
  onAdd,
  onCopy,
  onDelete,
  canDelete,
  getStatus
}: {
  configs: Array<ClaudeCodeConfig | CodexConfig>
  activeId: string
  onSelect: (id: string) => void
  onAdd: () => void
  onCopy: (id: string) => void
  onDelete: (id: string) => void
  canDelete: boolean
  getStatus: (config: ClaudeCodeConfig | CodexConfig) => AiCodingConfigStatus
}): React.JSX.Element {
  const { t } = useTranslation('settings')
  return (
    <div className="rounded-lg border border-border/70 bg-card/40 p-2">
      <div className="mb-2 flex items-center justify-between gap-2 px-1">
        <div>
          <p className="text-xs font-medium">{t('aiCoding.configs')}</p>
          <p className="text-[11px] text-muted-foreground">{t('aiCoding.configsDesc')}</p>
        </div>
        <Button size="icon-xs" variant="ghost" onClick={onAdd} title={t('aiCoding.addConfig')}>
          <Plus className="size-3.5" />
        </Button>
      </div>
      <div className="space-y-1">
        {configs.map((config) => {
          const active = config.id === activeId
          const status = getStatus(config)
          return (
            <button
              key={config.id}
              type="button"
              className={`group flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs transition-colors ${
                active
                  ? 'bg-primary/10 text-foreground'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
              }`}
              onClick={() => onSelect(config.id)}
            >
              <span className="min-w-0 flex-1 truncate">{config.name}</span>
              <Badge
                variant={status.valid ? 'secondary' : 'outline'}
                className="h-5 shrink-0 rounded px-1.5 text-[9px]"
              >
                {status.valid ? t('aiCoding.ready') : t('aiCoding.invalid')}
              </Badge>
              <span
                role="button"
                tabIndex={0}
                className="rounded p-0.5 opacity-0 transition-opacity hover:bg-muted group-hover:opacity-100"
                onClick={(event) => {
                  event.stopPropagation()
                  onCopy(config.id)
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  event.stopPropagation()
                  onCopy(config.id)
                }}
                title={t('aiCoding.copyConfig')}
              >
                <Copy className="size-3" />
              </span>
              <span
                role="button"
                tabIndex={canDelete ? 0 : -1}
                aria-disabled={!canDelete}
                className={`rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 ${
                  canDelete
                    ? 'hover:bg-destructive/10 hover:text-destructive'
                    : 'cursor-not-allowed text-muted-foreground/40'
                }`}
                onClick={(event) => {
                  event.stopPropagation()
                  if (!canDelete) return
                  onDelete(config.id)
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  event.stopPropagation()
                  if (!canDelete) return
                  onDelete(config.id)
                }}
                title={t('aiCoding.deleteConfig')}
              >
                <Trash2 className="size-3" />
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function ProviderSelect({
  groups,
  value,
  onChange
}: {
  groups: AiCodingProviderModelGroup[]
  value: string
  onChange: (providerId: string) => void
}): React.JSX.Element {
  const { t } = useTranslation('settings')
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-full text-xs">
        <SelectValue placeholder={t('aiCoding.selectProvider')} />
      </SelectTrigger>
      <SelectContent>
        {groups.map(({ provider }) => (
          <SelectItem key={provider.id} value={provider.id} className="text-xs">
            <span className="flex items-center gap-2">
              <ProviderIcon builtinId={provider.builtinId} size={14} />
              {provider.name}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function ModelSelect({
  groups,
  providerId,
  value,
  onChange,
  placeholder
}: {
  groups: AiCodingProviderModelGroup[]
  providerId: string
  value: string
  onChange: (modelId: string) => void
  placeholder: string
}): React.JSX.Element {
  const group = groups.find(({ provider }) => provider.id === providerId)
  const modelGroups = group ? [group] : groups
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-full text-xs">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {modelGroups.map(({ provider, models }) => (
          <SelectGroup key={provider.id}>
            <SelectLabel className="text-[10px] uppercase tracking-wide">
              {provider.name}
            </SelectLabel>
            {models.map((model) => (
              <SelectItem key={`${provider.id}-${model.id}`} value={model.id} className="text-xs">
                <div className="flex items-center gap-2">
                  <ModelIcon
                    icon={model.icon}
                    modelId={model.id}
                    providerBuiltinId={provider.builtinId}
                    size={16}
                    className="text-muted-foreground/70"
                  />
                  <div className="flex min-w-0 flex-col text-left">
                    <span className="truncate">{model.name}</span>
                    <span className="truncate text-[10px] text-muted-foreground/60">
                      {model.id}
                    </span>
                  </div>
                </div>
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  )
}

function FieldBlock({
  label,
  description,
  children
}: {
  label: string
  description?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="space-y-2">
      <div>
        <label className="text-sm font-medium">{label}</label>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </section>
  )
}

function ClaudeCodeEditor({
  config,
  groups,
  onUpdate
}: {
  config: ClaudeCodeConfig
  groups: AiCodingProviderModelGroup[]
  onUpdate: (patch: Partial<ClaudeCodeConfig>) => void
}): React.JSX.Element {
  const { t } = useTranslation('settings')
  const provider = useProviderStore((state) =>
    state.providers.find((candidate) => candidate.id === config.providerId)
  )
  const status = validateClaudeCodeConfig(config)
  const selectedGroup = groups.find(({ provider: item }) => item.id === config.providerId)
  const firstModel = selectedGroup?.models[0]?.id ?? ''
  const selectModelPlaceholder = t('aiCoding.selectModel')
  const permissionOptions = config.permissionOptions ?? []
  const updateProvider = (providerId: string): void => {
    const group = groups.find(({ provider: item }) => item.id === providerId)
    const modelId = group?.models[0]?.id ?? ''
    onUpdate({
      providerId,
      defaultModelId: modelId,
      smallFastModelId: modelId,
      sonnetModelId: modelId,
      opusModelId: modelId,
      haikuModelId: modelId
    })
  }
  const updatePermissionOption = (option: ClaudeCodePermissionOption, checked: boolean): void => {
    const nextOptions = checked
      ? Array.from(new Set([...permissionOptions, option]))
      : permissionOptions.filter((item) => item !== option)
    onUpdate({ permissionOptions: nextOptions })
  }

  return (
    <div className="space-y-5">
      <FieldBlock label={t('aiCoding.configName')}>
        <Input
          value={config.name}
          onChange={(event) => onUpdate({ name: event.target.value })}
          className="max-w-md"
        />
      </FieldBlock>

      <FieldBlock label={t('aiCoding.provider')} description={t('aiCoding.claudeProviderDesc')}>
        <ProviderSelect groups={groups} value={config.providerId} onChange={updateProvider} />
      </FieldBlock>

      <FieldBlock label={t('aiCoding.defaultModel')} description="ANTHROPIC_MODEL">
        <ModelSelect
          groups={groups}
          providerId={config.providerId}
          value={config.defaultModelId || firstModel}
          onChange={(modelId) => onUpdate({ defaultModelId: modelId })}
          placeholder={selectModelPlaceholder}
        />
      </FieldBlock>

      {(
        [
          ['smallFastModelId', 'ANTHROPIC_SMALL_FAST_MODEL'],
          ['sonnetModelId', 'ANTHROPIC_DEFAULT_SONNET_MODEL'],
          ['opusModelId', 'ANTHROPIC_DEFAULT_OPUS_MODEL'],
          ['haikuModelId', 'ANTHROPIC_DEFAULT_HAIKU_MODEL']
        ] as Array<[ClaudeCodeModelField, string]>
      ).map(([field, envName]) => (
        <FieldBlock key={field} label={envName}>
          <ModelSelect
            groups={groups}
            providerId={config.providerId}
            value={String(config[field] || '')}
            onChange={(modelId) => onUpdate({ [field]: modelId } as Partial<ClaudeCodeConfig>)}
            placeholder={selectModelPlaceholder}
          />
        </FieldBlock>
      ))}

      <FieldBlock
        label={t('aiCoding.permissionOptions')}
        description={t('aiCoding.permissionOptionsDesc')}
      >
        <label className="flex max-w-2xl cursor-pointer items-start gap-3 rounded-lg border border-border/70 bg-muted/20 p-3 text-sm">
          <Checkbox
            checked={permissionOptions.includes('dangerouslySkipPermissions')}
            onCheckedChange={(checked) =>
              updatePermissionOption('dangerouslySkipPermissions', Boolean(checked))
            }
            className="mt-0.5"
          />
          <span className="min-w-0">
            <span className="block font-medium">{t('aiCoding.fullAccessPermission')}</span>
            <span className="mt-1 block text-xs text-muted-foreground">
              {t('aiCoding.fullAccessPermissionDesc')}
            </span>
          </span>
        </label>
      </FieldBlock>

      <section className="rounded-lg border border-border/70 bg-muted/20 p-3 text-xs">
        <div className="mb-2 flex items-center justify-between">
          <span className="font-medium">{t('aiCoding.resolvedEnvironment')}</span>
          <Badge variant={status.valid ? 'secondary' : 'outline'} className="h-5 rounded px-1.5">
            {t(statusLabelKey(status))}
          </Badge>
        </div>
        <div className="space-y-1 text-muted-foreground">
          <div>
            {t('aiCoding.command')}:{' '}
            {permissionOptions.includes('dangerouslySkipPermissions')
              ? 'claude --dangerously-skip-permissions'
              : 'claude'}
          </div>
          <div>ANTHROPIC_AUTH_TOKEN: {maskSecret(provider?.apiKey ?? '')}</div>
          <div>ANTHROPIC_BASE_URL: {provider?.baseUrl || '-'}</div>
        </div>
      </section>
    </div>
  )
}

function CodexEditor({
  config,
  groups,
  onUpdate
}: {
  config: CodexConfig
  groups: AiCodingProviderModelGroup[]
  onUpdate: (patch: Partial<CodexConfig>) => void
}): React.JSX.Element {
  const { t } = useTranslation('settings')
  const provider = useProviderStore((state) =>
    state.providers.find((candidate) => candidate.id === config.providerId)
  )
  const status = validateCodexConfig(config)
  const selectedGroup = groups.find(({ provider: item }) => item.id === config.providerId)
  const firstModel = selectedGroup?.models[0]?.id ?? ''
  const updateProvider = (providerId: string): void => {
    const group = groups.find(({ provider: item }) => item.id === providerId)
    onUpdate({ providerId, modelId: group?.models[0]?.id ?? '' })
  }

  return (
    <div className="space-y-5">
      <FieldBlock label={t('aiCoding.configName')}>
        <Input
          value={config.name}
          onChange={(event) => onUpdate({ name: event.target.value })}
          className="max-w-md"
        />
      </FieldBlock>

      <FieldBlock label={t('aiCoding.provider')} description={t('aiCoding.codexProviderDesc')}>
        <ProviderSelect groups={groups} value={config.providerId} onChange={updateProvider} />
      </FieldBlock>

      <FieldBlock label={t('aiCoding.model')} description={t('aiCoding.codexModelDesc')}>
        <ModelSelect
          groups={groups}
          providerId={config.providerId}
          value={config.modelId || firstModel}
          onChange={(modelId) => onUpdate({ modelId })}
          placeholder={t('aiCoding.selectModel')}
        />
      </FieldBlock>

      <section className="rounded-lg border border-border/70 bg-muted/20 p-3 text-xs">
        <div className="mb-2 flex items-center justify-between">
          <span className="font-medium">{t('aiCoding.resolvedCodexConfig')}</span>
          <Badge variant={status.valid ? 'secondary' : 'outline'} className="h-5 rounded px-1.5">
            {t(statusLabelKey(status))}
          </Badge>
        </div>
        <div className="space-y-1 text-muted-foreground">
          <div>
            {t('aiCoding.apiKey')}: {maskSecret(provider?.apiKey ?? '')}
          </div>
          <div>
            {t('aiCoding.baseUrl')}: {provider?.baseUrl || '-'}
          </div>
        </div>
      </section>
    </div>
  )
}

export function AiCodingPanel({
  kind,
  hideHeader = false
}: {
  kind: AiCodingPanelKind
  /** Set when a host page already renders the title, e.g. the merged AI Coding tab. */
  hideHeader?: boolean
}): React.JSX.Element {
  const { t } = useTranslation('settings')
  const settings = useSettingsStore()
  const providers = useProviderStore((state) => state.providers)
  const groups = useMemo(
    () =>
      kind === 'claude'
        ? getClaudeCodeProviderGroups(providers)
        : getCodexProviderGroups(providers),
    [kind, providers]
  )
  const configs = kind === 'claude' ? settings.claudeCodeConfigs : settings.codexConfigs
  const [activeId, setActiveId] = useState(configs[0]?.id ?? '')

  useEffect(() => {
    if (configs.some((config) => config.id === activeId)) return
    setActiveId(configs[0]?.id ?? '')
  }, [activeId, configs])

  const activeConfig = configs.find((config) => config.id === activeId) ?? configs[0]

  const updateConfigs = (nextConfigs: typeof configs): void => {
    if (kind === 'claude') {
      settings.updateSettings({ claudeCodeConfigs: nextConfigs as ClaudeCodeConfig[] })
      return
    }
    settings.updateSettings({ codexConfigs: nextConfigs as CodexConfig[] })
  }

  const handleAdd = (): void => {
    const id = createId(kind)
    const nextConfig =
      kind === 'claude'
        ? {
            ...createDefaultClaudeCodeConfig(),
            id,
            name: t('aiCoding.defaultConfigName', { index: configs.length + 1 })
          }
        : {
            ...createDefaultCodexConfig(),
            id,
            name: t('aiCoding.defaultConfigName', { index: configs.length + 1 })
          }
    updateConfigs([
      ...(configs as Array<ClaudeCodeConfig | CodexConfig>),
      nextConfig
    ] as typeof configs)
    setActiveId(id)
  }

  const handleCopy = (id: string): void => {
    const target = configs.find((config) => config.id === id)
    if (!target) return
    const nextConfig = {
      ...target,
      id: createId(kind),
      name: t('aiCoding.copyName', { name: target.name })
    }
    updateConfigs([
      ...(configs as Array<ClaudeCodeConfig | CodexConfig>),
      nextConfig
    ] as typeof configs)
    setActiveId(nextConfig.id)
  }

  const handleDelete = (id: string): void => {
    if (configs.length <= 1) return
    const nextConfigs = configs.filter((config) => config.id !== id) as typeof configs
    updateConfigs(nextConfigs)
    if (id === activeId) setActiveId(nextConfigs[0]?.id ?? '')
  }

  const handleUpdate = (patch: Partial<ClaudeCodeConfig> | Partial<CodexConfig>): void => {
    if (!activeConfig) return
    updateConfigs(
      configs.map((config) =>
        config.id === activeConfig.id ? { ...config, ...patch } : config
      ) as typeof configs
    )
  }

  const getStatus = (config: ClaudeCodeConfig | CodexConfig): AiCodingConfigStatus =>
    kind === 'claude'
      ? validateClaudeCodeConfig(config as ClaudeCodeConfig)
      : validateCodexConfig(config as CodexConfig)

  return (
    <div className="space-y-6">
      {hideHeader ? null : (
        <div>
          <h2 className="text-lg font-semibold">
            {kind === 'claude' ? t('aiCoding.claudeTitle') : t('aiCoding.codexTitle')}
          </h2>
          <p className="text-sm text-muted-foreground">
            {kind === 'claude' ? t('aiCoding.claudeSubtitle') : t('aiCoding.codexSubtitle')}
          </p>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
        <ConfigList
          configs={configs}
          activeId={activeConfig?.id ?? ''}
          onSelect={setActiveId}
          onAdd={handleAdd}
          onCopy={handleCopy}
          onDelete={handleDelete}
          canDelete={configs.length > 1}
          getStatus={getStatus}
        />

        <div className="min-w-0 rounded-lg border border-border/70 bg-card/40 p-4">
          {groups.length === 0 ? (
            <div className="mb-4 rounded-md border border-dashed p-4 text-xs text-muted-foreground">
              {kind === 'claude' ? t('aiCoding.noClaudeProviders') : t('aiCoding.noCodexProviders')}
            </div>
          ) : null}
          {activeConfig && kind === 'claude' ? (
            <ClaudeCodeEditor
              config={activeConfig as ClaudeCodeConfig}
              groups={groups}
              onUpdate={(patch) => handleUpdate(patch)}
            />
          ) : activeConfig ? (
            <CodexEditor
              config={activeConfig as CodexConfig}
              groups={groups}
              onUpdate={(patch) => handleUpdate(patch)}
            />
          ) : null}
        </div>
      </div>
    </div>
  )
}
