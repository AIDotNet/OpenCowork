import { useEffect, useCallback, useMemo, useState, useRef, type ElementType } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowUp,
  RefreshCw,
  Loader2,
  Folder,
  FolderPlus,
  FilePlus2,
  Pencil,
  Trash2,
  Copy,
  Download,
  FileText,
  FileCode,
  FileImage,
  FileArchive,
  FileJson,
  FileSpreadsheet,
  File,
  ChevronRight
} from 'lucide-react'
import { useSshStore, type SshFileEntry } from '@renderer/stores/ssh-store'
import { cn } from '@renderer/lib/utils'
import {
  Files,
  FolderItem,
  FolderTrigger,
  FolderContent,
  FileItem,
  SubFiles
} from '@renderer/components/animate-ui/components/radix/files'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator
} from '@renderer/components/ui/context-menu'
import { confirm } from '@renderer/components/ui/confirm-dialog'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { toast } from 'sonner'

interface SshFileExplorerProps {
  sessionId: string
  connectionId: string
  rootPath?: string
}

const ROOT_PATH = '/'
const EMPTY_ENTRY_MAP: Record<string, SshFileEntry[]> = {}
const EMPTY_LOADING_MAP: Record<string, boolean> = {}
const EMPTY_ERROR_MAP: Record<string, string | null> = {}
const EMPTY_PAGEINFO_MAP: Record<string, { cursor?: string; hasMore: boolean }> = {}
const EMPTY_EXPANDED_DIRS = new Set<string>()
const FILE_SIZE_LIMIT = 2 * 1024 * 1024
const DEFAULT_ROOT_PATH = '/'

function normalizeRootPath(input?: string): string {
  if (!input) return ROOT_PATH
  const trimmed = input.trim()
  if (!trimmed) return ROOT_PATH
  if (trimmed.length > 1 && trimmed.endsWith('/')) return trimmed.slice(0, -1)
  return trimmed
}

function joinRemotePath(parent: string, name: string): string {
  if (parent === '/' || parent === '') return `/${name}`
  return `${parent}/${name}`
}

function getParentPath(path: string): string {
  if (!path || path === '/') return '/'
  if (path === '~') return '~'
  const trimmed = path.endsWith('/') && path.length > 1 ? path.slice(0, -1) : path
  if (trimmed === '~') return '~'
  const idx = trimmed.lastIndexOf('/')
  if (idx <= 0) return trimmed.startsWith('~') ? '~' : '/'
  return trimmed.slice(0, idx)
}

function InlineInput({
  defaultValue,
  icon,
  placeholder,
  onConfirm,
  onCancel
}: {
  defaultValue: string
  icon: React.ReactNode
  placeholder?: string
  onConfirm: (value: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(defaultValue)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    const dot = defaultValue.lastIndexOf('.')
    el.setSelectionRange(0, dot > 0 ? dot : defaultValue.length)
  }, [defaultValue])

  return (
    <div className="flex items-center gap-2 p-2 text-sm">
      {icon}
      <input
        ref={ref}
        className="pointer-events-auto flex-1 min-w-0 rounded border border-border bg-muted/60 px-2 py-0.5 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            const trimmed = value.trim()
            if (trimmed) onConfirm(trimmed)
            else onCancel()
          }
          if (e.key === 'Escape') onCancel()
        }}
        onBlur={() => onCancel()}
      />
    </div>
  )
}

