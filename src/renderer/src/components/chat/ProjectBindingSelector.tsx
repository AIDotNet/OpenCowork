import * as React from 'react'
import { FolderOpen, Pencil, Server } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { cn } from '@renderer/lib/utils'
import { useChatStore } from '@renderer/stores/chat-store'
import { useSshStore } from '@renderer/stores/ssh-store'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'

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

export function ProjectBindingSelector({
  project,
  onSelectProject,
  onCreateProject
}: {
  project: ReturnType<typeof useChatStore.getState>['projects'][number]
  onSelectProject: (projectId: string) => void
  onCreateProject: () => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation('chat')
  const { t: tCommon } = useTranslation('common')
  const projects = useChatStore((state) => state.projects)
  const updateProjectDirectory = useChatStore((state) => state.updateProjectDirectory)
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

  const handleSelectDesktopFolder = React.useCallback(
    (folderPath: string): void => {
      updateProjectDirectory(project.id, { workingFolder: folderPath, sshConnectionId: null })
    },
    [project.id, updateProjectDirectory]
  )

  const handleSelectOtherFolder = React.useCallback(async (): Promise<void> => {
    const result = (await ipcClient.invoke('fs:select-folder')) as { canceled?: boolean; path?: string }
    if (!result.canceled && result.path) {
      updateProjectDirectory(project.id, { workingFolder: result.path, sshConnectionId: null })
    }
  }, [project.id, updateProjectDirectory])

  const handleSelectSshFolder = React.useCallback(
    (connId: string): void => {
      const conn = sshConnections.find((item) => item.id === connId)
      if (!conn) return
      const dir = sshDirInputs[connId]?.trim() || conn.defaultDirectory || DEFAULT_SSH_WORKDIR
      updateProjectDirectory(project.id, { workingFolder: dir, sshConnectionId: connId })
      setSshDirEditingId(null)
    },
    [project.id, sshConnections, sshDirInputs, updateProjectDirectory]
  )

  React.useEffect(() => {
    if (!sshLoaded) void useSshStore.getState().loadAll()
  }, [sshLoaded])

  React.useEffect(() => {
    void loadDesktopDirectories()
  }, [loadDesktopDirectories])

  const normalizedWorkingFolder = project.workingFolder?.toLowerCase()

  return (
    <div className="space-y-3">
      <div>
        <div className="mb-2 text-[11px] font-medium text-muted-foreground">{t('input.selectProject', { defaultValue: '选择项目' })}</div>
        <div className="max-h-40 space-y-1 overflow-y-auto pr-1">
          {projects.filter((item) => !item.pluginId).map((item) => (
            <button key={item.id} type="button" className={cn('flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors', item.id === project.id ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/50')} onClick={() => onSelectProject(item.id)}>
              <FolderOpen className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{item.name}</span>
            </button>
          ))}
          <button type="button" className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-primary transition-colors hover:bg-primary/10" onClick={() => void onCreateProject()}>
            <span className="size-3.5 shrink-0" />
            <span>{t('input.newProject', { defaultValue: '新建项目' })}</span>
          </button>
        </div>
      </div>
      <div className="border-t pt-3">
        <div className="mb-2 text-[11px] font-medium text-muted-foreground">{t('input.currentWorkingFolder', { defaultValue: '当前工作目录' })}</div>
        <div className="mb-2 rounded-md border border-border/60 bg-muted/20 px-2 py-1.5 text-[11px] text-muted-foreground">{project.workingFolder || project.name}</div>
        <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto pr-1">
          <button type="button" className="inline-flex items-center gap-1 rounded-md border border-dashed px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground" onClick={() => void loadDesktopDirectories()}>
            <FolderOpen className="size-3 shrink-0" />
            {tCommon('action.refresh', { defaultValue: 'Refresh' })}
          </button>
          {desktopDirectoriesLoading ? (
            <span className="text-[11px] text-muted-foreground/60">{t('input.loadingFolders', { defaultValue: 'Loading folders...' })}</span>
          ) : (
            desktopDirectories.map((directory) => (
              <button key={directory.path} type="button" className={cn('inline-flex max-w-full items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition-colors', directory.path.toLowerCase() === normalizedWorkingFolder ? 'border-primary/60 bg-primary/10 text-primary' : 'border-border/70 bg-muted/20 text-muted-foreground hover:bg-muted/50 hover:text-foreground')} onClick={() => handleSelectDesktopFolder(directory.path)} title={directory.path}>
                <FolderOpen className="size-3 shrink-0" />
                <span className="max-w-[180px] truncate">{directory.name}</span>
              </button>
            ))
          )}
          <button type="button" className="inline-flex items-center gap-1 rounded-md border border-dashed px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground" onClick={() => void handleSelectOtherFolder()}>
            <Pencil className="size-3 shrink-0" />
            {t('input.selectOtherFolder', { defaultValue: '选择其他目录' })}
          </button>
        </div>
      </div>
      <div className="border-t pt-3">
        <div className="mb-2 text-[11px] font-medium text-muted-foreground">{t('input.sshConnections', { defaultValue: 'SSH 连接' })}</div>
        {sshConnections.length > 0 ? (
          <div className="max-h-40 space-y-1.5 overflow-y-auto pr-1">
            {sshConnections.map((conn) => {
              const isSelected = project.sshConnectionId === conn.id
              const dirValue = sshDirInputs[conn.id] ?? conn.defaultDirectory ?? DEFAULT_SSH_WORKDIR
              const isEditingDir = sshDirEditingId === conn.id
              return (
                <div key={conn.id} className={cn('rounded-md border px-2 py-1.5', isSelected ? 'border-primary/60 bg-primary/10' : 'border-border/70 bg-muted/20')}>
                  <div className="flex items-center gap-2">
                    <Server className="size-3 shrink-0 text-muted-foreground/60" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[11px] font-medium">{conn.name}</div>
                      <div className="truncate text-[9px] text-muted-foreground/50">{conn.username}@{conn.host}:{conn.port}</div>
                    </div>
                    <Button variant="ghost" size="sm" className="h-6 px-2 text-[10px]" onClick={() => handleSelectSshFolder(conn.id)}>{t('input.sshSelect', { defaultValue: 'Select' })}</Button>
                  </div>
                  <div className="mt-1.5 flex items-center gap-1.5">
                    <Input value={dirValue} onFocus={() => setSshDirEditingId(conn.id)} onChange={(event) => setSshDirInputs((current) => ({ ...current, [conn.id]: event.target.value }))} onKeyDown={(event) => { if (event.key === 'Enter') handleSelectSshFolder(conn.id); if (event.key === 'Escape') setSshDirEditingId(null) }} placeholder={t('input.sshDirectoryPlaceholder', { defaultValue: '/home/user/project' })} className={cn('h-7 text-[10px]', isEditingDir ? 'border-primary/50' : 'border-border/60')} />
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <span className="text-[11px] text-muted-foreground/60">{t('input.noSshConnections', { defaultValue: 'No SSH connections configured' })}</span>
        )}
      </div>
    </div>
  )
}
