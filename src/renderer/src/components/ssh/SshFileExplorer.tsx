import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowUp,
  File,
  FileArchive,
  FileCode2,
  FileImage,
  FileJson2,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  HardDriveDownload,
  HardDriveUpload,
  Loader2,
  Pencil,
  Plug,
  Plug2,
  RefreshCw,
  SquareTerminal,
  Trash2
} from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import {
  type SftpConnectionState,
  type SftpPaneState,
  type SshConnection,
  type SshFileEntry
} from '@renderer/stores/ssh-store'
import { Button } from '@renderer/components/ui/button'
import { Checkbox } from '@renderer/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { useUIStore } from '@renderer/stores/ui-store'
import { useSshStore } from '@renderer/stores/ssh-store'

interface ModernSshFileExplorerProps {
  active: boolean
  connections: SshConnection[]
  connection: SshConnection | null
  paneState: SftpPaneState
  connectionState?: SftpConnectionState | null
  entries: SshFileEntry[]
  loading: boolean
  error?: string | null
  hasMore: boolean
  selectedEntries: Record<string, SshFileEntry>
  onActivatePane: () => void
  onSelectConnection: (connectionId: string | null) => void
  onConnect: () => void
  onDisconnect: () => void
  onOpenTerminal: () => void
  onNavigate: (path: string) => void
  onGoUp: () => void
  onRefresh: () => void
  onLoadMore: () => void
  onSelectOnly: (entry: SshFileEntry) => void
  onToggleSelect: (entry: SshFileEntry) => void
  onSelectAll: (entries: SshFileEntry[]) => void
  onClearSelection: () => void
  onDownloadSelection: () => void
  onUploadFile: () => void
  onUploadFolder: () => void
  onCreateFile: () => void
  onCreateFolder: () => void
  onRenameEntry: (entry: SshFileEntry) => void
  onDeleteEntry: (entry: SshFileEntry) => void
}

interface LegacySshFileExplorerProps {
  sessionId: string
  connectionId: string
  rootPath?: string
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '--'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let amount = value
  let index = 0
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024
    index += 1
  }
  return `${amount >= 100 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`
}

function formatModifiedTime(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '--'
  return new Date(value).toLocaleString()
}

function getParentPath(currentPath?: string | null): string {
  if (!currentPath || currentPath === '/') return '/'
  const trimmed = currentPath.endsWith('/') ? currentPath.slice(0, -1) : currentPath
  const index = trimmed.lastIndexOf('/')
  if (index <= 0) return '/'
  return trimmed.slice(0, index)
}

function buildPathSegments(value?: string | null): Array<{ label: string; path: string }> {
  const currentPath = value && value.trim() ? value.trim() : '/'
  if (currentPath === '/') return [{ label: '/', path: '/' }]

  const parts = currentPath.split('/').filter(Boolean)
  const segments: Array<{ label: string; path: string }> = [{ label: '/', path: '/' }]
  let current = ''
  for (const part of parts) {
    current = `${current}/${part}`.replace(/\/{2,}/g, '/')
    segments.push({ label: part, path: current })
  }
  return segments
}

function getEntryIcon(entry: SshFileEntry): typeof Folder {
  if (entry.type === 'directory') return Folder

  const lowered = entry.name.toLowerCase()
  const ext = lowered.split('.').pop() ?? ''

  if (['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico'].includes(ext)) return FileImage
  if (['json', 'jsonl'].includes(ext)) return FileJson2
  if (['csv', 'tsv', 'xlsx', 'xls'].includes(ext)) return FileSpreadsheet
  if (['zip', 'tar', 'gz', '7z', 'rar'].includes(ext)) return FileArchive
  if (
    [
      'ts',
      'tsx',
      'js',
      'jsx',
      'py',
      'go',
      'rs',
      'java',
      'c',
      'cpp',
      'h',
      'sh',
      'sql',
      'yaml',
      'yml',
      'toml',
      'html',
      'css',
      'scss'
    ].includes(ext)
  ) {
    return FileCode2
  }
  if (['md', 'txt', 'log', 'env', 'ini', 'conf'].includes(ext)) return FileText
  return File
}

