import { create } from 'zustand'
import { toast } from 'sonner'
import i18n from '@renderer/locales'
import { ipcClient } from '../lib/ipc/ipc-client'
import { IPC } from '../lib/ipc/channels'

// ── Types ──

export interface SshGroup {
  id: string
  name: string
  sortOrder: number
  createdAt: number
  updatedAt: number
}

export interface SshConnection {
  id: string
  groupId: string | null
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'privateKey' | 'agent'
  privateKeyPath: string | null
  startupCommand: string | null
  defaultDirectory: string | null
  proxyJump: string | null
  keepAliveInterval: number
  sortOrder: number
  lastConnectedAt: number | null
  createdAt: number
  updatedAt: number
}

export interface SshSession {
  id: string
  connectionId: string
  status: 'connecting' | 'connected' | 'disconnected' | 'error'
  error?: string
}

export interface SshTab {
  id: string
  type: 'terminal' | 'file'
  sessionId: string | null
  connectionId: string
  connectionName: string
  title: string
  filePath?: string
  status?: 'connecting' | 'connected' | 'error'
  error?: string
}

export interface SshFileEntry {
  name: string
  path: string
  type: 'file' | 'directory' | 'symlink'
  size: number
  modifyTime: number
}

export type SshWorkspaceSection =
  | 'hosts'
  | 'keychain'
  | 'forwarding'
  | 'snippets'
  | 'knownHosts'
  | 'logs'
  | 'sftp'
  | 'terminal'

export type SshUploadStage =
  | 'compress'
  | 'upload'
  | 'remote_unzip'
  | 'cleanup'
  | 'done'
  | 'error'
  | 'canceled'

export type SshUploadProgress = {
  current?: number
  total?: number
  percent?: number
}

export type SshUploadTask = {
  taskId: string
  connectionId: string
  stage: SshUploadStage
  progress?: SshUploadProgress
  message?: string
  updatedAt: number
}

export type SftpPaneId = 'left' | 'right'

export type SftpConflictPolicy = 'skip' | 'overwrite' | 'duplicate'

export type SftpTransferTaskType = 'upload' | 'download' | 'remote-copy'

export type SftpTransferStage =
  | 'preparing'
  | 'transferring'
  | 'cleanup'
  | 'done'
  | 'error'
  | 'canceled'

export type SftpTransferProgress = {
  currentBytes?: number
  totalBytes?: number
  percent?: number
  processedItems?: number
  totalItems?: number
}

export type SftpTransferTask = {
  taskId: string
  type: SftpTransferTaskType
  stage: SftpTransferStage
  sourceConnectionId?: string | null
  targetConnectionId?: string | null
  progress?: SftpTransferProgress
  message?: string
  currentItem?: string
  updatedAt: number
  conflictPolicy?: SftpConflictPolicy
}

export type SftpConnectionStatus = 'idle' | 'connecting' | 'connected' | 'error'

export type SftpConnectionState = {
  status: SftpConnectionStatus
  error?: string
  homeDir?: string | null
  lastConnectedAt?: number
}

export type SftpPaneState = {
  connectionId: string | null
  currentPath: string | null
}

export type SftpInspectorTab = 'details' | 'tasks'

interface SshGroupRow {
  id: string
  name: string
  sort_order: number
  created_at: number
  updated_at: number
}

interface SshConnectionRow {
  id: string
  group_id: string | null
  name: string
  host: string
  port: number
  username: string
  auth_type: string
  private_key_path: string | null
  startup_command: string | null
  default_directory: string | null
  proxy_jump: string | null
  keep_alive_interval: number
  sort_order: number
  last_connected_at: number | null
  created_at: number
  updated_at: number
}

