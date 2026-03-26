import * as React from 'react'
import { FolderOpen, Monitor, Pencil, Server } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { useSshStore } from '@renderer/stores/ssh-store'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { cn } from '@renderer/lib/utils'

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

interface WorkingFolderSelectorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workingFolder?: string
  sshConnectionId?: string | null
  onSelectLocalFolder: (folderPath: string) => void | Promise<void>
  onSelectSshFolder: (folderPath: string, connectionId: string) => void | Promise<void>
}

export function WorkingFolderSelectorDialog({
  open,
  onOpenChange,
  workingFolder,
  sshConnectionId,
  onSelectLocalFolder,
  onSelectSshFolder
}: WorkingFolderSelectorDialogProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  const { t: tLayout } = useTranslation('layout')
  const sshConnections = useSshStore((state) => state.connections)
  const sshLoaded = useSshStore((state) => state._loaded)
  const [desktopDirectories, setDesktopDirectories] = React.useState<DesktopDirectoryOption[]>([])
  const [desktopDirectoriesLoading, setDesktopDirectoriesLoading] = React.useState(false)
  const [sshDirInputs, setSshDirInputs] = React.useState<Record<string, string>>({})
  const [sshDirEditingId, setSshDirEditingId] = React.useState<string | null>(null)

  const loadDesktopDirectories = React.useCallback(async (): Promise<void> => {
    setDesktopDirectoriesLoading(true)
    try {
      const result = (await ipcClient.invoke('fs:list-desktop-directories')) as DesktopDirectoryResult
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
  }, [loadDesktopDirectories, open, sshLoaded])

  const normalizedWorkingFolder = workingFolder?.toLowerCase()

  const handleSelectOtherFolder = React.useCallback(async (): Promise<void> => {
    const result = (await ipcClient.invoke('fs:select-folder')) as {
      canceled?: boolean
      path?: string
    }
    if (result.canceled || !result.path) {
      return
    }
    await onSelectLocalFolder(result.path)
    onOpenChange(false)
  }, [onOpenChange, onSelectLocalFolder])

  const handleSelectDesktopFolder = React.useCallback(
    async (folderPath: string): Promise<void> => {
      await onSelectLocalFolder(folderPath)
      onOpenChange(false)
    },
    [onOpenChange, onSelectLocalFolder]
  )

  const handleSelectSshFolder = React.useCallback(
    async (connectionId: string): Promise<void> => {
      const conn = sshConnections.find((item) => item.id === connectionId)
      if (!conn) return
      const folderPath =
        sshDirInputs[connectionId]?.trim() || conn.defaultDirectory || DEFAULT_SSH_WORKDIR
      await onSelectSshFolder(folderPath, connectionId)
      setSshDirEditingId(null)
      onOpenChange(false)
    },
    [onOpenChange, onSelectSshFolder, sshConnections, sshDirInputs]
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="p-4 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {t('input.desktopFolders', {
              defaultValue: 'Desktop folders'
            })}
          </DialogTitle>
        </DialogHeader>

        <div className="-mt-1 rounded-xl border bg-background/60 p-3">
          <div className="mb-2 rounded-md border border-border/60 bg-muted/20 px-2 py-1.5">
            <p className="text-[10px] text-muted-foreground/70">
              {t('input.currentWorkingFolder', {
                defaultValue: 'Current working folder'
              })}
            </p>
            <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <FolderOpen className="size-3 shrink-0" />
              <span className="truncate">
                {workingFolder ??
                  t('input.noWorkingFolderSelected', {
                    defaultValue: 'No folder selected'
                  })}
              </span>
            </div>
          </div>

          <div className="mb-2 flex items-center justify-end">
            <button
              className="text-[10px] text-muted-foreground/60 transition-colors hover:text-muted-foreground"
              onClick={() => void loadDesktopDirectories()}
            >
              {tLayout('refresh', { defaultValue: 'Refresh' })}
            </button>
          </div>

          <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto pr-1">
            {desktopDirectoriesLoading ? (
              <span className="text-[11px] text-muted-foreground/60">
                {t('input.loadingFolders', {
                  defaultValue: 'Loading folders...'
                })}
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
                {t('input.noDesktopFolders', {
                  defaultValue: 'No folders found on Desktop'
                })}
              </span>
            )}

            <button
              className="inline-flex items-center gap-1 rounded-md border border-dashed px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
              onClick={() => void handleSelectOtherFolder()}
            >
              <FolderOpen className="size-3 shrink-0" />
              {t('input.selectOtherFolder', {
                defaultValue: 'Select other folder'
              })}
            </button>
          </div>

          <div className="mt-3 border-t pt-3">
            <p className="mb-2 flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground/70">
              <Monitor className="size-3" />
              {t('input.sshConnections', {
                defaultValue: 'SSH Connections'
              })}
            </p>
            {sshConnections.length > 0 ? (
              <div className="space-y-1.5">
                {sshConnections.map((conn) => {
                  const isSelected = sshConnectionId === conn.id
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
                            isEditingDir ? 'max-w-[200px] opacity-100' : 'pointer-events-none max-w-0 opacity-0'
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
        </div>
      </DialogContent>
    </Dialog>
  )
}
