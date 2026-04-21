import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeftRight, PanelRightOpen, Server } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@renderer/lib/utils'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import {
  useSshStore,
  type SftpInspectorTab,
  type SftpPaneId,
  type SshConnection,
  type SshFileEntry,
  type SftpTransferTask
} from '@renderer/stores/ssh-store'
import { Button } from '@renderer/components/ui/button'
import { confirm } from '@renderer/components/ui/confirm-dialog'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger
} from '@renderer/components/ui/sheet'
import { SshFileExplorer } from './SshFileExplorer'
import { SshSftpFilePreview } from './SshSftpFilePreview'

type NameDialogState =
  | {
      mode: 'new-file' | 'new-folder'
      paneId: SftpPaneId
    }
  | {
      mode: 'rename'
      paneId: SftpPaneId
      entry: SshFileEntry
    }
  | null

function getParentPath(currentPath?: string | null): string {
  if (!currentPath || currentPath === '/') return '/'
  const trimmed = currentPath.endsWith('/') ? currentPath.slice(0, -1) : currentPath
  const index = trimmed.lastIndexOf('/')
  if (index <= 0) return '/'
  return trimmed.slice(0, index)
}

function joinRemotePath(parentPath: string, child: string): string {
  if (parentPath === '/') return `/${child}`
  return `${parentPath}/${child}`
}

function formatBytes(value?: number): string {
  if (!value || value <= 0) return '--'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let amount = value
  let index = 0
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024
    index += 1
  }
  return `${amount >= 100 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`
}

function formatTaskTitle(task: SftpTransferTask): string {
  if (task.type === 'remote-copy') return 'Remote copy'
  if (task.type === 'download') return 'Download'
  return 'Upload'
}

