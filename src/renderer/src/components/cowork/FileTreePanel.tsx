import { useState, useCallback, useEffect } from 'react'
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
  Copy,
  Check,
  AlertCircle,
  X,
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { useChatStore } from '@renderer/stores/chat-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { cn } from '@renderer/lib/utils'
import { PrismAsyncLight as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { MONO_FONT } from '@renderer/lib/constants'

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
  '.gif': <Image className="size-3.5 text-green-400" />,
}

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.next', '.nuxt', 'dist', 'build', 'out',
  '__pycache__', '.venv', 'venv', '.cache', '.idea', '.vscode',
  'target', 'coverage', '.turbo', '.parcel-cache',
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

// --- Tree Node Component ---

const LANG_MAP: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
  py: 'python', rs: 'rust', go: 'go', json: 'json',
  css: 'css', scss: 'scss', less: 'less',
  html: 'html', htm: 'html', xml: 'xml', svg: 'xml',
  md: 'markdown', mdx: 'markdown',
  yaml: 'yaml', yml: 'yaml', toml: 'toml',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  sql: 'sql', graphql: 'graphql', gql: 'graphql',
  c: 'c', h: 'c', cpp: 'cpp', cxx: 'cpp', cc: 'cpp', hpp: 'cpp',
  java: 'java', kt: 'kotlin', kts: 'kotlin',
  rb: 'ruby', php: 'php', swift: 'swift',
  dockerfile: 'docker', makefile: 'makefile',
  r: 'r', lua: 'lua', dart: 'dart',
  ini: 'ini', env: 'bash', conf: 'ini',
}

function detectLang(name: string): string {
  const ext = name.includes('.') ? name.split('.').pop()?.toLowerCase() ?? '' : ''
  return LANG_MAP[ext] ?? 'text'
}

