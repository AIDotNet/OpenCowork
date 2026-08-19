import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Eye, EyeOff, FolderPlus, FolderOpen, Trash2, Puzzle, Save, Shapes } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { Input } from '@renderer/components/ui/input'
import { Switch } from '@renderer/components/ui/switch'
import { Separator } from '@renderer/components/ui/separator'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '@renderer/components/ui/dialog'
import { confirm } from '@renderer/components/ui/confirm-dialog'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { useExtensionStore, type ExtensionAggregateInfo } from '@renderer/stores/extension-store'
import { refreshExtensionTools } from '@renderer/lib/extensions/extension-tools'
import { SettingsPanel } from './settings-primitives'
import { SkillsMarketPanel } from './SkillsMarketPanel'
import type { ExtensionInstance } from '../../../../shared/extension-types'

type TranslateFn = (key: string, options?: Record<string, unknown>) => string

function hasBundledResources(info: ExtensionAggregateInfo): boolean {
  const { skills, agents, commands, mcpServers } = info.declared
  return skills > 0 || agents > 0 || commands > 0 || mcpServers > 0
}

function formatBundledCounts(info: ExtensionAggregateInfo, t: TranslateFn): string {
  const { skills, agents, commands, mcpServers } = info.declared
  const parts: string[] = []
  if (skills > 0) {
    parts.push(t('extension.bundledSkills', { defaultValue: '{{count}} skills', count: skills }))
  }
  if (info.workflows.length > 0) {
    parts.push(
      t('extension.bundledWorkflows', {
        defaultValue: '{{count}} workflows',
        count: info.workflows.length
      })
    )
  }
  if (agents > 0) {
    parts.push(t('extension.bundledAgents', { defaultValue: '{{count}} agents', count: agents }))
  }
  if (commands > 0) {
    parts.push(
      t('extension.bundledCommands', { defaultValue: '{{count}} commands', count: commands })
    )
  }
  if (mcpServers > 0) {
    parts.push(
      t('extension.bundledMcp', { defaultValue: '{{count}} MCP servers', count: mcpServers })
    )
  }
  return parts.join(' · ')
}

function countReadOnlyTools(extension: ExtensionInstance): number {
  return extension.manifest.tools.filter((tool) => {
    if (typeof tool.readOnly === 'boolean') return tool.readOnly
    if (tool.kind === 'http') return (tool.http?.method ?? 'GET').toUpperCase() === 'GET'
    return false
  }).length
}

/** Compact clickable card shown in the grid. Opens the detail dialog on click. */
function ExtensionCard({
  extension,
  onOpen
}: {
  extension: ExtensionInstance
  onOpen: () => void
}): React.JSX.Element {
  const { t } = useTranslation('settings')
  const updateExtension = useExtensionStore((state) => state.updateExtension)

  const toolCount = extension.manifest.tools.length
  const componentCount = extension.manifest.components?.length ?? 0
  const rendererCount = extension.manifest.renderers?.length ?? 0

  const handleToggle = async (enabled: boolean): Promise<void> => {
    const result = await updateExtension(extension.id, { enabled })
    if (!result.success) {
      toast.error(t('extension.updateFailed', { defaultValue: 'Failed to update extension' }), {
        description: result.error
      })
      return
    }
    if (result.syncWarnings && result.syncWarnings.length > 0) {
      toast.warning(
        t('extension.syncWarnings', { defaultValue: 'Some bundled resources were not synced' }),
        { description: result.syncWarnings.join('\n') }
      )
    }
    await refreshExtensionTools()
  }

  return (
    <section
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen()
        }
      }}
      className="group flex cursor-pointer flex-col rounded-xl border border-border/60 bg-background p-4 text-left outline-none transition-colors hover:border-border hover:bg-muted/20 focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/35">
          <Puzzle className="size-5 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="truncate text-base font-semibold text-foreground">
              {extension.manifest.name}
            </h3>
            <Badge variant="outline" className="shrink-0">
              v{extension.manifest.version}
            </Badge>
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{extension.id}</p>
        </div>
        <div onClick={(event) => event.stopPropagation()} className="shrink-0">
          <Switch
            checked={extension.enabled}
            onCheckedChange={(value) => void handleToggle(value)}
          />
        </div>
      </div>

      {extension.manifest.description ? (
        <p className="mt-3 line-clamp-2 text-sm leading-6 text-muted-foreground">
          {extension.manifest.description}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <Badge variant={extension.enabled ? 'secondary' : 'outline'}>
          {extension.enabled
            ? t('extension.enabled', { defaultValue: 'Enabled' })
            : t('extension.disabled', { defaultValue: 'Disabled' })}
        </Badge>
        <Badge variant="outline">
          {toolCount} {t('extension.tools', { defaultValue: 'Tools' })}
        </Badge>
        {componentCount > 0 ? (
          <Badge variant="outline">
            {componentCount} {t('extension.components', { defaultValue: 'Components' })}
          </Badge>
        ) : null}
        {rendererCount > 0 ? (
          <Badge variant="outline">
            {rendererCount} {t('extension.renderers', { defaultValue: 'Renderers' })}
          </Badge>
        ) : null}
      </div>
    </section>
  )
}

