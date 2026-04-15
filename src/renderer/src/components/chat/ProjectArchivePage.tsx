import { useCallback, useEffect, useState } from 'react'
import { ChevronRight, FileText, Loader2, PanelLeftOpen, RefreshCw, Save } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import { Textarea } from '@renderer/components/ui/textarea'
import { ChannelPanel } from '@renderer/components/settings/PluginPanel'
import { useChatStore } from '@renderer/stores/chat-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { useChannelStore } from '@renderer/stores/channel-store'
import { cn } from '@renderer/lib/utils'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import {
  PROJECT_MEMORY_DIRNAME,
  getProjectMemoryCandidatePaths,
  joinFsPath,
  resolveTextFileWithFallbackPaths,
  type ProjectMemoryPathSource
} from '@renderer/lib/agent/memory-files'

const DEFAULT_PROJECT_MEMORY_TEMPLATES = {
  agents: `# AGENTS.md

在这里编写项目级工作协议、边界和协作说明。
`,
  soul: `# SOUL.md

This file refines identity, tone, and behavior for this workspace only.

## Project Overrides
- Add workspace-specific style or behavior constraints here.
- Keep system and safety rules above this file.
`,
  user: `# USER.md

This file captures workspace-specific preferences for the human you are helping.

## Current Goals
- Add project-scoped goals, expectations, or collaboration preferences here.
`,
  memory: `# MEMORY.md

This file stores project-scoped durable memory.

## Decisions
- Record stable project decisions here.

## Context
- Save long-lived workspace context here.
`,
  daily: `# Daily Memory

Use this file for short-term notes for today in this workspace.

- Temporary decisions
- Context to carry into the next session
- Follow-ups to distill into MEMORY.md
`
} as const

type ProjectMemoryTabId = keyof typeof DEFAULT_PROJECT_MEMORY_TEMPLATES

type ProjectMemoryFileState = {
  id: ProjectMemoryTabId
  title: string
  description: string
  filename: string
  path: string
  source: ProjectMemoryPathSource
  savedContent: string
  draftContent: string
  missingFile: boolean
  lastSavedAt: number | null
}

const PROJECT_MEMORY_FILE_META: Record<
  ProjectMemoryTabId,
  Pick<ProjectMemoryFileState, 'id' | 'title' | 'description'>
> = {
  agents: {
    id: 'agents',
    title: 'AGENTS.md',
    description: '项目级工作协议、边界和协作说明。'
  },
  soul: {
    id: 'soul',
    title: 'SOUL.md',
    description: '当前项目专用的人格/风格补充，优先级高于全局 SOUL.md。'
  },
  user: {
    id: 'user',
    title: 'USER.md',
    description: '当前项目下你的偏好、目标和协作方式。'
  },
  memory: {
    id: 'memory',
    title: 'MEMORY.md',
    description: '沉淀当前项目的长期记忆、决定和背景。'
  },
  daily: {
    id: 'daily',
    title: '今日记忆',
    description: '记录今天的项目临时上下文，后续可整理进 MEMORY.md。'
  }
}

function createInitialProjectMemoryFiles(): Record<ProjectMemoryTabId, ProjectMemoryFileState> {
  return {
    agents: {
      ...PROJECT_MEMORY_FILE_META.agents,
      filename: 'AGENTS.md',
      path: '',
      source: 'agents-dir',
      savedContent: DEFAULT_PROJECT_MEMORY_TEMPLATES.agents,
      draftContent: DEFAULT_PROJECT_MEMORY_TEMPLATES.agents,
      missingFile: true,
      lastSavedAt: null
    },
    soul: {
      ...PROJECT_MEMORY_FILE_META.soul,
      filename: 'SOUL.md',
      path: '',
      source: 'agents-dir',
      savedContent: DEFAULT_PROJECT_MEMORY_TEMPLATES.soul,
      draftContent: DEFAULT_PROJECT_MEMORY_TEMPLATES.soul,
      missingFile: true,
      lastSavedAt: null
    },
    user: {
      ...PROJECT_MEMORY_FILE_META.user,
      filename: 'USER.md',
      path: '',
      source: 'agents-dir',
      savedContent: DEFAULT_PROJECT_MEMORY_TEMPLATES.user,
      draftContent: DEFAULT_PROJECT_MEMORY_TEMPLATES.user,
      missingFile: true,
      lastSavedAt: null
    },
    memory: {
      ...PROJECT_MEMORY_FILE_META.memory,
      filename: 'MEMORY.md',
      path: '',
      source: 'agents-dir',
      savedContent: DEFAULT_PROJECT_MEMORY_TEMPLATES.memory,
      draftContent: DEFAULT_PROJECT_MEMORY_TEMPLATES.memory,
      missingFile: true,
      lastSavedAt: null
    },
    daily: {
      ...PROJECT_MEMORY_FILE_META.daily,
      filename: '',
      path: '',
      source: 'agents-dir',
      savedContent: DEFAULT_PROJECT_MEMORY_TEMPLATES.daily,
      draftContent: DEFAULT_PROJECT_MEMORY_TEMPLATES.daily,
      missingFile: true,
      lastSavedAt: null
    }
  }
}

