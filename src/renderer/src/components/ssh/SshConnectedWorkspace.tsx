import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  Folder,
  FolderOpen,
  FolderTree,
  GripVertical,
  HardDrive,
  Monitor,
  RefreshCw,
  TerminalSquare
} from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import {
  useSshStore,
  type SshConnection,
  type SshFileEntry,
  type SshTab
} from '@renderer/stores/ssh-store'
import { SshTerminal } from './SshTerminal'
import { SshFileEditor } from './SshFileEditor'
import { SshTerminalStatusPanel } from './SshTerminalStatusPanel'

const EMPTY_FILE_ENTRIES: SshFileEntry[] = []
const STATUS_PANEL_MIN_WIDTH = 280
const STATUS_PANEL_MAX_WIDTH = 520
const STATUS_PANEL_DEFAULT_WIDTH = 340
const STATUS_PANEL_WIDTH_KEY = 'open-cowork:ssh-status-panel-width'

function clampStatusPanelWidth(value: number): number {
  if (!Number.isFinite(value)) return STATUS_PANEL_DEFAULT_WIDTH
  return Math.min(STATUS_PANEL_MAX_WIDTH, Math.max(STATUS_PANEL_MIN_WIDTH, Math.round(value)))
}

function getInitialStatusPanelWidth(): number {
  if (typeof window === 'undefined') return STATUS_PANEL_DEFAULT_WIDTH
  const stored = window.localStorage.getItem(STATUS_PANEL_WIDTH_KEY)
  return clampStatusPanelWidth(stored ? Number.parseInt(stored, 10) : STATUS_PANEL_DEFAULT_WIDTH)
}

function getDefaultExplorerPath(connection: SshConnection): string {
  if (connection.defaultDirectory?.trim()) return connection.defaultDirectory.trim()
  if (connection.username === 'root') return '/root'
  return `/home/${connection.username}`
}

function buildPathChain(targetPath: string): string[] {
  const cleaned = targetPath.trim() || '/'
  if (cleaned === '/') return ['/']

  const parts = cleaned.split('/').filter(Boolean)
  const chain = ['/']
  let current = ''
  for (const part of parts) {
    current = `${current}/${part}`.replace(/\/{2,}/g, '/')
    chain.push(current)
  }
  return chain
}

function fileIcon(entry: SshFileEntry): React.ReactNode {
  if (entry.type === 'directory') {
    return <Folder className="size-3.5 text-[#f6c453]" />
  }
  return <span className="ml-[2px] text-[11px] text-[#9ca3af]">·</span>
}

function openRemoteFileTab(connection: SshConnection, sessionId: string, filePath: string): void {
  const store = useSshStore.getState()
  const existing = store.openTabs.find(
    (tab) => tab.type === 'file' && tab.connectionId === connection.id && tab.filePath === filePath
  )

  if (existing) {
    store.setActiveTab(existing.id)
    return
  }

  const title = filePath.split('/').pop() || filePath
  store.openTab({
    id: `ssh-file:${connection.id}:${filePath}`,
    type: 'file',
    sessionId,
    connectionId: connection.id,
    connectionName: connection.name,
    title,
    filePath
  })
}