function rowToGroup(row: SshGroupRow): SshGroup {
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function rowToConnection(row: SshConnectionRow): SshConnection {
  return {
    id: row.id,
    groupId: row.group_id,
    name: row.name,
    host: row.host,
    port: row.port,
    username: row.username,
    authType: row.auth_type as SshConnection['authType'],
    privateKeyPath: row.private_key_path,
    startupCommand: row.startup_command,
    defaultDirectory: row.default_directory,
    proxyJump: row.proxy_jump,
    keepAliveInterval: row.keep_alive_interval,
    sortOrder: row.sort_order,
    lastConnectedAt: row.last_connected_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

const MAX_CONCURRENT_LIST_DIR = 2
const SSH_FILE_EXPLORER_PAGE_SIZE = 200
const SSH_FILE_EXPLORER_STALE_LOAD_MS = 30000
const IPC_LIST_DIR_TIMEOUT_MS = 45000

const listDirInFlightSince = new Map<string, number>()

function ipcWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error('IPC list-dir timeout')), ms)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function getListDirKey(sessionId: string, path: string): string {
  return `${sessionId}:${path}`
}

type FileExplorerPageInfo = {
  cursor?: string
  hasMore: boolean
}

type ListDirPagedResult = {
  entries?: SshFileEntry[]
  nextCursor?: string
  hasMore?: boolean
  error?: string
}

type ListDirQueue = {
  active: number
  queue: Array<() => void>
}

const listDirQueues = new Map<string, ListDirQueue>()

function getListDirQueue(sessionId: string): ListDirQueue {
  const existing = listDirQueues.get(sessionId)
  if (existing) return existing
  const created = { active: 0, queue: [] }
  listDirQueues.set(sessionId, created)
  return created
}

const SLOT_ACQUIRE_TIMEOUT_MS = 10000

let uploadEventsSubscribed = false
let transferEventsSubscribed = false
let sshConfigChangedSubscribed = false
let sshStatusSubscribed = false

function mapUploadStageToTransferStage(stage: SshUploadStage): SftpTransferStage {
  switch (stage) {
    case 'compress':
      return 'preparing'
    case 'upload':
    case 'remote_unzip':
      return 'transferring'
    case 'cleanup':
      return 'cleanup'
    case 'done':
      return 'done'
    case 'error':
      return 'error'
    case 'canceled':
      return 'canceled'
    default:
      return 'transferring'
  }
}

function ensureUploadEventsSubscribed(): void {
  if (uploadEventsSubscribed) return
  uploadEventsSubscribed = true

  ipcClient.on(IPC.SSH_FS_UPLOAD_EVENTS, (evt) => {
    if (!evt || typeof evt !== 'object') return
    const data = evt as {
      taskId?: string
      connectionId?: string
      stage?: SshUploadStage
      progress?: SshUploadProgress
      message?: string
    }
    if (!data.taskId || !data.connectionId || !data.stage) return
    const taskId = data.taskId
    const connectionId = data.connectionId
    const stage = data.stage

    useSshStore.setState((s) => {
      const prev = s.uploadTasks[taskId]
      const nextTask: SshUploadTask = {
        taskId,
        connectionId,
        stage,
        progress: data.progress,
        message: data.message,
        updatedAt: Date.now()
      }
      return {
        uploadTasks: {
          ...s.uploadTasks,
          [taskId]: { ...prev, ...nextTask }
        },
        transferTasks: {
          ...s.transferTasks,
          [taskId]: {
            taskId,
            type: 'upload',
            stage: mapUploadStageToTransferStage(stage),
            targetConnectionId: connectionId,
            progress: data.progress
              ? {
                  currentBytes: data.progress.current,
                  totalBytes: data.progress.total,
                  percent: data.progress.percent
                }
              : undefined,
            message: data.message,
            updatedAt: Date.now()
          }
        }
      }
    })
  })
}

function ensureTransferEventsSubscribed(): void {
  if (transferEventsSubscribed) return
  transferEventsSubscribed = true

  ipcClient.on(IPC.SSH_FS_TRANSFER_EVENTS, (evt) => {
    if (!evt || typeof evt !== 'object') return
    const data = evt as {
      taskId?: string
      type?: SftpTransferTaskType
      stage?: SftpTransferStage
      sourceConnectionId?: string | null
      targetConnectionId?: string | null
      progress?: SftpTransferProgress
      message?: string
      currentItem?: string
      conflictPolicy?: SftpConflictPolicy
    }
    if (!data.taskId || !data.type || !data.stage) return

    useSshStore.setState((state) => ({
      transferTasks: {
        ...state.transferTasks,
        [data.taskId!]: {
          ...(state.transferTasks[data.taskId!] ?? {}),
          taskId: data.taskId!,
          type: data.type!,
          stage: data.stage!,
          sourceConnectionId: data.sourceConnectionId ?? null,
          targetConnectionId: data.targetConnectionId ?? null,
          progress: data.progress,
          message: data.message,
          currentItem: data.currentItem,
          conflictPolicy: data.conflictPolicy,
          updatedAt: Date.now()
        }
      }
    }))
  })
}

function ensureSshConfigChangedSubscribed(): void {
  if (sshConfigChangedSubscribed) return
  sshConfigChangedSubscribed = true

  ipcClient.on('ssh:config:changed', () => {
    void useSshStore.getState().loadAll()
  })
}

function ensureSshStatusSubscribed(): void {
  if (sshStatusSubscribed) return
  sshStatusSubscribed = true

  ipcClient.on(IPC.SSH_STATUS, (payload) => {
    if (!payload || typeof payload !== 'object') return
    const data = payload as {
      sessionId?: string
      connectionId?: string
      status?: string
      error?: string
    }
    if (!data.sessionId || !data.status) return

    const store = useSshStore.getState()
    const status = data.status as SshSession['status']

    if (status === 'disconnected') {
      store.removeSession(data.sessionId)
      return
    }

    const existing = store.sessions[data.sessionId]
    if (!existing && data.connectionId) {
      useSshStore.setState((state) => ({
        sessions: {
          ...state.sessions,
          [data.sessionId!]: {
            id: data.sessionId!,
            connectionId: data.connectionId!,
            status,
            error: data.error
          }
        }
      }))
      return
    }

    store.updateSessionStatus(data.sessionId, status, data.error)
    if (status === 'error' && data.error) {
      toast.error(i18n.t('connectionFailed', { ns: 'ssh' }), { description: data.error })
    }
  })
}

function acquireListDirSlot(sessionId: string): Promise<() => void> {
  const queue = getListDirQueue(sessionId)
  return new Promise((resolve) => {
    let resolved = false
    const tryAcquire = (): void => {
      if (resolved) return
      if (queue.active < MAX_CONCURRENT_LIST_DIR) {
        resolved = true
        queue.active += 1
        resolve(() => {
          queue.active = Math.max(0, queue.active - 1)
          const next = queue.queue.shift()
          if (next) next()
        })
        return
      }
      queue.queue.push(tryAcquire)
    }

    tryAcquire()

    if (!resolved) {
      console.warn('[SshStore] slot queue full, waiting...', {
        sessionId,
        active: queue.active,
        queued: queue.queue.length
      })
      setTimeout(() => {
        if (resolved) return
        console.warn('[SshStore] slot acquire timeout — force-resetting queue', {
          sessionId,
          active: queue.active,
          queued: queue.queue.length
        })
        resolved = true
        queue.active = 0
        queue.queue.length = 0
        queue.active = 1
        resolve(() => {
          queue.active = Math.max(0, queue.active - 1)
          const next = queue.queue.shift()
          if (next) next()
        })
      }, SLOT_ACQUIRE_TIMEOUT_MS)
    }
  })
}

function sortEntries(entries: SshFileEntry[]): SshFileEntry[] {
  return entries.slice().sort((a, b) => {
    if (a.type === 'directory' && b.type !== 'directory') return -1
    if (a.type !== 'directory' && b.type === 'directory') return 1
    return a.name.localeCompare(b.name)
  })
}

function normalizePageInfo(meta?: ListDirPagedResult): FileExplorerPageInfo {
  const cursor = typeof meta?.nextCursor === 'string' ? meta.nextCursor : undefined
  const hasMore = typeof meta?.hasMore === 'boolean' ? meta.hasMore : Boolean(cursor)
  return { cursor, hasMore }
}

// ── Store ──

interface SshStore {
  groups: SshGroup[]
  connections: SshConnection[]
  sessions: Record<string, SshSession>
  activeTerminalId: string | null
  selectedConnectionId: string | null
  _loaded: boolean

  // Tab management
  openTabs: SshTab[]
  activeTabId: string | null

  // File explorer
  fileExplorerOpen: boolean
  fileExplorerPaths: Record<string, string>
  fileExplorerEntries: Record<string, Record<string, SshFileEntry[]>>
  fileExplorerPageInfo: Record<string, Record<string, FileExplorerPageInfo>>
  fileExplorerExpanded: Record<string, Set<string>>
  fileExplorerLoading: Record<string, Record<string, boolean>>
  fileExplorerErrors: Record<string, Record<string, string | null>>

  // Upload tasks
  uploadTasks: Record<string, SshUploadTask>
  transferTasks: Record<string, SftpTransferTask>

  // SFTP workspace
  sftpConnections: Record<string, SftpConnectionState>
  sftpPaneStates: Record<SftpPaneId, SftpPaneState>
  sftpCompareMode: boolean
  sftpActivePane: SftpPaneId
  sftpEntries: Record<string, Record<string, SshFileEntry[]>>
  sftpPageInfo: Record<string, Record<string, FileExplorerPageInfo>>
  sftpLoading: Record<string, Record<string, boolean>>
  sftpErrors: Record<string, Record<string, string | null>>
  sftpSelections: Record<SftpPaneId, Record<string, SshFileEntry>>
  sftpConflictPolicy: SftpConflictPolicy
  sftpInspectorTab: SftpInspectorTab

  // Connection list UI
  connectionListViewMode: 'table' | 'card'
  setConnectionListViewMode: (mode: 'table' | 'card') => void
  workspaceSection: SshWorkspaceSection
  setWorkspaceSection: (section: SshWorkspaceSection) => void
  detailConnectionId: string | null
  setDetailConnectionId: (id: string | null) => void
  inspectorMode: 'create' | 'edit'
  setInspectorMode: (mode: 'create' | 'edit') => void

  // Data loading
  loadAll: () => Promise<void>

  // Group CRUD
  createGroup: (name: string) => Promise<string>
  updateGroup: (id: string, name: string) => Promise<void>
  deleteGroup: (id: string) => Promise<void>

  // Connection CRUD
  createConnection: (data: {
    name: string
    host: string
    port?: number
    username: string
    authType?: string
    password?: string
    privateKeyPath?: string
    passphrase?: string
    groupId?: string
    startupCommand?: string
    defaultDirectory?: string
    proxyJump?: string
    keepAliveInterval?: number
  }) => Promise<string>
  updateConnection: (
    id: string,
    data: {
      name?: string
      host?: string
      port?: number
      username?: string
      authType?: string
      password?: string | null
      privateKeyPath?: string | null
      passphrase?: string | null
      groupId?: string | null
      startupCommand?: string | null
      defaultDirectory?: string | null
      proxyJump?: string | null
      keepAliveInterval?: number
    }
  ) => Promise<void>
  deleteConnection: (id: string) => Promise<void>
  testConnection: (id: string) => Promise<{ success: boolean; error?: string }>

  // Terminal sessions
  connect: (connectionId: string) => Promise<string | null>
  openTerminalTab: (connectionId: string) => Promise<string | null>
  disconnect: (sessionId: string) => Promise<void>
  setActiveTerminal: (sessionId: string | null) => void
  setSelectedConnection: (connectionId: string | null) => void
  updateSessionStatus: (sessionId: string, status: SshSession['status'], error?: string) => void
  removeSession: (sessionId: string) => void

  // Tab management
  openTab: (tab: SshTab) => void
  closeTab: (tabId: string) => void
  setActiveTab: (tabId: string | null) => void
  replaceTab: (tabId: string, tab: SshTab) => void

  // File explorer
  toggleFileExplorer: () => void
  setFileExplorerPath: (sessionId: string, path: string) => void
  loadFileExplorerEntries: (sessionId: string, path: string, force?: boolean) => Promise<void>
  loadMoreFileExplorerEntries: (sessionId: string, path: string) => Promise<void>
  toggleFileExplorerDir: (sessionId: string, dirPath: string) => void
  setFileExplorerExpanded: (sessionId: string, expanded: string[]) => void

  // Upload tasks
  startUpload: (args: {
    connectionId: string
    remoteDir: string
    localPath: string
    kind?: 'file' | 'folder'
  }) => Promise<string | null>
  cancelUpload: (taskId: string) => Promise<void>
  clearUploadTask: (taskId: string) => void

  // SFTP workspace
  connectSftpConnection: (
    connectionId: string
  ) => Promise<{ homeDir?: string | null; error?: string }>
  disconnectSftpConnection: (connectionId: string) => Promise<void>
  setSftpPaneConnection: (paneId: SftpPaneId, connectionId: string | null) => void
  setSftpPanePath: (paneId: SftpPaneId, path: string) => void
  setSftpCompareMode: (enabled: boolean) => void
  setSftpActivePane: (paneId: SftpPaneId) => void
  loadSftpEntries: (connectionId: string, path: string, force?: boolean) => Promise<void>
  loadMoreSftpEntries: (connectionId: string, path: string) => Promise<void>
  setSftpSelection: (paneId: SftpPaneId, entries: SshFileEntry[]) => void
  toggleSftpSelection: (paneId: SftpPaneId, entry: SshFileEntry) => void
  clearSftpSelection: (paneId: SftpPaneId) => void
  setSftpConflictPolicy: (policy: SftpConflictPolicy) => void
  setSftpInspectorTab: (tab: SftpInspectorTab) => void
  startTransfer: (
    args:
      | {
          type: 'upload'
          connectionId: string
          remoteDir: string
          localPaths: string[]
          conflictPolicy?: SftpConflictPolicy
        }
      | {
          type: 'download'
          connectionId: string
          remotePaths: string[]
          localDir: string
          conflictPolicy?: SftpConflictPolicy
        }
      | {
          type: 'remote-copy'
          sourceConnectionId: string
          targetConnectionId: string
          sourcePaths: string[]
          targetDir: string
          conflictPolicy?: SftpConflictPolicy
        }
  ) => Promise<string | null>
  cancelTransfer: (taskId: string) => Promise<void>
  clearTransferTask: (taskId: string) => void
}

export const useSshStore = create<SshStore>()((set, get) => ({
  groups: [],
  connections: [],
  sessions: {},
  activeTerminalId: null,
  selectedConnectionId: null,
  _loaded: false,

  openTabs: [],
  activeTabId: null,

  fileExplorerOpen: false,
  fileExplorerPaths: {},
  fileExplorerEntries: {},
  fileExplorerPageInfo: {},
  fileExplorerExpanded: {},
  fileExplorerLoading: {},
  fileExplorerErrors: {},

  uploadTasks: {},
  transferTasks: {},

  sftpConnections: {},
  sftpPaneStates: {
    left: { connectionId: null, currentPath: null },
    right: { connectionId: null, currentPath: null }
  },
  sftpCompareMode: false,
  sftpActivePane: 'left',
  sftpEntries: {},
  sftpPageInfo: {},
  sftpLoading: {},
  sftpErrors: {},
  sftpSelections: {
    left: {},
    right: {}
  },
  sftpConflictPolicy: 'skip',
  sftpInspectorTab: 'details',

  connectionListViewMode: 'card',
  setConnectionListViewMode: (mode) => set({ connectionListViewMode: mode }),
  workspaceSection: 'hosts',
  setWorkspaceSection: (section) => set({ workspaceSection: section }),
  detailConnectionId: null,
  setDetailConnectionId: (id) => set({ detailConnectionId: id }),
  inspectorMode: 'edit',
  setInspectorMode: (mode) => set({ inspectorMode: mode }),

  loadAll: async () => {
    try {
      ensureUploadEventsSubscribed()
      ensureTransferEventsSubscribed()
      ensureSshConfigChangedSubscribed()
      ensureSshStatusSubscribed()
      const [groupRows, connRows, sessionRows] = await Promise.all([
        ipcClient.invoke(IPC.SSH_GROUP_LIST) as Promise<SshGroupRow[] | { error: string }>,
        ipcClient.invoke(IPC.SSH_CONNECTION_LIST) as Promise<
          SshConnectionRow[] | { error: string }
        >,
        ipcClient.invoke(IPC.SSH_SESSION_LIST) as Promise<
          { id: string; connectionId: string; status: string; error?: string }[] | { error: string }
        >
      ])

      const groups = Array.isArray(groupRows) ? groupRows.map(rowToGroup) : []
      const connections = Array.isArray(connRows) ? connRows.map(rowToConnection) : []
      const sessions = Array.isArray(sessionRows)
        ? sessionRows.reduce<Record<string, SshSession>>((acc, row) => {
            acc[row.id] = {
              id: row.id,
              connectionId: row.connectionId,
              status: row.status as SshSession['status'],
              error: row.error
            }
            return acc
          }, {})
        : {}

      set((state) => ({
        groups,
        connections,
        sessions,
        _loaded: true,
        sftpPaneStates: {
          left: {
            ...state.sftpPaneStates.left,
            connectionId:
              state.sftpPaneStates.left.connectionId &&
              connections.some((item) => item.id === state.sftpPaneStates.left.connectionId)
                ? state.sftpPaneStates.left.connectionId
                : (connections[0]?.id ?? null)
          },
          right: {
            ...state.sftpPaneStates.right,
            connectionId:
              state.sftpPaneStates.right.connectionId &&
              connections.some((item) => item.id === state.sftpPaneStates.right.connectionId)
                ? state.sftpPaneStates.right.connectionId
                : null
          }
        }
      }))
    } catch (err) {
      console.error('[SshStore] Failed to load:', err)
      set({ _loaded: true })
    }
  },

  startUpload: async (args) => {
    ensureUploadEventsSubscribed()
    const result = await ipcClient.invoke(IPC.SSH_FS_UPLOAD_START, args)
    if (result && typeof result === 'object' && 'error' in result) return null
    const taskId = (result as { taskId?: string }).taskId
    if (!taskId) return null
    set((s) => ({
      uploadTasks: {
        ...s.uploadTasks,
        [taskId]: {
          taskId,
          connectionId: args.connectionId,
          stage: 'upload',
          updatedAt: Date.now()
        }
      }
    }))
    return taskId
  },

  cancelUpload: async (taskId) => {
    await ipcClient.invoke(IPC.SSH_FS_UPLOAD_CANCEL, { taskId })
  },

  clearUploadTask: (taskId) => {
    set((s) => {
      if (!s.uploadTasks[taskId]) return s
      const next = { ...s.uploadTasks }
      delete next[taskId]
      return { uploadTasks: next }
    })
  },

  connectSftpConnection: async (connectionId) => {
    const existing = get().sftpConnections[connectionId]
    if (existing?.status === 'connected') {
      return { homeDir: existing.homeDir ?? null }
    }
    if (existing?.status === 'connecting') {
      return { homeDir: existing.homeDir ?? null }
    }

    set((state) => ({
      sftpConnections: {
        ...state.sftpConnections,
        [connectionId]: {
          ...(state.sftpConnections[connectionId] ?? { homeDir: null }),
          status: 'connecting',
          error: undefined
        }
      }
    }))

    const result = (await ipcClient.invoke(IPC.SSH_FS_CONNECT, {
      connectionId
    })) as { success?: boolean; homeDir?: string | null; error?: string }

    if (result?.error || !result?.success) {
      set((state) => ({
        sftpConnections: {
          ...state.sftpConnections,
          [connectionId]: {
            ...(state.sftpConnections[connectionId] ?? { homeDir: null }),
            status: 'error',
            error: result?.error ?? 'Failed to connect'
          }
        }
      }))
      return { error: result?.error ?? 'Failed to connect' }
    }

    set((state) => {
      const leftNeedsPath =
        state.sftpPaneStates.left.connectionId === connectionId &&
        !state.sftpPaneStates.left.currentPath
      const rightNeedsPath =
        state.sftpPaneStates.right.connectionId === connectionId &&
        !state.sftpPaneStates.right.currentPath
      return {
        sftpConnections: {
          ...state.sftpConnections,
          [connectionId]: {
            status: 'connected',
            error: undefined,
            homeDir: result.homeDir ?? null,
            lastConnectedAt: Date.now()
          }
        },
        sftpPaneStates: {
          left: leftNeedsPath
            ? { ...state.sftpPaneStates.left, currentPath: result.homeDir ?? '/' }
            : state.sftpPaneStates.left,
          right: rightNeedsPath
            ? { ...state.sftpPaneStates.right, currentPath: result.homeDir ?? '/' }
            : state.sftpPaneStates.right
        }
      }
    })

    return { homeDir: result.homeDir ?? null }
  },

  disconnectSftpConnection: async (connectionId) => {
    await ipcClient.invoke(IPC.SSH_FS_DISCONNECT, { connectionId })
    set((state) => ({
      sftpConnections: {
        ...state.sftpConnections,
        [connectionId]: {
          ...(state.sftpConnections[connectionId] ?? { homeDir: null }),
          status: 'idle',
          error: undefined
        }
      }
    }))
  },

  setSftpPaneConnection: (paneId, connectionId) => {
    set((state) => {
      const connection = connectionId
        ? (state.connections.find((item) => item.id === connectionId) ?? null)
        : null
      const currentState = connectionId ? state.sftpConnections[connectionId] : null
      const nextPath =
        connectionId == null ? null : (currentState?.homeDir ?? connection?.defaultDirectory ?? '/')

      return {
        sftpPaneStates: {
          ...state.sftpPaneStates,
          [paneId]: {
            connectionId,
            currentPath: nextPath
          }
        },
        sftpSelections: {
          ...state.sftpSelections,
          [paneId]: {}
        }
      }
    })
  },

  setSftpPanePath: (paneId, path) => {
    set((state) => ({
      sftpPaneStates: {
        ...state.sftpPaneStates,
        [paneId]: {
          ...state.sftpPaneStates[paneId],
          currentPath: path
        }
      }
    }))
  },

  setSftpCompareMode: (enabled) => set({ sftpCompareMode: enabled }),

  setSftpActivePane: (paneId) => set({ sftpActivePane: paneId }),

  loadSftpEntries: async (connectionId, path, force = false) => {
    const state = get()
    const sessionLoading = state.sftpLoading[connectionId] ?? {}
    const sessionEntries = state.sftpEntries[connectionId] ?? {}
    const now = Date.now()
    const listDirKey = getListDirKey(connectionId, path)
    const startedAt = listDirInFlightSince.get(listDirKey)

    if (sessionLoading[path]) {
      if (!force && Object.prototype.hasOwnProperty.call(sessionEntries, path)) {
        listDirInFlightSince.delete(listDirKey)
        set((s) => ({
          sftpLoading: {
            ...s.sftpLoading,
            [connectionId]: { ...(s.sftpLoading[connectionId] ?? {}), [path]: false }
          }
        }))
        return
      }

      if (!startedAt || now - startedAt > SSH_FILE_EXPLORER_STALE_LOAD_MS) {
        listDirInFlightSince.delete(listDirKey)
        set((s) => ({
          sftpLoading: {
            ...s.sftpLoading,
            [connectionId]: { ...(s.sftpLoading[connectionId] ?? {}), [path]: false }
          }
        }))
      } else {
        return
      }
    }

    if (!force && Object.prototype.hasOwnProperty.call(sessionEntries, path)) return

    const connectResult = await get().connectSftpConnection(connectionId)
    if (connectResult.error) return

    set((s) => ({
      sftpLoading: {
        ...s.sftpLoading,
        [connectionId]: { ...(s.sftpLoading[connectionId] ?? {}), [path]: true }
      },
      sftpErrors: {
        ...s.sftpErrors,
        [connectionId]: { ...(s.sftpErrors[connectionId] ?? {}), [path]: null }
      }
    }))

    listDirInFlightSince.set(listDirKey, now)
    const release = await acquireListDirSlot(connectionId)

    try {
      const result = await ipcWithTimeout(
        ipcClient.invoke(IPC.SSH_FS_LIST_DIR, {
          connectionId,
          path,
          limit: SSH_FILE_EXPLORER_PAGE_SIZE,
          refresh: force
        }),
        IPC_LIST_DIR_TIMEOUT_MS
      )

      if (result && typeof result === 'object' && 'error' in result) {
        const errorMessage = String((result as { error?: string }).error ?? 'Failed to load')
        set((s) => ({
          sftpErrors: {
            ...s.sftpErrors,
            [connectionId]: { ...(s.sftpErrors[connectionId] ?? {}), [path]: errorMessage }
          },
          sftpConnections: {
            ...s.sftpConnections,
            [connectionId]: {
              ...(s.sftpConnections[connectionId] ?? { homeDir: null }),
              status: 'error',
              error: errorMessage
            }
          }
        }))
        return
      }

      const entries = Array.isArray(result)
        ? result
        : Array.isArray((result as ListDirPagedResult | undefined)?.entries)
          ? ((result as ListDirPagedResult).entries ?? [])
          : null

      if (!entries) {
        throw new Error('Failed to load')
      }

      const sorted = sortEntries(entries)
      const pageInfo = Array.isArray(result)
        ? { hasMore: false }
        : normalizePageInfo(result as ListDirPagedResult)

      set((s) => ({
        sftpEntries: {
          ...s.sftpEntries,
          [connectionId]: { ...(s.sftpEntries[connectionId] ?? {}), [path]: sorted }
        },
        sftpPageInfo: {
          ...s.sftpPageInfo,
          [connectionId]: { ...(s.sftpPageInfo[connectionId] ?? {}), [path]: pageInfo }
        },
        sftpErrors: {
          ...s.sftpErrors,
          [connectionId]: { ...(s.sftpErrors[connectionId] ?? {}), [path]: null }
        },
        sftpConnections: {
          ...s.sftpConnections,
          [connectionId]: {
            ...(s.sftpConnections[connectionId] ?? { homeDir: null }),
            status: 'connected',
            error: undefined
          }
        }
      }))
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to load'
      set((s) => ({
        sftpErrors: {
          ...s.sftpErrors,
          [connectionId]: { ...(s.sftpErrors[connectionId] ?? {}), [path]: errorMessage }
        },
        sftpConnections: {
          ...s.sftpConnections,
          [connectionId]: {
            ...(s.sftpConnections[connectionId] ?? { homeDir: null }),
            status: 'error',
            error: errorMessage
          }
        }
      }))
    } finally {
      release()
      listDirInFlightSince.delete(listDirKey)
      set((s) => ({
        sftpLoading: {
          ...s.sftpLoading,
          [connectionId]: { ...(s.sftpLoading[connectionId] ?? {}), [path]: false }
        }
      }))
    }
  },

  loadMoreSftpEntries: async (connectionId, path) => {
    const state = get()
    const sessionLoading = state.sftpLoading[connectionId] ?? {}
    const pageInfo = state.sftpPageInfo[connectionId]?.[path]
    const now = Date.now()
    const listDirKey = getListDirKey(connectionId, path)
    const startedAt = listDirInFlightSince.get(listDirKey)

    if (sessionLoading[path]) {
      if (!startedAt || now - startedAt > SSH_FILE_EXPLORER_STALE_LOAD_MS) {
        listDirInFlightSince.delete(listDirKey)
        set((s) => ({
          sftpLoading: {
            ...s.sftpLoading,
            [connectionId]: { ...(s.sftpLoading[connectionId] ?? {}), [path]: false }
          }
        }))
      } else {
        return
      }
    }

    if (!pageInfo?.hasMore || !pageInfo.cursor) return

    const connectResult = await get().connectSftpConnection(connectionId)
    if (connectResult.error) return

    set((s) => ({
      sftpLoading: {
        ...s.sftpLoading,
        [connectionId]: { ...(s.sftpLoading[connectionId] ?? {}), [path]: true }
      },
      sftpErrors: {
        ...s.sftpErrors,
        [connectionId]: { ...(s.sftpErrors[connectionId] ?? {}), [path]: null }
      }
    }))

    listDirInFlightSince.set(listDirKey, now)
    const release = await acquireListDirSlot(connectionId)

    try {
      const result = await ipcWithTimeout(
        ipcClient.invoke(IPC.SSH_FS_LIST_DIR, {
          connectionId,
          path,
          cursor: pageInfo.cursor,
          limit: SSH_FILE_EXPLORER_PAGE_SIZE
        }),
        IPC_LIST_DIR_TIMEOUT_MS
      )

      if (result && typeof result === 'object' && 'error' in result) {
        throw new Error(String((result as { error?: string }).error ?? 'Failed to load'))
      }

      const entries = Array.isArray(result)
        ? result
        : Array.isArray((result as ListDirPagedResult | undefined)?.entries)
          ? ((result as ListDirPagedResult).entries ?? [])
          : null

      if (!entries) throw new Error('Failed to load')

      const sorted = sortEntries(entries)
      const nextInfo = Array.isArray(result)
        ? { hasMore: false }
        : normalizePageInfo(result as ListDirPagedResult)

      set((s) => {
        const existing = s.sftpEntries[connectionId]?.[path] ?? []
        const combined = sortEntries([...existing, ...sorted])
        return {
          sftpEntries: {
            ...s.sftpEntries,
            [connectionId]: { ...(s.sftpEntries[connectionId] ?? {}), [path]: combined }
          },
          sftpPageInfo: {
            ...s.sftpPageInfo,
            [connectionId]: { ...(s.sftpPageInfo[connectionId] ?? {}), [path]: nextInfo }
          },
          sftpErrors: {
            ...s.sftpErrors,
            [connectionId]: { ...(s.sftpErrors[connectionId] ?? {}), [path]: null }
          }
        }
      })
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to load'
      set((s) => ({
        sftpErrors: {
          ...s.sftpErrors,
          [connectionId]: { ...(s.sftpErrors[connectionId] ?? {}), [path]: errorMessage }
        }
      }))
    } finally {
      release()
      listDirInFlightSince.delete(listDirKey)
      set((s) => ({
        sftpLoading: {
          ...s.sftpLoading,
          [connectionId]: { ...(s.sftpLoading[connectionId] ?? {}), [path]: false }
        }
      }))
    }
  },

  setSftpSelection: (paneId, entries) => {
    set((state) => ({
      sftpSelections: {
        ...state.sftpSelections,
        [paneId]: entries.reduce<Record<string, SshFileEntry>>((acc, entry) => {
          acc[entry.path] = entry
          return acc
        }, {})
      }
    }))
  },

  toggleSftpSelection: (paneId, entry) => {
    set((state) => {
      const current = { ...(state.sftpSelections[paneId] ?? {}) }
      if (current[entry.path]) delete current[entry.path]
      else current[entry.path] = entry
      return {
        sftpSelections: {
          ...state.sftpSelections,
          [paneId]: current
        }
      }
    })
  },

  clearSftpSelection: (paneId) => {
    set((state) => ({
      sftpSelections: {
        ...state.sftpSelections,
        [paneId]: {}
      }
    }))
  },

  setSftpConflictPolicy: (policy) => set({ sftpConflictPolicy: policy }),
  setSftpInspectorTab: (tab) => set({ sftpInspectorTab: tab }),

  startTransfer: async (args) => {
    ensureTransferEventsSubscribed()
    const result = await ipcClient.invoke(IPC.SSH_FS_TRANSFER_START, args)
    if (result && typeof result === 'object' && 'error' in result) return null
    const taskId = (result as { taskId?: string }).taskId
    if (!taskId) return null

    set((state) => ({
      transferTasks: {
        ...state.transferTasks,
        [taskId]: {
          taskId,
          type: args.type,
          stage: 'preparing',
          sourceConnectionId:
            args.type === 'remote-copy' ? args.sourceConnectionId : args.connectionId,
          targetConnectionId:
            args.type === 'upload'
              ? args.connectionId
              : args.type === 'remote-copy'
                ? args.targetConnectionId
                : null,
          conflictPolicy: args.conflictPolicy,
          message: 'Preparing transfer...',
          updatedAt: Date.now()
        }
      }
    }))

    return taskId
  },

  cancelTransfer: async (taskId) => {
    await ipcClient.invoke(IPC.SSH_FS_TRANSFER_CANCEL, { taskId })
  },

  clearTransferTask: (taskId) => {
    set((state) => {
      if (!state.transferTasks[taskId]) return state
      const next = { ...state.transferTasks }
      delete next[taskId]
      return { transferTasks: next }
    })
  },

  // ── Group CRUD ──

  createGroup: async (name) => {
    const id = `sshg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const maxOrder = Math.max(0, ...get().groups.map((g) => g.sortOrder))
    await ipcClient.invoke(IPC.SSH_GROUP_CREATE, { id, name, sortOrder: maxOrder + 1 })
    const now = Date.now()
    set((s) => ({
      groups: [...s.groups, { id, name, sortOrder: maxOrder + 1, createdAt: now, updatedAt: now }]
    }))
    return id
  },

  updateGroup: async (id, name) => {
    await ipcClient.invoke(IPC.SSH_GROUP_UPDATE, { id, name })
    set((s) => ({
      groups: s.groups.map((g) => (g.id === id ? { ...g, name, updatedAt: Date.now() } : g))
    }))
  },

  deleteGroup: async (id) => {
    await ipcClient.invoke(IPC.SSH_GROUP_DELETE, { id })
    set((s) => ({
      groups: s.groups.filter((g) => g.id !== id),
      connections: s.connections.map((c) => (c.groupId === id ? { ...c, groupId: null } : c))
    }))
  },

  // ── Connection CRUD ──

  createConnection: async (data) => {
    const id = `sshc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const maxOrder = Math.max(0, ...get().connections.map((c) => c.sortOrder))
    await ipcClient.invoke(IPC.SSH_CONNECTION_CREATE, {
      id,
      ...data,
      sortOrder: maxOrder + 1
    })
    const now = Date.now()
    set((s) => ({
      connections: [
        ...s.connections,
        {
          id,
          groupId: data.groupId ?? null,
          name: data.name,
          host: data.host,
          port: data.port ?? 22,
          username: data.username,
          authType: (data.authType as SshConnection['authType']) ?? 'password',
          privateKeyPath: data.privateKeyPath ?? null,
          startupCommand: data.startupCommand ?? null,
          defaultDirectory: data.defaultDirectory ?? null,
          proxyJump: data.proxyJump ?? null,
          keepAliveInterval: data.keepAliveInterval ?? 60,
          sortOrder: maxOrder + 1,
          lastConnectedAt: null,
          createdAt: now,
          updatedAt: now
        }
      ]
    }))
    return id
  },

  updateConnection: async (id, data) => {
    await ipcClient.invoke(IPC.SSH_CONNECTION_UPDATE, { id, ...data })
    set((s) => ({
      connections: s.connections.map((c) => {
        if (c.id !== id) return c
        const updated = { ...c, updatedAt: Date.now() }
        if (data.name !== undefined) updated.name = data.name
        if (data.host !== undefined) updated.host = data.host
        if (data.port !== undefined) updated.port = data.port
        if (data.username !== undefined) updated.username = data.username
        if (data.authType !== undefined)
          updated.authType = data.authType as SshConnection['authType']
        if (data.privateKeyPath !== undefined) updated.privateKeyPath = data.privateKeyPath
        if (data.groupId !== undefined) updated.groupId = data.groupId
        if (data.startupCommand !== undefined) updated.startupCommand = data.startupCommand
        if (data.defaultDirectory !== undefined) updated.defaultDirectory = data.defaultDirectory
        if (data.proxyJump !== undefined) updated.proxyJump = data.proxyJump
        if (data.keepAliveInterval !== undefined) updated.keepAliveInterval = data.keepAliveInterval
        return updated
      })
    }))
  },

  deleteConnection: async (id) => {
    await ipcClient.invoke(IPC.SSH_CONNECTION_DELETE, { id })
    set((s) => ({
      connections: s.connections.filter((c) => c.id !== id),
      selectedConnectionId: s.selectedConnectionId === id ? null : s.selectedConnectionId
    }))
  },

  testConnection: async (id) => {
    const result = (await ipcClient.invoke(IPC.SSH_CONNECTION_TEST, { id })) as {
      success: boolean
      error?: string
    }
    return result
  },

  // ── Terminal sessions ──

  connect: async (connectionId) => {
    ensureSshStatusSubscribed()
    const result = (await ipcClient.invoke(IPC.SSH_CONNECT, { connectionId })) as {
      sessionId?: string
      error?: string
    }
    if (result.error || !result.sessionId) {
      if (result.error) {
        toast.error(i18n.t('connectionFailed', { ns: 'ssh' }), { description: result.error })
      }
      return null
    }
    const session: SshSession = {
      id: result.sessionId,
      connectionId,
      status: 'connecting'
    }
    set((s) => {
      const existing = s.sessions[result.sessionId!]
      return {
        sessions: {
          ...s.sessions,
          [result.sessionId!]: existing && existing.status !== 'connecting' ? existing : session
        },
        activeTerminalId: result.sessionId!,
        connections: s.connections.map((c) =>
          c.id === connectionId ? { ...c, lastConnectedAt: Date.now() } : c
        )
      }
    })
    return result.sessionId
  },

  openTerminalTab: async (connectionId) => {
    const conn = get().connections.find((item) => item.id === connectionId)
    if (!conn) return null

    const pendingTabId = `pending-${connectionId}-${Date.now()}`
    set((state) => ({
      openTabs: [
        ...state.openTabs,
        {
          id: pendingTabId,
          type: 'terminal',
          sessionId: null,
          connectionId,
          connectionName: conn.name,
          title: conn.name,
          status: 'connecting'
        }
      ],
      activeTabId: pendingTabId,
      workspaceSection: 'terminal'
    }))

    const sessionId = await get().connect(connectionId)
    if (!sessionId) {
      get().closeTab(pendingTabId)
      return null
    }

    const stillOpen = get().openTabs.find((tab) => tab.id === pendingTabId)
    if (!stillOpen) {
      await get().disconnect(sessionId)
      return null
    }

    const resolvedTabId = `tab-${sessionId}`
    get().replaceTab(pendingTabId, {
      id: resolvedTabId,
      type: 'terminal',
      sessionId,
      connectionId,
      connectionName: conn.name,
      title: conn.name
    })
    get().setActiveTerminal(sessionId)
    return resolvedTabId
  },

  disconnect: async (sessionId) => {
    await ipcClient.invoke(IPC.SSH_DISCONNECT, { sessionId })
    set((s) => {
      const updated = { ...s.sessions }
      delete updated[sessionId]
      const remainingTabs = s.openTabs.filter((t) => t.sessionId !== sessionId)
      const closedActiveTab =
        s.activeTabId && s.openTabs.find((t) => t.id === s.activeTabId)?.sessionId === sessionId
      return {
        sessions: updated,
        activeTerminalId: s.activeTerminalId === sessionId ? null : s.activeTerminalId,
        openTabs: remainingTabs,
        activeTabId: closedActiveTab
          ? (remainingTabs[remainingTabs.length - 1]?.id ?? null)
          : s.activeTabId
      }
    })
  },

  setActiveTerminal: (sessionId) => set({ activeTerminalId: sessionId }),

  setSelectedConnection: (connectionId) => set({ selectedConnectionId: connectionId }),

  updateSessionStatus: (sessionId, status, error) => {
    set((s) => {
      const existing = s.sessions[sessionId]
      if (!existing) return s
      return {
        sessions: {
          ...s.sessions,
          [sessionId]: { ...existing, status, error }
        }
      }
    })
  },

  removeSession: (sessionId) => {
    set((s) => {
      const updated = { ...s.sessions }
      delete updated[sessionId]
      const remainingTabs = s.openTabs.filter((t) => t.sessionId !== sessionId)
      const closedActiveTab =
        s.activeTabId && s.openTabs.find((t) => t.id === s.activeTabId)?.sessionId === sessionId
      return {
        sessions: updated,
        activeTerminalId: s.activeTerminalId === sessionId ? null : s.activeTerminalId,
        openTabs: remainingTabs,
        activeTabId: closedActiveTab
          ? (remainingTabs[remainingTabs.length - 1]?.id ?? null)
          : s.activeTabId
      }
    })
  },

  // ── Tab management ──

  openTab: (tab) => {
    set((s) => {
      const exists = s.openTabs.find((t) => t.id === tab.id)
      if (exists) return { activeTabId: tab.id, workspaceSection: 'terminal' }
      return {
        openTabs: [...s.openTabs, tab],
        activeTabId: tab.id,
        workspaceSection: 'terminal'
      }
    })
  },

  closeTab: (tabId) => {
    set((s) => {
      const idx = s.openTabs.findIndex((t) => t.id === tabId)
      const remaining = s.openTabs.filter((t) => t.id !== tabId)
      const wasActive = s.activeTabId === tabId
      const tab = s.openTabs[idx]

      return {
        openTabs: remaining,
        activeTabId: wasActive
          ? (remaining[Math.min(idx, remaining.length - 1)]?.id ?? null)
          : s.activeTabId,
        activeTerminalId: tab && s.activeTerminalId === tab.sessionId ? null : s.activeTerminalId,
        workspaceSection:
          wasActive && remaining.length === 0 && s.workspaceSection === 'terminal'
            ? 'hosts'
            : s.workspaceSection
      }
    })
  },

  setActiveTab: (tabId) =>
    set((s) => ({
      activeTabId: tabId,
      workspaceSection: tabId ? 'terminal' : s.workspaceSection
    })),

  replaceTab: (tabId, tab) => {
    set((s) => {
      const openTabs = s.openTabs.map((t) => (t.id === tabId ? tab : t))
      const activeTabId = s.activeTabId === tabId ? tab.id : s.activeTabId
      return { openTabs, activeTabId, workspaceSection: 'terminal' }
    })
  },

  // ── File explorer ──

  toggleFileExplorer: () => set((s) => ({ fileExplorerOpen: !s.fileExplorerOpen })),

  setFileExplorerPath: (sessionId, path) => {
    set((s) => ({ fileExplorerPaths: { ...s.fileExplorerPaths, [sessionId]: path } }))
  },

  loadFileExplorerEntries: async (sessionId, path, force = false) => {
    const state = get()
    const sessionLoading = state.fileExplorerLoading[sessionId] ?? {}
    const sessionEntries = state.fileExplorerEntries[sessionId] ?? {}
    const now = Date.now()
    const listDirKey = getListDirKey(sessionId, path)
    const startedAt = listDirInFlightSince.get(listDirKey)

    if (sessionLoading[path]) {
      if (!force && Object.prototype.hasOwnProperty.call(sessionEntries, path)) {
        console.debug('[SshStore] loadDir guard: already has entries, clearing loading', { path })
        listDirInFlightSince.delete(listDirKey)
        set((s) => ({
          fileExplorerLoading: {
            ...s.fileExplorerLoading,
            [sessionId]: { ...(s.fileExplorerLoading[sessionId] ?? {}), [path]: false }
          }
        }))
        return
      }
      if (!startedAt) {
        console.warn('[SshStore] Clearing orphaned loading state (no in-flight record)', {
          sessionId,
          path
        })
        listDirInFlightSince.delete(listDirKey)
        set((s) => ({
          fileExplorerLoading: {
            ...s.fileExplorerLoading,
            [sessionId]: { ...(s.fileExplorerLoading[sessionId] ?? {}), [path]: false }
          }
        }))
      } else if (now - startedAt > SSH_FILE_EXPLORER_STALE_LOAD_MS) {
        console.warn('[SshStore] Clearing stale list-dir loading state', { sessionId, path })
        listDirInFlightSince.delete(listDirKey)
        set((s) => ({
          fileExplorerLoading: {
            ...s.fileExplorerLoading,
            [sessionId]: { ...(s.fileExplorerLoading[sessionId] ?? {}), [path]: false }
          }
        }))
      } else {
        console.debug('[SshStore] loadDir guard: already loading, skipping', { path })
        return
      }
    }

    if (!force && Object.prototype.hasOwnProperty.call(sessionEntries, path)) return

    const connectionId = get().sessions[sessionId]?.connectionId
    console.debug('[SshStore] loadDir START', { sessionId, path, connectionId, force })

    set((s) => ({
      fileExplorerLoading: {
        ...s.fileExplorerLoading,
        [sessionId]: { ...(s.fileExplorerLoading[sessionId] ?? {}), [path]: true }
      },
      fileExplorerErrors: {
        ...s.fileExplorerErrors,
        [sessionId]: { ...(s.fileExplorerErrors[sessionId] ?? {}), [path]: null }
      }
    }))
    listDirInFlightSince.set(listDirKey, now)
    console.debug('[SshStore] loadDir: waiting for slot', { path })
    const release = await acquireListDirSlot(sessionId)
    console.debug('[SshStore] loadDir: slot acquired, invoking IPC', { path, connectionId })
    try {
      const result = await ipcWithTimeout(
        ipcClient.invoke(IPC.SSH_FS_LIST_DIR, {
          connectionId: get().sessions[sessionId]?.connectionId,
          path,
          limit: SSH_FILE_EXPLORER_PAGE_SIZE,
          refresh: force
        }),
        IPC_LIST_DIR_TIMEOUT_MS
      )

      console.debug('[SshStore] loadDir: IPC returned', {
        path,
        resultType: typeof result,
        isArray: Array.isArray(result),
        keys: result && typeof result === 'object' ? Object.keys(result) : null
      })

      if (result && typeof result === 'object' && 'error' in result) {
        const errorMessage = String((result as { error?: string }).error ?? 'Failed to load')
        console.error('[SshStore] loadDir ERROR from IPC:', { path, errorMessage })
        set((s) => ({
          fileExplorerErrors: {
            ...s.fileExplorerErrors,
            [sessionId]: { ...(s.fileExplorerErrors[sessionId] ?? {}), [path]: errorMessage }
          }
        }))
        return
      }

      const entries = Array.isArray(result)
        ? result
        : Array.isArray((result as ListDirPagedResult | undefined)?.entries)
          ? ((result as ListDirPagedResult).entries ?? [])
          : null

      if (entries) {
        const sorted = sortEntries(entries)
        const pageInfo = Array.isArray(result)
          ? { hasMore: false }
          : normalizePageInfo(result as ListDirPagedResult)
        console.debug('[SshStore] loadDir: setting entries', {
          path,
          count: sorted.length,
          pageInfo
        })
        set((s) => ({
          fileExplorerEntries: {
            ...s.fileExplorerEntries,
            [sessionId]: { ...(s.fileExplorerEntries[sessionId] ?? {}), [path]: sorted }
          },
          fileExplorerPageInfo: {
            ...s.fileExplorerPageInfo,
            [sessionId]: { ...(s.fileExplorerPageInfo[sessionId] ?? {}), [path]: pageInfo }
          },
          fileExplorerErrors: {
            ...s.fileExplorerErrors,
            [sessionId]: { ...(s.fileExplorerErrors[sessionId] ?? {}), [path]: null }
          }
        }))
      } else {
        console.error('[SshStore] loadDir: entries is null, result:', result)
        const errorMessage = 'Failed to load'
        set((s) => ({
          fileExplorerErrors: {
            ...s.fileExplorerErrors,
            [sessionId]: { ...(s.fileExplorerErrors[sessionId] ?? {}), [path]: errorMessage }
          }
        }))
      }
    } catch (err) {
      console.error('[SshStore] loadDir CATCH:', err)
      const errorMessage = err instanceof Error ? err.message : 'Failed to load'
      set((s) => ({
        fileExplorerErrors: {
          ...s.fileExplorerErrors,
          [sessionId]: { ...(s.fileExplorerErrors[sessionId] ?? {}), [path]: errorMessage }
        }
      }))
    } finally {
      console.debug('[SshStore] loadDir FINALLY', { path })
      release()
      listDirInFlightSince.delete(listDirKey)
      set((s) => ({
        fileExplorerLoading: {
          ...s.fileExplorerLoading,
          [sessionId]: { ...(s.fileExplorerLoading[sessionId] ?? {}), [path]: false }
        }
      }))
    }
  },

  loadMoreFileExplorerEntries: async (sessionId, path) => {
    const state = get()
    const sessionLoading = state.fileExplorerLoading[sessionId] ?? {}
    const now = Date.now()
    const listDirKey = getListDirKey(sessionId, path)
    const startedAt = listDirInFlightSince.get(listDirKey)

    if (sessionLoading[path]) {
      if (!startedAt) {
        console.warn('[SshStore] loadMore: clearing orphaned loading state', { sessionId, path })
        listDirInFlightSince.delete(listDirKey)
        set((s) => ({
          fileExplorerLoading: {
            ...s.fileExplorerLoading,
            [sessionId]: { ...(s.fileExplorerLoading[sessionId] ?? {}), [path]: false }
          }
        }))
      } else if (now - startedAt > SSH_FILE_EXPLORER_STALE_LOAD_MS) {
        console.warn('[SshStore] Clearing stale list-dir loading state', { sessionId, path })
        listDirInFlightSince.delete(listDirKey)
        set((s) => ({
          fileExplorerLoading: {
            ...s.fileExplorerLoading,
            [sessionId]: { ...(s.fileExplorerLoading[sessionId] ?? {}), [path]: false }
          }
        }))
      } else {
        return
      }
    }

    const pageInfo = state.fileExplorerPageInfo[sessionId]?.[path]
    if (!pageInfo?.hasMore || !pageInfo.cursor) return

    set((s) => ({
      fileExplorerLoading: {
        ...s.fileExplorerLoading,
        [sessionId]: { ...(s.fileExplorerLoading[sessionId] ?? {}), [path]: true }
      },
      fileExplorerErrors: {
        ...s.fileExplorerErrors,
        [sessionId]: { ...(s.fileExplorerErrors[sessionId] ?? {}), [path]: null }
      }
    }))

    listDirInFlightSince.set(listDirKey, now)
    const release = await acquireListDirSlot(sessionId)
    try {
      const result = await ipcWithTimeout(
        ipcClient.invoke(IPC.SSH_FS_LIST_DIR, {
          connectionId: get().sessions[sessionId]?.connectionId,
          path,
          cursor: pageInfo.cursor,
          limit: SSH_FILE_EXPLORER_PAGE_SIZE
        }),
        IPC_LIST_DIR_TIMEOUT_MS
      )

      if (result && typeof result === 'object' && 'error' in result) {
        const errorMessage = String((result as { error?: string }).error ?? 'Failed to load')
        console.error('[SshStore] Failed to load file entries:', result)
        set((s) => ({
          fileExplorerErrors: {
            ...s.fileExplorerErrors,
            [sessionId]: { ...(s.fileExplorerErrors[sessionId] ?? {}), [path]: errorMessage }
          }
        }))
        return
      }

      const entries = Array.isArray(result)
        ? result
        : Array.isArray((result as ListDirPagedResult | undefined)?.entries)
          ? ((result as ListDirPagedResult).entries ?? [])
          : null

      if (entries) {
        const sorted = sortEntries(entries)
        set((s) => {
          const existing = s.fileExplorerEntries[sessionId]?.[path] ?? []
          const combined = sortEntries([...existing, ...sorted])
          const nextInfo = Array.isArray(result)
            ? { hasMore: false }
            : normalizePageInfo(result as ListDirPagedResult)
          return {
            fileExplorerEntries: {
              ...s.fileExplorerEntries,
              [sessionId]: { ...(s.fileExplorerEntries[sessionId] ?? {}), [path]: combined }
            },
            fileExplorerPageInfo: {
              ...s.fileExplorerPageInfo,
              [sessionId]: { ...(s.fileExplorerPageInfo[sessionId] ?? {}), [path]: nextInfo }
            },
            fileExplorerErrors: {
              ...s.fileExplorerErrors,
              [sessionId]: { ...(s.fileExplorerErrors[sessionId] ?? {}), [path]: null }
            }
          }
        })
      } else {
        const errorMessage = 'Failed to load'
        set((s) => ({
          fileExplorerErrors: {
            ...s.fileExplorerErrors,
            [sessionId]: { ...(s.fileExplorerErrors[sessionId] ?? {}), [path]: errorMessage }
          }
        }))
      }
    } catch (err) {
      console.error('[SshStore] Failed to load file entries:', err)
      const errorMessage = err instanceof Error ? err.message : 'Failed to load'
      set((s) => ({
        fileExplorerErrors: {
          ...s.fileExplorerErrors,
          [sessionId]: { ...(s.fileExplorerErrors[sessionId] ?? {}), [path]: errorMessage }
        }
      }))
    } finally {
      release()
      listDirInFlightSince.delete(listDirKey)
      set((s) => ({
        fileExplorerLoading: {
          ...s.fileExplorerLoading,
          [sessionId]: { ...(s.fileExplorerLoading[sessionId] ?? {}), [path]: false }
        }
      }))
    }
  },

  toggleFileExplorerDir: (sessionId, dirPath) => {
    set((s) => {
      const current = s.fileExplorerExpanded[sessionId] ?? new Set<string>()
      const next = new Set(current)
      if (next.has(dirPath)) next.delete(dirPath)
      else next.add(dirPath)
      return {
        fileExplorerExpanded: { ...s.fileExplorerExpanded, [sessionId]: next }
      }
    })
  },

  setFileExplorerExpanded: (sessionId, expanded) => {
    set((s) => ({
      fileExplorerExpanded: { ...s.fileExplorerExpanded, [sessionId]: new Set(expanded) }
    }))
  }
}))