function TreeItem({
  node,
  depth,
  onToggle,
  onCopyPath,
  onPreview,
}: {
  node: TreeNode
  depth: number
  onToggle: (path: string) => void
  onCopyPath: (path: string) => void
  onPreview: (path: string, name: string) => void
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const isDir = node.type === 'directory'
  const isIgnored = isDir && IGNORED_DIRS.has(node.name)

  const handleCopy = useCallback(() => {
    onCopyPath(node.path)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }, [node.path, onCopyPath])

  return (
    <>
      <div
        className={cn(
          'group flex items-center gap-1 py-[1px] pr-2 text-[12px] cursor-pointer rounded-sm hover:bg-muted/60 transition-colors',
          isIgnored && 'opacity-40',
        )}
        style={{ paddingLeft: `${depth * 14 + 4}px` }}
        onClick={() => isDir && !isIgnored ? onToggle(node.path) : onPreview(node.path, node.name)}
        title={node.path}
      >
        {/* Expand chevron */}
        {isDir ? (
          node.expanded
            ? <ChevronDown className="size-3 shrink-0 text-muted-foreground/50" />
            : <ChevronRight className="size-3 shrink-0 text-muted-foreground/50" />
        ) : (
          <span className="size-3 shrink-0" />
        )}

        {/* Icon */}
        {isDir ? (
          node.expanded
            ? <FolderOpen className="size-3.5 shrink-0 text-amber-400" />
            : <Folder className="size-3.5 shrink-0 text-amber-400/70" />
        ) : (
          fileIcon(node.name)
        )}

        {/* Name */}
        <span className={cn(
          'truncate',
          isDir ? 'text-foreground/80 font-medium' : 'text-muted-foreground',
        )}>
          {node.name}
        </span>

        {/* Copy button (files only, on hover) */}
        {!isDir && (
          <button
            className="ml-auto hidden group-hover:block shrink-0 text-muted-foreground/30 hover:text-muted-foreground transition-colors"
            onClick={(e) => { e.stopPropagation(); handleCopy() }}
            title="Copy path"
          >
            {copied ? <Check className="size-3 text-green-500" /> : <Copy className="size-3" />}
          </button>
        )}
      </div>

      {/* Children */}
      {isDir && node.expanded && node.children?.map((child) => (
        <TreeItem
          key={child.path}
          node={child}
          depth={depth + 1}
          onToggle={onToggle}
          onCopyPath={onCopyPath}
          onPreview={onPreview}
        />
      ))}
    </>
  )
}

// --- Main Panel ---

export function FileTreePanel(): React.JSX.Element {
  const sessions = useChatStore((s) => s.sessions)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const activeSession = sessions.find((s) => s.id === activeSessionId)
  const workingFolder = activeSession?.workingFolder

  const [tree, setTree] = useState<TreeNode[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ path: string; name: string; content: string } | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)

  const loadDir = useCallback(async (dirPath: string): Promise<TreeNode[]> => {
    const result = await ipcClient.invoke('fs:list-dir', { path: dirPath }) as FileEntry[] | { error: string }
    if ('error' in result) throw new Error(String(result.error))
    const sorted = sortEntries(result as FileEntry[])
    return sorted.map((e) => ({
      ...e,
      expanded: false,
      loaded: e.type === 'file',
      children: e.type === 'directory' ? [] : undefined,
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

  const handleToggle = useCallback(async (dirPath: string) => {
    const toggleNode = async (nodes: TreeNode[]): Promise<TreeNode[]> => {
      return Promise.all(nodes.map(async (n) => {
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
      }))
    }
    setTree(await toggleNode(tree))
  }, [tree, loadDir])

  const handleCopyPath = useCallback((filePath: string) => {
    // Make path relative to working folder if possible
    const rel = workingFolder && filePath.startsWith(workingFolder)
      ? filePath.slice(workingFolder.length).replace(/^[\\//]/, '')
      : filePath
    useUIStore.getState().setPendingInsertText(rel)
    navigator.clipboard.writeText(filePath)
  }, [workingFolder])

  const handlePreview = useCallback(async (filePath: string, name: string) => {
    // If same file, toggle off
    if (preview?.path === filePath) { setPreview(null); return }
    setPreviewLoading(true)
    try {
      const raw = await ipcClient.invoke('fs:read-file', { path: filePath }) as string
      if (typeof raw === 'string' && !raw.startsWith('{"error"')) {
        // Truncate to first 80 lines for preview
        const lines = raw.split('\n')
        const content = lines.length > 80 ? lines.slice(0, 80).join('\n') + '\n…' : raw
        setPreview({ path: filePath, name, content })
      } else {
        setPreview({ path: filePath, name, content: '(Unable to read file)' })
      }
    } catch {
      setPreview({ path: filePath, name, content: '(Unable to read file)' })
    } finally {
      setPreviewLoading(false)
    }
  }, [preview])

  if (!workingFolder) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-8 text-muted-foreground/60">
        <FolderPlus className="size-8" />
        <p className="text-xs">Select a working folder to view files</p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {/* Header */}
      <div className="flex items-center gap-2">
        <FolderOpen className="size-3.5 text-amber-400 shrink-0" />
        <span className="text-xs text-muted-foreground truncate flex-1" title={workingFolder}>
          {workingFolder.split(/[\\/]/).pop()}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-5"
          onClick={loadRoot}
          disabled={loading}
          title="Refresh"
        >
          <RefreshCw className={cn('size-3', loading && 'animate-spin')} />
        </Button>
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-1.5 text-[11px] text-destructive px-1">
          <AlertCircle className="size-3 shrink-0" />
          <span className="truncate">{error}</span>
        </div>
      )}

      {/* Tree */}
      {loading && tree.length === 0 ? (
        <div className="flex items-center justify-center py-4">
          <RefreshCw className="size-4 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="text-[12px] max-h-[calc(100vh-200px)] overflow-y-auto">
          {tree.map((node) => (
            <TreeItem
              key={node.path}
              node={node}
              depth={0}
              onToggle={handleToggle}
              onCopyPath={handleCopyPath}
              onPreview={handlePreview}
            />
          ))}
        </div>
      )}

      {/* File Preview */}
      {(preview || previewLoading) && (
        <div className="border-t pt-2 mt-2 space-y-1">
          {preview && (
            <div className="flex items-center gap-1.5">
              {fileIcon(preview.name)}
              <span className="text-[11px] text-muted-foreground truncate flex-1" title={preview.path}>
                {preview.name}
              </span>
              <button
                className="text-muted-foreground/30 hover:text-muted-foreground transition-colors"
                onClick={() => { handleCopyPath(preview.path) }}
                title="Insert path into chat"
              >
                <Copy className="size-3" />
              </button>
              <button
                className="text-muted-foreground/30 hover:text-muted-foreground transition-colors"
                onClick={() => setPreview(null)}
                title="Close preview"
              >
                <X className="size-3" />
              </button>
            </div>
          )}
          {previewLoading ? (
            <div className="flex items-center justify-center py-4">
              <RefreshCw className="size-3 animate-spin text-muted-foreground" />
            </div>
          ) : preview ? (
            <SyntaxHighlighter
              language={detectLang(preview.name)}
              style={oneDark}
              showLineNumbers
              customStyle={{
                margin: 0,
                padding: '0.4rem',
                borderRadius: '0.375rem',
                fontSize: '10px',
                maxHeight: '250px',
                overflow: 'auto',
                fontFamily: MONO_FONT
              }}
              codeTagProps={{ style: { fontFamily: 'inherit' } }}
            >
              {preview.content}
            </SyntaxHighlighter>
          ) : null}
        </div>
      )}

      {/* Stats */}
      {tree.length > 0 && !preview && (
        <div className="text-[9px] text-muted-foreground/30 px-1">
          {tree.filter((n) => n.type === 'directory').length} folders · {tree.filter((n) => n.type === 'file').length} files
        </div>
      )}
    </div>
  )
}