function ExplorerNode({
  connection,
  sessionId,
  path,
  label,
  depth,
  currentPath
}: {
  connection: SshConnection
  sessionId: string
  path: string
  label: string
  depth: number
  currentPath: string
}): React.JSX.Element {
  const expanded = useSshStore((state) => state.fileExplorerExpanded[sessionId]?.has(path) ?? false)
  const entries = useSshStore(
    (state) => state.fileExplorerEntries[sessionId]?.[path] ?? EMPTY_FILE_ENTRIES
  )
  const loading = useSshStore((state) => state.fileExplorerLoading[sessionId]?.[path] ?? false)
  const setFileExplorerPath = useSshStore((state) => state.setFileExplorerPath)
  const toggleFileExplorerDir = useSshStore((state) => state.toggleFileExplorerDir)
  const loadFileExplorerEntries = useSshStore((state) => state.loadFileExplorerEntries)

  const handleToggle = useCallback(async (): Promise<void> => {
    setFileExplorerPath(sessionId, path)
    if (!expanded) {
      await loadFileExplorerEntries(sessionId, path)
    }
    toggleFileExplorerDir(sessionId, path)
  }, [
    expanded,
    loadFileExplorerEntries,
    path,
    sessionId,
    setFileExplorerPath,
    toggleFileExplorerDir
  ])

  const handleSelect = useCallback(async (): Promise<void> => {
    setFileExplorerPath(sessionId, path)
    await loadFileExplorerEntries(sessionId, path)
  }, [loadFileExplorerEntries, path, sessionId, setFileExplorerPath])

  return (
    <div>
      <div
        className={cn(
          'group flex items-center gap-1 rounded-[8px] px-2 py-1.5 text-left text-[12px] transition-colors',
          currentPath === path ? 'bg-[#232323] text-[#fafafa]' : 'text-[#d4d4d8] hover:bg-[#202020]'
        )}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
      >
        <button
          type="button"
          onClick={() => void handleToggle()}
          className="inline-flex size-4 items-center justify-center rounded-[4px] text-[#7a7a7a] hover:text-[#fafafa]"
        >
          {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        </button>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2"
          onClick={() => void handleSelect()}
        >
          {expanded ? (
            <FolderOpen className="size-3.5 text-[#f6c453]" />
          ) : (
            <Folder className="size-3.5 text-[#f6c453]" />
          )}
          <span className="truncate">{label}</span>
          {loading ? <RefreshCw className="size-3 animate-spin text-[#6ee787]" /> : null}
        </button>
      </div>

      {expanded ? (
        <div>
          {entries.map((entry) => {
            if (entry.type === 'directory') {
              return (
                <ExplorerNode
                  key={entry.path}
                  connection={connection}
                  sessionId={sessionId}
                  path={entry.path}
                  label={entry.name}
                  depth={depth + 1}
                  currentPath={currentPath}
                />
              )
            }

            return (
              <button
                key={entry.path}
                type="button"
                onClick={() => openRemoteFileTab(connection, sessionId, entry.path)}
                className="flex w-full items-center gap-2 rounded-[8px] px-2 py-1.5 text-left text-[12px] text-[#a1a1aa] transition-colors hover:bg-[#202020] hover:text-[#fafafa]"
                style={{ paddingLeft: `${30 + depth * 14}px` }}
              >
                {fileIcon(entry)}
                <span className="truncate">{entry.name}</span>
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

function ExplorerPane({
  connection,
  sessionId
}: {
  connection: SshConnection
  sessionId: string
}): React.JSX.Element {
  const currentPath = useSshStore(
    (state) => state.fileExplorerPaths[sessionId] ?? getDefaultExplorerPath(connection)
  )
  const currentEntries = useSshStore(
    (state) => state.fileExplorerEntries[sessionId]?.[currentPath] ?? EMPTY_FILE_ENTRIES
  )
  const currentLoading = useSshStore(
    (state) => state.fileExplorerLoading[sessionId]?.[currentPath] ?? false
  )
  const currentError = useSshStore(
    (state) => state.fileExplorerErrors[sessionId]?.[currentPath] ?? null
  )
  const loadFileExplorerEntries = useSshStore((state) => state.loadFileExplorerEntries)
  const setFileExplorerPath = useSshStore((state) => state.setFileExplorerPath)
  const setFileExplorerExpanded = useSshStore((state) => state.setFileExplorerExpanded)

  const chain = useMemo(() => buildPathChain(currentPath), [currentPath])

  useEffect(() => {
    let cancelled = false

    const bootstrap = async (): Promise<void> => {
      const nextPath = currentPath || getDefaultExplorerPath(connection)
      const nextChain = buildPathChain(nextPath)
      setFileExplorerPath(sessionId, nextPath)
      setFileExplorerExpanded(sessionId, nextChain)

      for (const path of nextChain) {
        if (cancelled) return
        await loadFileExplorerEntries(sessionId, path)
      }
    }

    void bootstrap()
    return () => {
      cancelled = true
    }
  }, [
    connection,
    currentPath,
    loadFileExplorerEntries,
    sessionId,
    setFileExplorerExpanded,
    setFileExplorerPath
  ])

  return (
    <aside className="flex h-full w-[364px] shrink-0 flex-col border-r border-[#313131] bg-[#171717]">
      <div className="border-b border-[#2c2c2c] px-3 py-2">
        <div className="flex items-center gap-2">
          <div className="inline-flex items-center gap-2 rounded-[8px] border border-[#3a3a3a] bg-[#121212] px-3 py-1 text-[12px] text-[#6ee787]">
            <FolderTree className="size-3.5" />
            <span>文件工作区</span>
            <span className="text-[#9ca3af]">x</span>
          </div>
          <button
            type="button"
            className="rounded-[8px] p-1 text-[#9ca3af] hover:bg-[#202020] hover:text-[#fafafa]"
          >
            <span className="block text-[16px] leading-none">+</span>
          </button>
        </div>

        <div className="mt-3 flex items-center gap-2 rounded-[10px] border border-[#2f2f2f] bg-[#111111] px-3 py-2 text-[12px] text-[#d4d4d8]">
          <HardDrive className="size-3.5 text-[#6ee787]" />
          <span className="truncate">{currentPath}</span>
          {currentLoading ? (
            <RefreshCw className="ml-auto size-3.5 animate-spin text-[#6ee787]" />
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        {chain.length > 0 ? (
          <ExplorerNode
            connection={connection}
            sessionId={sessionId}
            path={chain[0]!}
            label={chain[0] === '/' ? '/' : chain[0]!.split('/').pop() || '/'}
            depth={0}
            currentPath={currentPath}
          />
        ) : null}

        {currentError ? (
          <div className="mt-4 rounded-[10px] border border-[#3a2a2a] bg-[#221616] px-3 py-2 text-[12px] text-[#f87171]">
            {currentError}
          </div>
        ) : null}

        {!currentLoading && currentEntries.length === 0 ? (
          <div className="mt-4 rounded-[10px] border border-[#2a2a2a] bg-[#1a1a1a] px-3 py-2 text-[12px] text-[#888]">
            Empty directory
          </div>
        ) : null}
      </div>
    </aside>
  )
}

export function SshConnectedWorkspace({
  connection,
  sessionId,
  activeTab,
  showStatusPanel,
  onCloseStatus
}: {
  connection: SshConnection
  sessionId: string
  activeTab: SshTab
  showStatusPanel: boolean
  onCloseStatus: () => void
}): React.JSX.Element {
  const [statusPanelWidth, setStatusPanelWidth] = useState(getInitialStatusPanelWidth)
  const [isResizingStatusPanel, setIsResizingStatusPanel] = useState(false)
  const resizeStateRef = useRef({ startX: 0, startWidth: STATUS_PANEL_DEFAULT_WIDTH })
  const centerTitle =
    activeTab.type === 'file' ? activeTab.filePath?.split('/').pop() || activeTab.title : '终端'
  const CenterIcon = activeTab.type === 'file' ? FileCode2 : TerminalSquare

  useEffect(() => {
    window.localStorage.setItem(STATUS_PANEL_WIDTH_KEY, String(statusPanelWidth))
  }, [statusPanelWidth])

  const handleStatusResizeStart = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      resizeStateRef.current = {
        startX: event.clientX,
        startWidth: statusPanelWidth
      }
      setIsResizingStatusPanel(true)
    },
    [statusPanelWidth]
  )

  const handleStatusResizeMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      if (!isResizingStatusPanel) return
      const delta = resizeStateRef.current.startX - event.clientX
      setStatusPanelWidth(clampStatusPanelWidth(resizeStateRef.current.startWidth + delta))
    },
    [isResizingStatusPanel]
  )

  const handleStatusResizeEnd = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      if (!isResizingStatusPanel) return
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      setIsResizingStatusPanel(false)
    },
    [isResizingStatusPanel]
  )

  return (
    <div
      className={cn(
        'flex h-full min-w-0 flex-1 overflow-hidden bg-[#111111] text-[#e5e7eb]',
        isResizingStatusPanel && 'select-none'
      )}
    >
      <ExplorerPane connection={connection} sessionId={sessionId} />

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-[#2b2b2b] px-3 py-2">
          <div className="flex items-center gap-2">
            <div className="inline-flex items-center gap-2 rounded-[8px] border border-[#373737] bg-[#171717] px-3 py-1 text-[12px] text-[#6ee787]">
              <CenterIcon className="size-3.5" />
              <span className="truncate">{centerTitle}</span>
              <span className="text-[#8b8b8b]">x</span>
            </div>
          </div>

          {showStatusPanel ? (
            <div className="inline-flex items-center gap-2 rounded-[8px] border border-[#373737] bg-[#171717] px-3 py-1 text-[12px] text-[#6ee787]">
              <Monitor className="size-3.5" />
              <span>监控</span>
            </div>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-hidden bg-[#0f1120]">
          {activeTab.type === 'file' && activeTab.filePath ? (
            <SshFileEditor
              connectionId={connection.id}
              filePath={activeTab.filePath}
              sessionId={sessionId}
            />
          ) : (
            <SshTerminal sessionId={sessionId} connectionName={connection.name} />
          )}
        </div>
      </div>

      {showStatusPanel ? (
        <div className="flex h-full shrink-0 overflow-hidden" style={{ width: statusPanelWidth }}>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize monitor panel"
            className={cn(
              'group relative z-10 flex w-2 shrink-0 cursor-col-resize touch-none items-center justify-center bg-[#111111]',
              isResizingStatusPanel && 'bg-[#173620]'
            )}
            onPointerDown={handleStatusResizeStart}
            onPointerMove={handleStatusResizeMove}
            onPointerUp={handleStatusResizeEnd}
            onPointerCancel={handleStatusResizeEnd}
          >
            <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[#303030] transition-colors group-hover:bg-[#30c56b]" />
            <div className="rounded-[7px] border border-[#3a3a3a] bg-[#181818] p-0.5 text-[#777] opacity-0 transition-opacity group-hover:opacity-100">
              <GripVertical className="size-3.5" />
            </div>
          </div>
          <SshTerminalStatusPanel
            connectionId={connection.id}
            connectionName={connection.name}
            host={connection.host}
            onClose={onCloseStatus}
          />
        </div>
      ) : null}
    </div>
  )
}