function getFileIconComponent(name: string): ElementType {
  const lowered = name.toLowerCase()
  if (lowered === 'dockerfile' || lowered === 'makefile') return FileCode
  if (lowered === 'license' || lowered === 'readme' || lowered === 'readme.md') return FileText
  if (lowered === '.gitignore' || lowered === '.env' || lowered.startsWith('.env.')) return FileText

  const ext = name.split('.').pop()?.toLowerCase()
  if (!ext) return File

  const codeExts = [
    'ts',
    'tsx',
    'js',
    'jsx',
    'py',
    'go',
    'rs',
    'java',
    'cpp',
    'c',
    'h',
    'rb',
    'php',
    'vue',
    'svelte',
    'sh',
    'bash',
    'zsh',
    'yaml',
    'yml',
    'toml',
    'json',
    'xml',
    'html',
    'css',
    'scss',
    'sql'
  ]
  const textExts = ['md', 'txt', 'log', 'conf', 'cfg', 'ini', 'env']
  const jsonExts = ['json', 'jsonl']
  const sheetExts = ['csv', 'tsv', 'xls', 'xlsx']
  const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp']
  const archiveExts = ['zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar']

  if (codeExts.includes(ext)) return FileCode
  if (jsonExts.includes(ext)) return FileJson
  if (sheetExts.includes(ext)) return FileSpreadsheet
  if (textExts.includes(ext)) return FileText
  if (imageExts.includes(ext)) return FileImage
  if (archiveExts.includes(ext)) return FileArchive

  return File
}

