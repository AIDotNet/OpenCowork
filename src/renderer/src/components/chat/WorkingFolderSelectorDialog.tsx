import * as React from 'react'
import { ArrowRight, FolderOpen, Monitor, Pencil, Server } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { Switch } from '@renderer/components/ui/switch'
import { useSshStore } from '@renderer/stores/ssh-store'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { cn } from '@renderer/lib/utils'
import { useSettingsStore } from '@renderer/stores/settings-store'

const DEFAULT_SSH_WORKDIR = ''

interface DesktopDirectoryOption {
  name: string
  path: string
  isDesktop: boolean
}

interface DesktopDirectorySuccessResult {
  desktopPath: string
  directories: DesktopDirectoryOption[]
}

interface DesktopDirectoryErrorResult {
  error: string
}

type DesktopDirectoryResult = DesktopDirectorySuccessResult | DesktopDirectoryErrorResult

type PendingSelection =
  | { kind: 'local'; folderPath: string }
  | { kind: 'ssh'; folderPath: string; connectionId: string }

interface WorkingFolderSelectorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workingFolder?: string
  sshConnectionId?: string | null
  projectName?: string
  createMode?: boolean
  preferredSection?: 'local' | 'ssh'
  onSelectLocalFolder: (folderPath: string) => void | Promise<void>
  onSelectSshFolder: (folderPath: string, connectionId: string) => void | Promise<void>
}

