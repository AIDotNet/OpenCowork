import * as React from 'react'
import { ArrowRight, FolderOpen, Monitor, Server } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { useSshStore } from '@renderer/stores/ssh-store'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { cn } from '@renderer/lib/utils'
import { useSettingsStore } from '@renderer/stores/settings-store'

const DEFAULT_SSH_WORKDIR = ''
const SOURCE_TAB_TRANSITION = { duration: 0.18, ease: 'easeOut' } as const
const SOURCE_PANEL_TRANSITION = { duration: 0.16, ease: 'easeOut' } as const

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

function sanitizeProjectName(rawName: string): string {
  const cleaned = rawName
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || 'New Project'
}

function deriveProjectNameFromFolder(folderPath: string, fallbackName: string): string {
  const normalized = folderPath.trim().replace(/[\\/]+$/, '')
  const parts = normalized.split(/[\\/]/).filter(Boolean)
  const name = parts[parts.length - 1]
  return name ? sanitizeProjectName(name) : fallbackName
}

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
  const [sshDirInputs, setSshDirInputs] = React.useState<Record<string, string>>({})
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
  const displayedProjectName = pendingSelection
    ? deriveProjectNameFromFolder(pendingSelection.folderPath, suggestedProjectName)
    : suggestedProjectName
  const preferredDirectoryLabel =
    preferredDirectory || t('input.systemDefaultLocation', { defaultValue: 'System default' })

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

  const handleChangeSection = React.useCallback(
    (section: 'local' | 'ssh'): void => {
      setActiveSection(section)
      if (!createMode) return
      setPendingSelection((current) => (current?.kind === section ? current : null))
    },
    [createMode]
  )

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
        return
      }
      await onSelectSshFolder(folderPath, connectionId)
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
      <DialogContent className="p-4 sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {createMode ? t('input.createProject') : t('input.selectFolder')}
          </DialogTitle>
        </DialogHeader>

        <div className="-mt-1 rounded-xl border bg-background/60 p-3">
          {createMode ? (
            <>
              <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <p className="text-[10px] text-muted-foreground/70">{t('input.projectName')}</p>
                  <div className="mt-1 flex items-center gap-1.5 text-[13px] font-medium text-foreground">
                    <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{displayedProjectName}</span>
                  </div>
                  <p className="mt-1 text-[10px] text-muted-foreground/60">
                    {t('input.createProjectSubtitle', {
                      defaultValue:
                        'Choose a local or SSH folder. The project name follows the folder name.'
                    })}
                  </p>
                </div>

                <div className="w-full shrink-0 sm:w-44">
                  <p className="text-[10px] text-muted-foreground/70">
                    {t('input.projectSource', { defaultValue: 'Project source' })}
                  </p>
                  <div className="mt-1 grid grid-cols-2 rounded-lg border border-border/70 bg-muted/20 p-0.5">
                    <button
                      className={cn(
                        'rounded-md px-2 py-1 text-[11px] transition-colors',
                        showLocalSection
                          ? 'bg-background text-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground'
                      )}
                      onClick={() => handleChangeSection('local')}
                    >
                      {t('input.sourceLocal', { defaultValue: 'Local' })}
                    </button>
                    <button
                      className={cn(
                        'rounded-md px-2 py-1 text-[11px] transition-colors',
                        showSshSection
                          ? 'bg-background text-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground'
                      )}
                      onClick={() => handleChangeSection('ssh')}
                    >
                      {t('input.sourceSsh', { defaultValue: 'SSH' })}
                    </button>
                  </div>
                </div>
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

          {createMode && showLocalSection ? (
            <button
              className="group mb-3 flex w-full items-center gap-3 rounded-lg border border-primary/25 bg-primary/5 px-3 py-3 text-left transition-colors hover:border-primary/40 hover:bg-primary/10"
              onClick={() => void handleSelectOtherFolder()}
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <FolderOpen className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[12px] font-medium text-foreground">
                  {t('input.selectLocalProjectFolder', {
                    defaultValue: 'Select local working folder'
                  })}
                </div>
                <div className="text-[10px] text-muted-foreground/70">
                  {t('input.selectLocalProjectFolderHint', {
                    defaultValue:
                      'Open the system folder picker. It starts from your last/default project location.'
                  })}
                </div>
              </div>
              <ArrowRight className="size-4 shrink-0 text-primary/70 transition-transform group-hover:translate-x-0.5" />
            </button>
          ) : null}

          {!createMode || showLocalSection ? (
            <>
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

              <div
                className={cn(
                  'max-h-40 overflow-y-auto pr-1',
                  createMode ? 'grid grid-cols-2 gap-1.5' : 'flex flex-wrap gap-1.5'
                )}
              >
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
                          createMode ? 'justify-start' : '',
                          selected
                            ? 'border-primary/60 bg-primary/10 text-primary'
                            : 'border-border/70 bg-muted/20 text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                        )}
                        onClick={() => void handleSelectDesktopFolder(directory.path)}
                        title={directory.path}
                      >
                        <FolderOpen className="size-3 shrink-0" />
                        <span className="truncate">{directory.name}</span>
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

              {createMode ? (
                <p className="mt-2 truncate text-[10px] text-muted-foreground/60">
                  {t('input.pickerDefaultLocation', {
                    defaultValue: 'Picker opens at: {{path}}',
                    path: preferredDirectoryLabel
                  })}
                </p>
              ) : null}
            </>
          ) : null}

          {!createMode || showSshSection ? (
            <div className={cn('border-t pt-3', createMode ? 'mt-0' : 'mt-3')}>
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
                    return (
                      <div
                        key={conn.id}
                        className={cn(
                          'flex flex-col gap-2 rounded-md border px-2 py-2 transition-colors sm:flex-row sm:items-center',
                          isSelected
                            ? 'border-primary/60 bg-primary/10'
                            : 'border-border/70 bg-muted/20 hover:bg-muted/50'
                        )}
                      >
                        <div className="flex min-w-0 flex-1 items-center gap-2">
                          <Server className="size-3 shrink-0 text-muted-foreground/60" />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[11px] font-medium">{conn.name}</div>
                            <div className="truncate text-[9px] text-muted-foreground/50">
                              {conn.username}@{conn.host}:{conn.port}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 sm:w-64">
                          <Input
                            aria-label={t('input.sshDirectory')}
                            value={dirValue}
                            onChange={(event) =>
                              setSshDirInputs((prev) => ({
                                ...prev,
                                [conn.id]: event.target.value
                              }))
                            }
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') void handleSelectSshFolder(conn.id)
                            }}
                            placeholder={t('input.sshDirectoryPlaceholder', {
                              defaultValue: '/home/user/project'
                            })}
                            className="h-7 min-w-0 flex-1 bg-background/60 text-[10px]"
                          />
                          <button
                            className="shrink-0 rounded-md border border-primary/50 bg-primary/10 px-2 py-1 text-[10px] font-medium text-primary transition-colors hover:bg-primary/15"
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
          ) : null}

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
                  {pendingSelection
                    ? t('input.createProject')
                    : t('input.selectFolderFirst', { defaultValue: 'Select a folder first' })}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