function PaneStatus({ status }: { status?: SftpConnectionState['status'] }): React.JSX.Element {
  const statusClass =
    status === 'connected'
      ? 'bg-[#eaf7ef] text-[#217a49]'
      : status === 'connecting'
        ? 'bg-[#fff3df] text-[#b77618]'
        : status === 'error'
          ? 'bg-[#ffeaea] text-[#c54c4c]'
          : 'bg-[#edf2f7] text-[#607088]'

  return (
    <span className={cn('rounded-full px-2.5 py-1 text-[11px] font-semibold', statusClass)}>
      {status ?? 'idle'}
    </span>
  )
}

function LegacySshFileExplorer({
  connectionId,
  rootPath = '/'
}: LegacySshFileExplorerProps): React.JSX.Element {
  const { t } = useTranslation('ssh')
  const connectSftpConnection = useSshStore((state) => state.connectSftpConnection)
  const loadSftpEntries = useSshStore((state) => state.loadSftpEntries)
  const sftpEntries = useSshStore((state) => state.sftpEntries)
  const sftpLoading = useSshStore((state) => state.sftpLoading)
  const sftpErrors = useSshStore((state) => state.sftpErrors)
  const openFilePreview = useUIStore((state) => state.openFilePreview)
  const [currentPath, setCurrentPath] = useState(rootPath)

  const entries = sftpEntries[connectionId]?.[currentPath] ?? []
  const loading = sftpLoading[connectionId]?.[currentPath] ?? false
  const error = sftpErrors[connectionId]?.[currentPath] ?? null

  useEffect(() => {
    setCurrentPath(rootPath)
  }, [rootPath])

  useEffect(() => {
    void connectSftpConnection(connectionId).then(() => {
      void loadSftpEntries(connectionId, currentPath)
    })
  }, [connectSftpConnection, connectionId, currentPath, loadSftpEntries])

  return (
    <div className="flex h-full flex-col overflow-hidden bg-white">
      <div className="border-b border-[#dce4ee] px-4 py-3">
        <div className="flex items-center gap-2 rounded-[14px] border border-[#d7e0ea] bg-[#f9fbfd] px-2 py-2">
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-8 rounded-[10px] text-[#6f7f96] hover:bg-[#eef3f8]"
            onClick={() => setCurrentPath(getParentPath(currentPath))}
            disabled={currentPath === rootPath || currentPath === '/'}
          >
            <ArrowUp className="size-4" />
          </Button>
          <div className="min-w-0 flex-1 truncate text-[12px] text-[#607088]">{currentPath}</div>
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-8 rounded-[10px] text-[#6f7f96] hover:bg-[#eef3f8]"
            onClick={() => void loadSftpEntries(connectionId, currentPath, true)}
          >
            <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && entries.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="size-5 animate-spin text-[#2f8cf3]" />
          </div>
        ) : error && entries.length === 0 ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-[#8795aa]">
            {error}
          </div>
        ) : (
          <div>
            {entries.map((entry) => {
              const Icon = getEntryIcon(entry)
              return (
                <button
                  key={entry.path}
                  type="button"
                  className="grid w-full grid-cols-[minmax(0,1fr)_120px_110px] items-center px-4 py-3 text-left transition-colors hover:bg-[#f6f9fc]"
                  onClick={() => {
                    if (entry.type === 'directory') {
                      setCurrentPath(entry.path)
                    } else {
                      openFilePreview(entry.path, undefined, connectionId)
                    }
                  }}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <Icon
                      className={cn(
                        'size-4 shrink-0',
                        entry.type === 'directory' ? 'text-[#c58617]' : 'text-[#607088]'
                      )}
                    />
                    <span className="truncate text-[13px] font-medium text-[#22304a]">
                      {entry.name}
                    </span>
                  </div>
                  <div className="text-[12px] text-[#7d8ba0]">
                    {entry.type === 'directory'
                      ? t('workspace.sftp.directory', { defaultValue: 'Directory' })
                      : formatBytes(entry.size)}
                  </div>
                  <div className="truncate text-right text-[12px] text-[#7d8ba0]">
                    {formatModifiedTime(entry.modifyTime)}
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function ModernSshFileExplorer({
  active,
  connections,
  connection,
  paneState,
  connectionState,
  entries,
  loading,
  error,
  hasMore,
  selectedEntries,
  onActivatePane,
  onSelectConnection,
  onConnect,
  onDisconnect,
  onOpenTerminal,
  onNavigate,
  onGoUp,
  onRefresh,
  onLoadMore,
  onSelectOnly,
  onToggleSelect,
  onSelectAll,
  onClearSelection,
  onDownloadSelection,
  onUploadFile,
  onUploadFolder,
  onCreateFile,
  onCreateFolder,
  onRenameEntry,
  onDeleteEntry
}: ModernSshFileExplorerProps): React.JSX.Element {
  const { t } = useTranslation('ssh')
  const selectedCount = Object.keys(selectedEntries).length
  const allSelected = entries.length > 0 && entries.every((entry) => selectedEntries[entry.path])

  const breadcrumbs = useMemo(
    () => buildPathSegments(paneState.currentPath ?? connectionState?.homeDir ?? '/'),
    [connectionState?.homeDir, paneState.currentPath]
  )

  const emptyState = !connection
    ? t('workspace.sftp.paneEmpty', {
        defaultValue: 'Select a host to start browsing remote files.'
      })
    : connectionState?.status !== 'connected'
      ? t('workspace.sftp.connectHint', {
          defaultValue: 'Connect this pane before loading the remote directory.'
        })
      : t('fileExplorer.empty')

  return (
    <section
      className={cn(
        'flex h-full min-w-0 flex-col rounded-[28px] border bg-white/92 shadow-[0_22px_48px_rgba(111,133,165,0.08)]',
        active ? 'border-[#2f8cf3]' : 'border-[#d8e1eb]'
      )}
      onMouseDown={onActivatePane}
    >
      <div className="border-b border-[#dce4ee] px-4 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-[220px] flex-1">
            <Select
              value={connection?.id ?? ''}
              onValueChange={(value) => onSelectConnection(value || null)}
            >
              <SelectTrigger className="h-11 rounded-[16px] border-[#d3dbe6] bg-white px-4 text-[0.9rem] text-[#24314a] shadow-none">
                <SelectValue
                  placeholder={t('workspace.sftp.chooseHost', {
                    defaultValue: 'Choose remote host'
                  })}
                />
              </SelectTrigger>
              <SelectContent>
                {connections.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <PaneStatus status={connectionState?.status} />

          <Button
            size="sm"
            className="h-10 rounded-[14px] bg-[#2f8cf3] px-4 text-[0.82rem] font-semibold text-white hover:bg-[#247fe6]"
            onClick={onConnect}
            disabled={!connection || connectionState?.status === 'connecting'}
          >
            {connectionState?.status === 'connecting' ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Plug className="size-4" />
            )}
            {connectionState?.status === 'connected'
              ? t('workspace.sftp.connected', { defaultValue: 'Connected' })
              : t('connect')}
          </Button>

          <Button
            variant="outline"
            size="sm"
            className="h-10 rounded-[14px] border-[#d0d8e4] bg-white px-4 text-[0.82rem] font-semibold text-[#51627a] shadow-none hover:bg-[#f3f7fb]"
            onClick={onDisconnect}
            disabled={!connection || connectionState?.status !== 'connected'}
          >
            <Plug2 className="size-4" />
            {t('disconnect')}
          </Button>
        </div>

        <div className="mt-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-[1rem] font-semibold text-[#22304a]">
              {connection?.name ??
                t('workspace.sftp.paneTitle', { defaultValue: 'Remote file pane' })}
            </div>
            <div className="mt-1 truncate text-[0.78rem] text-[#8a98ac]">
              {connection
                ? `${connection.username}@${connection.host}:${connection.port}`
                : t('workspace.sftp.paneMeta', {
                    defaultValue: 'Pick a host and connect to start.'
                  })}
            </div>
          </div>

          <Button
            variant="outline"
            size="sm"
            className="h-10 rounded-[14px] border-[#d0d8e4] bg-white px-4 text-[0.82rem] font-semibold text-[#51627a] shadow-none hover:bg-[#f3f7fb]"
            onClick={onOpenTerminal}
            disabled={!connection}
          >
            <SquareTerminal className="size-4" />
            {t('openTerminal')}
          </Button>
        </div>
      </div>

      <div className="border-b border-[#dce4ee] px-4 py-3">
        <div className="flex items-center gap-2 rounded-[16px] border border-[#d7e0ea] bg-[#f9fbfd] px-2 py-2 shadow-[0_8px_20px_rgba(111,133,165,0.04)]">
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-8 rounded-[10px] text-[#6f7f96] hover:bg-[#eef3f8]"
            onClick={onGoUp}
            disabled={
              !connection ||
              !paneState.currentPath ||
              getParentPath(paneState.currentPath) === paneState.currentPath
            }
          >
            <ArrowUp className="size-4" />
          </Button>

          <div className="min-w-0 flex-1 overflow-x-auto">
            <div className="flex min-w-max items-center gap-1 text-[11px] text-[#5f7088]">
              {breadcrumbs.map((segment, index) => (
                <button
                  key={`${segment.path}-${index}`}
                  type="button"
                  className="rounded px-1.5 py-0.5 hover:bg-white"
                  onClick={() => onNavigate(segment.path)}
                >
                  {segment.label}
                </button>
              ))}
            </div>
          </div>

          <Button
            variant="ghost"
            size="icon-sm"
            className="size-8 rounded-[10px] text-[#6f7f96] hover:bg-[#eef3f8]"
            onClick={onRefresh}
            disabled={!connection || connectionState?.status !== 'connected'}
          >
            <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
          </Button>
        </div>
      </div>

      <div className="border-b border-[#dce4ee] px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-9 rounded-[12px] border-[#d0d8e4] bg-white px-3 text-[0.78rem] font-semibold text-[#51627a] shadow-none hover:bg-[#f3f7fb]"
            onClick={onUploadFile}
            disabled={!connection || connectionState?.status !== 'connected'}
          >
            <HardDriveUpload className="size-3.5" />
            {t('fileExplorer.uploadFile')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-9 rounded-[12px] border-[#d0d8e4] bg-white px-3 text-[0.78rem] font-semibold text-[#51627a] shadow-none hover:bg-[#f3f7fb]"
            onClick={onUploadFolder}
            disabled={!connection || connectionState?.status !== 'connected'}
          >
            <FolderOpen className="size-3.5" />
            {t('fileExplorer.uploadFolder')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-9 rounded-[12px] border-[#d0d8e4] bg-white px-3 text-[0.78rem] font-semibold text-[#51627a] shadow-none hover:bg-[#f3f7fb]"
            onClick={onDownloadSelection}
            disabled={selectedCount === 0}
          >
            <HardDriveDownload className="size-3.5" />
            {t('workspace.sftp.downloadSelected', { defaultValue: 'Download selected' })}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-9 rounded-[12px] border-[#d0d8e4] bg-white px-3 text-[0.78rem] font-semibold text-[#51627a] shadow-none hover:bg-[#f3f7fb]"
            onClick={onCreateFile}
            disabled={!connection || connectionState?.status !== 'connected'}
          >
            <FileText className="size-3.5" />
            {t('fileExplorer.newFile')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-9 rounded-[12px] border-[#d0d8e4] bg-white px-3 text-[0.78rem] font-semibold text-[#51627a] shadow-none hover:bg-[#f3f7fb]"
            onClick={onCreateFolder}
            disabled={!connection || connectionState?.status !== 'connected'}
          >
            <FolderPlus className="size-3.5" />
            {t('fileExplorer.newFolder')}
          </Button>

          <div className="ml-auto rounded-full bg-[#eef3f8] px-3 py-1.5 text-[11px] font-semibold text-[#607088]">
            {selectedCount} {t('workspace.sftp.selected', { defaultValue: 'selected' })}
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="grid grid-cols-[40px_minmax(0,1fr)_100px_168px_88px] items-center border-b border-[#e2e8f0] bg-[#f8fbfd] px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-[#8592a4]">
          <div className="flex items-center justify-center">
            <Checkbox
              checked={allSelected}
              onCheckedChange={(checked) => {
                if (checked) onSelectAll(entries)
                else onClearSelection()
              }}
              aria-label="Select all"
              disabled={entries.length === 0}
            />
          </div>
          <div>{t('migration.columns.name', { defaultValue: 'Name' })}</div>
          <div>{t('workspace.sftp.columns.type', { defaultValue: 'Type' })}</div>
          <div>{t('workspace.sftp.columns.modified', { defaultValue: 'Modified' })}</div>
          <div className="text-right">
            {t('workspace.sftp.columns.size', { defaultValue: 'Size' })}
          </div>
        </div>

        <div className="h-full overflow-y-auto">
          {!connection || connectionState?.status !== 'connected' ? (
            <div className="flex h-full flex-col items-center justify-center px-8 text-center">
              <div className="flex size-16 items-center justify-center rounded-[22px] bg-[#e2ebf5] text-[#3d5879]">
                <Folder className="size-7" />
              </div>
              <div className="mt-5 text-[1rem] font-semibold text-[#22304a]">{emptyState}</div>
            </div>
          ) : error && entries.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center px-8 text-center">
              <div className="text-[0.95rem] font-semibold text-[#22304a]">
                {t('fileExplorer.error')}
              </div>
              <div className="mt-2 max-w-sm text-[0.82rem] text-[#8795aa]">{error}</div>
            </div>
          ) : loading && entries.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="size-5 animate-spin text-[#2f8cf3]" />
            </div>
          ) : entries.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center px-8 text-center">
              <div className="text-[0.95rem] font-semibold text-[#22304a]">
                {t('fileExplorer.empty')}
              </div>
            </div>
          ) : (
            <div>
              {entries.map((entry) => {
                const Icon = getEntryIcon(entry)
                const selected = Boolean(selectedEntries[entry.path])

                return (
                  <div
                    key={entry.path}
                    className={cn(
                      'grid grid-cols-[40px_minmax(0,1fr)_100px_168px_88px] items-center px-4 py-2.5 text-[13px] text-[#26334d] transition-colors',
                      selected ? 'bg-[#edf5ff]' : 'hover:bg-[#f6f9fc]'
                    )}
                    onClick={() => {
                      onActivatePane()
                      onSelectOnly(entry)
                    }}
                    onDoubleClick={() => {
                      if (entry.type === 'directory') {
                        onNavigate(entry.path)
                      }
                    }}
                  >
                    <div className="flex items-center justify-center">
                      <Checkbox
                        checked={selected}
                        onCheckedChange={() => onToggleSelect(entry)}
                        aria-label={entry.name}
                        onClick={(event) => event.stopPropagation()}
                      />
                    </div>
                    <div className="flex min-w-0 items-center gap-2">
                      <Icon
                        className={cn(
                          'size-4 shrink-0',
                          entry.type === 'directory' ? 'text-[#c58617]' : 'text-[#607088]'
                        )}
                      />
                      <div className="min-w-0 truncate font-medium">{entry.name}</div>
                    </div>
                    <div className="text-[12px] text-[#6b7b91]">
                      {entry.type === 'directory'
                        ? t('workspace.sftp.directory', { defaultValue: 'Directory' })
                        : t('workspace.sftp.file', { defaultValue: 'File' })}
                    </div>
                    <div className="truncate text-[12px] text-[#7d8ba0]">
                      {formatModifiedTime(entry.modifyTime)}
                    </div>
                    <div className="flex items-center justify-end gap-1.5">
                      <span className="text-[12px] text-[#7d8ba0]">
                        {entry.type === 'directory' ? '--' : formatBytes(entry.size)}
                      </span>
                      <button
                        type="button"
                        className="rounded p-1 text-[#8b97ab] hover:bg-white hover:text-[#41526c]"
                        onClick={(event) => {
                          event.stopPropagation()
                          onRenameEntry(entry)
                        }}
                      >
                        <Pencil className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        className="rounded p-1 text-[#8b97ab] hover:bg-white hover:text-[#c45555]"
                        onClick={(event) => {
                          event.stopPropagation()
                          onDeleteEntry(entry)
                        }}
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  </div>
                )
              })}

              {hasMore ? (
                <div className="px-4 py-4">
                  <Button
                    variant="outline"
                    className="h-10 rounded-[14px] border-[#d0d8e4] bg-white px-4 text-[0.82rem] font-semibold text-[#51627a] shadow-none hover:bg-[#f3f7fb]"
                    onClick={onLoadMore}
                  >
                    {loading ? <Loader2 className="size-4 animate-spin" /> : null}
                    {t('fileExplorer.loadMore')}
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

export function SshFileExplorer(
  props: ModernSshFileExplorerProps | LegacySshFileExplorerProps
): React.JSX.Element {
  if ('sessionId' in props) {
    return <LegacySshFileExplorer {...props} />
  }

  return <ModernSshFileExplorer {...props} />
}
