import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { confirm } from '@renderer/components/ui/confirm-dialog'
import {
  FolderOpen,
  Folder,
  File,
  FileCode,
  FileJson,
  FileText,
  Image,
  ChevronRight,
  ChevronDown,
  RefreshCw,
  FolderPlus,
  FilePlus2,
  Copy,
  Check,
  AlertCircle,
  Pencil,
  Trash2,
  Search,
  GripVertical,
  X
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator
} from '@renderer/components/ui/context-menu'
import { useChatStore } from '@renderer/stores/chat-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { createSelectFileTag } from '@renderer/lib/select-file-tags'
import { cn } from '@renderer/lib/utils'
import { AnimatePresence, motion } from 'motion/react'

// --- Types ---

interface FileEntry {
  name: string
  type: 'file' | 'directory'
  path: string
}

interface TreeNode extends FileEntry {
  children?: TreeNode[]
  loaded?: boolean
  expanded?: boolean
}

interface FileSearchItem {
  name: string
  path: string
}

const INTERNAL_FILE_DRAG_MIME = 'application/x-opencowork-file-paths'

// --- File icon helper ---

const EXT_ICONS: Record<string, React.ReactNode> = {
  '.ts': <FileCode className="size-3.5 text-blue-400" />,
  '.tsx': <FileCode className="size-3.5 text-blue-400" />,
  '.js': <FileCode className="size-3.5 text-yellow-500" />,
  '.jsx': <FileCode className="size-3.5 text-yellow-500" />,
  '.py': <FileCode className="size-3.5 text-green-500" />,
  '.rs': <FileCode className="size-3.5 text-orange-400" />,
  '.go': <FileCode className="size-3.5 text-cyan-400" />,
  '.json': <FileJson className="size-3.5 text-amber-400" />,
  '.md': <FileText className="size-3.5 text-muted-foreground" />,
  '.txt': <FileText className="size-3.5 text-muted-foreground" />,
  '.yaml': <FileText className="size-3.5 text-pink-400" />,
  '.yml': <FileText className="size-3.5 text-pink-400" />,
  '.css': <FileCode className="size-3.5 text-purple-400" />,
  '.html': <FileCode className="size-3.5 text-orange-400" />,
  '.svg': <Image className="size-3.5 text-green-400" />,
  '.png': <Image className="size-3.5 text-green-400" />,
  '.jpg': <Image className="size-3.5 text-green-400" />,
  '.gif': <Image className="size-3.5 text-green-400" />
}

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.nuxt',
  'dist',
  'build',
  'out',
  '__pycache__',
  '.venv',
  'venv',
  '.cache',
  '.idea',
  '.vscode',
  'target',
  'coverage',
  '.turbo',
  '.parcel-cache'
])

function fileIcon(name: string): React.ReactNode {
  const ext = name.includes('.') ? '.' + name.split('.').pop()!.toLowerCase() : ''
  return EXT_ICONS[ext] ?? <File className="size-3.5 text-muted-foreground/60" />
}

// --- Sort: directories first, then alphabetical ---
function sortEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

function countTreeStats(nodes: TreeNode[]): { folders: number; files: number } {
  return nodes.reduce(
    (acc, node) => {
      if (node.type === 'directory') {
        acc.folders += 1
        if (node.children?.length) {
          const childStats = countTreeStats(node.children)
          acc.folders += childStats.folders
          acc.files += childStats.files
        }
      } else {
        acc.files += 1
      }
      return acc
    },
    { folders: 0, files: 0 }
  )
}

function collapseTree(nodes: TreeNode[]): TreeNode[] {
  return nodes.map((node) => ({
    ...node,
    expanded: false,
    children: node.children ? collapseTree(node.children) : node.children
  }))
}

function toRelativePath(filePath: string, workingFolder?: string): string {
  if (!workingFolder) return filePath
  if (!filePath.startsWith(workingFolder)) return filePath
  return filePath.slice(workingFolder.length).replace(/^[\\/]+/, '')
}