function HostSidebar({
  connections,
  compareMode,
  activePane,
  leftConnectionId,
  rightConnectionId,
  onSelect
}: {
  connections: SshConnection[]
  compareMode: boolean
  activePane: SftpPaneId
  leftConnectionId: string | null
  rightConnectionId: string | null
  onSelect: (connectionId: string) => void
}): React.JSX.Element {
  const { t } = useTranslation('ssh')
  const sftpConnections = useSshStore((state) => state.sftpConnections)

  return (
    <aside className="hidden w-[248px] shrink-0 flex-col border-r border-border bg-sidebar/55 xl:flex">
      <div className="border-b border-border px-4 py-5">
        <div className="text-[0.74rem] font-semibold uppercase tracking-[0.28em] text-muted-foreground">
          SFTP 2.0
        </div>
        <div className="mt-2 text-[1.15rem] font-semibold text-foreground">
          {t('workspace.sftp.sidebarTitle', { defaultValue: 'Remote Workbench' })}
        </div>
        <div className="mt-2 text-[0.8rem] leading-6 text-muted-foreground">
          {t('workspace.sftp.sidebarBody', {
            defaultValue:
              'Assign hosts to the active pane, then add a second pane only when you need compare or transfer.'
          })}
        </div>
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto px-3 py-4">
        {connections.map((connection) => {
          const state = sftpConnections[connection.id]
          const selectedOnLeft = leftConnectionId === connection.id
          const selectedOnRight = compareMode && rightConnectionId === connection.id
          const active =
            (activePane === 'left' && selectedOnLeft) || (activePane === 'right' && selectedOnRight)

          return (
            <button
              key={connection.id}
              type="button"
              className={cn(
                'w-full rounded-[20px] border px-4 py-4 text-left transition-all',
                active
                  ? 'border-primary bg-card shadow-[0_16px_36px_-24px_color-mix(in_srgb,var(--primary)_30%,transparent)]'
                  : 'border-border bg-card/90 hover:border-primary/25'
              )}
              onClick={() => onSelect(connection.id)}
            >
              <div className="flex items-start gap-3">
                <div className="flex size-11 shrink-0 items-center justify-center rounded-[14px] bg-primary text-primary-foreground shadow-[0_12px_28px_-18px_color-mix(in_srgb,var(--primary)_32%,transparent)]">
                  <Server className="size-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[0.94rem] font-semibold text-foreground">
                    {connection.name}
                  </div>
                  <div className="mt-1 truncate text-[0.76rem] text-muted-foreground">
                    {connection.username}@{connection.host}
                  </div>
                  <div className="mt-2 flex items-center gap-2 text-[11px] font-semibold">
                    {compareMode && selectedOnLeft ? (
                      <span className="rounded-full bg-primary/12 px-2 py-1 text-primary">A</span>
                    ) : null}
                    {selectedOnRight ? (
                      <span className="rounded-full bg-secondary px-2 py-1 text-secondary-foreground">
                        B
                      </span>
                    ) : null}
                    <span className="text-muted-foreground">{state?.status ?? 'idle'}</span>
                  </div>
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </aside>
  )
}

function TransferTaskList({
  tasks,
  onCancel,
  onClear
}: {
  tasks: SftpTransferTask[]
  onCancel: (taskId: string) => void
  onClear: (taskId: string) => void
}): React.JSX.Element {
  const { t } = useTranslation('ssh')

  if (tasks.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-[0.85rem] text-muted-foreground">
        {t('workspace.sftp.noTasks', { defaultValue: 'No transfer tasks yet.' })}
      </div>
    )
  }

  return (
    <div className="space-y-3 px-4 py-4">
      {tasks.map((task) => {
        const percent = task.progress?.percent ?? 0
        const active = !['done', 'error', 'canceled'].includes(task.stage)

        return (
          <div
            key={task.taskId}
            className="rounded-[22px] border border-border bg-card px-4 py-4 shadow-[0_14px_30px_-22px_color-mix(in_srgb,var(--foreground)_18%,transparent)]"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-[0.9rem] font-semibold text-foreground">
                  {formatTaskTitle(task)}
                </div>
                <div className="mt-1 truncate text-[0.76rem] text-muted-foreground">
                  {task.message || task.currentItem || task.taskId}
                </div>
                <div className="mt-1 text-[0.72rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                  {task.stage}
                </div>
              </div>

              <Button
                variant="outline"
                size="sm"
                className="h-8 rounded-[12px] border-border bg-card px-3 text-[0.72rem] font-semibold text-foreground shadow-none hover:bg-accent"
                onClick={() => (active ? onCancel(task.taskId) : onClear(task.taskId))}
              >
                {active
                  ? t('workspace.sftp.cancelTask', { defaultValue: 'Cancel' })
                  : t('workspace.sftp.clearTask', { defaultValue: 'Clear' })}
              </Button>
            </div>

            <div className="mt-4">
              <div className="h-2 rounded-full bg-muted">
                <div
                  className="h-2 rounded-full bg-primary transition-all"
                  style={{ width: `${Math.max(4, percent)}%` }}
                />
              </div>
              <div className="mt-2 flex items-center justify-between text-[0.72rem] text-muted-foreground">
                <span>{percent}%</span>
                <span>
                  {task.progress?.processedItems ?? 0}/{task.progress?.totalItems ?? 0}
                </span>
              </div>
              <div className="mt-1 text-[0.72rem] text-muted-foreground">
                {(task.progress?.currentBytes ?? 0) > 0 || (task.progress?.totalBytes ?? 0) > 0
                  ? `${formatBytes(task.progress?.currentBytes)} / ${formatBytes(task.progress?.totalBytes)}`
                  : '--'}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function InspectorPanel({
  compareMode,
  tab,
  setTab,
  tasks,
  onCancelTask,
  onClearTask,
  activePane,
  activeConnection,
  activeCurrentPath,
  activeSelection,
  onPreviewOpenFile,
  onRenameSelected,
  onDeleteSelected
}: {
  compareMode: boolean
  tab: SftpInspectorTab
  setTab: (tab: SftpInspectorTab) => void
  tasks: SftpTransferTask[]
  onCancelTask: (taskId: string) => void
  onClearTask: (taskId: string) => void
  activePane: SftpPaneId
  activeConnection: SshConnection | null
  activeCurrentPath: string | null
  activeSelection: SshFileEntry[]
  onPreviewOpenFile: (filePath: string) => void
  onRenameSelected: () => void
  onDeleteSelected: () => void
}): React.JSX.Element {
  const { t } = useTranslation('ssh')
  const singleEntry = activeSelection.length === 1 ? activeSelection[0] : null

  return (
    <div className="flex h-full min-h-0 flex-col bg-muted/30">
      <div className="border-b border-border px-4 py-4">
        <div className="flex items-center gap-2 rounded-[14px] bg-card p-1 shadow-[0_10px_24px_-18px_color-mix(in_srgb,var(--foreground)_18%,transparent)]">
          {(['details', 'tasks'] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={cn(
                'flex-1 rounded-[12px] px-3 py-2 text-[0.8rem] font-semibold transition-colors',
                tab === value
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
              )}
              onClick={() => setTab(value)}
            >
              {value === 'details'
                ? t('workspace.sftp.detailsTab', { defaultValue: 'Details' })
                : t('workspace.sftp.tasksTab', { defaultValue: 'Tasks' })}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'tasks' ? (
          <TransferTaskList tasks={tasks} onCancel={onCancelTask} onClear={onClearTask} />
        ) : singleEntry && singleEntry.type === 'file' && activeConnection ? (
          <div className="flex h-full min-h-0 flex-col">
            <div className="border-b border-border px-4 py-4">
              <div className="truncate text-[0.98rem] font-semibold text-foreground">
                {singleEntry.name}
              </div>
              <div className="mt-1 truncate text-[0.76rem] text-muted-foreground">
                {singleEntry.path}
              </div>
            </div>
            <div className="min-h-0 flex-1">
              <SshSftpFilePreview
                connectionId={activeConnection.id}
                filePath={singleEntry.path}
                workspaceRoot={activeCurrentPath}
                onOpenFile={onPreviewOpenFile}
              />
            </div>
          </div>
        ) : (
          <div className="px-4 py-4">
            <div className="rounded-[24px] border border-border bg-card px-4 py-4 shadow-[0_14px_30px_-22px_color-mix(in_srgb,var(--foreground)_18%,transparent)]">
              <div className="text-[0.82rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                {compareMode
                  ? t('workspace.sftp.activePane', { defaultValue: 'Active pane' })
                  : t('workspace.sftp.activeHost', { defaultValue: 'Current host' })}
              </div>
              <div className="mt-3 flex items-center gap-2">
                {compareMode ? (
                  <span className="rounded-full bg-primary/12 px-2 py-1 text-[0.72rem] font-semibold text-primary">
                    {activePane === 'left' ? 'A' : 'B'}
                  </span>
                ) : null}
                <span className="truncate text-[0.95rem] font-semibold text-foreground">
                  {activeConnection?.name ??
                    t('workspace.sftp.noHostSelected', { defaultValue: 'No host selected' })}
                </span>
              </div>
              <div className="mt-2 truncate text-[0.76rem] text-muted-foreground">
                {activeCurrentPath ||
                  t('workspace.sftp.noPath', { defaultValue: 'No directory selected yet.' })}
              </div>
            </div>

            <div className="mt-4 rounded-[24px] border border-border bg-card px-4 py-4 shadow-[0_14px_30px_-22px_color-mix(in_srgb,var(--foreground)_18%,transparent)]">
              <div className="text-[0.82rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                {t('workspace.sftp.selection', { defaultValue: 'Selection' })}
              </div>
              {activeSelection.length === 0 ? (
                <div className="mt-4 text-[0.82rem] text-muted-foreground">
                  {compareMode
                    ? t('workspace.sftp.selectionEmpty', {
                        defaultValue:
                          'Select files or folders in either pane to inspect or move them.'
                      })
                    : t('workspace.sftp.singleSelectionEmpty', {
                        defaultValue:
                          'Select files or folders in the current pane to inspect or move them.'
                      })}
                </div>
              ) : (
                <>
                  <div className="mt-4 flex items-center justify-between gap-3">
                    <div className="text-[0.95rem] font-semibold text-foreground">
                      {activeSelection.length}{' '}
                      {t('workspace.sftp.itemsSelected', { defaultValue: 'items selected' })}
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 rounded-[12px] border-border bg-card px-3 text-[0.74rem] font-semibold text-foreground shadow-none hover:bg-accent"
                        onClick={onRenameSelected}
                        disabled={activeSelection.length !== 1}
                      >
                        {t('fileExplorer.rename')}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 rounded-[12px] border-border bg-card px-3 text-[0.74rem] font-semibold text-foreground shadow-none hover:bg-accent"
                        onClick={onDeleteSelected}
                      >
                        {t('fileExplorer.delete')}
                      </Button>
                    </div>
                  </div>
                  <div className="mt-4 space-y-2">
                    {activeSelection.slice(0, 8).map((entry) => (
                      <div
                        key={entry.path}
                        className="flex items-center justify-between gap-3 rounded-[16px] bg-muted/50 px-3 py-2"
                      >
                        <div className="min-w-0">
                          <div className="truncate text-[0.82rem] font-semibold text-foreground">
                            {entry.name}
                          </div>
                          <div className="truncate text-[0.72rem] text-muted-foreground">
                            {entry.path}
                          </div>
                        </div>
                        <div className="text-[0.72rem] text-muted-foreground">
                          {entry.type === 'directory' ? 'dir' : formatBytes(entry.size)}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export function SshSftpWorkspace(): React.JSX.Element {
  const { t } = useTranslation('ssh')

  const connections = useSshStore((state) => state.connections)
  const sftpConnections = useSshStore((state) => state.sftpConnections)
  const sftpPaneStates = useSshStore((state) => state.sftpPaneStates)
  const sftpCompareMode = useSshStore((state) => state.sftpCompareMode)
  const sftpEntries = useSshStore((state) => state.sftpEntries)
  const sftpPageInfo = useSshStore((state) => state.sftpPageInfo)
  const sftpLoading = useSshStore((state) => state.sftpLoading)
  const sftpErrors = useSshStore((state) => state.sftpErrors)
  const sftpSelections = useSshStore((state) => state.sftpSelections)
  const sftpActivePane = useSshStore((state) => state.sftpActivePane)
  const sftpConflictPolicy = useSshStore((state) => state.sftpConflictPolicy)
  const sftpInspectorTab = useSshStore((state) => state.sftpInspectorTab)
  const transferTasks = useSshStore((state) => state.transferTasks)

  const connectSftpConnection = useSshStore((state) => state.connectSftpConnection)
  const disconnectSftpConnection = useSshStore((state) => state.disconnectSftpConnection)
  const setSftpPaneConnection = useSshStore((state) => state.setSftpPaneConnection)
  const setSftpPanePath = useSshStore((state) => state.setSftpPanePath)
  const setSftpCompareMode = useSshStore((state) => state.setSftpCompareMode)
  const setSftpActivePane = useSshStore((state) => state.setSftpActivePane)
  const loadSftpEntries = useSshStore((state) => state.loadSftpEntries)
  const loadMoreSftpEntries = useSshStore((state) => state.loadMoreSftpEntries)
  const setSftpSelection = useSshStore((state) => state.setSftpSelection)
  const toggleSftpSelection = useSshStore((state) => state.toggleSftpSelection)
  const clearSftpSelection = useSshStore((state) => state.clearSftpSelection)
  const setSftpConflictPolicy = useSshStore((state) => state.setSftpConflictPolicy)
  const setSftpInspectorTab = useSshStore((state) => state.setSftpInspectorTab)
  const startTransfer = useSshStore((state) => state.startTransfer)
  const cancelTransfer = useSshStore((state) => state.cancelTransfer)
  const clearTransferTask = useSshStore((state) => state.clearTransferTask)

  const [compactPane, setCompactPane] = useState<SftpPaneId>('left')
  const [sheetOpen, setSheetOpen] = useState(false)
  const [nameDialog, setNameDialog] = useState<NameDialogState>(null)
  const [draftName, setDraftName] = useState('')

  const leftPane = sftpPaneStates.left
  const rightPane = sftpPaneStates.right
  const activePaneId = sftpCompareMode ? sftpActivePane : 'left'

  const getConnection = useCallback(
    (connectionId: string | null) =>
      connectionId
        ? (connections.find((connection) => connection.id === connectionId) ?? null)
        : null,
    [connections]
  )

  const activePane = activePaneId === 'left' ? leftPane : rightPane
  const activeConnection = getConnection(activePane.connectionId)
  const activeSelection = Object.values(sftpSelections[activePaneId] ?? {})

  const orderedTasks = useMemo(
    () => Object.values(transferTasks).sort((left, right) => right.updatedAt - left.updatedAt),
    [transferTasks]
  )

  const paneEntries = useCallback(
    (paneId: SftpPaneId) => {
      const pane = sftpPaneStates[paneId]
      if (!pane.connectionId || !pane.currentPath) return []
      return sftpEntries[pane.connectionId]?.[pane.currentPath] ?? []
    },
    [sftpEntries, sftpPaneStates]
  )

  const paneLoading = useCallback(
    (paneId: SftpPaneId) => {
      const pane = sftpPaneStates[paneId]
      if (!pane.connectionId || !pane.currentPath) return false
      return sftpLoading[pane.connectionId]?.[pane.currentPath] ?? false
    },
    [sftpLoading, sftpPaneStates]
  )

  const paneError = useCallback(
    (paneId: SftpPaneId) => {
      const pane = sftpPaneStates[paneId]
      if (!pane.connectionId || !pane.currentPath) return null
      return sftpErrors[pane.connectionId]?.[pane.currentPath] ?? null
    },
    [sftpErrors, sftpPaneStates]
  )

  const paneHasMore = useCallback(
    (paneId: SftpPaneId) => {
      const pane = sftpPaneStates[paneId]
      if (!pane.connectionId || !pane.currentPath) return false
      return sftpPageInfo[pane.connectionId]?.[pane.currentPath]?.hasMore ?? false
    },
    [sftpPageInfo, sftpPaneStates]
  )

  useEffect(() => {
    const visiblePanes = sftpCompareMode ? (['left', 'right'] as const) : (['left'] as const)

    visiblePanes.forEach((paneId) => {
      const pane = sftpPaneStates[paneId]
      if (!pane.connectionId) return
      const connection = connections.find((item) => item.id === pane.connectionId)
      const preferredPath =
        pane.currentPath ??
        sftpConnections[pane.connectionId]?.homeDir ??
        connection?.defaultDirectory ??
        '/'

      if (preferredPath !== pane.currentPath) {
        setSftpPanePath(paneId, preferredPath)
        return
      }

      if (
        !sftpConnections[pane.connectionId] ||
        sftpConnections[pane.connectionId]?.status === 'idle'
      ) {
        void connectSftpConnection(pane.connectionId)
        return
      }

      if (
        sftpConnections[pane.connectionId]?.status === 'connected' &&
        preferredPath &&
        !sftpLoading[pane.connectionId]?.[preferredPath] &&
        !Object.prototype.hasOwnProperty.call(
          sftpEntries[pane.connectionId] ?? {},
          preferredPath
        ) &&
        !sftpErrors[pane.connectionId]?.[preferredPath]
      ) {
        void loadSftpEntries(pane.connectionId, preferredPath)
      }
    })
  }, [
    connectSftpConnection,
    connections,
    loadSftpEntries,
    setSftpPanePath,
    sftpCompareMode,
    sftpConnections,
    sftpEntries,
    sftpErrors,
    sftpLoading,
    sftpPaneStates
  ])

  useEffect(() => {
    if (sftpCompareMode) return
    if (sftpActivePane !== 'left') setSftpActivePane('left')
    if (compactPane !== 'left') setCompactPane('left')
  }, [compactPane, setSftpActivePane, sftpActivePane, sftpCompareMode])

  const handleAssignConnection = useCallback(
    (connectionId: string) => {
      setSftpPaneConnection(activePaneId, connectionId)
      setCompactPane(activePaneId)
    },
    [activePaneId, setSftpPaneConnection]
  )

  const handlePaneConnectionChange = useCallback(
    (paneId: SftpPaneId, connectionId: string | null) => {
      setSftpActivePane(paneId)
      setSftpPaneConnection(paneId, connectionId)
      if (paneId !== compactPane) setCompactPane(paneId)
    },
    [compactPane, setSftpActivePane, setSftpPaneConnection]
  )

  const handleEnableCompareMode = useCallback(() => {
    setSftpCompareMode(true)
    setSftpActivePane('right')
    setCompactPane('right')

    if (rightPane.connectionId) return

    const fallbackConnectionId =
      connections.find((connection) => connection.id !== leftPane.connectionId)?.id ?? null

    if (fallbackConnectionId) {
      setSftpPaneConnection('right', fallbackConnectionId)
    }
  }, [
    connections,
    leftPane.connectionId,
    rightPane.connectionId,
    setSftpActivePane,
    setSftpCompareMode,
    setSftpPaneConnection
  ])

  const handleDisableCompareMode = useCallback(() => {
    setSftpCompareMode(false)
    setSftpActivePane('left')
    setCompactPane('left')
  }, [setSftpActivePane, setSftpCompareMode])

  const handleNavigate = useCallback(
    (paneId: SftpPaneId, path: string) => {
      const pane = sftpPaneStates[paneId]
      if (!pane.connectionId) return
      setSftpActivePane(paneId)
      setSftpPanePath(paneId, path)
      clearSftpSelection(paneId)
      void loadSftpEntries(pane.connectionId, path)
    },
    [clearSftpSelection, loadSftpEntries, setSftpActivePane, setSftpPanePath, sftpPaneStates]
  )

  const handleGoUp = useCallback(
    (paneId: SftpPaneId) => {
      const pane = sftpPaneStates[paneId]
      if (!pane.currentPath) return
      handleNavigate(paneId, getParentPath(pane.currentPath))
    },
    [handleNavigate, sftpPaneStates]
  )

  const handleRefresh = useCallback(
    (paneId: SftpPaneId) => {
      const pane = sftpPaneStates[paneId]
      if (!pane.connectionId || !pane.currentPath) return
      void loadSftpEntries(pane.connectionId, pane.currentPath, true)
    },
    [loadSftpEntries, sftpPaneStates]
  )

  const handleUpload = useCallback(
    async (paneId: SftpPaneId, kind: 'file' | 'folder') => {
      const pane = sftpPaneStates[paneId]
      if (!pane.connectionId || !pane.currentPath) return
      const channel = kind === 'file' ? IPC.FS_SELECT_FILE : IPC.FS_SELECT_FOLDER
      const selected = await ipcClient.invoke(channel)
      if (!selected || typeof selected !== 'object') return
      if ((selected as { canceled?: boolean }).canceled) return
      const localPath = (selected as { path?: string }).path
      if (!localPath) return

      const taskId = await startTransfer({
        type: 'upload',
        connectionId: pane.connectionId,
        remoteDir: pane.currentPath,
        localPaths: [localPath],
        conflictPolicy: sftpConflictPolicy
      })
      if (!taskId) {
        toast.error('Transfer failed')
        return
      }
      setSftpInspectorTab('tasks')
    },
    [setSftpInspectorTab, sftpConflictPolicy, sftpPaneStates, startTransfer]
  )

  const handleDownloadSelection = useCallback(
    async (paneId: SftpPaneId) => {
      const pane = sftpPaneStates[paneId]
      const selection = Object.values(sftpSelections[paneId] ?? {})
      if (!pane.connectionId || selection.length === 0) return

      const selected = await ipcClient.invoke(IPC.FS_SELECT_FOLDER)
      if (!selected || typeof selected !== 'object') return
      if ((selected as { canceled?: boolean }).canceled) return
      const localDir = (selected as { path?: string }).path
      if (!localDir) return

      const taskId = await startTransfer({
        type: 'download',
        connectionId: pane.connectionId,
        remotePaths: selection.map((entry) => entry.path),
        localDir,
        conflictPolicy: sftpConflictPolicy
      })
      if (!taskId) {
        toast.error('Transfer failed')
        return
      }
      setSftpInspectorTab('tasks')
    },
    [setSftpInspectorTab, sftpConflictPolicy, sftpPaneStates, sftpSelections, startTransfer]
  )

  const handleRemoteCopy = useCallback(
    async (sourcePaneId: SftpPaneId) => {
      const targetPaneId: SftpPaneId = sourcePaneId === 'left' ? 'right' : 'left'
      const sourcePane = sftpPaneStates[sourcePaneId]
      const targetPane = sftpPaneStates[targetPaneId]
      const selection = Object.values(sftpSelections[sourcePaneId] ?? {})
      if (
        !sourcePane.connectionId ||
        !targetPane.connectionId ||
        !targetPane.currentPath ||
        selection.length === 0
      ) {
        return
      }

      const taskId = await startTransfer({
        type: 'remote-copy',
        sourceConnectionId: sourcePane.connectionId,
        targetConnectionId: targetPane.connectionId,
        sourcePaths: selection.map((entry) => entry.path),
        targetDir: targetPane.currentPath,
        conflictPolicy: sftpConflictPolicy
      })
      if (!taskId) {
        toast.error('Transfer failed')
        return
      }
      setSftpInspectorTab('tasks')
    },
    [setSftpInspectorTab, sftpConflictPolicy, sftpPaneStates, sftpSelections, startTransfer]
  )

  const openNameDialog = useCallback((state: NameDialogState) => {
    setNameDialog(state)
    if (!state) {
      setDraftName('')
      return
    }
    setDraftName(state.mode === 'rename' ? state.entry.name : '')
  }, [])

  const handleNameDialogSubmit = useCallback(async () => {
    if (!nameDialog) return
    const name = draftName.trim()
    if (!name) return

    const pane = sftpPaneStates[nameDialog.paneId]
    if (!pane.connectionId) return

    try {
      if (nameDialog.mode === 'rename') {
        const targetPath = joinRemotePath(getParentPath(nameDialog.entry.path), name)
        const result = await ipcClient.invoke(IPC.SSH_FS_MOVE, {
          connectionId: pane.connectionId,
          from: nameDialog.entry.path,
          to: targetPath
        })
        if (result && typeof result === 'object' && 'error' in result) {
          throw new Error(String((result as { error?: string }).error ?? 'Rename failed'))
        }
        clearSftpSelection(nameDialog.paneId)
      } else if (nameDialog.mode === 'new-folder') {
        const result = await ipcClient.invoke(IPC.SSH_FS_MKDIR, {
          connectionId: pane.connectionId,
          path: joinRemotePath(pane.currentPath ?? '/', name)
        })
        if (result && typeof result === 'object' && 'error' in result) {
          throw new Error(String((result as { error?: string }).error ?? 'Create failed'))
        }
      } else {
        const result = await ipcClient.invoke(IPC.SSH_FS_WRITE_FILE, {
          connectionId: pane.connectionId,
          path: joinRemotePath(pane.currentPath ?? '/', name),
          content: ''
        })
        if (result && typeof result === 'object' && 'error' in result) {
          throw new Error(String((result as { error?: string }).error ?? 'Create failed'))
        }
      }

      openNameDialog(null)
      if (pane.currentPath) {
        void loadSftpEntries(pane.connectionId, pane.currentPath, true)
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Action failed')
    }
  }, [clearSftpSelection, draftName, loadSftpEntries, nameDialog, openNameDialog, sftpPaneStates])

  const handleDeleteEntry = useCallback(
    async (paneId: SftpPaneId, entry: SshFileEntry) => {
      const pane = sftpPaneStates[paneId]
      if (!pane.connectionId) return
      const confirmed = await confirm({
        title: t('fileExplorer.deleteConfirm', { name: entry.name }),
        variant: 'destructive'
      })
      if (!confirmed) return

      const result = await ipcClient.invoke(IPC.SSH_FS_DELETE, {
        connectionId: pane.connectionId,
        path: entry.path
      })
      if (result && typeof result === 'object' && 'error' in result) {
        toast.error(String((result as { error?: string }).error ?? 'Delete failed'))
        return
      }

      clearSftpSelection(paneId)
      if (pane.currentPath) {
        void loadSftpEntries(pane.connectionId, pane.currentPath, true)
      }
    },
    [clearSftpSelection, loadSftpEntries, sftpPaneStates, t]
  )

  const handleDeleteSelected = useCallback(async () => {
    const entries = Object.values(sftpSelections[activePaneId] ?? {})
    for (const entry of entries) {
      await handleDeleteEntry(activePaneId, entry)
    }
  }, [activePaneId, handleDeleteEntry, sftpSelections])

  const handleRenameSelected = useCallback(() => {
    const selection = Object.values(sftpSelections[activePaneId] ?? {})
    if (selection.length !== 1) return
    openNameDialog({ mode: 'rename', paneId: activePaneId, entry: selection[0] })
  }, [activePaneId, openNameDialog, sftpSelections])

  const handlePreviewOpenFile = useCallback(
    (filePath: string) => {
      const pane = sftpPaneStates[activePaneId]
      if (!pane.connectionId) return
      const parentPath = getParentPath(filePath)
      setSftpPanePath(activePaneId, parentPath)
      setSftpSelection(activePaneId, [
        {
          name: filePath.split('/').pop() || filePath,
          path: filePath,
          type: 'file',
          size: 0,
          modifyTime: 0
        }
      ])
      void loadSftpEntries(pane.connectionId, parentPath)
    },
    [activePaneId, loadSftpEntries, setSftpPanePath, setSftpSelection, sftpPaneStates]
  )

  const renderPane = (paneId: SftpPaneId): React.JSX.Element => {
    const pane = sftpPaneStates[paneId]
    const connection = getConnection(pane.connectionId)
    const state = pane.connectionId ? sftpConnections[pane.connectionId] : undefined

    return (
      <SshFileExplorer
        active={activePaneId === paneId}
        connections={connections}
        connection={connection}
        paneState={pane}
        connectionState={state}
        entries={paneEntries(paneId)}
        loading={paneLoading(paneId)}
        error={paneError(paneId)}
        hasMore={paneHasMore(paneId)}
        selectedEntries={sftpSelections[paneId] ?? {}}
        onActivatePane={() => setSftpActivePane(paneId)}
        onSelectConnection={(connectionId) => handlePaneConnectionChange(paneId, connectionId)}
        onConnect={() => {
          if (!pane.connectionId) return
          void connectSftpConnection(pane.connectionId)
        }}
        onDisconnect={() => {
          if (!pane.connectionId) return
          void disconnectSftpConnection(pane.connectionId)
        }}
        onOpenTerminal={() => {
          if (!pane.connectionId) return
          void useSshStore.getState().openTerminalTab(pane.connectionId)
        }}
        onNavigate={(path) => handleNavigate(paneId, path)}
        onGoUp={() => handleGoUp(paneId)}
        onRefresh={() => handleRefresh(paneId)}
        onLoadMore={() => {
          if (!pane.connectionId || !pane.currentPath) return
          void loadMoreSftpEntries(pane.connectionId, pane.currentPath)
        }}
        onSelectOnly={(entry) => {
          setSftpActivePane(paneId)
          setSftpSelection(paneId, [entry])
        }}
        onToggleSelect={(entry) => {
          setSftpActivePane(paneId)
          toggleSftpSelection(paneId, entry)
        }}
        onSelectAll={(entries) => {
          setSftpActivePane(paneId)
          setSftpSelection(paneId, entries)
        }}
        onClearSelection={() => clearSftpSelection(paneId)}
        onDownloadSelection={() => void handleDownloadSelection(paneId)}
        onUploadFile={() => void handleUpload(paneId, 'file')}
        onUploadFolder={() => void handleUpload(paneId, 'folder')}
        onCreateFile={() => openNameDialog({ mode: 'new-file', paneId })}
        onCreateFolder={() => openNameDialog({ mode: 'new-folder', paneId })}
        onRenameEntry={(entry) => openNameDialog({ mode: 'rename', paneId, entry })}
        onDeleteEntry={(entry) => void handleDeleteEntry(paneId, entry)}
      />
    )
  }

  const transferBridge = (
    <div className="flex flex-col items-center justify-center gap-3 rounded-[26px] border border-border bg-card/92 px-4 py-5 shadow-[0_18px_40px_-28px_color-mix(in_srgb,var(--foreground)_18%,transparent)]">
      <div className="text-center">
        <div className="text-[0.76rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
          {t('workspace.sftp.transferBridge', { defaultValue: 'Transfer bridge' })}
        </div>
        <div className="mt-2 text-[0.86rem] font-semibold text-foreground">
          {Object.keys(sftpSelections.left).length} A / {Object.keys(sftpSelections.right).length} B
        </div>
      </div>

      <Select
        value={sftpConflictPolicy}
        onValueChange={(value) => setSftpConflictPolicy(value as typeof sftpConflictPolicy)}
      >
        <SelectTrigger className="h-10 w-full rounded-[14px] border-border bg-card px-3 text-[0.76rem] text-foreground shadow-none">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="skip">
            {t('workspace.sftp.conflict.skip', { defaultValue: 'Skip conflict' })}
          </SelectItem>
          <SelectItem value="overwrite">
            {t('workspace.sftp.conflict.overwrite', { defaultValue: 'Overwrite' })}
          </SelectItem>
          <SelectItem value="duplicate">
            {t('workspace.sftp.conflict.duplicate', { defaultValue: 'Duplicate copy' })}
          </SelectItem>
        </SelectContent>
      </Select>

      <Button
        className="h-11 w-full rounded-[16px] bg-primary text-[0.82rem] font-semibold text-primary-foreground hover:bg-primary/90"
        onClick={() => void handleRemoteCopy('left')}
        disabled={
          Object.keys(sftpSelections.left).length === 0 ||
          !leftPane.connectionId ||
          !rightPane.connectionId ||
          !rightPane.currentPath
        }
      >
        <ArrowLeftRight className="size-4" />
        {t('workspace.sftp.sendToRight', { defaultValue: 'A to B' })}
      </Button>

      <Button
        variant="outline"
        className="h-11 w-full rounded-[16px] border-border bg-card text-[0.82rem] font-semibold text-foreground shadow-none hover:bg-accent"
        onClick={() => void handleRemoteCopy('right')}
        disabled={
          Object.keys(sftpSelections.right).length === 0 ||
          !leftPane.connectionId ||
          !leftPane.currentPath ||
          !rightPane.connectionId
        }
      >
        <ArrowLeftRight className="size-4" />
        {t('workspace.sftp.sendToLeft', { defaultValue: 'B to A' })}
      </Button>
    </div>
  )

  return (
    <div className="flex h-full min-w-0 overflow-hidden bg-background text-foreground">
      <HostSidebar
        connections={connections}
        compareMode={sftpCompareMode}
        activePane={activePaneId}
        leftConnectionId={leftPane.connectionId}
        rightConnectionId={rightPane.connectionId}
        onSelect={handleAssignConnection}
      />

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="border-b border-border px-4 py-4">
          <div className="flex flex-wrap items-center gap-3">
            <div>
              <div className="text-[1.08rem] font-semibold text-foreground">
                {t('workspace.sftp.title', { defaultValue: 'SFTP remote workbench' })}
              </div>
              <div className="mt-1 text-[0.82rem] text-muted-foreground">
                {sftpCompareMode
                  ? t('workspace.sftp.compareSubtitle', {
                      defaultValue:
                        'Browse two remote hosts side by side, then move files with one transfer model.'
                    })
                  : t('workspace.sftp.subtitle', {
                      defaultValue:
                        'Start with one remote host, then add a second pane only when you need cross-host transfer.'
                    })}
              </div>
            </div>

            <div className="ml-auto flex items-center gap-2">
              <Button
                variant={sftpCompareMode ? 'outline' : 'default'}
                size="sm"
                className={cn(
                  'h-9 rounded-[12px] px-3 text-[0.76rem] font-semibold',
                  sftpCompareMode
                    ? 'border-border bg-card text-foreground shadow-none hover:bg-accent'
                    : 'bg-primary text-primary-foreground hover:bg-primary/90'
                )}
                onClick={sftpCompareMode ? handleDisableCompareMode : handleEnableCompareMode}
              >
                <ArrowLeftRight className="size-4" />
                {sftpCompareMode
                  ? t('workspace.sftp.disableCompare', { defaultValue: 'Single-pane mode' })
                  : t('workspace.sftp.enableCompare', { defaultValue: 'Add second pane' })}
              </Button>

              {sftpCompareMode ? (
                <div className="flex items-center gap-2 xl:hidden">
                  {(['left', 'right'] as const).map((paneId, index) => (
                    <Button
                      key={paneId}
                      variant={compactPane === paneId ? 'default' : 'outline'}
                      size="sm"
                      className={cn(
                        'h-9 rounded-[12px] px-3 text-[0.76rem] font-semibold',
                        compactPane === paneId
                          ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                          : 'border-border bg-card text-foreground shadow-none hover:bg-accent'
                      )}
                      onClick={() => setCompactPane(paneId)}
                    >
                      {index === 0 ? 'A' : 'B'}
                    </Button>
                  ))}
                </div>
              ) : null}

              <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
                <SheetTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9 rounded-[12px] border-border bg-card px-3 text-[0.76rem] font-semibold text-foreground shadow-none hover:bg-accent 2xl:hidden"
                  >
                    <PanelRightOpen className="size-4" />
                    {t('workspace.sftp.panel', { defaultValue: 'Panel' })}
                  </Button>
                </SheetTrigger>
                <SheetContent className="w-[92vw] sm:max-w-lg">
                  <SheetHeader>
                    <SheetTitle>
                      {t('workspace.sftp.panel', { defaultValue: 'Details and tasks' })}
                    </SheetTitle>
                  </SheetHeader>
                  <div className="mt-4 min-h-0 h-[calc(100vh-7rem)]">
                    <InspectorPanel
                      compareMode={sftpCompareMode}
                      tab={sftpInspectorTab}
                      setTab={setSftpInspectorTab}
                      tasks={orderedTasks}
                      onCancelTask={(taskId) => void cancelTransfer(taskId)}
                      onClearTask={clearTransferTask}
                      activePane={activePaneId}
                      activeConnection={activeConnection}
                      activeCurrentPath={activePane.currentPath}
                      activeSelection={activeSelection}
                      onPreviewOpenFile={handlePreviewOpenFile}
                      onRenameSelected={handleRenameSelected}
                      onDeleteSelected={() => void handleDeleteSelected()}
                    />
                  </div>
                </SheetContent>
              </Sheet>
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden p-4">
          <div className="flex h-full min-w-0 gap-4">
            <div className="min-w-0 flex-1">
              <div className={cn('h-full xl:block', compactPane !== 'left' && 'hidden xl:block')}>
                {renderPane('left')}
              </div>
            </div>

            {sftpCompareMode ? (
              <>
                <div className="hidden w-[172px] shrink-0 xl:flex">{transferBridge}</div>

                <div className="min-w-0 flex-1">
                  <div
                    className={cn('h-full xl:block', compactPane !== 'right' && 'hidden xl:block')}
                  >
                    {renderPane('right')}
                  </div>
                </div>
              </>
            ) : null}

            <aside className="hidden w-[400px] shrink-0 overflow-hidden rounded-[28px] border border-border bg-card/70 shadow-[0_22px_48px_-30px_color-mix(in_srgb,var(--foreground)_18%,transparent)] 2xl:flex">
              <InspectorPanel
                compareMode={sftpCompareMode}
                tab={sftpInspectorTab}
                setTab={setSftpInspectorTab}
                tasks={orderedTasks}
                onCancelTask={(taskId) => void cancelTransfer(taskId)}
                onClearTask={clearTransferTask}
                activePane={activePaneId}
                activeConnection={activeConnection}
                activeCurrentPath={activePane.currentPath}
                activeSelection={activeSelection}
                onPreviewOpenFile={handlePreviewOpenFile}
                onRenameSelected={handleRenameSelected}
                onDeleteSelected={() => void handleDeleteSelected()}
              />
            </aside>
          </div>

          {sftpCompareMode ? <div className="mt-4 xl:hidden">{transferBridge}</div> : null}
        </div>
      </div>

      <Dialog open={Boolean(nameDialog)} onOpenChange={(open) => !open && openNameDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {nameDialog?.mode === 'rename'
                ? t('fileExplorer.rename')
                : nameDialog?.mode === 'new-folder'
                  ? t('fileExplorer.newFolder')
                  : t('fileExplorer.newFile')}
            </DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <Input value={draftName} onChange={(event) => setDraftName(event.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => openNameDialog(null)}>
              {t('workspace.sftp.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button onClick={() => void handleNameDialogSubmit()}>
              {t('workspace.sftp.confirm', { defaultValue: 'Confirm' })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