/** Full detail view rendered inside a dialog when a card is opened. */
function ExtensionDetailDialog({
  extension,
  open,
  onOpenChange
}: {
  extension: ExtensionInstance
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const { t } = useTranslation('settings')
  const updateExtension = useExtensionStore((state) => state.updateExtension)
  const removeExtension = useExtensionStore((state) => state.removeExtension)
  const openExtensionFolder = useExtensionStore((state) => state.openExtensionFolder)
  const getAggregateInfo = useExtensionStore((state) => state.getAggregateInfo)
  const [config, setConfig] = useState<Record<string, string>>(extension.config)
  const [saving, setSaving] = useState(false)
  const [visibleSecrets, setVisibleSecrets] = useState<Record<string, boolean>>({})
  const [aggregate, setAggregate] = useState<ExtensionAggregateInfo | null>(null)

  useEffect(() => {
    setConfig(extension.config)
  }, [extension.config])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void getAggregateInfo(extension.id).then((info) => {
      if (!cancelled) setAggregate(info)
    })
    return () => {
      cancelled = true
    }
  }, [open, extension.id, extension.updatedAt, getAggregateInfo])

  const configFields = extension.manifest.configSchema ?? []
  const network = extension.manifest.permissions?.network ?? []
  const components = extension.manifest.components ?? []
  const readOnlyTools = useMemo(() => countReadOnlyTools(extension), [extension])

  const handleToggle = async (enabled: boolean): Promise<void> => {
    const result = await updateExtension(extension.id, { enabled })
    if (!result.success) {
      toast.error(t('extension.updateFailed', { defaultValue: 'Failed to update extension' }), {
        description: result.error
      })
      return
    }
    if (result.syncWarnings && result.syncWarnings.length > 0) {
      toast.warning(
        t('extension.syncWarnings', { defaultValue: 'Some bundled resources were not synced' }),
        { description: result.syncWarnings.join('\n') }
      )
    }
    await refreshExtensionTools()
  }

  const handleSaveConfig = async (): Promise<void> => {
    setSaving(true)
    try {
      const result = await updateExtension(extension.id, { config })
      if (!result.success) {
        toast.error(t('extension.saveFailed', { defaultValue: 'Failed to save configuration' }), {
          description: result.error
        })
        return
      }
      await refreshExtensionTools()
      toast.success(t('extension.saved', { defaultValue: 'Extension configuration saved' }))
    } finally {
      setSaving(false)
    }
  }

  const handleRemove = async (): Promise<void> => {
    const ok = await confirm({
      title: t('extension.removeConfirm', { defaultValue: 'Remove this extension?' }),
      description: extension.manifest.name,
      variant: 'destructive'
    })
    if (!ok) return
    const result = await removeExtension(extension.id)
    if (!result.success) {
      toast.error(t('extension.removeFailed', { defaultValue: 'Failed to remove extension' }), {
        description: result.error
      })
      return
    }
    onOpenChange(false)
    await refreshExtensionTools()
  }

  const handleOpenFolder = async (): Promise<void> => {
    const result = await openExtensionFolder(extension.id)
    if (!result.success) {
      toast.error(t('extension.openFolderFailed', { defaultValue: 'Failed to open folder' }), {
        description: result.error
      })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] gap-0 overflow-y-auto p-0 sm:max-w-3xl">
        <DialogHeader className="border-b border-border/60 p-5 pb-4">
          <div className="flex items-start gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/35">
              <Puzzle className="size-5 text-muted-foreground" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <DialogTitle className="truncate text-lg">{extension.manifest.name}</DialogTitle>
                <Badge variant="outline" className="shrink-0">
                  v{extension.manifest.version}
                </Badge>
              </div>
              <DialogDescription className="mt-1 text-xs">{extension.id}</DialogDescription>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Badge variant={extension.enabled ? 'secondary' : 'outline'}>
                {extension.enabled
                  ? t('extension.enabled', { defaultValue: 'Enabled' })
                  : t('extension.disabled', { defaultValue: 'Disabled' })}
              </Badge>
              <Switch
                checked={extension.enabled}
                onCheckedChange={(value) => void handleToggle(value)}
              />
            </div>
          </div>
        </DialogHeader>

        <div className="p-5 pt-4">
          {extension.manifest.description ? (
            <p className="text-sm leading-6 text-muted-foreground">
              {extension.manifest.description}
            </p>
          ) : null}

          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-lg border border-border/50 bg-muted/15 p-3">
              <div className="text-xs font-medium text-muted-foreground">
                {t('extension.tools', { defaultValue: 'Tools' })}
              </div>
              <div className="mt-1 text-lg font-semibold">{extension.manifest.tools.length}</div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                {t('extension.readOnlyCount', {
                  defaultValue: '{{count}} read-only',
                  count: readOnlyTools
                })}
              </div>
            </div>
            <div className="rounded-lg border border-border/50 bg-muted/15 p-3">
              <div className="text-xs font-medium text-muted-foreground">
                {t('extension.renderers', { defaultValue: 'Renderers' })}
              </div>
              <div className="mt-1 text-lg font-semibold">
                {extension.manifest.renderers?.length ?? 0}
              </div>
            </div>
            <div className="rounded-lg border border-border/50 bg-muted/15 p-3">
              <div className="text-xs font-medium text-muted-foreground">
                {t('extension.components', { defaultValue: 'Components' })}
              </div>
              <div className="mt-1 text-lg font-semibold">{components.length}</div>
              <div className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
                <Shapes className="size-3" />
                {t('extension.hostRendered', { defaultValue: 'host-rendered' })}
              </div>
            </div>
            <div className="rounded-lg border border-border/50 bg-muted/15 p-3">
              <div className="text-xs font-medium text-muted-foreground">
                {t('extension.network', { defaultValue: 'Network' })}
              </div>
              <div className="mt-1 truncate text-xs text-foreground/80">
                {network.length > 0
                  ? network.join(', ')
                  : t('extension.noNetwork', { defaultValue: 'No network access' })}
              </div>
            </div>
            {aggregate && hasBundledResources(aggregate) ? (
              <div className="rounded-lg border border-border/50 bg-muted/15 p-3">
                <div className="text-xs font-medium text-muted-foreground">
                  {t('extension.bundled', { defaultValue: 'Bundled resources' })}
                </div>
                <div className="mt-1 truncate text-xs text-foreground/80">
                  {formatBundledCounts(aggregate, t)}
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  {aggregate.synced
                    ? t('extension.bundledSynced', { defaultValue: 'Synced' })
                    : t('extension.bundledNotSynced', { defaultValue: 'Not synced' })}
                </div>
              </div>
            ) : null}
          </div>

          {configFields.length > 0 ? (
            <>
              <Separator className="my-4" />
              <div className="grid gap-3 md:grid-cols-2">
                {configFields.map((field) => {
                  const isSecret = field.type === 'secret'
                  const visible = visibleSecrets[field.key] === true
                  const value = config[field.key] ?? ''
                  const missing = field.required && !value.trim()
                  return (
                    <label key={field.key} className="grid gap-1.5 text-sm">
                      <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                        <span>
                          {field.label}
                          {field.required ? ' *' : ''}
                        </span>
                        {missing ? (
                          <Badge variant="outline" className="text-[10px] text-destructive">
                            {t('extension.required', { defaultValue: 'Required' })}
                          </Badge>
                        ) : null}
                      </span>
                      <div className="relative">
                        <Input
                          type={isSecret && !visible ? 'password' : 'text'}
                          value={value}
                          placeholder={field.placeholder}
                          onChange={(event) =>
                            setConfig((current) => ({
                              ...current,
                              [field.key]: event.target.value
                            }))
                          }
                          className={isSecret ? 'pr-9' : undefined}
                        />
                        {isSecret ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground"
                            onClick={() =>
                              setVisibleSecrets((current) => ({
                                ...current,
                                [field.key]: !current[field.key]
                              }))
                            }
                            aria-label={
                              visible
                                ? t('extension.hideSecret', { defaultValue: 'Hide secret' })
                                : t('extension.showSecret', { defaultValue: 'Show secret' })
                            }
                          >
                            {visible ? (
                              <EyeOff className="size-3.5" />
                            ) : (
                              <Eye className="size-3.5" />
                            )}
                          </Button>
                        ) : null}
                      </div>
                      {field.description ? (
                        <span className="text-xs leading-5 text-muted-foreground/80">
                          {field.description}
                        </span>
                      ) : null}
                    </label>
                  )
                })}
              </div>
              <div className="mt-3">
                <Button
                  size="sm"
                  className="gap-2"
                  onClick={() => void handleSaveConfig()}
                  disabled={saving}
                >
                  <Save className="size-3.5" />
                  {t('extension.saveConfig', { defaultValue: 'Save config' })}
                </Button>
              </div>
            </>
          ) : null}

          <Separator className="my-4" />
          <div className="grid gap-3 lg:grid-cols-2">
            <div>
              <div className="mb-2 text-xs font-medium text-muted-foreground">
                {t('extension.tools', { defaultValue: 'Tools' })}
              </div>
              <div className="extension-scroll-area max-h-72 space-y-1.5 overflow-y-auto overscroll-contain pr-1">
                {extension.manifest.tools.map((tool) => (
                  <div
                    key={tool.name}
                    className="flex items-center justify-between gap-3 rounded-md border border-border/50 px-2.5 py-2 text-xs"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-medium text-foreground">{tool.name}</div>
                      <div className="truncate text-muted-foreground">{tool.description}</div>
                    </div>
                    <Badge variant="outline">{tool.kind}</Badge>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <div className="mb-2 text-xs font-medium text-muted-foreground">
                {t('extension.renderers', { defaultValue: 'Renderers' })}
              </div>
              <div className="extension-scroll-area max-h-72 space-y-1.5 overflow-y-auto overscroll-contain pr-1">
                {(extension.manifest.renderers ?? []).length > 0 ? (
                  extension.manifest.renderers?.map((renderer) => (
                    <div
                      key={renderer.name}
                      className="flex items-center justify-between gap-3 rounded-md border border-border/50 px-2.5 py-2 text-xs"
                    >
                      <span className="font-medium text-foreground">{renderer.name}</span>
                      <span className="truncate text-muted-foreground">{renderer.entry}</span>
                    </div>
                  ))
                ) : (
                  <div className="rounded-md border border-dashed border-border/60 px-2.5 py-2 text-xs text-muted-foreground">
                    {t('extension.noRenderers', { defaultValue: 'No custom renderers' })}
                  </div>
                )}
              </div>
            </div>
            {components.length > 0 ? (
              <div className="lg:col-span-2">
                <div className="mb-2 text-xs font-medium text-muted-foreground">
                  {t('extension.components', { defaultValue: 'Components' })}
                </div>
                <div className="extension-scroll-area grid max-h-72 gap-1.5 overflow-y-auto overscroll-contain pr-1 md:grid-cols-2">
                  {components.map((component) => (
                    <div
                      key={component.name}
                      className="flex items-center justify-between gap-3 rounded-md border border-border/50 px-2.5 py-2 text-xs"
                    >
                      <div className="min-w-0">
                        <div className="truncate font-medium text-foreground">
                          {component.title ?? component.name}
                        </div>
                        {component.description ? (
                          <div className="truncate text-muted-foreground">
                            {component.description}
                          </div>
                        ) : null}
                        <div className="truncate font-mono text-[11px] text-muted-foreground/80">
                          {component.entry}
                        </div>
                      </div>
                      <Badge variant="outline">{component.type}</Badge>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          {aggregate && aggregate.workflows.length > 0 ? (
            <>
              <Separator className="my-4" />
              <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                {t('extension.workflows', { defaultValue: 'Workflows' })}
                <Badge variant="outline">{aggregate.workflows.length}</Badge>
              </div>
              <p className="mb-2 text-[11px] text-muted-foreground/80">
                {t('extension.workflowsHint', {
                  defaultValue:
                    'This plugin is one router skill that loads these workflows on demand.'
                })}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {aggregate.workflows.map((workflow) => (
                  <Badge key={workflow} variant="secondary" className="font-normal">
                    {workflow}
                  </Badge>
                ))}
              </div>
            </>
          ) : null}

          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              className="gap-2"
              onClick={() => void handleOpenFolder()}
            >
              <FolderOpen className="size-3.5" />
              {t('extension.openFolder', { defaultValue: 'Open folder' })}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              className="gap-2"
              onClick={() => void handleRemove()}
            >
              <Trash2 className="size-3.5" />
              {t('extension.remove', { defaultValue: 'Remove' })}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function ExtensionPanel(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const extensions = useExtensionStore((state) => state.extensions)
  const loaded = useExtensionStore((state) => state.loaded)
  const loadExtensions = useExtensionStore((state) => state.loadExtensions)
  const installFromFolder = useExtensionStore((state) => state.installFromFolder)
  const [openId, setOpenId] = useState<string | null>(null)

  useEffect(() => {
    void loadExtensions()
  }, [loadExtensions])

  const openExtension = useMemo(
    () => extensions.find((extension) => extension.id === openId) ?? null,
    [extensions, openId]
  )

  const handleInstall = async (): Promise<void> => {
    const selected = (await ipcClient.invoke(IPC.FS_SELECT_FOLDER)) as {
      canceled?: boolean
      path?: string
    }
    if (selected.canceled || !selected.path) return
    const result = await installFromFolder(selected.path)
    if (!result.success) {
      toast.error(t('extension.installFailed', { defaultValue: 'Failed to install extension' }), {
        description: result.error
      })
      return
    }
    await refreshExtensionTools()
    toast.success(t('extension.installed', { defaultValue: 'Extension installed' }))
  }

  return (
    <SettingsPanel
      title={t('extension.title', { defaultValue: 'Extensions' })}
      description={t('extension.subtitle', {
        defaultValue:
          'Install local extensions that add custom Agent tools and response UI components.'
      })}
      actions={
        <Button className="gap-2" onClick={() => void handleInstall()}>
          <FolderPlus className="size-4" />
          {t('extension.installFolder', { defaultValue: 'Install folder' })}
        </Button>
      }
    >
      {!loaded ? (
        <div className="rounded-xl border border-border/60 bg-background p-6 text-sm text-muted-foreground">
          {t('extension.loading', { defaultValue: 'Loading extensions...' })}
        </div>
      ) : extensions.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/70 bg-background p-8 text-center">
          <Puzzle className="mx-auto size-8 text-muted-foreground/60" />
          <div className="mt-3 text-sm font-medium text-foreground">
            {t('extension.emptyTitle', { defaultValue: 'No extensions installed' })}
          </div>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            {t('extension.emptyDesc', {
              defaultValue:
                'Choose a folder containing extension.json to add custom tools to OpenCowork.'
            })}
          </p>
        </div>
      ) : (
        <div>
          <div className="grid gap-3 sm:grid-cols-2">
            {extensions.map((extension) => (
              <ExtensionCard
                key={extension.id}
                extension={extension}
                onOpen={() => setOpenId(extension.id)}
              />
            ))}
          </div>
        </div>
      )}

      <SkillsMarketPanel />

      {openExtension ? (
        <ExtensionDetailDialog
          extension={openExtension}
          open={openId !== null}
          onOpenChange={(next) => setOpenId(next ? openExtension.id : null)}
        />
      ) : null}
    </SettingsPanel>
  )
}
