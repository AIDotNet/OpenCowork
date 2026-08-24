import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, RefreshCw, Save, Wand2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { Textarea } from '@renderer/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { confirm } from '@renderer/components/ui/confirm-dialog'
import { SettingsPanel } from '../settings-primitives'
import { IPC } from '@renderer/lib/ipc/channels'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import {
  isMissingFileErrorMessage,
  joinFsPath,
  readTextFile,
  resolveGlobalMemoryHomePath
} from '@renderer/lib/agent/memory-files'
import {
  DEFAULT_BUILTIN_SOUL_TEMPLATE_ID,
  type BuiltinSoulTemplateWithContent
} from '../../../../../shared/builtin-souls'

const DEFAULT_GLOBAL_MEMORY_TEMPLATES = {
  soul: '',
  user: `# USER.md

This file captures durable user preferences and collaboration style.

## Profile
- Name:
- What to call them:
- Timezone:

## Preferences
- Preferred language:
- Preferred answer style:
- Things to avoid:
`,
  memory: `# MEMORY.md

This file stores global durable memory shared across OpenCowork sessions.

## Stable Preferences
- Add user preferences that should persist across projects.

## Durable Decisions
- Record decisions and workflow habits that should be reused.

## Long-lived Context
- Save long-term facts and defaults (non-sensitive only).

## Do Not Store
- Secrets, API keys, credentials
- Temporary debugging notes or one-off task context
`,
  daily: `# Daily Memory

Use this file for short-term notes for today.

- Decisions made today
- Temporary context worth carrying into the next session
- Follow-ups to review later and distill into MEMORY.md
`
} as const

type GlobalMemoryTabId = keyof typeof DEFAULT_GLOBAL_MEMORY_TEMPLATES

type GlobalMemoryFileState = {
  id: GlobalMemoryTabId
  titleKey: string
  descriptionKey: string
  filename: string
  path: string
  savedContent: string
  draftContent: string
  missingFile: boolean
  lastSavedAt: number | null
}
const GLOBAL_MEMORY_FILE_META: Record<
  GlobalMemoryTabId,
  Pick<GlobalMemoryFileState, 'id' | 'titleKey' | 'descriptionKey'>
> = {
  soul: {
    id: 'soul',
    titleKey: 'memory.tabs.soul',
    descriptionKey: 'memory.tabDescriptions.soul'
  },
  user: {
    id: 'user',
    titleKey: 'memory.tabs.user',
    descriptionKey: 'memory.tabDescriptions.user'
  },
  memory: {
    id: 'memory',
    titleKey: 'memory.tabs.memory',
    descriptionKey: 'memory.tabDescriptions.memory'
  },
  daily: {
    id: 'daily',
    titleKey: 'memory.tabs.daily',
    descriptionKey: 'memory.tabDescriptions.daily'
  }
}

function createInitialGlobalMemoryFiles(): Record<GlobalMemoryTabId, GlobalMemoryFileState> {
  return {
    soul: {
      ...GLOBAL_MEMORY_FILE_META.soul,
      filename: 'SOUL.md',
      path: '',
      savedContent: DEFAULT_GLOBAL_MEMORY_TEMPLATES.soul,
      draftContent: DEFAULT_GLOBAL_MEMORY_TEMPLATES.soul,
      missingFile: true,
      lastSavedAt: null
    },
    user: {
      ...GLOBAL_MEMORY_FILE_META.user,
      filename: 'USER.md',
      path: '',
      savedContent: DEFAULT_GLOBAL_MEMORY_TEMPLATES.user,
      draftContent: DEFAULT_GLOBAL_MEMORY_TEMPLATES.user,
      missingFile: true,
      lastSavedAt: null
    },
    memory: {
      ...GLOBAL_MEMORY_FILE_META.memory,
      filename: 'MEMORY.md',
      path: '',
      savedContent: DEFAULT_GLOBAL_MEMORY_TEMPLATES.memory,
      draftContent: DEFAULT_GLOBAL_MEMORY_TEMPLATES.memory,
      missingFile: true,
      lastSavedAt: null
    },
    daily: {
      ...GLOBAL_MEMORY_FILE_META.daily,
      filename: '',
      path: '',
      savedContent: DEFAULT_GLOBAL_MEMORY_TEMPLATES.daily,
      draftContent: DEFAULT_GLOBAL_MEMORY_TEMPLATES.daily,
      missingFile: true,
      lastSavedAt: null
    }
  }
}

function getSoulLabelTranslationKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function getIpcError(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null
  const error = (result as { error?: unknown }).error
  return typeof error === 'string' && error.trim() ? error : null
}

export function MemoryPanel(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const [memoryRootPath, setMemoryRootPath] = useState('')
  const [activeTab, setActiveTab] = useState<GlobalMemoryTabId>('soul')
  const [files, setFiles] = useState<Record<GlobalMemoryTabId, GlobalMemoryFileState>>(
    createInitialGlobalMemoryFiles
  )
  const [builtinSoulTemplates, setBuiltinSoulTemplates] = useState<
    BuiltinSoulTemplateWithContent[]
  >([])
  const [selectedBuiltinSoulId, setSelectedBuiltinSoulId] = useState(
    DEFAULT_BUILTIN_SOUL_TEMPLATE_ID
  )
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const activeFile = files[activeTab]
  const selectedBuiltinSoulTemplate = useMemo(
    () =>
      builtinSoulTemplates.find((template) => template.id === selectedBuiltinSoulId) ??
      builtinSoulTemplates[0] ??
      null,
    [builtinSoulTemplates, selectedBuiltinSoulId]
  )
  const hasUnsavedChanges = activeFile.draftContent !== activeFile.savedContent
  const canSave = activeFile.missingFile || hasUnsavedChanges
  const getBuiltinSoulTemplateName = useCallback(
    (template: BuiltinSoulTemplateWithContent): string =>
      t(`builtinSouls.templates.${template.id}.name`, {
        ns: 'common',
        defaultValue: template.name
      }),
    [t]
  )
  const getBuiltinSoulTemplateDescription = useCallback(
    (template: BuiltinSoulTemplateWithContent): string =>
      t(`builtinSouls.templates.${template.id}.description`, {
        ns: 'common',
        defaultValue: template.description
      }),
    [t]
  )
  const getBuiltinSoulCategoryLabel = useCallback(
    (category: string): string =>
      t(`builtinSouls.categories.${getSoulLabelTranslationKey(category)}`, {
        ns: 'common',
        defaultValue: category
      }),
    [t]
  )
  const getBuiltinSoulTagLabel = useCallback(
    (tag: string): string =>
      t(`builtinSouls.tags.${getSoulLabelTranslationKey(tag)}`, {
        ns: 'common',
        defaultValue: tag
      }),
    [t]
  )

  const loadBuiltinSoulTemplates = async (): Promise<BuiltinSoulTemplateWithContent[]> => {
    const result = (await ipcClient.invoke(IPC.SOULS_BUILTIN_LIST)) as {
      templates?: BuiltinSoulTemplateWithContent[]
      error?: string
    }
    const templates = Array.isArray(result.templates)
      ? result.templates.filter((template) => template.content.trim())
      : []

    if (result.error) {
      throw new Error(result.error)
    }

    setBuiltinSoulTemplates(templates)
    setSelectedBuiltinSoulId((current) => {
      if (templates.some((template) => template.id === current)) return current
      return templates[0]?.id ?? DEFAULT_BUILTIN_SOUL_TEMPLATE_ID
    })
    return templates
  }

  const loadGlobalMemoryFiles = async (): Promise<void> => {
    setLoading(true)
    try {
      let builtinTemplates: BuiltinSoulTemplateWithContent[] = []
      try {
        builtinTemplates = await loadBuiltinSoulTemplates()
      } catch (error) {
        console.error('[memory] failed to load builtin SOUL templates', error)
        setBuiltinSoulTemplates([])
      }
      const defaultSoulContent =
        builtinTemplates[0]?.content ?? DEFAULT_GLOBAL_MEMORY_TEMPLATES.soul
      const rootPath = await resolveGlobalMemoryHomePath(ipcClient)
      if (!rootPath) {
        toast.error(t('memory.resolvePathFailed'))
        setMemoryRootPath('')
        return
      }

      const today = new Date().toISOString().slice(0, 10)
      const descriptors = {
        soul: { filename: 'SOUL.md', path: joinFsPath(rootPath, 'SOUL.md') },
        user: { filename: 'USER.md', path: joinFsPath(rootPath, 'USER.md') },
        memory: { filename: 'MEMORY.md', path: joinFsPath(rootPath, 'MEMORY.md') },
        daily: {
          filename: `memory/${today}.md`,
          path: joinFsPath(rootPath, 'memory', `${today}.md`)
        }
      } as const

      setMemoryRootPath(rootPath)

      const nextEntries = await Promise.all(
        (Object.keys(descriptors) as GlobalMemoryTabId[]).map(async (id) => {
          const descriptor = descriptors[id]
          const { content, error } = await readTextFile(ipcClient, descriptor.path)

          if (error && !isMissingFileErrorMessage(error)) {
            throw new Error(`${descriptor.filename}: ${error}`)
          }

          const normalized =
            error && isMissingFileErrorMessage(error)
              ? id === 'soul'
                ? defaultSoulContent
                : DEFAULT_GLOBAL_MEMORY_TEMPLATES[id]
              : (content ?? '')

          return [
            id,
            {
              ...GLOBAL_MEMORY_FILE_META[id],
              filename: descriptor.filename,
              path: descriptor.path,
              savedContent: normalized,
              draftContent: normalized,
              missingFile: Boolean(error && isMissingFileErrorMessage(error)),
              lastSavedAt: null
            }
          ] as const
        })
      )

      setFiles((prev) => {
        const updated = { ...prev }
        for (const [id, entry] of nextEntries) {
          updated[id] = {
            ...entry,
            lastSavedAt: prev[id].lastSavedAt
          }
        }
        return updated
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error(t('memory.loadFailed', { error: message }))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadGlobalMemoryFiles()
    // Only auto-load once when the panel mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const updateDraft = useCallback(
    (value: string) => {
      setFiles((prev) => ({
        ...prev,
        [activeTab]: {
          ...prev[activeTab],
          draftContent: value
        }
      }))
    },
    [activeTab]
  )

  const handleReset = useCallback(() => {
    setFiles((prev) => ({
      ...prev,
      [activeTab]: {
        ...prev[activeTab],
        draftContent: prev[activeTab].savedContent
      }
    }))
  }, [activeTab])

  const handleSave = useCallback(async () => {
    if (!activeFile.path) {
      toast.error(t('memory.resolvePathFailed'))
      return
    }

    setSaving(true)
    try {
      const result = await ipcClient.invoke(IPC.FS_WRITE_FILE, {
        path: activeFile.path,
        content: activeFile.draftContent
      })
      const error = getIpcError(result)
      if (error) {
        toast.error(t('memory.saveFailed', { file: activeFile.filename, error }))
        return
      }

      setFiles((prev) => ({
        ...prev,
        [activeTab]: {
          ...prev[activeTab],
          savedContent: prev[activeTab].draftContent,
          missingFile: false,
          lastSavedAt: Date.now()
        }
      }))
      toast.success(t('memory.saved', { file: activeFile.filename }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error(t('memory.saveFailed', { file: activeFile.filename, error: message }))
    } finally {
      setSaving(false)
    }
  }, [activeFile.draftContent, activeFile.filename, activeFile.path, activeTab, t])

  const handleLoadBuiltinSoulTemplate = useCallback(() => {
    if (!selectedBuiltinSoulTemplate) {
      toast.error(t('memory.builtin.missingTemplate'))
      return
    }

    const templateName = getBuiltinSoulTemplateName(selectedBuiltinSoulTemplate)
    setActiveTab('soul')
    setFiles((prev) => ({
      ...prev,
      soul: {
        ...prev.soul,
        draftContent: selectedBuiltinSoulTemplate.content
      }
    }))
    toast.success(t('memory.builtin.loaded', { name: templateName }))
  }, [getBuiltinSoulTemplateName, selectedBuiltinSoulTemplate, t])

  const handleOverwriteBuiltinSoulTemplate = useCallback(async (): Promise<void> => {
    if (!selectedBuiltinSoulTemplate) {
      toast.error(t('memory.builtin.missingTemplate'))
      return
    }

    const soulFile = files.soul
    if (!soulFile.path) {
      toast.error(t('memory.resolvePathFailed'))
      return
    }

    const templateName = getBuiltinSoulTemplateName(selectedBuiltinSoulTemplate)
    const ok = await confirm({
      title: t('memory.builtin.confirmTitle'),
      description: t('memory.builtin.confirmDescription', {
        name: templateName,
        path: soulFile.path
      }),
      confirmLabel: t('memory.builtin.confirmAction'),
      variant: 'destructive'
    })
    if (!ok) return

    setActiveTab('soul')
    setSaving(true)
    try {
      const result = await ipcClient.invoke(IPC.FS_WRITE_FILE, {
        path: soulFile.path,
        content: selectedBuiltinSoulTemplate.content
      })
      const error = getIpcError(result)
      if (error) {
        toast.error(t('memory.saveFailed', { file: soulFile.filename, error }))
        return
      }

      setFiles((prev) => ({
        ...prev,
        soul: {
          ...prev.soul,
          savedContent: selectedBuiltinSoulTemplate.content,
          draftContent: selectedBuiltinSoulTemplate.content,
          missingFile: false,
          lastSavedAt: Date.now()
        }
      }))
      toast.success(t('memory.builtin.overwriteSaved', { name: templateName }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error(t('memory.saveFailed', { file: soulFile.filename, error: message }))
    } finally {
      setSaving(false)
    }
  }, [files.soul, getBuiltinSoulTemplateName, selectedBuiltinSoulTemplate, t])

  return (
    <SettingsPanel
      title={t('memory.title')}
      description={t('memory.subtitle')}
      actions={
        <Button
          variant="outline"
          size="sm"
          className="h-8 text-xs"
          onClick={() => void loadGlobalMemoryFiles()}
          disabled={loading || saving}
        >
          <RefreshCw className={`mr-1.5 size-3.5 ${loading ? 'animate-spin' : ''}`} />
          {t('memory.reloadAction')}
        </Button>
      }
    >
      <section className="space-y-3 rounded-lg border border-border/60 bg-muted/20 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-1">
            <p className="text-sm font-medium">{t('memory.rootPathLabel')}</p>
            <p className="break-all text-xs text-muted-foreground">
              {memoryRootPath || t('memory.pathUnavailable')}
            </p>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{t('memory.effectiveHint')}</p>
      </section>

      <section className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {(Object.keys(files) as GlobalMemoryTabId[]).map((id) => {
            const entry = files[id]
            const isActive = activeTab === id
            return (
              <Button
                key={id}
                type="button"
                size="sm"
                variant={isActive ? 'default' : 'outline'}
                className="h-8 text-xs"
                onClick={() => setActiveTab(id)}
              >
                {t(entry.titleKey)}
              </Button>
            )
          })}
        </div>

        {activeTab === 'soul' ? (
          <div className="space-y-3 rounded-lg border border-border/60 bg-muted/20 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-1">
                <p className="flex items-center gap-2 text-sm font-medium">
                  <Wand2 className="size-4 text-primary" />
                  {t('memory.builtin.title')}
                </p>
                <p className="text-xs text-muted-foreground">{t('memory.builtin.subtitle')}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={handleLoadBuiltinSoulTemplate}
                  disabled={loading || saving || !selectedBuiltinSoulTemplate}
                >
                  {t('memory.builtin.loadAction')}
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => void handleOverwriteBuiltinSoulTemplate()}
                  disabled={loading || saving || !selectedBuiltinSoulTemplate}
                >
                  {t('memory.builtin.overwriteAction')}
                </Button>
              </div>
            </div>

            {builtinSoulTemplates.length > 0 ? (
              <div className="grid gap-3 lg:grid-cols-[minmax(220px,320px)_1fr]">
                <div className="space-y-2">
                  <label className="text-xs font-medium">{t('memory.builtin.selectLabel')}</label>
                  <Select value={selectedBuiltinSoulId} onValueChange={setSelectedBuiltinSoulId}>
                    <SelectTrigger className="h-9 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {builtinSoulTemplates.map((template) => (
                        <SelectItem key={template.id} value={template.id}>
                          {getBuiltinSoulTemplateName(template)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {selectedBuiltinSoulTemplate ? (
                    <div className="flex flex-wrap gap-1.5">
                      <Badge variant="outline" className="text-[10px]">
                        {getBuiltinSoulCategoryLabel(selectedBuiltinSoulTemplate.category)}
                      </Badge>
                      {selectedBuiltinSoulTemplate.tags.map((tag) => (
                        <Badge key={tag} variant="secondary" className="text-[10px]">
                          {getBuiltinSoulTagLabel(tag)}
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                </div>

                {selectedBuiltinSoulTemplate ? (
                  <div className="min-w-0 space-y-2 rounded-md border bg-background/70 p-3">
                    <div className="space-y-1">
                      <p className="text-xs font-semibold">
                        {getBuiltinSoulTemplateName(selectedBuiltinSoulTemplate)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {getBuiltinSoulTemplateDescription(selectedBuiltinSoulTemplate)}
                      </p>
                    </div>
                    <pre className="max-h-36 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted/40 p-2 font-mono text-[11px] leading-5 text-muted-foreground">
                      {selectedBuiltinSoulTemplate.content.slice(0, 1800)}
                      {selectedBuiltinSoulTemplate.content.length > 1800 ? '\n...' : ''}
                    </pre>
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
                {t('memory.builtin.unavailable')}
              </p>
            )}
          </div>
        ) : null}

        <div className="rounded-lg border border-border/60 bg-background/60 p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <label className="text-sm font-medium">{t(activeFile.titleKey)}</label>
              <p className="text-xs text-muted-foreground">{t(activeFile.descriptionKey)}</p>
              <p className="break-all text-[11px] text-muted-foreground">
                {activeFile.path || t('memory.pathUnavailable')}
              </p>
            </div>
            <span className="text-[11px] text-muted-foreground">
              {hasUnsavedChanges
                ? t('memory.unsavedChanges')
                : activeFile.lastSavedAt
                  ? t('memory.lastSavedAt', {
                      time: new Date(activeFile.lastSavedAt).toLocaleString()
                    })
                  : t('memory.upToDate')}
            </span>
          </div>

          {activeFile.missingFile && (
            <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
              {t('memory.missingFileHint', { file: activeFile.filename })}
            </p>
          )}

          <Textarea
            value={activeFile.draftContent}
            onChange={(e) => updateDraft(e.target.value)}
            placeholder={t('memory.editorPlaceholder', {
              file: activeFile.filename || t(activeFile.titleKey)
            })}
            rows={20}
            className="min-h-[420px] font-mono text-xs leading-5"
          />
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              className="h-8 text-xs"
              onClick={() => void handleSave()}
              disabled={saving || loading || !canSave}
            >
              {saving ? (
                <Loader2 className="mr-1.5 size-3.5 animate-spin" />
              ) : (
                <Save className="mr-1.5 size-3.5" />
              )}
              {saving ? t('memory.savingAction') : t('memory.saveAction')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-xs"
              onClick={handleReset}
              disabled={saving || loading || !hasUnsavedChanges}
            >
              {t('memory.resetAction')}
            </Button>
          </div>
        </div>
      </section>
    </SettingsPanel>
  )
}
