import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { confirm } from '@renderer/components/ui/confirm-dialog'
import {
  FolderOpen,
  Folder,
  File,
  Code2,
  ExternalLink,
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
  Eye,
  MessageSquarePlus,
  Pencil,
  SquareTerminal,
  Trash2,
  Search,
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
import { IPC } from '@renderer/lib/ipc/channels'
import { ensureProjectTerminalReady } from '@renderer/lib/terminal/project-terminal-context'
import { createSelectFileTag } from '@renderer/lib/select-file-tags'
import { cn } from '@renderer/lib/utils'
import { AnimatePresence, motion } from 'motion/react'
import { toast } from 'sonner'

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

export interface AgentFileTreeCommand {
  id: number
  type: 'new-file' | 'new-folder' | 'refresh' | 'collapse-all'
}

interface FileSearchItem {
  name: string
  path: string
}

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

function collectExpandedPaths(nodes: TreeNode[], paths = new Set<string>()): Set<string> {
  for (const node of nodes) {
    if (node.type === 'directory' && node.expanded) paths.add(node.path)
    if (node.children?.length) collectExpandedPaths(node.children, paths)
  }
  return paths
}

function toRelativePath(filePath: string, workingFolder?: string): string {
  if (!workingFolder) return filePath
  if (!filePath.startsWith(workingFolder)) return filePath
  return filePath.slice(workingFolder.length).replace(/^[\\/]+/, '')
}

function basename(filePath: string): string {
  const normalized = filePath.replace(/[\\/]+$/, '')
  return normalized.split(/[\\/]/).filter(Boolean).pop() ?? normalized
}

function parentPath(filePath: string, separator: string): string {
  const index = filePath.lastIndexOf(separator)
  if (index <= 0) return separator === '/' ? '/' : ''
  return filePath.slice(0, index)
}

function joinPath(parent: string, name: string, separator: string): string {
  return `${parent.replace(/[\\/]+$/, '')}${separator}${name}`
}

function getErrorMessage(err: unknown, fallback = 'Operation failed'): string {
  if (err instanceof Error && err.message) return err.message
  if (typeof err === 'string' && err.trim()) return err
  return fallback
}

function getIpcError(result: unknown): string | null {
  if (!result || typeof result !== 'object' || !('error' in result)) return null
  const error = (result as { error?: unknown }).error
  return typeof error === 'string' && error.length > 0 ? error : 'Operation failed'
}

type EntryNameValidationError = 'empty' | 'dot' | 'separator'

function validateEntryName(name: string): EntryNameValidationError | null {
  if (!name.trim()) return 'empty'
  if (name === '.' || name === '..') return 'dot'
  if (/[\\/]/.test(name)) return 'separator'
  return null
}

function DepthGuides({ depth }: { depth: number }): React.JSX.Element | null {
  if (depth <= 0) return null

  return (
    <div className="absolute inset-y-0 left-0 pointer-events-none">
      {Array.from({ length: depth }).map((_, index) => (
        <span
          key={index}
          className="workspace-filetree-guide absolute inset-y-0 w-px"
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
        className="workspace-filetree-input flex-1 min-w-0 rounded border px-1 py-0 text-[12px] text-foreground outline-none focus:ring-1 focus:ring-ring"
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
  localActionsAvailable: boolean
  onDelete: (nodePath: string, nodeName: string, isDir: boolean) => void
  onRenameStart: (nodePath: string, nodeName: string) => void
  onRenameConfirm: (value: string) => void
  onRenameCancel: () => void
  onAddToChat: (nodePath: string) => void
  onCopyPath: (nodePath: string) => void
  onPreview: (nodePath: string) => void
  onOpenDefault: (nodePath: string) => void
  onOpenTerminal: (nodePath: string, isDir: boolean) => void
  onOpenWithCode: (nodePath: string) => void
  onReveal: (nodePath: string) => void
  onNewFile: (dirPath: string) => void
  onNewFolder: (dirPath: string) => void
  onNewItemConfirm: (value: string) => void
  onNewItemCancel: () => void
  onRefresh: (dirPath: string) => void
}

function TreeItem({
  node,
  depth,
  activePath,
  onToggle,
  editState,
  actions,
  agentSurface = false
}: {
  node: TreeNode
  depth: number
  activePath: string | null
  onToggle: (path: string) => void
  editState: TreeEditState
  actions: TreeActions
  agentSurface?: boolean
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
    actions.onCopyPath(node.path)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }, [actions, node.path])

  const handleAddToChat = useCallback(() => {
    actions.onAddToChat(node.path)
  }, [actions, node.path])

  const rowContent = (
    <div
      className={cn(
        'workspace-filetree-row group relative flex items-center text-[12px] transition-all',
        'cursor-pointer',
        agentSurface
          ? 'workspace-filetree-row--agent gap-0 rounded-none px-0 py-0'
          : 'gap-2 rounded-xl px-2 py-1.5',
        isActive
          ? 'workspace-filetree-row--active text-foreground'
          : isDir && node.expanded
            ? 'workspace-filetree-row--expanded workspace-filetree-row--interactive'
            : 'workspace-filetree-row--interactive',
        isIgnored && 'opacity-40'
      )}
      style={{ paddingLeft: `${depth * 14 + (agentSurface ? 4 : 6)}px` }}
      onClick={() => (isDir && !isIgnored ? onToggle(node.path) : actions.onPreview(node.path))}
      onContextMenu={(event) => event.stopPropagation()}
      title={node.path}
    >
      {!agentSurface ? <DepthGuides depth={depth} /> : null}
      {depth > 0 && !agentSurface && (
        <span
          className="workspace-filetree-guide absolute top-1/2 h-px w-2 pointer-events-none"
          style={{ left: `${(depth - 1) * 14 + 9}px` }}
        />
      )}

      {isDir ? (
        node.expanded ? (
          <ChevronDown
            className={cn(
              'shrink-0',
              agentSurface
                ? 'workspace-filetree-chevron size-4 text-agent-files-icon'
                : 'size-3 text-muted-foreground/60'
            )}
          />
        ) : (
          <ChevronRight
            className={cn(
              'shrink-0',
              agentSurface
                ? 'workspace-filetree-chevron size-4 text-agent-files-icon'
                : 'size-3 text-muted-foreground/60'
            )}
          />
        )
      ) : (
        <span className={cn('shrink-0', agentSurface ? 'size-4' : 'size-3')} />
      )}

      {isDir ? (
        node.expanded ? (
          <FolderOpen
            className={cn(
              'shrink-0',
              agentSurface ? 'size-4 text-[#dcb67a]' : 'size-3.5 text-amber-400'
            )}
          />
        ) : (
          <Folder
            className={cn(
              'shrink-0',
              agentSurface ? 'size-4 text-[#dcb67a]' : 'size-3.5 text-amber-400/80'
            )}
          />
        )
      ) : (
        fileIcon(node.name)
      )}

      {isRenaming ? (
        <input
          autoFocus
          className="workspace-filetree-input flex-1 min-w-0 rounded border px-1 py-0 text-[12px] text-foreground outline-none focus:ring-1 focus:ring-ring"
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
              agentSurface
                ? 'font-normal text-agent-files-fg'
                : isDir
                  ? 'font-medium text-foreground/85'
                  : 'text-foreground/80'
            )}
          >
            {node.name}
          </span>
        </div>
      )}

      {!agentSurface && !isDir && !isRenaming && (
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-all group-hover:opacity-100">
          <button
            className="workspace-filetree-action rounded-md p-1"
            onClick={(e) => {
              e.stopPropagation()
              handleAddToChat()
            }}
            title={t('fileTree.addToChat')}
          >
            <MessageSquarePlus className="size-3" />
          </button>
          <button
            className="workspace-filetree-action rounded-md p-1"
            onClick={(e) => {
              e.stopPropagation()
              handleCopy()
            }}
            title={t('fileTree.copyPath')}
          >
            {copied ? <Check className="size-3 text-green-500" /> : <Copy className="size-3" />}
          </button>
        </div>
      )}
    </div>
  )

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{rowContent}</ContextMenuTrigger>
        <ContextMenuContent className="w-52">
          {!isDir && (
            <ContextMenuItem
              className="gap-2 text-xs"
              onSelect={() => actions.onPreview(node.path)}
            >
              <Eye className="size-3.5" /> {t('fileTree.preview')}
            </ContextMenuItem>
          )}
          <ContextMenuItem className="gap-2 text-xs" onSelect={handleAddToChat}>
            <MessageSquarePlus className="size-3.5" /> {t('fileTree.addToChat')}
          </ContextMenuItem>
          {isDir && !isIgnored && (
            <>
              <ContextMenuItem className="gap-2 text-xs" onSelect={() => onToggle(node.path)}>
                {node.expanded ? (
                  <ChevronDown className="size-3.5" />
                ) : (
                  <ChevronRight className="size-3.5" />
                )}
                {node.expanded ? t('fileTree.collapseFolder') : t('fileTree.expandFolder')}
              </ContextMenuItem>
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
              <ContextMenuItem
                className="gap-2 text-xs"
                onSelect={() => actions.onRefresh(node.path)}
              >
                <RefreshCw className="size-3.5" /> {t('action.refresh', { ns: 'common' })}
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}
          <ContextMenuItem className="gap-2 text-xs" onSelect={handleCopy}>
            <Copy className="size-3.5" /> {t('action.copyPath', { ns: 'common' })}
          </ContextMenuItem>
          <ContextMenuItem
            className="gap-2 text-xs"
            onSelect={() => actions.onOpenTerminal(node.path, isDir)}
          >
            <SquareTerminal className="size-3.5" /> {t('fileTree.openTerminal')}
          </ContextMenuItem>
          {actions.localActionsAvailable && !isIgnored && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                className="gap-2 text-xs"
                onSelect={() => actions.onOpenDefault(node.path)}
              >
                <ExternalLink className="size-3.5" /> {t('fileTree.openDefault')}
              </ContextMenuItem>
              <ContextMenuItem
                className="gap-2 text-xs"
                onSelect={() => actions.onOpenWithCode(node.path)}
              >
                <Code2 className="size-3.5" /> {t('fileTree.openWithCode')}
              </ContextMenuItem>
              <ContextMenuItem
                className="gap-2 text-xs"
                onSelect={() => actions.onReveal(node.path)}
              >
                <FolderOpen className="size-3.5" /> {t('fileTree.revealInFinder')}
              </ContextMenuItem>
            </>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem
            className="gap-2 text-xs"
            onSelect={() => actions.onRenameStart(node.path, node.name)}
          >
            <Pencil className="size-3.5" /> {t('action.rename', { ns: 'common' })}
          </ContextMenuItem>
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
                  editState={editState}
                  actions={actions}
                  agentSurface={agentSurface}
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

interface FileTreePanelProps {
  sessionId?: string | null
  surface?: 'card' | 'sheet' | 'agent'
  agentSearchOpen?: boolean
  agentCommand?: AgentFileTreeCommand | null
  watchEnabled?: boolean
}

export function FileTreePanel({
  sessionId = null,
  surface = 'card',
  agentSearchOpen = false,
  agentCommand = null,
  watchEnabled = true
}: FileTreePanelProps): React.JSX.Element {
  const { t } = useTranslation('cowork')
  const sessionView = useChatStore(
    useShallow((state) => {
      const resolvedSessionId = sessionId ?? state.activeSessionId
      const currentSession = resolvedSessionId
        ? state.sessions.find((item) => item.id === resolvedSessionId)
        : undefined
      const currentProject = currentSession?.projectId
        ? state.projects.find((item) => item.id === currentSession.projectId)
        : undefined

      return {
        sessionId: resolvedSessionId,
        projectId: currentSession?.projectId ?? currentProject?.id ?? null,
        projectName: currentProject?.name ?? null,
        workingFolder: currentSession?.workingFolder ?? currentProject?.workingFolder,
        sshConnectionId: currentSession?.sshConnectionId ?? currentProject?.sshConnectionId
      }
    })
  )
  const workingFolder = sessionView.workingFolder
  const sshConnectionId = sessionView.sshConnectionId
  const agentSurface = surface === 'agent'
  const previewPanelState = useUIStore((s) => s.previewPanelState)

  const [tree, setTree] = useState<TreeNode[]>([])
  const treeRef = useRef<TreeNode[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<FileSearchItem[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [agentRootExpanded, setAgentRootExpanded] = useState(true)
  const lastAgentCommandIdRef = useRef(0)

  // --- Edit state for context menu actions ---
  const [renamingPath, setRenamingPath] = useState<string | null>(null)
  const [newItemParent, setNewItemParent] = useState<string | null>(null)
  const [newItemType, setNewItemType] = useState<'file' | 'directory'>('file')

  const loadDir = useCallback(
    async (dirPath: string): Promise<TreeNode[]> => {
      const result = sshConnectionId
        ? ((await ipcClient.invoke(IPC.SSH_FS_LIST_DIR, {
            connectionId: sshConnectionId,
            path: dirPath
          })) as FileEntry[] | { error: string })
        : ((await ipcClient.invoke(IPC.FS_LIST_DIR, { path: dirPath })) as
            | FileEntry[]
            | { error: string })
      if ('error' in result) throw new Error(String(result.error))
      const sorted = sortEntries(result as FileEntry[])
      return sorted.map((e) => ({
        ...e,
        expanded: false,
        loaded: e.type === 'file',
        children: e.type === 'directory' ? [] : undefined
      }))
    },
    [sshConnectionId]
  )

  useEffect(() => {
    treeRef.current = tree
  }, [tree])

  const hydrateExpandedNodes = useCallback(
    async (nodes: TreeNode[], expandedPaths: Set<string>): Promise<TreeNode[]> => {
      const hydrate = async (items: TreeNode[]): Promise<TreeNode[]> => {
        return Promise.all(
          items.map(async (node) => {
            if (node.type !== 'directory') return node
            const expanded = expandedPaths.has(node.path)
            if (!expanded) {
              return { ...node, expanded: false, loaded: false, children: [] }
            }

            try {
              const children = await loadDir(node.path)
              return {
                ...node,
                expanded: true,
                loaded: true,
                children: await hydrate(children)
              }
            } catch {
              return { ...node, expanded: true, loaded: true, children: node.children ?? [] }
            }
          })
        )
      }

      return hydrate(nodes)
    },
    [loadDir]
  )

  const loadRoot = useCallback(
    async (preserveExpanded = false) => {
      if (!workingFolder) return
      setLoading(true)
      setError(null)
      try {
        const expandedPaths: Set<string> = preserveExpanded
          ? collectExpandedPaths(treeRef.current)
          : new Set<string>()
        const nodes = await loadDir(workingFolder)
        const nextTree = preserveExpanded ? await hydrateExpandedNodes(nodes, expandedPaths) : nodes
        setTree(nextTree)
      } catch (err) {
        setError(getErrorMessage(err, 'Failed to load files'))
      } finally {
        setLoading(false)
      }
    },
    [hydrateExpandedNodes, workingFolder, loadDir]
  )

  useEffect(() => {
    treeRef.current = []
    void loadRoot(false)
  }, [loadRoot])

  const refreshTree = useCallback(async () => {
    await loadRoot(true)
  }, [loadRoot])

  // Watch working directory for changes and auto-refresh
  useEffect(() => {
    const shouldWatchWorkingFolder = watchEnabled && (!agentSurface || agentRootExpanded)
    if (!shouldWatchWorkingFolder || !workingFolder || sshConnectionId) return

    let mounted = true
    let refreshTimer: NodeJS.Timeout | null = null
    const handleDirChanged = (...args: unknown[]): void => {
      const payload = args[0]
      const data =
        payload && typeof payload === 'object'
          ? (payload as { path?: string; changedPath?: string })
          : undefined
      if (!mounted) return
      if (data?.path && data.path !== workingFolder) return
      // Debounce refresh to avoid excessive updates
      if (refreshTimer) clearTimeout(refreshTimer)
      refreshTimer = setTimeout(() => {
        if (!mounted) return
        void refreshTree()
      }, 500)
    }

    // Start watching the working directory
    void ipcClient.invoke(IPC.FS_WATCH_DIR, { path: workingFolder, recursive: true })

    // Listen for directory change events
    const cleanup = ipcClient.on(IPC.FS_DIR_CHANGED, handleDirChanged)

    return () => {
      mounted = false
      if (refreshTimer) clearTimeout(refreshTimer)
      cleanup()
      void ipcClient.invoke(IPC.FS_UNWATCH_DIR, { path: workingFolder, recursive: true })
    }
  }, [agentRootExpanded, agentSurface, watchEnabled, workingFolder, sshConnectionId, refreshTree])

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
        .invoke(
          sshConnectionId ? IPC.SSH_FS_GLOB : 'fs:search-files',
          sshConnectionId
            ? {
                connectionId: sshConnectionId,
                path: workingFolder,
                pattern: `*${query}*`
              }
            : {
                path: workingFolder,
                query,
                limit: 100
              }
        )
        .then((result) => {
          if (cancelled) return
          if (sshConnectionId) {
            const matches = (
              result as { matches?: Array<{ path: string; type?: 'file' | 'directory' }> }
            ).matches
            setSearchResults(
              Array.isArray(matches)
                ? matches
                    .filter((item) => item.type !== 'directory')
                    .slice(0, 100)
                    .map((item) => ({ path: item.path, name: basename(item.path) }))
                : []
            )
            return
          }
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
  }, [searchQuery, sshConnectionId, workingFolder])

  const handleToggle = useCallback(
    async (dirPath: string) => {
      const toggleNode = async (nodes: TreeNode[]): Promise<TreeNode[]> => {
        return Promise.all(
          nodes.map(async (n) => {
            if (n.path === dirPath && n.type === 'directory') {
              if (n.expanded) {
                return { ...n, expanded: false }
              }
              // Always reload directory contents when expanding to ensure fresh data
              try {
                const children = await loadDir(dirPath)
                return { ...n, expanded: true, loaded: true, children }
              } catch {
                return { ...n, expanded: true, loaded: true, children: [] }
              }
            }
            if (n.children) {
              return { ...n, children: await toggleNode(n.children) }
            }
            return n
          })
        )
      }
      setTree(await toggleNode(treeRef.current))
    },
    [loadDir]
  )

  // Refresh a single directory's children in the tree (after create/rename/delete)
  const refreshDir = useCallback(
    async (dirPath: string) => {
      if (dirPath) await refreshTree()
    },
    [refreshTree]
  )

  const handleCopyPath = useCallback(
    (filePath: string) => {
      void navigator.clipboard.writeText(filePath).catch((err) => {
        toast.error(t('fileTree.copyFailed'), {
          description: getErrorMessage(err, 'Unable to copy path')
        })
      })
    },
    [t]
  )

  const handleAddToChat = useCallback(
    (filePath: string) => {
      const relativePath = toRelativePath(filePath, workingFolder)
      useUIStore.getState().setPendingInsertText(createSelectFileTag(relativePath))
    },
    [workingFolder]
  )

  // --- Context menu action handlers ---

  const sep = sshConnectionId ? '/' : workingFolder?.includes('/') ? '/' : '\\'

  const getNameValidationErrorMessage = useCallback(
    (error: EntryNameValidationError): string => {
      if (error === 'empty') {
        return t('fileTree.nameEmpty', { defaultValue: 'Name cannot be empty' })
      }
      if (error === 'dot') {
        return t('fileTree.nameDotReserved', {
          defaultValue: 'Name cannot be "." or ".."'
        })
      }
      return t('fileTree.nameSeparator', {
        defaultValue: 'Name cannot contain path separators'
      })
    },
    [t]
  )

  const showActionError = useCallback((title: string, err: unknown) => {
    toast.error(title, {
      description: getErrorMessage(err)
    })
  }, [])

  const pathExists = useCallback(
    async (targetPath: string): Promise<boolean> => {
      const result = await ipcClient.invoke(
        sshConnectionId ? IPC.SSH_FS_STAT_PATH : IPC.FS_STAT_PATH,
        sshConnectionId ? { connectionId: sshConnectionId, path: targetPath } : { path: targetPath }
      )
      const error = getIpcError(result)
      if (error) throw new Error(error)
      return Boolean((result as { exists?: boolean } | undefined)?.exists)
    },
    [sshConnectionId]
  )

  const handleDelete = useCallback(
    async (nodePath: string, nodeName: string, isDir: boolean) => {
      const type = isDir ? t('fileTree.folder') : t('fileTree.file')
      const confirmed = await confirm({
        title: t('fileTree.deleteConfirmTitle', {
          type,
          defaultValue: 'Delete {{type}}?'
        }),
        description: t('fileTree.deleteConfirmDescription', {
          name: nodeName,
          defaultValue: 'Delete "{{name}}"?'
        }),
        confirmLabel: t('action.delete', { ns: 'common' }),
        variant: 'destructive'
      })
      if (!confirmed) return
      try {
        const result = await ipcClient.invoke(
          sshConnectionId ? IPC.SSH_FS_DELETE : IPC.SHELL_TRASH_PATH,
          sshConnectionId ? { connectionId: sshConnectionId, path: nodePath } : nodePath
        )
        const error = getIpcError(result)
        if (error) throw new Error(error)
        const parentDir = parentPath(nodePath, sep)
        if (parentDir === workingFolder) {
          await loadRoot(true)
        } else {
          await refreshDir(parentDir)
        }
      } catch (err) {
        showActionError(t('fileTree.deleteFailed', { defaultValue: 'Delete failed' }), err)
      }
    },
    [sep, sshConnectionId, t, workingFolder, loadRoot, refreshDir, showActionError]
  )

  const handleRenameStart = useCallback((nodePath: string) => {
    setRenamingPath(nodePath)
    setNewItemParent(null)
  }, [])

  const handleRenameConfirm = useCallback(
    async (newName: string) => {
      if (!renamingPath) return
      const validationError = validateEntryName(newName)
      if (validationError) {
        toast.error(t('fileTree.invalidName', { defaultValue: 'Invalid name' }), {
          description: getNameValidationErrorMessage(validationError)
        })
        return
      }

      const parentDir = parentPath(renamingPath, sep)
      const newPath = joinPath(parentDir, newName, sep)
      try {
        if (newPath !== renamingPath && (await pathExists(newPath))) {
          throw new Error(t('fileTree.targetExists', { defaultValue: 'Target already exists' }))
        }

        const result = await ipcClient.invoke(
          sshConnectionId ? IPC.SSH_FS_MOVE : IPC.FS_MOVE,
          sshConnectionId
            ? { connectionId: sshConnectionId, from: renamingPath, to: newPath }
            : { from: renamingPath, to: newPath }
        )
        const error = getIpcError(result)
        if (error) throw new Error(error)
        setRenamingPath(null)
        if (parentDir === workingFolder) {
          await loadRoot(true)
        } else {
          await refreshDir(parentDir)
        }
      } catch (err) {
        showActionError(t('fileTree.renameFailed', { defaultValue: 'Rename failed' }), err)
      }
    },
    [
      renamingPath,
      sep,
      sshConnectionId,
      workingFolder,
      loadRoot,
      refreshDir,
      pathExists,
      showActionError,
      getNameValidationErrorMessage,
      t
    ]
  )

  const handleRenameCancel = useCallback(() => setRenamingPath(null), [])

  const expandDirectoryForNewItem = useCallback(
    async (dirPath: string) => {
      if (dirPath === workingFolder) return

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
      setTree(await expandNode(treeRef.current))
    },
    [loadDir, workingFolder]
  )

  const handleNewFile = useCallback(
    async (dirPath: string) => {
      setNewItemParent(dirPath)
      setNewItemType('file')
      setRenamingPath(null)
      await expandDirectoryForNewItem(dirPath)
    },
    [expandDirectoryForNewItem]
  )

  const handleNewFolder = useCallback(
    async (dirPath: string) => {
      setNewItemParent(dirPath)
      setNewItemType('directory')
      setRenamingPath(null)
      await expandDirectoryForNewItem(dirPath)
    },
    [expandDirectoryForNewItem]
  )

  const handleNewItemConfirm = useCallback(
    async (name: string) => {
      if (!newItemParent) return
      const validationError = validateEntryName(name)
      if (validationError) {
        toast.error(t('fileTree.invalidName', { defaultValue: 'Invalid name' }), {
          description: getNameValidationErrorMessage(validationError)
        })
        return
      }

      const newPath = joinPath(newItemParent, name, sep)
      try {
        if (await pathExists(newPath)) {
          throw new Error(t('fileTree.targetExists', { defaultValue: 'Target already exists' }))
        }

        let result: unknown
        if (newItemType === 'directory') {
          result = await ipcClient.invoke(
            sshConnectionId ? IPC.SSH_FS_MKDIR : IPC.FS_MKDIR,
            sshConnectionId ? { connectionId: sshConnectionId, path: newPath } : { path: newPath }
          )
        } else {
          result = await ipcClient.invoke(
            sshConnectionId ? IPC.SSH_FS_WRITE_FILE : IPC.FS_WRITE_FILE,
            sshConnectionId
              ? { connectionId: sshConnectionId, path: newPath, content: '' }
              : { path: newPath, content: '' }
          )
        }
        const error = getIpcError(result)
        if (error) throw new Error(error)
        setNewItemParent(null)
        await refreshDir(newItemParent)
      } catch (err) {
        showActionError(t('fileTree.createFailed', { defaultValue: 'Create failed' }), err)
      }
    },
    [
      newItemParent,
      newItemType,
      sep,
      sshConnectionId,
      refreshDir,
      pathExists,
      showActionError,
      getNameValidationErrorMessage,
      t
    ]
  )

  const handleNewItemCancel = useCallback(() => setNewItemParent(null), [])

  const handleRefresh = useCallback(
    async (dirPath: string) => {
      await refreshDir(dirPath)
    },
    [refreshDir]
  )

  const handleOpenDefault = useCallback(
    async (nodePath: string) => {
      if (sshConnectionId) {
        toast.info(t('fileTree.localOnlyAction', { defaultValue: 'This action is local only' }))
        return
      }

      const result = await ipcClient.invoke(IPC.SHELL_OPEN_PATH, nodePath)
      if (typeof result === 'string' && result.length > 0) {
        toast.error(t('fileTree.openFailed', { defaultValue: 'Open failed' }), {
          description: result
        })
      }
    },
    [sshConnectionId, t]
  )

  const handleReveal = useCallback(
    async (nodePath: string) => {
      if (sshConnectionId) {
        toast.info(t('fileTree.localOnlyAction', { defaultValue: 'This action is local only' }))
        return
      }

      const result = await ipcClient.invoke(IPC.SHELL_SHOW_ITEM_IN_FOLDER, nodePath)
      const error = getIpcError(result)
      if (error) {
        toast.error(t('fileTree.revealFailed', { defaultValue: 'Reveal failed' }), {
          description: error
        })
      }
    },
    [sshConnectionId, t]
  )

  const handleOpenWithCode = useCallback(
    async (nodePath: string) => {
      if (sshConnectionId) {
        toast.info(t('fileTree.localOnlyAction', { defaultValue: 'This action is local only' }))
        return
      }

      const result = await ipcClient.invoke(IPC.SHELL_OPEN_WITH_APP, {
        path: nodePath,
        appId: 'vscode'
      })
      const error = getIpcError(result)
      if (error) {
        toast.error(t('fileTree.openWithCodeFailed', { defaultValue: 'Open in VS Code failed' }), {
          description: error
        })
      }
    },
    [sshConnectionId, t]
  )

  const handleOpenTerminal = useCallback(
    async (nodePath: string, isDir: boolean) => {
      const terminalPath = isDir ? nodePath : parentPath(nodePath, sep)
      const tabId = await ensureProjectTerminalReady({
        projectId: sessionView.projectId,
        projectName: sessionView.projectName,
        workingFolder: sshConnectionId ? workingFolder : terminalPath,
        sshConnectionId
      })

      if (!tabId) {
        toast.error(t('fileTree.openTerminalFailed', { defaultValue: 'Failed to open terminal' }))
        return
      }

      if (sessionView.projectId) {
        useUIStore.getState().setBottomTerminalDockOpen(sessionView.projectId, true)
      }
    },
    [sep, sessionView.projectId, sessionView.projectName, sshConnectionId, workingFolder, t]
  )

  const activePath = previewPanelState?.source === 'file' ? previewPanelState.filePath : null
  const treeStats = useMemo(() => countTreeStats(tree), [tree])
  const normalizedSearchQuery = searchQuery.trim().toLowerCase()
  const isSearching = normalizedSearchQuery.length > 0

  const handlePreview = useCallback(
    (filePath: string) => {
      useUIStore.getState().openFilePreview(filePath, undefined, undefined, sessionView.sessionId)
    },
    [sessionView.sessionId]
  )

  const editState: TreeEditState = { renamingPath, newItemParent, newItemType }
  const treeActions: TreeActions = {
    localActionsAvailable: !sshConnectionId,
    onDelete: handleDelete,
    onRenameStart: handleRenameStart,
    onRenameConfirm: handleRenameConfirm,
    onRenameCancel: handleRenameCancel,
    onAddToChat: handleAddToChat,
    onCopyPath: handleCopyPath,
    onPreview: handlePreview,
    onOpenDefault: handleOpenDefault,
    onOpenTerminal: handleOpenTerminal,
    onOpenWithCode: handleOpenWithCode,
    onReveal: handleReveal,
    onNewFile: handleNewFile,
    onNewFolder: handleNewFolder,
    onNewItemConfirm: handleNewItemConfirm,
    onNewItemCancel: handleNewItemCancel,
    onRefresh: handleRefresh
  }

  const handleCollapseAll = useCallback(() => {
    setTree((current) => collapseTree(current))
  }, [])
  const compactSheetSurface = surface === 'sheet' || surface === 'agent'
  const showSearchInput = !agentSurface || agentSearchOpen

  useEffect(() => {
    if (!agentSurface || agentSearchOpen) return
    setSearchQuery('')
  }, [agentSearchOpen, agentSurface])

  useEffect(() => {
    if (
      !agentSurface ||
      !workingFolder ||
      !agentCommand ||
      lastAgentCommandIdRef.current === agentCommand.id
    )
      return
    lastAgentCommandIdRef.current = agentCommand.id

    if (agentCommand.type === 'new-file') {
      setAgentRootExpanded(true)
      void handleNewFile(workingFolder)
      return
    }
    if (agentCommand.type === 'new-folder') {
      setAgentRootExpanded(true)
      void handleNewFolder(workingFolder)
      return
    }
    if (agentCommand.type === 'refresh') {
      void refreshTree()
      return
    }
    if (agentCommand.type === 'collapse-all') {
      setAgentRootExpanded(true)
      handleCollapseAll()
    }
  }, [
    agentCommand,
    agentSurface,
    handleCollapseAll,
    handleNewFile,
    handleNewFolder,
    refreshTree,
    workingFolder
  ])

  const rootNewItemInput =
    newItemParent === workingFolder ? (
      <InlineInput
        defaultValue={newItemType === 'file' ? 'untitled' : 'new-folder'}
        depth={agentSurface ? 1 : 0}
        icon={
          newItemType === 'file' ? (
            <File className="size-3.5 text-muted-foreground/60" />
          ) : (
            <Folder className="size-3.5 text-amber-400/70" />
          )
        }
        onConfirm={handleNewItemConfirm}
        onCancel={handleNewItemCancel}
      />
    ) : null

  if (!workingFolder) {
    return (
      <div className="workspace-filetree-empty flex flex-col items-center justify-center gap-2 rounded-xl py-8 text-muted-foreground/70">
        <FolderPlus className="size-8" />
        <p className="text-xs">{t('fileTree.selectFolder')}</p>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className={cn(
          'workspace-filetree-surface flex min-h-0 flex-1 flex-col overflow-hidden',
          agentSurface
            ? 'workspace-filetree-surface--agent'
            : compactSheetSurface
              ? 'workspace-filetree-surface--sheet'
              : 'workspace-filetree-surface--card rounded-[20px]'
        )}
      >
        <div
          className={cn(
            'workspace-filetree-header',
            agentSurface ? 'workspace-filetree-header--agent px-0 py-0' : 'px-3 py-3'
          )}
        >
          {!compactSheetSurface && (
            <>
              <div className="flex items-start gap-2">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-amber-500/20 bg-amber-500/10">
                  <FolderOpen className="size-4 text-amber-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <div
                      className="truncate text-sm font-medium text-foreground"
                      title={workingFolder}
                    >
                      {workingFolder.split(/[\\/]/).pop()}
                    </div>
                  </div>
                  <div
                    className="mt-1 truncate text-[11px] text-muted-foreground"
                    title={workingFolder}
                  >
                    {workingFolder}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 rounded-lg"
                    onClick={() => void handleNewFile(workingFolder)}
                    disabled={isSearching}
                    title={t('fileTree.newFile')}
                  >
                    <FilePlus2 className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 rounded-lg"
                    onClick={() => void handleNewFolder(workingFolder)}
                    disabled={isSearching}
                    title={t('fileTree.newFolder')}
                  >
                    <FolderPlus className="size-3.5" />
                  </Button>
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
                      void refreshTree()
                    }}
                    disabled={loading}
                    title={t('action.refresh', { ns: 'common' })}
                  >
                    <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
                  </Button>
                </div>
              </div>

              <div className="mt-3 flex items-center gap-2 text-[10px] text-muted-foreground">
                <span className="workspace-filetree-chip rounded-full px-2 py-1">
                  {treeStats.folders} {t('unit.folders', { ns: 'common' })}
                </span>
                <span className="workspace-filetree-chip rounded-full px-2 py-1">
                  {treeStats.files} {t('unit.files', { ns: 'common' })}
                </span>
                {isSearching && (
                  <span className="rounded-full border border-primary/20 bg-primary/8 px-2 py-1 text-primary/80">
                    {searchResults.length} {t('unit.matches', { ns: 'common' })}
                  </span>
                )}
              </div>
            </>
          )}

          {compactSheetSurface && !agentSurface && (
            <div className="mb-3 flex items-center gap-2">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-xl border border-amber-500/20 bg-amber-500/10">
                <FolderOpen className="size-3.5 text-amber-400" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-foreground" title={workingFolder}>
                  {workingFolder.split(/[\\/]/).pop()}
                </div>
                <div className="truncate text-[11px] text-muted-foreground" title={workingFolder}>
                  {workingFolder}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 rounded-lg"
                  onClick={() => void handleNewFile(workingFolder)}
                  disabled={isSearching}
                  title={t('fileTree.newFile')}
                >
                  <FilePlus2 className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 rounded-lg"
                  onClick={() => void handleNewFolder(workingFolder)}
                  disabled={isSearching}
                  title={t('fileTree.newFolder')}
                >
                  <FolderPlus className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 rounded-lg"
                  onClick={() => void refreshTree()}
                  disabled={loading}
                  title={t('action.refresh', { ns: 'common' })}
                >
                  <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
                </Button>
              </div>
            </div>
          )}

          {showSearchInput ? (
            <div
              className={cn(
                'relative',
                !compactSheetSurface && 'mt-3',
                agentSurface && 'px-2 py-1'
              )}
            >
              <Search
                className={cn(
                  'pointer-events-none absolute top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/70',
                  agentSurface ? 'left-5' : 'left-3'
                )}
              />
              <Input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder={t('fileTree.searchPlaceholder', {
                  defaultValue: 'Search file name or path'
                })}
                className={cn(
                  'workspace-filetree-input rounded-xl pl-9 pr-9 text-sm',
                  agentSurface ? 'h-6 rounded-[2px] text-xs' : 'h-9'
                )}
              />
              {searchQuery && (
                <button
                  type="button"
                  className={cn(
                    'workspace-filetree-action absolute top-1/2 inline-flex -translate-y-1/2 items-center justify-center transition-colors',
                    agentSurface ? 'right-3 size-5 rounded-[2px]' : 'right-2 size-6 rounded-md'
                  )}
                  onClick={() => setSearchQuery('')}
                >
                  <X className="size-3.5" />
                </button>
              )}
            </div>
          ) : null}
        </div>

        {error && (
          <div className="workspace-filetree-header flex items-center gap-1.5 px-3 py-2 text-[11px] text-destructive">
            <AlertCircle className="size-3 shrink-0" />
            <span className="truncate">{error}</span>
          </div>
        )}

        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div
              className={cn(
                'min-h-0 flex-1 overflow-y-auto text-[12px]',
                agentSurface ? 'px-0 py-1' : compactSheetSurface ? 'px-3 py-3' : 'px-2 py-2'
              )}
            >
              {loading && tree.length === 0 ? (
                <div className="flex h-full items-center justify-center py-8">
                  <RefreshCw className="size-4 animate-spin text-muted-foreground" />
                </div>
              ) : isSearching ? (
                searchLoading ? (
                  <div className="workspace-filetree-empty flex items-center gap-2 rounded-xl px-3 py-3 text-xs text-muted-foreground">
                    <RefreshCw className="size-3.5 animate-spin" />
                    <span>{t('fileTree.searching', { defaultValue: 'Searching files...' })}</span>
                  </div>
                ) : searchResults.length === 0 ? (
                  <div className="workspace-filetree-empty workspace-filetree-empty--dashed flex flex-col items-center justify-center gap-2 rounded-xl px-4 py-10 text-center">
                    <Search className="size-5 text-muted-foreground/50" />
                    <div className="text-xs text-muted-foreground">
                      {t('fileTree.noSearchResults', { defaultValue: 'No matching files' })}
                    </div>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {searchResults.map((file) => {
                      const isActive = activePath === file.path
                      const relativePath = toRelativePath(file.path, workingFolder)
                      return (
                        <div
                          key={file.path}
                          className={cn(
                            'workspace-filetree-row group flex w-full items-center text-left transition-all',
                            agentSurface
                              ? 'workspace-filetree-row--agent h-[22px] gap-1 rounded-none px-1 py-0'
                              : 'gap-2 rounded-xl px-2.5 py-2',
                            isActive
                              ? 'workspace-filetree-row--active'
                              : 'workspace-filetree-row--interactive'
                          )}
                          onClick={() => handlePreview(file.path)}
                          title={file.path}
                        >
                          {fileIcon(file.name)}
                          <div className="min-w-0 flex-1">
                            <div
                              className={cn(
                                'truncate',
                                agentSurface
                                  ? 'text-[12px] font-normal text-agent-files-fg'
                                  : 'text-sm font-medium text-foreground/90'
                              )}
                            >
                              {file.name}
                            </div>
                            {!agentSurface ? (
                              <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                                {relativePath}
                              </div>
                            ) : null}
                          </div>
                          <div
                            className={cn(
                              'flex shrink-0 items-center gap-0.5 opacity-0 transition-all group-hover:opacity-100',
                              agentSurface && 'hidden'
                            )}
                          >
                            <button
                              className="workspace-filetree-action rounded-md p-1"
                              onClick={(event) => {
                                event.stopPropagation()
                                handleAddToChat(file.path)
                              }}
                              title={t('fileTree.addToChat')}
                            >
                              <MessageSquarePlus className="size-3" />
                            </button>
                            <button
                              className="workspace-filetree-action rounded-md p-1"
                              onClick={(event) => {
                                event.stopPropagation()
                                handleCopyPath(file.path)
                              }}
                              title={t('fileTree.copyPath')}
                            >
                              <Copy className="size-3" />
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )
              ) : tree.length === 0 && !rootNewItemInput ? (
                <div className="workspace-filetree-empty workspace-filetree-empty--dashed flex flex-col items-center justify-center gap-2 rounded-xl px-4 py-10 text-center">
                  <Folder className="size-5 text-muted-foreground/50" />
                  <div className="text-xs text-muted-foreground">
                    {t('fileTree.empty', { defaultValue: 'No files in current directory' })}
                  </div>
                </div>
              ) : (
                <div className={agentSurface ? 'space-y-0' : 'space-y-1'}>
                  {agentSurface ? (
                    <>
                      <div
                        className="workspace-filetree-row workspace-filetree-row--agent workspace-filetree-row--interactive group flex h-[22px] cursor-pointer items-center gap-0 px-0 py-0 text-[12px]"
                        style={{ paddingLeft: 4 }}
                        onClick={() => setAgentRootExpanded((value) => !value)}
                        title={workingFolder}
                      >
                        {agentRootExpanded ? (
                          <ChevronDown className="workspace-filetree-chevron size-4 shrink-0 text-agent-files-icon" />
                        ) : (
                          <ChevronRight className="workspace-filetree-chevron size-4 shrink-0 text-agent-files-icon" />
                        )}
                        <span className="min-w-0 flex-1 truncate text-agent-files-fg">
                          {workingFolder.split(/[\\/]/).pop()}
                        </span>
                      </div>
                      {agentRootExpanded ? (
                        <>
                          {rootNewItemInput}
                          {tree.map((node) => (
                            <TreeItem
                              key={node.path}
                              node={node}
                              depth={1}
                              activePath={activePath}
                              onToggle={handleToggle}
                              editState={editState}
                              actions={treeActions}
                              agentSurface
                            />
                          ))}
                        </>
                      ) : null}
                    </>
                  ) : (
                    <>
                      {rootNewItemInput}
                      {tree.map((node) => (
                        <TreeItem
                          key={node.path}
                          node={node}
                          depth={0}
                          activePath={activePath}
                          onToggle={handleToggle}
                          editState={editState}
                          actions={treeActions}
                        />
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-52">
            <ContextMenuItem
              className="gap-2 text-xs"
              onSelect={() => handleNewFile(workingFolder)}
            >
              <FilePlus2 className="size-3.5" /> {t('fileTree.newFile')}
            </ContextMenuItem>
            <ContextMenuItem
              className="gap-2 text-xs"
              onSelect={() => handleNewFolder(workingFolder)}
            >
              <FolderPlus className="size-3.5" /> {t('fileTree.newFolder')}
            </ContextMenuItem>
            <ContextMenuItem className="gap-2 text-xs" onSelect={() => refreshTree()}>
              <RefreshCw className="size-3.5" /> {t('action.refresh', { ns: 'common' })}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              className="gap-2 text-xs"
              onSelect={() => handleAddToChat(workingFolder)}
            >
              <MessageSquarePlus className="size-3.5" /> {t('fileTree.addToChat')}
            </ContextMenuItem>
            <ContextMenuItem
              className="gap-2 text-xs"
              onSelect={() => handleCopyPath(workingFolder)}
            >
              <Copy className="size-3.5" /> {t('action.copyPath', { ns: 'common' })}
            </ContextMenuItem>
            <ContextMenuItem
              className="gap-2 text-xs"
              onSelect={() => handleOpenTerminal(workingFolder, true)}
            >
              <SquareTerminal className="size-3.5" /> {t('fileTree.openTerminal')}
            </ContextMenuItem>
            {!sshConnectionId && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem
                  className="gap-2 text-xs"
                  onSelect={() => handleOpenDefault(workingFolder)}
                >
                  <ExternalLink className="size-3.5" /> {t('fileTree.openDefault')}
                </ContextMenuItem>
                <ContextMenuItem
                  className="gap-2 text-xs"
                  onSelect={() => handleOpenWithCode(workingFolder)}
                >
                  <Code2 className="size-3.5" /> {t('fileTree.openWithCode')}
                </ContextMenuItem>
                <ContextMenuItem
                  className="gap-2 text-xs"
                  onSelect={() => handleReveal(workingFolder)}
                >
                  <FolderOpen className="size-3.5" /> {t('fileTree.revealInFinder')}
                </ContextMenuItem>
              </>
            )}
          </ContextMenuContent>
        </ContextMenu>

        {!compactSheetSurface && (
          <div className="workspace-filetree-footer px-3 py-2 text-[10px] text-muted-foreground/80">
            {isSearching
              ? t('fileTree.searchHint', {
                  defaultValue: 'Click to preview, or use Add to Chat to insert a file reference'
                })
              : t('fileTree.stats', {
                  folders: treeStats.folders,
                  files: treeStats.files
                })}
          </div>
        )}
      </div>
    </div>
  )
}