function getIpcError(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null
  const error = (result as { error?: unknown }).error
  return typeof error === 'string' && error.trim() ? error : null
}

export function ProjectArchivePage(): React.JSX.Element {
  const { t } = useTranslation('chat')
  const { t: tCommon } = useTranslation('common')
  const activeProjectId = useChatStore((state) => state.activeProjectId)
  const projects = useChatStore((state) => state.projects)
  const leftSidebarOpen = useUIStore((state) => state.leftSidebarOpen)
  const toggleLeftSidebar = useUIStore((state) => state.toggleLeftSidebar)
  const chatView = useUIStore((state) => state.chatView)
  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null
  const viewMode = chatView === 'channels' ? 'channels' : 'archive'
  const loadChannels = useChannelStore((state) => state.loadChannels)
  const [memoryRootPath, setMemoryRootPath] = useState('')
  const [activeFileTab, setActiveFileTab] = useState<ProjectMemoryTabId>('agents')
  const [files, setFiles] = useState<Record<ProjectMemoryTabId, ProjectMemoryFileState>>(
    createInitialProjectMemoryFiles
  )
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const activeFile = files[activeFileTab]
  const hasUnsavedChanges = activeFile.draftContent !== activeFile.savedContent
  const canSave = activeFile.missingFile || hasUnsavedChanges

  const readProjectTextFile = useCallback(
    async (filePath: string): Promise<{ content?: string; error?: string }> => {
      if (!activeProject) {
        return { error: 'No active project selected' }
      }

      try {
        const result = activeProject.sshConnectionId
          ? await ipcClient.invoke(IPC.SSH_FS_READ_FILE, {
              connectionId: activeProject.sshConnectionId,
              path: filePath
            })
          : await ipcClient.invoke(IPC.FS_READ_FILE, { path: filePath })

        if (typeof result === 'string') {
          return { content: result }
        }

        return {
          error:
            result && typeof result === 'object' && 'error' in result
              ? String((result as { error?: unknown }).error ?? 'Failed to read file')
              : 'Failed to read file'
        }
      } catch (readError) {
        return {
          error: readError instanceof Error ? readError.message : String(readError)
        }
      }
    },
    [activeProject]
  )

  const loadProjectMemoryFiles = useCallback(async (): Promise<void> => {
    if (!activeProject?.workingFolder) {
      setLoading(false)
      setError(null)
      setMemoryRootPath('')
      setFiles(createInitialProjectMemoryFiles())
      return
    }

    setLoading(true)
    setError(null)

    try {
      const today = new Date().toISOString().slice(0, 10)
      const rootPath = joinFsPath(activeProject.workingFolder, PROJECT_MEMORY_DIRNAME)
      const descriptors = {
        agents: { filename: 'AGENTS.md', segments: ['AGENTS.md'] },
        soul: { filename: 'SOUL.md', segments: ['SOUL.md'] },
        user: { filename: 'USER.md', segments: ['USER.md'] },
        memory: { filename: 'MEMORY.md', segments: ['MEMORY.md'] },
        daily: { filename: `memory/${today}.md`, segments: ['memory', `${today}.md`] }
      } as const

      const nextEntries = await Promise.all(
        (Object.keys(descriptors) as ProjectMemoryTabId[]).map(async (id) => {
          const descriptor = descriptors[id]
          const { preferredPath, fallbackPath } = getProjectMemoryCandidatePaths(
            activeProject.workingFolder!,
            ...descriptor.segments
          )
          const resolved = await resolveTextFileWithFallbackPaths({
            readFile: readProjectTextFile,
            preferredPath,
            fallbackPath
          })

          if (resolved.error) {
            throw new Error(`${descriptor.filename}: ${resolved.error}`)
          }

          const normalized = resolved.missingFile
            ? DEFAULT_PROJECT_MEMORY_TEMPLATES[id]
            : (resolved.content ?? '')

          return [
            id,
            {
              ...PROJECT_MEMORY_FILE_META[id],
              filename: descriptor.filename,
              path: resolved.path,
              source: resolved.source,
              savedContent: normalized,
              draftContent: normalized,
              missingFile: resolved.missingFile,
              lastSavedAt: null
            }
          ] as const
        })
      )

      setMemoryRootPath(rootPath)
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
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : String(loadError)
      setError(message)
      toast.error(t('projectArchive.loadFailed', { defaultValue: '加载项目档案失败' }), {
        description: message
      })
    } finally {
      setLoading(false)
    }
  }, [activeProject, readProjectTextFile, t])

  useEffect(() => {
    if (viewMode !== 'archive') return
    void loadProjectMemoryFiles()
  }, [loadProjectMemoryFiles, viewMode])

  useEffect(() => {
    if (viewMode !== 'channels') return
    void loadChannels()
  }, [loadChannels, viewMode])

  const updateDraft = useCallback(
    (value: string) => {
      setFiles((prev) => ({
        ...prev,
        [activeFileTab]: {
          ...prev[activeFileTab],
          draftContent: value
        }
      }))
    },
    [activeFileTab]
  )

  const handleReset = useCallback(() => {
    setFiles((prev) => ({
      ...prev,
      [activeFileTab]: {
        ...prev[activeFileTab],
        draftContent: prev[activeFileTab].savedContent
      }
    }))
  }, [activeFileTab])

  const handleSave = useCallback(async () => {
    if (!activeProject || !activeFile.path) return

    setSaving(true)
    setError(null)

    try {
      const result = activeProject.sshConnectionId
        ? await ipcClient.invoke(IPC.SSH_FS_WRITE_FILE, {
            connectionId: activeProject.sshConnectionId,
            path: activeFile.path,
            content: activeFile.draftContent
          })
        : await ipcClient.invoke(IPC.FS_WRITE_FILE, {
            path: activeFile.path,
            content: activeFile.draftContent
          })

      const nextError = getIpcError(result)
      if (nextError) {
        throw new Error(nextError)
      }

      setFiles((prev) => ({
        ...prev,
        [activeFileTab]: {
          ...prev[activeFileTab],
          savedContent: prev[activeFileTab].draftContent,
          missingFile: false,
          lastSavedAt: Date.now()
        }
      }))
      toast.success(t('projectArchive.saved', { defaultValue: '项目档案已保存' }))
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : String(saveError)
      setError(message)
      toast.error(t('projectArchive.saveFailed', { defaultValue: '保存项目档案失败' }), {
        description: message
      })
    } finally {
      setSaving(false)
    }
  }, [activeFile.draftContent, activeFile.path, activeFileTab, activeProject, t])

  if (!activeProject) {
    return (
      <div className="flex flex-1 items-center justify-center px-6">
        <div className="max-w-md text-center">
          <div className="text-xl font-semibold text-foreground">
            {t('projectArchive.noProjectTitle', { defaultValue: '未选择项目' })}
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            {t('projectArchive.noProjectDesc', {
              defaultValue: '先返回首页选择项目，再查看项目档案。'
            })}
          </p>
          <Button className="mt-4" onClick={() => useUIStore.getState().navigateToHome()}>
            <ChevronRight className="size-4" />
            {t('projectArchive.backHome', { defaultValue: '返回首页' })}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div
      className={cn(
        'relative flex flex-1 flex-col overflow-hidden bg-gradient-to-b from-background via-background to-muted/20',
        viewMode === 'channels' ? 'px-4 py-4' : 'px-6 py-6'
      )}
    >
      {!leftSidebarOpen && (
        <Button
          variant="ghost"
          size="icon"
          className="absolute left-4 top-4 z-10 size-8 rounded-lg border border-border/60 bg-background/80 backdrop-blur-sm"
          onClick={toggleLeftSidebar}
        >
          <PanelLeftOpen className="size-4" />
        </Button>
      )}
      <div
        className={cn(
          'mx-auto flex h-full w-full flex-col overflow-hidden',
          viewMode === 'channels' ? 'max-w-[1500px]' : 'max-w-6xl'
        )}
      >
        <div className="flex min-h-0 flex-1 overflow-hidden rounded-3xl border border-border/60 bg-background/70 shadow-[0_24px_60px_-30px_rgba(0,0,0,0.55)] backdrop-blur-sm">
          {viewMode === 'channels' ? (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <div className="min-h-0 flex-1 overflow-hidden p-4">
                <div className="h-full min-h-0 overflow-hidden rounded-[24px] border border-border/60 bg-background/80 shadow-inner">
                  <ChannelPanel projectId={activeProjectId ?? undefined} />
                </div>
              </div>
            </div>
          ) : loading ? (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" />
              {t('projectArchive.loading', { defaultValue: '正在加载项目档案...' })}
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <div className="flex items-center justify-between gap-3 border-b px-5 py-3 text-sm">
                <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
                  <FileText className="size-4 shrink-0" />
                  <span className="truncate">
                    {memoryRootPath || activeProject.workingFolder || PROJECT_MEMORY_DIRNAME}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <div className="text-xs text-muted-foreground">
                    {hasUnsavedChanges
                      ? t('projectArchive.unsavedState', { defaultValue: '有未保存更改' })
                      : t('projectArchive.savedState', { defaultValue: '内容已同步' })}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => useUIStore.getState().navigateToProject()}
                  >
                    {t('projectArchive.backProject', { defaultValue: '返回项目主页' })}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void loadProjectMemoryFiles()}
                    disabled={loading || saving}
                  >
                    <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />
                    {tCommon('action.refresh', { defaultValue: '刷新' })}
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => void handleSave()}
                    disabled={saving || loading || !activeFile.path || !canSave}
                  >
                    {saving ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Save className="size-4" />
                    )}
                    {tCommon('action.save', { defaultValue: '保存' })}
                  </Button>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-auto p-4">
                <div className="space-y-6">
                  <section className="space-y-3 rounded-lg border border-border/60 bg-muted/20 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="space-y-1">
                        <p className="text-sm font-medium">项目记忆根目录</p>
                        <p className="break-all text-xs text-muted-foreground">
                          {memoryRootPath ||
                            t('projectArchive.pathUnavailable', { defaultValue: '路径不可用' })}
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 text-xs"
                        onClick={() => void loadProjectMemoryFiles()}
                        disabled={loading || saving}
                      >
                        <RefreshCw className={`mr-1.5 size-3.5 ${loading ? 'animate-spin' : ''}`} />
                        {t('projectArchive.reloadAction', { defaultValue: '重新加载' })}
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {t('projectArchive.effectiveHint', {
                        defaultValue:
                          '优先使用工作目录下的 .agents；若旧文件仍在工作目录根部，也会兼容读取并继续写回原处。'
                      })}
                    </p>
                  </section>

                  <section className="space-y-4">
                    <div className="flex flex-wrap gap-2">
                      {(Object.keys(files) as ProjectMemoryTabId[]).map((id) => {
                        const entry = files[id]
                        const isActive = activeFileTab === id
                        return (
                          <Button
                            key={id}
                            type="button"
                            size="sm"
                            variant={isActive ? 'default' : 'outline'}
                            className="h-8 text-xs"
                            onClick={() => setActiveFileTab(id)}
                          >
                            {entry.title}
                          </Button>
                        )
                      })}
                    </div>

                    <div className="space-y-3 rounded-lg border border-border/60 bg-background/60 p-4">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="space-y-1">
                          <label className="text-sm font-medium">{activeFile.title}</label>
                          <p className="text-xs text-muted-foreground">{activeFile.description}</p>
                          <p className="break-all text-[11px] text-muted-foreground">
                            {activeFile.path ||
                              t('projectArchive.pathUnavailable', { defaultValue: '路径不可用' })}
                          </p>
                        </div>
                        <span className="text-[11px] text-muted-foreground">
                          {hasUnsavedChanges
                            ? t('projectArchive.unsavedState', { defaultValue: '有未保存更改' })
                            : activeFile.lastSavedAt
                              ? t('projectArchive.lastSavedAt', {
                                  defaultValue: '保存于 {{time}}',
                                  time: new Date(activeFile.lastSavedAt).toLocaleString()
                                })
                              : t('projectArchive.upToDate', { defaultValue: '已是最新' })}
                        </span>
                      </div>

                      {activeFile.missingFile && (
                        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
                          {t('projectArchive.missingFileHint', {
                            defaultValue:
                              '{{file}} 尚不存在。已加载初始模板，点击保存即可创建文件。',
                            file: activeFile.filename || activeFile.title
                          })}
                        </p>
                      )}

                      {!activeFile.missingFile && activeFile.source === 'workspace-root' && (
                        <p className="rounded-md border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-xs text-blue-600 dark:text-blue-400">
                          {t('projectArchive.legacyLocationHint', {
                            defaultValue: '当前文件来自工作目录根部旧位置，保存会继续写回原处。'
                          })}
                        </p>
                      )}

                      <Textarea
                        value={activeFile.draftContent}
                        onChange={(event) => updateDraft(event.target.value)}
                        placeholder={t('projectArchive.placeholder', {
                          defaultValue: '在这里编辑 {{file}} ...',
                          file: activeFile.filename || activeFile.title
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
                          {saving
                            ? t('projectArchive.savingAction', { defaultValue: '保存中...' })
                            : tCommon('action.save', { defaultValue: '保存' })}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 text-xs"
                          onClick={handleReset}
                          disabled={saving || loading || !hasUnsavedChanges}
                        >
                          {t('projectArchive.resetAction', { defaultValue: '重置' })}
                        </Button>
                      </div>
                    </div>
                  </section>
                </div>
              </div>
              {error && (
                <div className="border-t px-5 py-3 text-sm text-destructive">
                  {t('projectArchive.errorLabel', { defaultValue: '错误：' })}
                  {error}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