function DepthGuides({ depth }: { depth: number }): React.JSX.Element | null {
  if (depth <= 0) return null

  return (
    <div className="absolute inset-y-0 left-0 pointer-events-none">
      {Array.from({ length: depth }).map((_, index) => (
        <span
          key={index}
          className="absolute inset-y-0 w-px bg-border/50"
          style={{ left: `${index * 14 + 9}px` }}
        />
      ))}
    </div>
  )
}

// --- Tree Node Component ---

// --- Inline input for rename / new item ---

function InlineInput({
  defaultValue,
  depth,
  icon,
  onConfirm,
  onCancel
}: {
  defaultValue: string
  depth: number
  icon: React.ReactNode
  onConfirm: (value: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(defaultValue)

  useEffect(() => {
    // Auto-focus and select filename without extension
    const el = ref.current
    if (!el) return
    el.focus()
    const dot = defaultValue.lastIndexOf('.')
    el.setSelectionRange(0, dot > 0 ? dot : defaultValue.length)
  }, [defaultValue])

  return (
    <div
      className="flex items-center gap-1 py-[1px] pr-2 text-[12px]"
      style={{ paddingLeft: `${depth * 14 + 4 + 16}px` }}
    >
      {icon}
      <input
        ref={ref}
        className="flex-1 min-w-0 bg-muted/60 border border-border rounded px-1 py-0 text-[12px] text-foreground outline-none focus:ring-1 focus:ring-ring"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && value.trim()) onConfirm(value.trim())
          if (e.key === 'Escape') onCancel()
        }}
        onBlur={() => onCancel()}
      />
    </div>
  )
}

// --- Edit state passed down the tree ---

interface TreeEditState {
  renamingPath: string | null
  newItemParent: string | null
  newItemType: 'file' | 'directory'
}

interface TreeActions {
  onDelete: (nodePath: string, nodeName: string, isDir: boolean) => void
  onRenameStart: (nodePath: string, nodeName: string) => void
  onRenameConfirm: (value: string) => void
  onRenameCancel: () => void
  onNewFile: (dirPath: string) => void
  onNewFolder: (dirPath: string) => void
  onNewItemConfirm: (value: string) => void
  onNewItemCancel: () => void
}