export function WorkingFolderSelectorDialog({
  open,
  onOpenChange,
  workingFolder,
  sshConnectionId,
  projectName,
  createMode = false,
  preferredSection = 'local',
  onSelectLocalFolder,
  onSelectSshFolder
}: WorkingFolderSelectorDialogProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  const { t: tCommon } = useTranslation('common')
  const { t: tLayout } = useTranslation('layout')
  const sshConnections = useSshStore((state) => state.connections)
  const sshLoaded = useSshStore((state) => state._loaded)
  const projectDefaultDirectoryMode = useSettingsStore((state) => state.projectDefaultDirectoryMode)
  const projectDefaultDirectory = useSettingsStore((state) => state.projectDefaultDirectory)
  const lastProjectDirectory = useSettingsStore((state) => state.lastProjectDirectory)
  const updateSettings = useSettingsStore((state) => state.updateSettings)
  const [desktopDirectories, setDesktopDirectories] = React.useState<DesktopDirectoryOption[]>([])
  const [desktopDirectoriesLoading, setDesktopDirectoriesLoading] = React.useState(false)
  const [customDefaultDirectoryEnabled, setCustomDefaultDirectoryEnabled] = React.useState(false)
  const [defaultDirectoryInput, setDefaultDirectoryInput] = React.useState('')
  const [sshDirInputs, setSshDirInputs] = React.useState<Record<string, string>>({})
  const [sshDirEditingId, setSshDirEditingId] = React.useState<string | null>(null)
  const [activeSection, setActiveSection] = React.useState<'local' | 'ssh'>(preferredSection)
  const [pendingSelection, setPendingSelection] = React.useState<PendingSelection | null>(null)
  const [creatingProject, setCreatingProject] = React.useState(false)

  const loadDesktopDirectories = React.useCallback(async (): Promise<void> => {
    setDesktopDirectoriesLoading(true)
    try {
      const result = (await ipcClient.invoke(
        'fs:list-desktop-directories'
      )) as DesktopDirectoryResult
      if ('error' in result || !Array.isArray(result.directories)) {
        setDesktopDirectories([])
        return
      }
      const seen = new Set<string>()
      setDesktopDirectories(
        result.directories.filter((directory) => {
          const key = directory.path.toLowerCase()
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
      )
    } catch {
      setDesktopDirectories([])
    } finally {
      setDesktopDirectoriesLoading(false)
    }
  }, [])

  React.useEffect(() => {
    if (!open) return
    void loadDesktopDirectories()
    if (!sshLoaded) void useSshStore.getState().loadAll()
    setActiveSection(preferredSection)
  }, [loadDesktopDirectories, open, preferredSection, sshLoaded])

  React.useEffect(() => {
    if (!open) return
    setCustomDefaultDirectoryEnabled(projectDefaultDirectoryMode === 'custom')
    setDefaultDirectoryInput(projectDefaultDirectory)
  }, [open, projectDefaultDirectory, projectDefaultDirectoryMode])

  React.useEffect(() => {
    if (!open) return
    setCreatingProject(false)
    if (createMode) {
      setPendingSelection(null)
      return
    }
    if (workingFolder?.trim()) {
      if (sshConnectionId?.trim()) {
        setPendingSelection({
          kind: 'ssh',
          folderPath: workingFolder,
          connectionId: sshConnectionId
        })
        return
      }
      setPendingSelection({
        kind: 'local',
        folderPath: workingFolder
      })
      return
    }
    setPendingSelection(null)
  }, [createMode, open, sshConnectionId, workingFolder])

  const activeLocalWorkingFolder =
    createMode && pendingSelection?.kind === 'local'
      ? pendingSelection.folderPath
      : (workingFolder ?? '')
  const activeSshConnectionId =
    createMode && pendingSelection?.kind === 'ssh'
      ? pendingSelection.connectionId
      : (sshConnectionId ?? null)
  const normalizedWorkingFolder = activeLocalWorkingFolder.toLowerCase()
  const preferredDirectory =
    projectDefaultDirectoryMode === 'custom' && projectDefaultDirectory.trim()
      ? projectDefaultDirectory.trim()
      : lastProjectDirectory.trim()
  const suggestedProjectName = projectName?.trim() || 'New Project'
  const showLocalSection = activeSection === 'local'
  const showSshSection = activeSection === 'ssh'

  const deriveBaseDirectoryFromSelectedFolder = React.useCallback((folderPath: string): string => {
    const normalized = folderPath.trim().replace(/[\\/]+$/, '')
    if (!normalized) return ''

    const parent = normalized.replace(/[\\/][^\\/]+$/, '')
    if (!parent) {
      if (normalized.startsWith('/')) return '/'
      if (/^[A-Za-z]:$/.test(normalized)) return `${normalized}\\`
      return normalized
    }
    if (/^[A-Za-z]:$/.test(parent)) {
      return `${parent}\\`
    }
    return parent
  }, [])

  const persistDefaultDirectoryMode = React.useCallback(
    (enabled: boolean): void => {
      setCustomDefaultDirectoryEnabled(enabled)
      updateSettings({
        projectDefaultDirectoryMode: enabled ? 'custom' : 'last-used',
        projectDefaultDirectory: enabled ? defaultDirectoryInput.trim() : projectDefaultDirectory
      })
    },
    [defaultDirectoryInput, projectDefaultDirectory, updateSettings]
  )

  const handleDefaultDirectoryInputBlur = React.useCallback((): void => {
    updateSettings({
      projectDefaultDirectory: defaultDirectoryInput.trim(),
      projectDefaultDirectoryMode:
        customDefaultDirectoryEnabled && defaultDirectoryInput.trim() ? 'custom' : 'last-used'
    })
  }, [customDefaultDirectoryEnabled, defaultDirectoryInput, updateSettings])

  const handleSelectOtherFolder = React.useCallback(async (): Promise<void> => {
    const result = (await ipcClient.invoke('fs:select-folder', {
      defaultPath: preferredDirectory || undefined
    })) as {
      canceled?: boolean
      path?: string
    }
    if (result.canceled || !result.path) {
      return
    }
    if (createMode) {
      setPendingSelection({
        kind: 'local',
        folderPath: result.path
      })
      return
    }
    await onSelectLocalFolder(result.path)
    updateSettings({ lastProjectDirectory: deriveBaseDirectoryFromSelectedFolder(result.path) })
    onOpenChange(false)
  }, [
    createMode,
    deriveBaseDirectoryFromSelectedFolder,
    onOpenChange,
    onSelectLocalFolder,
    preferredDirectory,
    updateSettings
  ])

  const handlePickDefaultDirectory = React.useCallback(async (): Promise<void> => {
    const result = (await ipcClient.invoke('fs:select-folder', {
      defaultPath: defaultDirectoryInput.trim() || preferredDirectory || undefined
    })) as {
      canceled?: boolean
      path?: string
    }
    if (result.canceled || !result.path) {
      return
    }
    setDefaultDirectoryInput(result.path)
    updateSettings({
      projectDefaultDirectoryMode: 'custom',
      projectDefaultDirectory: result.path,
      lastProjectDirectory: result.path
    })
    setCustomDefaultDirectoryEnabled(true)
  }, [defaultDirectoryInput, preferredDirectory, updateSettings])

  const handleSelectDesktopFolder = React.useCallback(
    async (folderPath: string): Promise<void> => {
      if (createMode) {
        setPendingSelection({
          kind: 'local',
          folderPath
        })
        return
      }
      await onSelectLocalFolder(folderPath)
      updateSettings({ lastProjectDirectory: folderPath })
      onOpenChange(false)
    },
    [createMode, onOpenChange, onSelectLocalFolder, updateSettings]
  )

  const handleSelectSshFolder = React.useCallback(
    async (connectionId: string): Promise<void> => {
      const conn = sshConnections.find((item) => item.id === connectionId)
      if (!conn) return
      const folderPath =
        sshDirInputs[connectionId]?.trim() || conn.defaultDirectory || DEFAULT_SSH_WORKDIR
      if (createMode) {
        setPendingSelection({
          kind: 'ssh',
          folderPath,
          connectionId
        })
        setSshDirEditingId(null)
        return
      }
      await onSelectSshFolder(folderPath, connectionId)
      setSshDirEditingId(null)
      onOpenChange(false)
    },
    [createMode, onOpenChange, onSelectSshFolder, sshConnections, sshDirInputs]
  )

  const handleCreateProject = React.useCallback(async (): Promise<void> => {
    if (!createMode || !pendingSelection || creatingProject) return
    setCreatingProject(true)
    try {
      if (pendingSelection.kind === 'ssh') {
        await onSelectSshFolder(pendingSelection.folderPath, pendingSelection.connectionId)
      } else {
        updateSettings({
          lastProjectDirectory: deriveBaseDirectoryFromSelectedFolder(pendingSelection.folderPath)
        })
        await onSelectLocalFolder(pendingSelection.folderPath)
      }
      onOpenChange(false)
    } finally {
      setCreatingProject(false)
    }
  }, [
    createMode,
    creatingProject,
    deriveBaseDirectoryFromSelectedFolder,
    onOpenChange,
    onSelectLocalFolder,
    onSelectSshFolder,
    pendingSelection,
    updateSettings
  ])

  const pendingSelectionConnection =
    pendingSelection?.kind === 'ssh'
      ? sshConnections.find((item) => item.id === pendingSelection.connectionId)
      : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="p-4 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {createMode ? t('input.createProject') : t('input.selectFolder')}
          </DialogTitle>
        </DialogHeader>

        <div className="-mt-1 rounded-xl border bg-background/60 p-3">
          {createMode ? (
            <>
              <div className="mb-3 rounded-md border border-border/60 bg-muted/20 px-2 py-1.5">
                <p className="text-[10px] text-muted-foreground/70">{t('input.projectName')}</p>
                <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <FolderOpen className="size-3 shrink-0" />
                  <span className="truncate">{suggestedProjectName}</span>
                </div>
                <p className="mt-1 text-[10px] text-muted-foreground/60">
                  {t('input.projectNameHint')}
                </p>
              </div>

              <div className="mb-3 flex gap-2">
                <button
                  className={cn(
                    'flex-1 rounded-md border px-2 py-1 text-[11px] transition-colors',
                    showLocalSection
                      ? 'border-primary/60 bg-primary/10 text-primary'
                      : 'border-border/70 bg-muted/20 text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                  )}
                  onClick={() => setActiveSection('local')}
                >
                  {t('input.selectFolder')}
                </button>
                <button
                  className={cn(
                    'flex-1 rounded-md border px-2 py-1 text-[11px] transition-colors',
                    showSshSection
                      ? 'border-primary/60 bg-primary/10 text-primary'
                      : 'border-border/70 bg-muted/20 text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                  )}
                  onClick={() => setActiveSection('ssh')}
                >
                  {t('input.selectSshFolder')}
                </button>
              </div>
            </>
          ) : (
            <div className="mb-2 rounded-md border border-border/60 bg-muted/20 px-2 py-1.5">
              <p className="text-[10px] text-muted-foreground/70">
                {t('input.currentWorkingFolder')}
              </p>
              <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <FolderOpen className="size-3 shrink-0" />
                <span className="truncate">
                  {workingFolder ?? t('input.noWorkingFolderSelected')}
                </span>
              </div>
            </div>
          )}

          {createMode ? (
            <div className="mb-3 rounded-md border border-border/60 bg-muted/20 px-2 py-2">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[10px] font-medium text-muted-foreground/80">
                    {t('input.defaultProjectDirectory')}
                  </p>
                  <p className="text-[10px] text-muted-foreground/60">
                    {t('input.defaultProjectDirectoryHint')}
                  </p>
                </div>
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                  <span>{t('input.useCustomDirectory')}</span>
                  <Switch
                    size="sm"
                    checked={customDefaultDirectoryEnabled}
                    onCheckedChange={persistDefaultDirectoryMode}
                  />
                </div>
              </div>
              <div className="mt-2 flex items-center gap-2">
                <Input
                  value={defaultDirectoryInput}
                  onChange={(event) => setDefaultDirectoryInput(event.target.value)}
                  onBlur={handleDefaultDirectoryInputBlur}
                  placeholder={t('input.defaultProjectDirectoryPlaceholder')}
                  className="h-7 text-[11px]"
                  disabled={!customDefaultDirectoryEnabled}
                />
                <button
                  className="shrink-0 rounded-md border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => void handlePickDefaultDirectory()}
                  disabled={!customDefaultDirectoryEnabled}
                >
                  {t('input.browseDefaultDirectory')}
                </button>
              </div>
              <p className="mt-1 truncate text-[10px] text-muted-foreground/60">
                {(customDefaultDirectoryEnabled
                  ? defaultDirectoryInput.trim()
                  : preferredDirectory) || t('input.defaultProjectDirectoryFallback')}
              </p>
            </div>
          ) : null}

          {createMode ? (
            <button
              className="group mb-3 flex w-full items-center gap-3 rounded-lg border border-primary/25 bg-primary/5 px-3 py-3 text-left transition-colors hover:border-primary/40 hover:bg-primary/10"
              onClick={() => void handleSelectOtherFolder()}
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <FolderOpen className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[12px] font-medium text-foreground">
                  {t('input.selectOtherFolder')}
                </div>
                <div className="text-[10px] text-muted-foreground/70">
                  {t('input.selectOtherFolderHint')}
                </div>
              </div>
              <ArrowRight className="size-4 shrink-0 text-primary/70 transition-transform group-hover:translate-x-0.5" />
            </button>
          ) : null}

          <div className="mb-2 flex items-center justify-between gap-3">
            <p className="text-[10px] font-medium text-muted-foreground/70">
              {t('input.desktopFolders')}
            </p>
            <button
              className="text-[10px] text-muted-foreground/60 transition-colors hover:text-muted-foreground"
              onClick={() => void loadDesktopDirectories()}
            >
              {tLayout('refresh')}
            </button>
          </div>

          <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto pr-1">
            {desktopDirectoriesLoading ? (
              <span className="text-[11px] text-muted-foreground/60">
                {t('input.loadingFolders')}
              </span>
            ) : desktopDirectories.length > 0 ? (
              desktopDirectories.map((directory) => {
                const selected = directory.path.toLowerCase() === normalizedWorkingFolder
                return (
                  <button
                    key={directory.path}
                    className={cn(
                      'inline-flex max-w-full items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition-colors',
                      selected
                        ? 'border-primary/60 bg-primary/10 text-primary'
                        : 'border-border/70 bg-muted/20 text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                    )}
                    onClick={() => void handleSelectDesktopFolder(directory.path)}
                    title={directory.path}
                  >
                    <FolderOpen className="size-3 shrink-0" />
                    <span className="max-w-[260px] truncate">{directory.name}</span>
                  </button>
                )
              })
            ) : (
              <span className="text-[11px] text-muted-foreground/60">
                {t('input.noDesktopFolders')}
              </span>
            )}

            {!createMode ? (
              <button
                className="inline-flex items-center gap-1 rounded-md border border-dashed px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                onClick={() => void handleSelectOtherFolder()}
              >
                <FolderOpen className="size-3 shrink-0" />
                {t('input.selectOtherFolder')}
              </button>
            ) : null}
          </div>

          <div className="mt-3 border-t pt-3">
            <p className="mb-2 flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground/70">
              <Monitor className="size-3" />
              {t('input.sshConnections')}
            </p>
            {sshConnections.length > 0 ? (
              <div className="space-y-1.5">
                {sshConnections.map((conn) => {
                  const isSelected = activeSshConnectionId === conn.id
                  const dirValue =
                    sshDirInputs[conn.id] ?? conn.defaultDirectory ?? DEFAULT_SSH_WORKDIR
                  const displayDir = dirValue.trim() || DEFAULT_SSH_WORKDIR
                  const isEditingDir = sshDirEditingId === conn.id
                  return (
                    <div
                      key={conn.id}
                      className={cn(
                        'flex items-center gap-2 rounded-md border px-2 py-1.5 transition-colors',
                        isSelected
                          ? 'border-primary/60 bg-primary/10'
                          : 'border-border/70 bg-muted/20 hover:bg-muted/50'
                      )}
                    >
                      <Server className="size-3 shrink-0 text-muted-foreground/60" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[11px] font-medium">{conn.name}</div>
                        <div className="truncate text-[9px] text-muted-foreground/50">
                          {conn.username}@{conn.host}:{conn.port}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <button
                          className={cn(
                            'flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-all duration-200',
                            isEditingDir
                              ? 'pointer-events-none max-w-0 -translate-x-1 opacity-0'
                              : 'max-w-[180px] bg-background/40 hover:bg-muted/40'
                          )}
                          onClick={() => setSshDirEditingId(conn.id)}
                          title={displayDir}
                        >
                          <FolderOpen className="size-3 shrink-0" />
                          <span className="truncate">{displayDir}</span>
                        </button>
                        <div
                          className={cn(
                            'overflow-hidden transition-all duration-200',
                            isEditingDir
                              ? 'max-w-[200px] opacity-100'
                              : 'pointer-events-none max-w-0 opacity-0'
                          )}
                        >
                          <Input
                            value={dirValue}
                            onChange={(event) =>
                              setSshDirInputs((prev) => ({
                                ...prev,
                                [conn.id]: event.target.value
                              }))
                            }
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') void handleSelectSshFolder(conn.id)
                              if (event.key === 'Escape') setSshDirEditingId(null)
                            }}
                            placeholder={t('input.sshDirectoryPlaceholder', {
                              defaultValue: '/home/user/project'
                            })}
                            className="h-6 w-40 bg-background/60 text-[10px]"
                          />
                        </div>
                        <button
                          className={cn(
                            'shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors',
                            isEditingDir
                              ? 'border-primary/50 text-primary'
                              : 'border-border/70 hover:bg-muted/50 hover:text-foreground'
                          )}
                          onClick={() => setSshDirEditingId(isEditingDir ? null : conn.id)}
                        >
                          <Pencil className="size-3" />
                        </button>
                        <button
                          className="shrink-0 rounded-md border px-2 py-0.5 text-[10px] font-medium text-primary transition-colors hover:bg-primary/10"
                          onClick={() => void handleSelectSshFolder(conn.id)}
                        >
                          {t('input.sshSelect', {
                            defaultValue: 'Select'
                          })}
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : (
              <span className="text-[11px] text-muted-foreground/60">
                {t('input.noSshConnections', {
                  defaultValue: 'No SSH connections configured'
                })}
              </span>
            )}
          </div>

          {createMode ? (
            <div className="mt-3 border-t pt-3">
              <div className="rounded-md border border-border/60 bg-muted/20 px-2 py-2">
                <p className="text-[10px] font-medium text-muted-foreground/80">
                  {t('input.selectedWorkingFolder', {
                    defaultValue: 'Selected working folder'
                  })}
                </p>
                <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  {pendingSelection?.kind === 'ssh' ? (
                    <Server className="size-3 shrink-0" />
                  ) : (
                    <FolderOpen className="size-3 shrink-0" />
                  )}
                  <span className="truncate">
                    {pendingSelection?.folderPath || t('input.noWorkingFolderSelected')}
                  </span>
                </div>
                {pendingSelectionConnection ? (
                  <p className="mt-1 truncate text-[10px] text-muted-foreground/60">
                    {pendingSelectionConnection.name} · {pendingSelectionConnection.username}@
                    {pendingSelectionConnection.host}:{pendingSelectionConnection.port}
                  </p>
                ) : null}
              </div>

              <div className="mt-3 flex justify-end gap-2">
                <button
                  className="rounded-md border border-border/70 px-3 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                  onClick={() => onOpenChange(false)}
                >
                  {tCommon('action.cancel')}
                </button>
                <button
                  className="rounded-md border border-primary/50 bg-primary/10 px-3 py-1 text-[11px] font-medium text-primary transition-colors hover:bg-primary/15 disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => void handleCreateProject()}
                  disabled={!pendingSelection || creatingProject}
                >
                  {t('input.createProject')}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