export function SshFileExplorer({
  sessionId,
  connectionId,
  rootPath
}: SshFileExplorerProps): React.JSX.Element {
  const { t } = useTranslation('ssh')

  const effectiveRootPath = rootPath == null ? DEFAULT_ROOT_PATH : rootPath
  const baseRoot = useMemo(() => normalizeRootPath(effectiveRootPath), [effectiveRootPath])
  const hasCustomRoot = typeof rootPath === 'string' && rootPath.trim() !== ''
  const [resolvedHomeDir, setResolvedHomeDir] = useState<string | null>(null)
  const effectiveBaseRoot = baseRoot
  const enforceRoot = effectiveBaseRoot !== ROOT_PATH
  const currentPath = useSshStore(
    (s) => s.fileExplorerPaths[sessionId] ?? resolvedHomeDir ?? effectiveBaseRoot
  )
  const entriesByPath = useSshStore((s) => s.fileExplorerEntries[sessionId] ?? EMPTY_ENTRY_MAP)
  const loadingByPath = useSshStore((s) => s.fileExplorerLoading[sessionId] ?? EMPTY_LOADING_MAP)
  const errorsByPath = useSshStore((s) => s.fileExplorerErrors[sessionId] ?? EMPTY_ERROR_MAP)
  const pageInfoByPath = useSshStore((s) => s.fileExplorerPageInfo[sessionId] ?? EMPTY_PAGEINFO_MAP)
  const expandedDirs = useSshStore((s) => s.fileExplorerExpanded[sessionId] ?? EMPTY_EXPANDED_DIRS)
  const sessionStatus = useSshStore((s) => s.sessions[sessionId]?.status)
  const connectionName = useSshStore(
    (s) => s.connections.find((c) => c.id === connectionId)?.name ?? connectionId
  )

  const [renamingPath, setRenamingPath] = useState<string | null>(null)
  const [newItemParent, setNewItemParent] = useState<string | null>(null)
  const [newItemType, setNewItemType] = useState<'file' | 'directory'>('file')

  useEffect(() => {
    setRenamingPath(null)
    setNewItemParent(null)
  }, [effectiveBaseRoot, sessionId])

  useEffect(() => {
    if (!sessionId || !connectionId) return
    if (sessionStatus !== 'connected') return
    if (hasCustomRoot) return
    if (baseRoot !== ROOT_PATH) return

    const loadHome = async (): Promise<void> => {
      const result = await ipcClient.invoke(IPC.SSH_FS_HOME_DIR, { connectionId })
      if (result && typeof result === 'object' && 'error' in result) return
      const home = (result as { path?: string }).path
      if (!home) return

      setResolvedHomeDir(home)

      const store = useSshStore.getState()
      const existingPath = store.fileExplorerPaths[sessionId]
      if (!existingPath || existingPath === baseRoot) {
        store.setFileExplorerPath(sessionId, home)
        store.setFileExplorerExpanded(sessionId, [])
      }
    }

    void loadHome()
  }, [baseRoot, connectionId, hasCustomRoot, sessionId, sessionStatus])

  const handleDownloadFile = useCallback(
    async (entry: SshFileEntry) => {
      const selected = await ipcClient.invoke(IPC.FS_SELECT_SAVE_FILE, {
        defaultPath: entry.name
      })
      if (!selected || typeof selected !== 'object') return
      if ((selected as { canceled?: boolean }).canceled) return
      const localPath = (selected as { path?: string }).path
      if (!localPath) return

      const result = await ipcClient.invoke(IPC.SSH_FS_DOWNLOAD, {
        connectionId,
        remotePath: entry.path,
        localPath
      })
      if (result && typeof result === 'object' && 'error' in result) {
        toast.error(String((result as { error?: string }).error ?? 'Download failed'))
        return
      }
      toast.success(t('fileExplorer.downloaded'))
    },
    [connectionId, t]
  )

  useEffect(() => {
    if (!sessionId || !connectionId) return
    if (sessionStatus !== 'connected') return

    const store = useSshStore.getState()
    const existingPath = store.fileExplorerPaths[sessionId]
    const shouldReset = hasCustomRoot && existingPath !== effectiveBaseRoot
    const shouldEnforceRoot =
      !!existingPath && enforceRoot && !existingPath.startsWith(effectiveBaseRoot)
    const preferHome = !hasCustomRoot && baseRoot === ROOT_PATH && resolvedHomeDir
    const nextPath = preferHome ? resolvedHomeDir : effectiveBaseRoot
    const shouldSetPath =
      !existingPath ||
      shouldReset ||
      shouldEnforceRoot ||
      (preferHome && existingPath === effectiveBaseRoot)

    if (shouldSetPath) {
      store.setFileExplorerPath(sessionId, nextPath)
      if (!existingPath || shouldReset || shouldEnforceRoot) {
        store.setFileExplorerExpanded(sessionId, [])
      }
    }

    const loadEntries = async (): Promise<void> => {
      if (hasCustomRoot && effectiveBaseRoot !== ROOT_PATH) {
        await ipcClient.invoke(IPC.SSH_FS_MKDIR, { connectionId, path: effectiveBaseRoot })
      }
      void store.loadFileExplorerEntries(sessionId, effectiveBaseRoot)
    }

    void loadEntries()
  }, [
    sessionId,
    connectionId,
    sessionStatus,
    effectiveBaseRoot,
    enforceRoot,
    hasCustomRoot,
    baseRoot,
    resolvedHomeDir
  ])

  useEffect(() => {
    if (sessionStatus !== 'connected') return
    const store = useSshStore.getState()

    for (const path of expandedDirs) {
      if (
        !Object.prototype.hasOwnProperty.call(entriesByPath, path) &&
        !loadingByPath[path] &&
        !errorsByPath[path]
      ) {
        void store.loadFileExplorerEntries(sessionId, path)
      }
    }
  }, [expandedDirs, entriesByPath, loadingByPath, errorsByPath, sessionId, sessionStatus])

  useEffect(() => {
    if (sessionStatus !== 'connected') return
    if (!currentPath) return
    if (
      !Object.prototype.hasOwnProperty.call(entriesByPath, currentPath) &&
      !loadingByPath[currentPath] &&
      !errorsByPath[currentPath]
    ) {
      void useSshStore.getState().loadFileExplorerEntries(sessionId, currentPath)
    }
  }, [currentPath, entriesByPath, loadingByPath, errorsByPath, sessionId, sessionStatus])

  useEffect(() => {
    if (!enforceRoot) return
    const filtered = Array.from(expandedDirs).filter(
      (path) => path === effectiveBaseRoot || path.startsWith(`${effectiveBaseRoot}/`)
    )
    if (filtered.length !== expandedDirs.size) {
      useSshStore.getState().setFileExplorerExpanded(sessionId, filtered)
    }
  }, [effectiveBaseRoot, expandedDirs, sessionId, enforceRoot])

  const handleOpenChange = useCallback(
    (next: string[]) => {
      const prev = expandedDirs
      const opened = next.find((value) => !prev.has(value))
      if (opened) {
        const store = useSshStore.getState()
        store.setFileExplorerPath(sessionId, opened)
        const sessionEntries = store.fileExplorerEntries[sessionId] ?? {}
        if (!Object.prototype.hasOwnProperty.call(sessionEntries, opened)) {
          void store.loadFileExplorerEntries(sessionId, opened)
        }
      }
      useSshStore.getState().setFileExplorerExpanded(sessionId, next)
    },
    [expandedDirs, sessionId]
  )

  const handleRefreshDir = useCallback(
    (dirPath: string) => {
      void useSshStore.getState().loadFileExplorerEntries(sessionId, dirPath, true)
    },
    [sessionId]
  )

  const handleZipDir = useCallback(
    async (dirPath: string) => {
      const result = await ipcClient.invoke(IPC.SSH_FS_ZIP_DIR, { connectionId, dirPath })
      if (result && typeof result === 'object' && 'error' in result) {
        toast.error(String((result as { error?: string }).error ?? 'Zip failed'))
        return
      }
      const outputPath = (result as { outputPath?: string }).outputPath
      if (outputPath) toast.success(outputPath)
      const parent = getParentPath(dirPath)
      void useSshStore.getState().loadFileExplorerEntries(sessionId, parent, true)
    },
    [connectionId, sessionId]
  )

  const handleUploadFileToDir = useCallback(
    async (remoteDir: string) => {
      const selected = await ipcClient.invoke(IPC.FS_SELECT_FILE)
      if (!selected || typeof selected !== 'object') return
      if ((selected as { canceled?: boolean }).canceled) return
      const localPath = (selected as { path?: string }).path
      if (!localPath) return
      const taskId = await useSshStore
        .getState()
        .startUpload({ connectionId, remoteDir, localPath, kind: 'file' })
      if (!taskId) toast.error('Upload failed')
    },
    [connectionId]
  )

  const handleUploadFolderToDir = useCallback(
    async (remoteDir: string) => {
      const selected = await ipcClient.invoke(IPC.FS_SELECT_FOLDER)
      if (!selected || typeof selected !== 'object') return
      if ((selected as { canceled?: boolean }).canceled) return
      const localPath = (selected as { path?: string }).path
      if (!localPath) return
      const taskId = await useSshStore
        .getState()
        .startUpload({ connectionId, remoteDir, localPath, kind: 'folder' })
      if (!taskId) toast.error('Upload failed')
    },
    [connectionId]
  )

  const handleSelectPath = useCallback(
    (path: string) => {
      useSshStore.getState().setFileExplorerPath(sessionId, path)
    },
    [sessionId]
  )

  const handleGoUp = useCallback(() => {
    if (currentPath === ROOT_PATH) return
    if (enforceRoot && currentPath === effectiveBaseRoot) return
    const parent = getParentPath(currentPath)
    if (enforceRoot && !parent.startsWith(effectiveBaseRoot)) {
      handleSelectPath(effectiveBaseRoot)
      return
    }
    handleSelectPath(parent)
  }, [currentPath, effectiveBaseRoot, enforceRoot, handleSelectPath])

  const handleRefresh = useCallback(() => {
    const store = useSshStore.getState()
    void store.loadFileExplorerEntries(sessionId, effectiveBaseRoot, true)
    for (const path of expandedDirs) {
      void store.loadFileExplorerEntries(sessionId, path, true)
    }
  }, [sessionId, expandedDirs, effectiveBaseRoot])

  const handleLoadMore = useCallback(
    (path: string) => {
      void useSshStore.getState().loadMoreFileExplorerEntries(sessionId, path)
    },
    [sessionId]
  )

  const ensureExpanded = useCallback(
    (dirPath: string) => {
      if (expandedDirs.has(dirPath)) return
      const next = new Set(expandedDirs)
      next.add(dirPath)
      useSshStore.getState().setFileExplorerExpanded(sessionId, Array.from(next))
    },
    [expandedDirs, sessionId]
  )

  const openFileTab = useCallback(
    (entry: SshFileEntry) => {
      if (entry.size >= FILE_SIZE_LIMIT) {
        toast.error(t('fileExplorer.tooLarge'))
        return
      }
      const store = useSshStore.getState()
      const existing = store.openTabs.find(
        (tab) =>
          tab.type === 'file' && tab.connectionId === connectionId && tab.filePath === entry.path
      )
      if (existing) {
        store.setActiveTab(existing.id)
        return
      }
      const tabId = `file-${connectionId}-${entry.path}`
      store.openTab({
        id: tabId,
        type: 'file',
        sessionId: null,
        connectionId,
        connectionName,
        title: entry.name,
        filePath: entry.path
      })
    },
    [connectionId, connectionName, t]
  )

  const handleDelete = useCallback(
    async (entry: SshFileEntry) => {
      const confirmed = await confirm({
        title: t('fileExplorer.deleteConfirm', { name: entry.name }),
        variant: 'destructive'
      })
      if (!confirmed) return
      const result = await ipcClient.invoke(IPC.SSH_FS_DELETE, {
        connectionId,
        path: entry.path
      })
      if (result && typeof result === 'object' && 'error' in result) {
        toast.error(String((result as { error?: string }).error ?? 'Delete failed'))
        return
      }
      const parent = getParentPath(entry.path)
      void useSshStore.getState().loadFileExplorerEntries(sessionId, parent, true)
    },
    [connectionId, sessionId, t]
  )

  const handleRenameConfirm = useCallback(
    async (entry: SshFileEntry, newName: string) => {
      const parent = getParentPath(entry.path)
      const nextPath = joinRemotePath(parent, newName)
      if (!newName || nextPath === entry.path) {
        setRenamingPath(null)
        return
      }
      const result = await ipcClient.invoke(IPC.SSH_FS_MOVE, {
        connectionId,
        from: entry.path,
        to: nextPath
      })
      if (result && typeof result === 'object' && 'error' in result) {
        toast.error(String((result as { error?: string }).error ?? 'Rename failed'))
        return
      }
      setRenamingPath(null)
      void useSshStore.getState().loadFileExplorerEntries(sessionId, parent, true)
    },
    [connectionId, sessionId]
  )

  const handleNewFile = useCallback(
    (dirPath: string) => {
      setNewItemParent(dirPath)
      setNewItemType('file')
      setRenamingPath(null)
      ensureExpanded(dirPath)
    },
    [ensureExpanded]
  )

  const handleNewFolder = useCallback(
    (dirPath: string) => {
      setNewItemParent(dirPath)
      setNewItemType('directory')
      setRenamingPath(null)
      ensureExpanded(dirPath)
    },
    [ensureExpanded]
  )

  const handleNewItemConfirm = useCallback(
    async (value: string) => {
      if (!newItemParent) return
      const targetPath = joinRemotePath(newItemParent, value)
      const result =
        newItemType === 'directory'
          ? await ipcClient.invoke(IPC.SSH_FS_MKDIR, { connectionId, path: targetPath })
          : await ipcClient.invoke(IPC.SSH_FS_WRITE_FILE, {
              connectionId,
              path: targetPath,
              content: ''
            })
      if (result && typeof result === 'object' && 'error' in result) {
        toast.error(String((result as { error?: string }).error ?? 'Create failed'))
        return
      }
      setNewItemParent(null)
      void useSshStore.getState().loadFileExplorerEntries(sessionId, newItemParent, true)
    },
    [connectionId, newItemParent, newItemType, sessionId]
  )

  const openValues = useMemo(() => Array.from(expandedDirs), [expandedDirs])
  const rootEntries = entriesByPath[effectiveBaseRoot] ?? []
  const rootError = errorsByPath[effectiveBaseRoot]
  const hasRootLoaded = Object.prototype.hasOwnProperty.call(entriesByPath, effectiveBaseRoot)
  const rootLoading = loadingByPath[effectiveBaseRoot] ?? false
  const rootInitialLoading = !hasRootLoaded && !rootError
  const rootLoadingMore = rootLoading && hasRootLoaded
  const rootHasMore = pageInfoByPath[effectiveBaseRoot]?.hasMore ?? false

  const renderEntries = useCallback(
    (entries: SshFileEntry[]): React.ReactNode => {
      return entries.map((entry) => {
        if (entry.type === 'directory') {
          const hasLoaded = Object.prototype.hasOwnProperty.call(entriesByPath, entry.path)
          const error = errorsByPath[entry.path]
          const isLoading = loadingByPath[entry.path] ?? false
          const children = hasLoaded ? (entriesByPath[entry.path] ?? []) : []
          const isInitialLoading = !hasLoaded && !error
          const isLoadingMore = isLoading && hasLoaded
          const pageInfo = pageInfoByPath[entry.path]
          const hasMore = pageInfo?.hasMore ?? false
          const isRenaming = renamingPath === entry.path
          const showNewItem = newItemParent === entry.path

          return (
            <FolderItem key={entry.path} value={entry.path}>
              <ContextMenu>
                <ContextMenuTrigger asChild>
                  <div
                    className="w-full"
                    onClick={() => {
                      handleSelectPath(entry.path)
                      const store = useSshStore.getState()
                      const sessionEntries = store.fileExplorerEntries[sessionId] ?? {}
                      if (!Object.prototype.hasOwnProperty.call(sessionEntries, entry.path)) {
                        void store.loadFileExplorerEntries(sessionId, entry.path)
                      }
                    }}
                  >
                    <FolderTrigger>
                      {isRenaming ? (
                        <input
                          autoFocus
                          className="pointer-events-auto w-full min-w-[120px] rounded border border-border bg-muted/60 px-2 py-0.5 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
                          defaultValue={entry.name}
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              const val = (e.target as HTMLInputElement).value.trim()
                              if (val) void handleRenameConfirm(entry, val)
                              else setRenamingPath(null)
                            }
                            if (e.key === 'Escape') setRenamingPath(null)
                          }}
                          onBlur={() => setRenamingPath(null)}
                        />
                      ) : (
                        <span className="inline-flex items-center gap-1">
                          <ChevronRight
                            className={cn(
                              'size-3 shrink-0 text-muted-foreground transition-transform duration-200',
                              expandedDirs.has(entry.path) && 'rotate-90'
                            )}
                          />
                          <span className="truncate">{entry.name}</span>
                        </span>
                      )}
                    </FolderTrigger>
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent className="w-44">
                  <ContextMenuItem
                    className="gap-2 text-xs"
                    onSelect={() => {
                      handleSelectPath(entry.path)
                      ensureExpanded(entry.path)
                    }}
                  >
                    <Folder className="size-3.5" />
                    {t('fileExplorer.open')}
                  </ContextMenuItem>
                  <ContextMenuItem
                    className="gap-2 text-xs"
                    onSelect={() => void handleZipDir(entry.path)}
                  >
                    <FileArchive className="size-3.5" />
                    {t('fileExplorer.zipDir')}
                  </ContextMenuItem>
                  <ContextMenuItem
                    className="gap-2 text-xs"
                    onSelect={() => void handleUploadFileToDir(entry.path)}
                  >
                    <FilePlus2 className="size-3.5" />
                    {t('fileExplorer.uploadFile')}
                  </ContextMenuItem>
                  <ContextMenuItem
                    className="gap-2 text-xs"
                    onSelect={() => void handleUploadFolderToDir(entry.path)}
                  >
                    <FolderPlus className="size-3.5" />
                    {t('fileExplorer.uploadFolder')}
                  </ContextMenuItem>
                  <ContextMenuItem
                    className="gap-2 text-xs"
                    onSelect={() => handleRefreshDir(entry.path)}
                  >
                    <RefreshCw className="size-3.5" />
                    {t('fileExplorer.refresh')}
                  </ContextMenuItem>
                  <ContextMenuItem
                    className="gap-2 text-xs"
                    onSelect={() => handleNewFile(entry.path)}
                  >
                    <FilePlus2 className="size-3.5" />
                    {t('fileExplorer.newFile')}
                  </ContextMenuItem>
                  <ContextMenuItem
                    className="gap-2 text-xs"
                    onSelect={() => handleNewFolder(entry.path)}
                  >
                    <FolderPlus className="size-3.5" />
                    {t('fileExplorer.newFolder')}
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    className="gap-2 text-xs"
                    onSelect={() => {
                      setRenamingPath(entry.path)
                      setNewItemParent(null)
                    }}
                  >
                    <Pencil className="size-3.5" />
                    {t('fileExplorer.rename')}
                  </ContextMenuItem>
                  <ContextMenuItem
                    className="gap-2 text-xs"
                    onSelect={() => navigator.clipboard.writeText(entry.path)}
                  >
                    <Copy className="size-3.5" />
                    {t('fileExplorer.copyPath')}
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    className="gap-2 text-xs text-destructive focus:text-destructive"
                    onSelect={() => void handleDelete(entry)}
                  >
                    <Trash2 className="size-3.5" />
                    {t('fileExplorer.delete')}
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
              <FolderContent>
                {error && children.length === 0 ? (
                  <div className="px-2 py-1 text-xs text-muted-foreground">
                    {t('fileExplorer.error')}
                  </div>
                ) : isInitialLoading ? (
                  <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
                    <Loader2 className="size-3 animate-spin" />
                    {t('fileExplorer.loading')}
                  </div>
                ) : children.length === 0 && !showNewItem ? (
                  <div className="px-2 py-1 text-xs text-muted-foreground">
                    {t('fileExplorer.empty')}
                  </div>
                ) : (
                  <>
                    {showNewItem && (
                      <InlineInput
                        defaultValue={newItemType === 'directory' ? 'new-folder' : 'untitled'}
                        icon={
                          newItemType === 'directory' ? (
                            <Folder className="size-4 text-amber-400" />
                          ) : (
                            <File className="size-4 text-muted-foreground" />
                          )
                        }
                        onConfirm={(value) => void handleNewItemConfirm(value)}
                        onCancel={() => setNewItemParent(null)}
                      />
                    )}
                    {children.length > 0 && <SubFiles>{renderEntries(children)}</SubFiles>}
                    {isLoadingMore && (
                      <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
                        <Loader2 className="size-3 animate-spin" />
                        {t('fileExplorer.loadingMore')}
                      </div>
                    )}
                    {!isLoadingMore && hasMore && (
                      <div className="px-2 py-1">
                        <button
                          className="pointer-events-auto text-xs text-muted-foreground hover:text-foreground"
                          onClick={() => handleLoadMore(entry.path)}
                        >
                          {t('fileExplorer.loadMore')}
                        </button>
                      </div>
                    )}
                    {error && children.length > 0 && (
                      <div className="px-2 py-1 text-xs text-muted-foreground">
                        {t('fileExplorer.error')}
                      </div>
                    )}
                  </>
                )}
              </FolderContent>
            </FolderItem>
          )
        }

        const isRenaming = renamingPath === entry.path
        return (
          <ContextMenu key={entry.path}>
            <ContextMenuTrigger asChild>
              <div
                className="w-full"
                onClick={() => {
                  handleSelectPath(entry.path)
                  if (!isRenaming) openFileTab(entry)
                }}
              >
                <FileItem icon={getFileIconComponent(entry.name)} className="text-sm">
                  {isRenaming ? (
                    <input
                      autoFocus
                      className="pointer-events-auto w-full min-w-[120px] rounded border border-border bg-muted/60 px-2 py-0.5 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
                      defaultValue={entry.name}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          const val = (e.target as HTMLInputElement).value.trim()
                          if (val) void handleRenameConfirm(entry, val)
                          else setRenamingPath(null)
                        }
                        if (e.key === 'Escape') setRenamingPath(null)
                      }}
                      onBlur={() => setRenamingPath(null)}
                    />
                  ) : (
                    entry.name
                  )}
                </FileItem>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-44">
              <ContextMenuItem
                className="gap-2 text-xs"
                onSelect={() => {
                  handleSelectPath(entry.path)
                  openFileTab(entry)
                }}
              >
                <FileText className="size-3.5" />
                {t('fileExplorer.open')}
              </ContextMenuItem>
              <ContextMenuItem
                className="gap-2 text-xs"
                onSelect={() => void handleDownloadFile(entry)}
              >
                <Download className="size-3.5" />
                {t('fileExplorer.download')}
              </ContextMenuItem>
              <ContextMenuItem
                className="gap-2 text-xs"
                onSelect={() => {
                  setRenamingPath(entry.path)
                  setNewItemParent(null)
                }}
              >
                <Pencil className="size-3.5" />
                {t('fileExplorer.rename')}
              </ContextMenuItem>
              <ContextMenuItem
                className="gap-2 text-xs"
                onSelect={() => navigator.clipboard.writeText(entry.path)}
              >
                <Copy className="size-3.5" />
                {t('fileExplorer.copyPath')}
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                className="gap-2 text-xs text-destructive focus:text-destructive"
                onSelect={() => void handleDelete(entry)}
              >
                <Trash2 className="size-3.5" />
                {t('fileExplorer.delete')}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        )
      })
    },
    [
      entriesByPath,
      errorsByPath,
      expandedDirs,
      handleDelete,
      handleLoadMore,
      handleNewFile,
      handleNewFolder,
      handleNewItemConfirm,
      handleRefreshDir,
      handleRenameConfirm,
      handleSelectPath,
      loadingByPath,
      newItemParent,
      newItemType,
      openFileTab,
      pageInfoByPath,
      ensureExpanded,
      renamingPath,
      t
    ]
  )

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      {/* Path bar */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border shrink-0">
        <button
          className="p-0.5 rounded hover:bg-muted/60 transition-colors"
          onClick={handleGoUp}
          title={t('fileExplorer.goUp')}
        >
          <ArrowUp className="size-3 text-muted-foreground" />
        </button>
        <div className="flex-1 min-w-0 text-[11px] text-muted-foreground truncate font-mono">
          {currentPath}
        </div>
        <button
          className="p-0.5 rounded hover:bg-muted/60 transition-colors"
          onClick={handleRefresh}
          title={t('fileExplorer.refresh')}
        >
          <RefreshCw
            className={cn(
              'size-3 text-muted-foreground',
              (rootLoading || rootInitialLoading) && 'animate-spin'
            )}
          />
        </button>
      </div>

      {/* File tree */}
      <div className="flex-1 overflow-y-auto py-1">
        {rootInitialLoading && rootEntries.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : rootError && rootEntries.length === 0 ? (
          <div className="px-3 py-4 text-center">
            <p className="text-[11px] text-muted-foreground">{t('fileExplorer.error')}</p>
          </div>
        ) : rootEntries.length === 0 ? (
          <div className="px-3 py-4 text-center">
            <p className="text-[11px] text-muted-foreground">{t('fileExplorer.empty')}</p>
          </div>
        ) : (
          <div>
            <Files open={openValues} onOpenChange={handleOpenChange}>
              {renderEntries(rootEntries)}
            </Files>
            {rootLoadingMore && (
              <div className="flex items-center gap-2 px-4 py-2 text-xs text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                {t('fileExplorer.loadingMore')}
              </div>
            )}
            {!rootLoadingMore && rootHasMore && (
              <div className="px-4 py-2">
                <button
                  className="pointer-events-auto text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => handleLoadMore(effectiveBaseRoot)}
                >
                  {t('fileExplorer.loadMore')}
                </button>
              </div>
            )}
            {rootError && rootEntries.length > 0 && (
              <div className="px-4 py-2 text-xs text-muted-foreground">
                {t('fileExplorer.error')}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