function TreeItem({
  node,
  depth,
  activePath,
  onToggle,
  onCopyPath,
  onPreview,
  onFileDragStart,
  editState,
  actions
}: {
  node: TreeNode
  depth: number
  activePath: string | null
  onToggle: (path: string) => void
  onCopyPath: (path: string) => void
  onPreview: (path: string, name: string) => void
  onFileDragStart: (event: React.DragEvent<HTMLElement>, path: string) => void
  editState: TreeEditState
  actions: TreeActions
}): React.JSX.Element {
  const { t } = useTranslation('cowork')
  const [copied, setCopied] = useState(false)
  const isDir = node.type === 'directory'
  const isIgnored = isDir && IGNORED_DIRS.has(node.name)
  const safeEditState = editState ?? {
    renamingPath: null,
    newItemParent: null,
    newItemType: 'file' as const
  }
  const isRenaming = safeEditState.renamingPath === node.path
  const isActive = activePath === node.path

  const handleCopy = useCallback(() => {
    onCopyPath(node.path)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }, [node.path, onCopyPath])

  const rowContent = (
    <div
      className={cn(
        'group relative flex items-center gap-2 rounded-xl border px-2 py-1.5 text-[12px] transition-all',
        isDir ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing',
        isActive
          ? 'border-primary/25 bg-primary/10 text-foreground shadow-sm'
          : isDir && node.expanded
            ? 'border-border/50 bg-muted/35'
            : 'border-transparent hover:border-border/50 hover:bg-muted/55',
        isIgnored && 'opacity-40'
      )}
      style={{ paddingLeft: `${depth * 14 + 6}px` }}
      onClick={() => (isDir && !isIgnored ? onToggle(node.path) : onPreview(node.path, node.name))}
      onDragStart={(event) => {
        if (!isDir) {
          onFileDragStart(event, node.path)
        }
      }}
      draggable={!isDir && !isRenaming}
      title={node.path}
    >
      <DepthGuides depth={depth} />
      {depth > 0 && (
        <span
          className="absolute top-1/2 h-px w-2 bg-border/60 pointer-events-none"
          style={{ left: `${(depth - 1) * 14 + 9}px` }}
        />
      )}

      {isDir ? (
        node.expanded ? (
          <ChevronDown className="size-3 shrink-0 text-muted-foreground/60" />
        ) : (
          <ChevronRight className="size-3 shrink-0 text-muted-foreground/60" />
        )
      ) : (
        <GripVertical className="size-3 shrink-0 text-muted-foreground/25 transition-colors group-hover:text-muted-foreground/60" />
      )}

      {isDir ? (
        node.expanded ? (
          <FolderOpen className="size-3.5 shrink-0 text-amber-400" />
        ) : (
          <Folder className="size-3.5 shrink-0 text-amber-400/80" />
        )
      ) : (
        fileIcon(node.name)
      )}

      {isRenaming ? (
        <input
          autoFocus
          className="flex-1 min-w-0 bg-muted/60 border border-border rounded px-1 py-0 text-[12px] text-foreground outline-none focus:ring-1 focus:ring-ring"
          defaultValue={node.name}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const val = (e.target as HTMLInputElement).value.trim()
              if (val && val !== node.name) actions.onRenameConfirm(val)
              else actions.onRenameCancel()
            }
            if (e.key === 'Escape') actions.onRenameCancel()
          }}
          onBlur={() => actions.onRenameCancel()}
          onFocus={(e) => {
            const dot = node.name.lastIndexOf('.')
            e.target.setSelectionRange(0, dot > 0 && !isDir ? dot : node.name.length)
          }}
        />
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span
            className={cn(
              'truncate',
              isDir ? 'font-medium text-foreground/85' : 'text-foreground/80'
            )}
          >
            {node.name}
          </span>
          {!isDir && (
            <span className="rounded-full border border-border/50 bg-background/70 px-1.5 py-0.5 text-[10px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
              拖动引用
            </span>
          )}
        </div>
      )}

      {!isDir && !isRenaming && (
        <button
          className="shrink-0 rounded-md p-1 text-muted-foreground/35 opacity-0 transition-all hover:bg-muted hover:text-muted-foreground group-hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation()
            handleCopy()
          }}
          title={t('fileTree.copyPath')}
        >
          {copied ? <Check className="size-3 text-green-500" /> : <Copy className="size-3" />}
        </button>
      )}
    </div>
  )

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{rowContent}</ContextMenuTrigger>
        <ContextMenuContent className="w-44">
          {isDir && !isIgnored && (
            <>
              <ContextMenuItem
                className="gap-2 text-xs"
                onSelect={() => actions.onNewFile(node.path)}
              >
                <FilePlus2 className="size-3.5" /> {t('fileTree.newFile')}
              </ContextMenuItem>
              <ContextMenuItem
                className="gap-2 text-xs"
                onSelect={() => actions.onNewFolder(node.path)}
              >
                <FolderPlus className="size-3.5" /> {t('fileTree.newFolder')}
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}
          <ContextMenuItem
            className="gap-2 text-xs"
            onSelect={() => actions.onRenameStart(node.path, node.name)}
          >
            <Pencil className="size-3.5" /> {t('action.rename', { ns: 'common' })}
          </ContextMenuItem>
          <ContextMenuItem className="gap-2 text-xs" onSelect={handleCopy}>
            <Copy className="size-3.5" /> {t('action.copyPath', { ns: 'common' })}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            className="gap-2 text-xs text-destructive focus:text-destructive"
            onSelect={() => actions.onDelete(node.path, node.name, isDir)}
          >
            <Trash2 className="size-3.5" /> {t('action.delete', { ns: 'common' })}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {/* New item input (shown as first child of this directory) */}
      {isDir && node.expanded && safeEditState.newItemParent === node.path && (
        <InlineInput
          defaultValue={safeEditState.newItemType === 'file' ? 'untitled' : 'new-folder'}
          depth={depth + 1}
          icon={
            safeEditState.newItemType === 'file' ? (
              <File className="size-3.5 text-muted-foreground/60" />
            ) : (
              <Folder className="size-3.5 text-amber-400/70" />
            )
          }
          onConfirm={actions.onNewItemConfirm}
          onCancel={actions.onNewItemCancel}
        />
      )}

      {/* Children */}
      <AnimatePresence>
        {isDir && node.expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            {node.children?.length ? (
              node.children.map((child) => (
                <TreeItem
                  key={child.path}
                  node={child}
                  depth={depth + 1}
                  activePath={activePath}
                  onToggle={onToggle}
                  onCopyPath={onCopyPath}
                  onPreview={onPreview}
                  onFileDragStart={onFileDragStart}
                  editState={editState}
                  actions={actions}
                />
              ))
            ) : (
              <div
                className="relative py-1 pl-8 text-[11px] text-muted-foreground/45"
                style={{ paddingLeft: `${(depth + 1) * 14 + 18}px` }}
              >
                <DepthGuides depth={depth + 1} />
                <span className="relative">{t('fileTree.empty')}</span>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}

// --- Main Panel ---

export function FileTreePanel(): React.JSX.Element {
  const { t } = useTranslation('cowork')
  const sessions = useChatStore((s) => s.sessions)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const activeSession = sessions.find((s) => s.id === activeSessionId)
  const workingFolder = activeSession?.workingFolder
  const previewPanelState = useUIStore((s) => s.previewPanelState)

  const [tree, setTree] = useState<TreeNode[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<FileSearchItem[]>([])
  const [searchLoading, setSearchLoading] = useState(false)

  // --- Edit state for context menu actions ---
  const [renamingPath, setRenamingPath] = useState<string | null>(null)
  const [newItemParent, setNewItemParent] = useState<string | null>(null)
  const [newItemType, setNewItemType] = useState<'file' | 'directory'>('file')

  const loadDir = useCallback(async (dirPath: string): Promise<TreeNode[]> => {
    const result = (await ipcClient.invoke('fs:list-dir', { path: dirPath })) as
      | FileEntry[]
      | { error: string }
    if ('error' in result) throw new Error(String(result.error))
    const sorted = sortEntries(result as FileEntry[])
    return sorted.map((e) => ({
      ...e,
      expanded: false,
      loaded: e.type === 'file',
      children: e.type === 'directory' ? [] : undefined
    }))
  }, [])

  const loadRoot = useCallback(async () => {
    if (!workingFolder) return
    setLoading(true)
    setError(null)
    try {
      const nodes = await loadDir(workingFolder)
      setTree(nodes)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [workingFolder, loadDir])

  useEffect(() => {
    loadRoot()
  }, [loadRoot])

  useEffect(() => {
    const query = searchQuery.trim()
    if (!workingFolder || !query) {
      setSearchResults([])
      setSearchLoading(false)
      return
    }

    let cancelled = false
    setSearchLoading(true)
    const timer = window.setTimeout(() => {
      void ipcClient
        .invoke('fs:search-files', {
          path: workingFolder,
          query,
          limit: 100
        })
        .then((result) => {
          if (cancelled) return
          setSearchResults(Array.isArray(result) ? (result as FileSearchItem[]) : [])
        })
        .catch(() => {
          if (cancelled) return
          setSearchResults([])
        })
        .finally(() => {
          if (cancelled) return
          setSearchLoading(false)
        })
    }, 120)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [searchQuery, workingFolder])

  const handleToggle = useCallback(
    async (dirPath: string) => {
      const toggleNode = async (nodes: TreeNode[]): Promise<TreeNode[]> => {
        return Promise.all(
          nodes.map(async (n) => {
            if (n.path === dirPath && n.type === 'directory') {
              if (n.expanded) {
                return { ...n, expanded: false }
              }
              if (!n.loaded) {
                try {
                  const children = await loadDir(dirPath)
                  return { ...n, expanded: true, loaded: true, children }
                } catch {
                  return { ...n, expanded: true, loaded: true, children: [] }
                }
              }
              return { ...n, expanded: true }
            }
            if (n.children) {
              return { ...n, children: await toggleNode(n.children) }
            }
            return n
          })
        )
      }
      setTree(await toggleNode(tree))
    },
    [tree, loadDir]
  )

  // Refresh a single directory's children in the tree (after create/rename/delete)
  const refreshDir = useCallback(
    async (dirPath: string) => {
      const refresh = async (nodes: TreeNode[]): Promise<TreeNode[]> => {
        return Promise.all(
          nodes.map(async (n) => {
            if (n.path === dirPath && n.type === 'directory') {
              try {
                const children = await loadDir(dirPath)
                return { ...n, expanded: true, loaded: true, children }
              } catch {
                return n
              }
            }
            if (n.children) return { ...n, children: await refresh(n.children) }
            return n
          })
        )
      }
      setTree(await refresh(tree))
    },
    [tree, loadDir]
  )

  const handleCopyPath = useCallback(
    (filePath: string) => {
      // Make path relative to working folder if possible
      const rel =
        workingFolder && filePath.startsWith(workingFolder)
          ? filePath.slice(workingFolder.length).replace(/^[\\//]/, '')
          : filePath
      useUIStore.getState().setPendingInsertText(createSelectFileTag(rel))
      navigator.clipboard.writeText(filePath)
    },
    [workingFolder]
  )

  // --- Context menu action handlers ---

  const sep = workingFolder?.includes('/') ? '/' : '\\'

  const handleDelete = useCallback(
    async (nodePath: string, nodeName: string, isDir: boolean) => {
      const confirmed = await confirm({
        title: t('fileTree.deleteConfirm', {
          type: isDir ? t('fileTree.folder') : t('fileTree.file'),
          name: nodeName
        }),
        variant: 'destructive'
      })
      if (!confirmed) return
      try {
        await ipcClient.invoke('fs:delete', { path: nodePath })
        const parentDir = nodePath.substring(0, nodePath.lastIndexOf(sep))
        if (parentDir === workingFolder) {
          await loadRoot()
        } else {
          await refreshDir(parentDir)
        }
      } catch (err) {
        console.error('Delete failed:', err)
      }
    },
    [sep, t, workingFolder, loadRoot, refreshDir]
  )

  const handleRenameStart = useCallback((nodePath: string) => {
    setRenamingPath(nodePath)
    setNewItemParent(null)
  }, [])

  const handleRenameConfirm = useCallback(
    async (newName: string) => {
      if (!renamingPath) return
      const parentDir = renamingPath.substring(0, renamingPath.lastIndexOf(sep))
      const newPath = parentDir + sep + newName
      try {
        await ipcClient.invoke('fs:move', { from: renamingPath, to: newPath })
        setRenamingPath(null)
        if (parentDir === workingFolder) {
          await loadRoot()
        } else {
          await refreshDir(parentDir)
        }
      } catch (err) {
        console.error('Rename failed:', err)
      }
    },
    [renamingPath, sep, workingFolder, loadRoot, refreshDir]
  )

  const handleRenameCancel = useCallback(() => setRenamingPath(null), [])

  const handleNewFile = useCallback(
    async (dirPath: string) => {
      setNewItemParent(dirPath)
      setNewItemType('file')
      setRenamingPath(null)
      // Ensure the directory is expanded
      const expandNode = async (nodes: TreeNode[]): Promise<TreeNode[]> => {
        return Promise.all(
          nodes.map(async (n) => {
            if (n.path === dirPath && n.type === 'directory' && !n.expanded) {
              if (!n.loaded) {
                const children = await loadDir(dirPath)
                return { ...n, expanded: true, loaded: true, children }
              }
              return { ...n, expanded: true }
            }
            if (n.children) return { ...n, children: await expandNode(n.children) }
            return n
          })
        )
      }
      setTree(await expandNode(tree))
    },
    [tree, loadDir]
  )

  const handleNewFolder = useCallback(
    async (dirPath: string) => {
      setNewItemParent(dirPath)
      setNewItemType('directory')
      setRenamingPath(null)
      const expandNode = async (nodes: TreeNode[]): Promise<TreeNode[]> => {
        return Promise.all(
          nodes.map(async (n) => {
            if (n.path === dirPath && n.type === 'directory' && !n.expanded) {
              if (!n.loaded) {
                const children = await loadDir(dirPath)
                return { ...n, expanded: true, loaded: true, children }
              }
              return { ...n, expanded: true }
            }
            if (n.children) return { ...n, children: await expandNode(n.children) }
            return n
          })
        )
      }
      setTree(await expandNode(tree))
    },
    [tree, loadDir]
  )

  const handleNewItemConfirm = useCallback(
    async (name: string) => {
      if (!newItemParent) return
      const newPath = newItemParent + sep + name
      try {
        if (newItemType === 'directory') {
          await ipcClient.invoke('fs:mkdir', { path: newPath })
        } else {
          await ipcClient.invoke('fs:write-file', { path: newPath, content: '' })
        }
        setNewItemParent(null)
        await refreshDir(newItemParent)
      } catch (err) {
        console.error('Create failed:', err)
      }
    },
    [newItemParent, newItemType, sep, refreshDir]
  )

  const handleNewItemCancel = useCallback(() => setNewItemParent(null), [])

  const activePath = previewPanelState?.source === 'file' ? previewPanelState.filePath : null
  const treeStats = useMemo(() => countTreeStats(tree), [tree])
  const normalizedSearchQuery = searchQuery.trim().toLowerCase()
  const isSearching = normalizedSearchQuery.length > 0

  const editState: TreeEditState = { renamingPath, newItemParent, newItemType }
  const treeActions: TreeActions = {
    onDelete: handleDelete,
    onRenameStart: handleRenameStart,
    onRenameConfirm: handleRenameConfirm,
    onRenameCancel: handleRenameCancel,
    onNewFile: handleNewFile,
    onNewFolder: handleNewFolder,
    onNewItemConfirm: handleNewItemConfirm,
    onNewItemCancel: handleNewItemCancel
  }

  const handlePreview = useCallback((filePath: string) => {
    useUIStore.getState().openFilePreview(filePath)
  }, [])

  const handleFileDragStart = useCallback(
    (event: React.DragEvent<HTMLElement>, filePath: string) => {
      const relativePath = toRelativePath(filePath, workingFolder)
      event.dataTransfer.effectAllowed = 'copy'
      event.dataTransfer.setData(INTERNAL_FILE_DRAG_MIME, JSON.stringify([filePath]))
      event.dataTransfer.setData('text/plain', relativePath)
    },
    [workingFolder]
  )

  const handleCollapseAll = useCallback(() => {
    setTree((current) => collapseTree(current))
  }, [])

  if (!workingFolder) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-8 text-muted-foreground/60">
        <FolderPlus className="size-8" />
        <p className="text-xs">{t('fileTree.selectFolder')}</p>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[20px] border border-border/60 bg-background/70 shadow-[0_10px_30px_rgba(0,0,0,0.12)]">
        <div className="border-b border-border/60 bg-gradient-to-b from-muted/30 to-background/30 px-3 py-3">
          <div className="flex items-start gap-2">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-amber-500/20 bg-amber-500/10">
              <FolderOpen className="size-4 text-amber-400" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <div className="truncate text-sm font-medium text-foreground" title={workingFolder}>
                  {workingFolder.split(/[\\/]/).pop()}
                </div>
                <span className="rounded-full border border-primary/15 bg-primary/8 px-1.5 py-0.5 text-[10px] text-primary/80">
                  拖到输入框可引用
                </span>
              </div>
              <div className="mt-1 truncate text-[11px] text-muted-foreground" title={workingFolder}>
                {workingFolder}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="size-7 rounded-lg"
                onClick={handleCollapseAll}
                disabled={tree.length === 0 || isSearching}
                title={t('action.showLess', { ns: 'common' })}
              >
                <ChevronDown className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 rounded-lg"
                onClick={() => {
                  void loadRoot()
                }}
                disabled={loading}
                title={t('action.refresh', { ns: 'common' })}
              >
                <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
              </Button>
            </div>
          </div>

          <div className="mt-3 flex items-center gap-2 text-[10px] text-muted-foreground">
            <span className="rounded-full border border-border/60 bg-background/80 px-2 py-1">
              {treeStats.folders} {t('unit.folders', { ns: 'common' })}
            </span>
            <span className="rounded-full border border-border/60 bg-background/80 px-2 py-1">
              {treeStats.files} {t('unit.files', { ns: 'common' })}
            </span>
            {isSearching && (
              <span className="rounded-full border border-primary/20 bg-primary/8 px-2 py-1 text-primary/80">
                {searchResults.length} 个结果
              </span>
            )}
          </div>

          <div className="relative mt-3">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/70" />
            <Input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={t('fileTree.searchPlaceholder', { defaultValue: '搜索文件名或路径' })}
              className="h-9 rounded-xl border-border/60 bg-background/70 pl-9 pr-9 text-sm"
            />
            {searchQuery && (
              <button
                type="button"
                className="absolute right-2 top-1/2 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                onClick={() => setSearchQuery('')}
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
        </div>

        {error && (
          <div className="flex items-center gap-1.5 border-b border-border/50 px-3 py-2 text-[11px] text-destructive">
            <AlertCircle className="size-3 shrink-0" />
            <span className="truncate">{error}</span>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2 text-[12px]">
          {loading && tree.length === 0 ? (
            <div className="flex h-full items-center justify-center py-8">
              <RefreshCw className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : isSearching ? (
            searchLoading ? (
              <div className="flex items-center gap-2 rounded-xl border border-border/60 bg-muted/20 px-3 py-3 text-xs text-muted-foreground">
                <RefreshCw className="size-3.5 animate-spin" />
                <span>{t('fileTree.searching', { defaultValue: '搜索文件中...' })}</span>
              </div>
            ) : searchResults.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border/60 bg-muted/15 px-4 py-10 text-center">
                <Search className="size-5 text-muted-foreground/50" />
                <div className="text-xs text-muted-foreground">
                  {t('fileTree.noSearchResults', { defaultValue: '没有匹配的文件' })}
                </div>
              </div>
            ) : (
              <div className="space-y-1.5">
                {searchResults.map((file) => {
                  const isActive = activePath === file.path
                  const relativePath = toRelativePath(file.path, workingFolder)
                  return (
                    <button
                      key={file.path}
                      type="button"
                      className={cn(
                        'group flex w-full items-center gap-2 rounded-xl border px-2.5 py-2 text-left transition-all',
                        isActive
                          ? 'border-primary/25 bg-primary/10 shadow-sm'
                          : 'border-transparent bg-background/50 hover:border-border/50 hover:bg-muted/55'
                      )}
                      draggable
                      onDragStart={(event) => handleFileDragStart(event, file.path)}
                      onClick={() => handlePreview(file.path)}
                      title={file.path}
                    >
                      <GripVertical className="size-3 shrink-0 text-muted-foreground/25 transition-colors group-hover:text-muted-foreground/60" />
                      {fileIcon(file.name)}
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-foreground/90">{file.name}</div>
                        <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                          {relativePath}
                        </div>
                      </div>
                      <span className="rounded-full border border-border/60 bg-background/80 px-1.5 py-0.5 text-[10px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
                        拖动引用
                      </span>
                    </button>
                  )
                })}
              </div>
            )
          ) : tree.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border/60 bg-muted/15 px-4 py-10 text-center">
              <Folder className="size-5 text-muted-foreground/50" />
              <div className="text-xs text-muted-foreground">
                {t('fileTree.empty', { defaultValue: '当前目录没有文件' })}
              </div>
            </div>
          ) : (
            <div className="space-y-1">
              {tree.map((node) => (
                <TreeItem
                  key={node.path}
                  node={node}
                  depth={0}
                  activePath={activePath}
                  onToggle={handleToggle}
                  onCopyPath={handleCopyPath}
                  onPreview={handlePreview}
                  onFileDragStart={handleFileDragStart}
                  editState={editState}
                  actions={treeActions}
                />
              ))}
            </div>
          )}
        </div>

        <div className="border-t border-border/60 bg-background/40 px-3 py-2 text-[10px] text-muted-foreground/80">
          {isSearching
            ? t('fileTree.searchHint', { defaultValue: '点击预览，拖到输入框可插入文件引用' })
            : t('fileTree.stats', {
                folders: treeStats.folders,
                files: treeStats.files
              })}
        </div>
      </div>
    </div>
  )
}
