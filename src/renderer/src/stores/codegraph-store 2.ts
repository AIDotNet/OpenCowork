import { create } from 'zustand'
import { toast } from 'sonner'
import i18n from '@renderer/locales'
import { ipcClient } from '../lib/ipc/ipc-client'
import { IPC } from '../lib/ipc/channels'

// =============================================================================
// CodeGraph visualization store (plan/codex-graph/07). Talks to the CodeGraph
// sidecar via the generic passthrough (agentBridge.request('codegraph/*', …)) —
// no dedicated IPC channels. Every codegraph/* result is success-shaped by
// convention (the JS promise resolves even on failure; inspect result.success /
// result.error), so callers never rely on a thrown rejection.
// =============================================================================

const t = (key: string, opts?: Record<string, unknown>): string =>
  i18n.t(`codegraphPage.${key}`, { ns: 'layout', ...opts })

async function cg<T>(
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 60_000
): Promise<T> {
  const { agentBridge } = await import('@renderer/lib/ipc/agent-bridge')
  return (await agentBridge.request(method, params, timeoutMs)) as T
}

// ---- Wire DTOs (mirror sidecars/OpenCowork.CodeGraph.Core, camelCase) --------

export interface CgProject {
  root: string
  hash: string
  state: string
  files: number
  nodes: number
  edges: number
  dbSizeBytes: number
  lastIndexedAt?: number | null
}

export interface CgIndexStatus {
  success: boolean
  indexed: boolean
  state?: string | null
  indexing: boolean
  lastIndexedAt?: number | null
  fileCount: number
  nodeCount: number
  edgeCount: number
  pendingReferenceCount: number
  dbSizeBytes: number
  backend: string
  journalMode: string
  stale: boolean
  indexedWithVersion?: string | null
  error?: string
  errorKind?: string
}

export interface CgCycle {
  files: string[]
}

export interface CgDeadSymbol {
  id: string
  name: string
  kind: string
  filePath: string
  startLine: number
}

// codegraph/analytics — on-demand graph health panels (M7-W3). Lists are capped
// (50 / 200) with uncapped totals alongside.
export interface CgAnalytics {
  success: boolean
  circularDependencies: CgCycle[]
  circularTotal: number
  deadCode: CgDeadSymbol[]
  deadCodeTotal: number
  error?: string
  errorKind?: string
}

export interface CgBucket {
  key: string
  count: number
}

export interface CgStats {
  success: boolean
  nodeCount: number
  edgeCount: number
  fileCount: number
  nodesByKind: CgBucket[]
  edgesByKind: CgBucket[]
  filesByLanguage: CgBucket[]
  dbSizeBytes: number
  lastUpdated: number
  error?: string
  errorKind?: string
}

export interface CgFileNode {
  path: string
  language: string
  nodeCount: number
  size: number
  indexedAt?: number | null
}

export interface CgNode {
  id: string
  kind: string
  name: string
  qualifiedName: string
  filePath: string
  language: string
  startLine: number
  endLine: number
  startColumn: number
  endColumn: number
  signature?: string | null
  isExported?: boolean
}

export interface CgEdge {
  source: string
  target: string
  kind: string
  line?: number | null
  column?: number | null
  provenance?: string | null
}

export interface CgSubgraph {
  success: boolean
  nodes: CgNode[]
  edges: CgEdge[]
  roots: string[]
  confidence?: string | null
  error?: string
  errorKind?: string
}

// Live index/sync progress relayed from the worker over IPC.CODEGRAPH_INDEX_PROGRESS.
// Phase: scan | extract | resolve | synthesize | maintenance | sync | complete.
export interface CgIndexProgress {
  indexId: string
  phase: string
  filesDone: number
  filesTotal: number
  nodeCount: number
  edgeCount: number
  message?: string | null
  done?: boolean
  state?: string
}

interface CgAssetStatus {
  workerReady: boolean
  grammarsReady: boolean
  ready: boolean
  needsDownload: boolean
}

interface CodeGraphStore {
  // Project list (across all indexed roots).
  projects: CgProject[]
  projectsLoading: boolean
  // Currently focused project.
  selectedRoot: string | null
  status: CgIndexStatus | null
  stats: CgStats | null
  detailLoading: boolean
  // On-demand analytics (cycles + dead code) for the selected project.
  analytics: CgAnalytics | null
  analyticsLoading: boolean
  // Indexed-file tree for the selected project.
  files: CgFileNode[] | null
  filesLoading: boolean
  // Single-flight guard: 'index:<root>' | 'sync:<root>' | 'remove:<hash>' | 'addFolder'.
  busyKey: string | null
  // Live progress for the current UI-initiated index/sync (null when idle).
  indexProgress: CgIndexProgress | null

  refreshProjects: () => Promise<void>
  selectProject: (root: string | null) => void
  refreshSelected: (opts?: { silent?: boolean }) => Promise<void>
  addFolder: () => Promise<void>
  indexProject: (root: string) => Promise<void>
  syncProject: (root: string) => Promise<void>
  removeProject: (root: string, hash: string) => Promise<void>
  loadFiles: (root: string) => Promise<void>
  loadAnalytics: (root: string) => Promise<void>
  fileSymbols: (root: string, file: string) => Promise<CgNode[]>
  queryNeighbors: (
    root: string,
    params: {
      nodeId?: string
      symbol?: string
      depth?: number
      edgeKinds?: string[]
      limit?: number
    }
  ) => Promise<CgSubgraph>
  // Pick a sensible starting node for an unseeded graph view: the top symbol of
  // the largest indexed file (most nodes). Null when the project has no symbols.
  pickDefaultSeed: (root: string) => Promise<CgNode | null>
}

const INDEX_TIMEOUT_MS = 15 * 60_000
const SYNC_TIMEOUT_MS = 5 * 60_000

export const useCodeGraphStore = create<CodeGraphStore>()((set, get) => ({
  projects: [],
  projectsLoading: false,
  selectedRoot: null,
  status: null,
  stats: null,
  detailLoading: false,
  analytics: null,
  analyticsLoading: false,
  files: null,
  filesLoading: false,
  busyKey: null,
  indexProgress: null,

  refreshProjects: async () => {
    set({ projectsLoading: true })
    try {
      const res = await cg<{ success: boolean; projects?: CgProject[] }>(
        'codegraph/list-projects',
        {},
        30_000
      )
      const projects = res.success && res.projects ? res.projects : []
      set({ projects })
      // Auto-select the first project when nothing is chosen yet.
      const { selectedRoot } = get()
      if (!selectedRoot && projects.length > 0) {
        get().selectProject(projects[0].root)
      } else if (selectedRoot && !projects.some((p) => p.root === selectedRoot)) {
        get().selectProject(projects[0]?.root ?? null)
      }
    } catch (error) {
      console.error('[CodeGraph] list-projects failed', error)
      set({ projects: [] })
    } finally {
      set({ projectsLoading: false })
    }
  },

  selectProject: (root) => {
    set({ selectedRoot: root, status: null, stats: null, files: null, analytics: null })
    if (root) {
      void get().refreshSelected()
    }
  },

  refreshSelected: async (opts) => {
    const root = get().selectedRoot
    if (!root) return
    if (!opts?.silent) set({ detailLoading: true })
    try {
      const [status, stats] = await Promise.all([
        cg<CgIndexStatus>('codegraph/index-status', { workingFolder: root }, 30_000),
        cg<CgStats>('codegraph/stats', { workingFolder: root }, 30_000)
      ])
      // Guard against a project switch mid-flight.
      if (get().selectedRoot !== root) return
      set({ status, stats })
    } catch (error) {
      console.error('[CodeGraph] refreshSelected failed', error)
    } finally {
      if (!opts?.silent) set({ detailLoading: false })
    }
  },

  loadAnalytics: async (root) => {
    set({ analyticsLoading: true })
    try {
      const analytics = await cg<CgAnalytics>(
        'codegraph/analytics',
        { workingFolder: root },
        120_000
      )
      if (get().selectedRoot !== root) return
      set({ analytics })
    } catch (error) {
      console.error('[CodeGraph] analytics failed', error)
    } finally {
      set({ analyticsLoading: false })
    }
  },

  addFolder: async () => {
    if (get().busyKey) return
    let picked: { canceled?: boolean; path?: string }
    try {
      picked = (await ipcClient.invoke(IPC.FS_SELECT_FOLDER)) as {
        canceled?: boolean
        path?: string
      }
    } catch (error) {
      toast.error(t('toast.addFolderFailed'), {
        description: error instanceof Error ? error.message : String(error)
      })
      return
    }
    if (picked.canceled || !picked.path) return
    const root = picked.path
    get().selectProject(root)
    await get().indexProject(root)
  },

  indexProject: async (root) => {
    const key = `index:${root}`
    if (get().busyKey) return
    const indexId = crypto.randomUUID()
    trackCodeGraphIndex(indexId)
    set({
      busyKey: key,
      indexProgress: {
        indexId,
        phase: 'scan',
        filesDone: 0,
        filesTotal: 0,
        nodeCount: 0,
        edgeCount: 0
      }
    })
    toast.info(t('toast.indexStarted'))
    // Poll the health snapshot so KPIs update live during a long index; the
    // codegraph/index-progress relay drives the progress bar in parallel.
    const poll = window.setInterval(() => {
      if (get().selectedRoot === root) void get().refreshSelected({ silent: true })
    }, 2_000)
    try {
      const res = await cg<{ success?: boolean; state?: string; error?: string }>(
        'codegraph/index',
        { workingFolder: root, indexId },
        INDEX_TIMEOUT_MS
      )
      if (res?.success === false) {
        toast.error(t('toast.indexFailed'), { description: res.error })
      } else {
        toast.success(t('toast.indexDone'))
      }
    } catch (error) {
      toast.error(t('toast.indexFailed'), {
        description: error instanceof Error ? error.message : String(error)
      })
    } finally {
      window.clearInterval(poll)
      untrackCodeGraphIndex(indexId)
      set({ busyKey: null, indexProgress: null })
      await get().refreshProjects()
      if (get().selectedRoot === root) {
        await get().refreshSelected()
        set({ files: null })
      }
    }
  },

  syncProject: async (root) => {
    const key = `sync:${root}`
    if (get().busyKey) return
    const indexId = crypto.randomUUID()
    trackCodeGraphIndex(indexId)
    set({
      busyKey: key,
      indexProgress: {
        indexId,
        phase: 'sync',
        filesDone: 0,
        filesTotal: 0,
        nodeCount: 0,
        edgeCount: 0
      }
    })
    try {
      const res = await cg<{ success?: boolean; error?: string }>(
        'codegraph/sync',
        { workingFolder: root, indexId },
        SYNC_TIMEOUT_MS
      )
      if (res?.success === false) {
        toast.error(t('toast.syncFailed'), { description: res.error })
      } else {
        toast.success(t('toast.syncDone'))
      }
    } catch (error) {
      toast.error(t('toast.syncFailed'), {
        description: error instanceof Error ? error.message : String(error)
      })
    } finally {
      untrackCodeGraphIndex(indexId)
      set({ busyKey: null, indexProgress: null })
      await get().refreshProjects()
      if (get().selectedRoot === root) {
        await get().refreshSelected()
        set({ files: null })
      }
    }
  },

  removeProject: async (root, hash) => {
    const key = `remove:${hash}`
    if (get().busyKey) return
    set({ busyKey: key })
    try {
      const res = await cg<{ success?: boolean; error?: string }>(
        'codegraph/remove-project',
        { workingFolder: root, hash },
        30_000
      )
      if (res?.success === false) {
        toast.error(t('toast.removeFailed'), { description: res.error })
      } else {
        toast.success(t('toast.removed'))
      }
    } catch (error) {
      toast.error(t('toast.removeFailed'), {
        description: error instanceof Error ? error.message : String(error)
      })
    } finally {
      set({ busyKey: null })
      if (get().selectedRoot === root) {
        set({ selectedRoot: null, status: null, stats: null, files: null })
      }
      await get().refreshProjects()
    }
  },

  loadFiles: async (root) => {
    set({ filesLoading: true })
    try {
      const res = await cg<{ success: boolean; files?: CgFileNode[] }>(
        'codegraph/files-tree',
        { workingFolder: root },
        30_000
      )
      if (get().selectedRoot !== root) return
      set({ files: res.success && res.files ? res.files : [] })
    } catch (error) {
      console.error('[CodeGraph] files-tree failed', error)
      set({ files: [] })
    } finally {
      set({ filesLoading: false })
    }
  },

  fileSymbols: async (root, file) => {
    try {
      const res = await cg<{ success: boolean; nodes?: CgNode[] }>(
        'codegraph/file-symbols',
        { workingFolder: root, file },
        30_000
      )
      return res.success && res.nodes ? res.nodes : []
    } catch (error) {
      console.error('[CodeGraph] file-symbols failed', error)
      return []
    }
  },

  queryNeighbors: async (root, params) => {
    const empty: CgSubgraph = { success: false, nodes: [], edges: [], roots: [] }
    try {
      const res = await cg<CgSubgraph>(
        'codegraph/query-neighbors',
        {
          workingFolder: root,
          nodeId: params.nodeId,
          symbol: params.symbol,
          depth: params.depth ?? 1,
          edgeKinds: params.edgeKinds,
          limit: params.limit ?? 60
        },
        30_000
      )
      return res ?? empty
    } catch (error) {
      console.error('[CodeGraph] query-neighbors failed', error)
      return empty
    }
  },

  pickDefaultSeed: async (root) => {
    try {
      const res = await cg<{ success: boolean; files?: CgFileNode[] }>(
        'codegraph/files-tree',
        { workingFolder: root },
        30_000
      )
      const files = res.success && res.files ? res.files : []
      if (files.length === 0) return null
      // Largest file by symbol count is a reliable "center of gravity" for a first look.
      const top = files.reduce((a, b) => (b.nodeCount > a.nodeCount ? b : a))
      const symbols = await get().fileSymbols(root, top.path)
      if (symbols.length === 0) return null
      return symbols.find((s) => s.isExported) ?? symbols[0]
    } catch (error) {
      console.error('[CodeGraph] pickDefaultSeed failed', error)
      return null
    }
  }
}))

// ---- Live index progress (IPC.CODEGRAPH_INDEX_PROGRESS relay) ----------------
// Only events whose indexId was registered by a UI-initiated index/sync update
// the store, so background auto-sync (which uses its own random indexId) is
// ignored and never flashes a progress bar.
const trackedIndexIds = new Set<string>()

export function trackCodeGraphIndex(indexId: string): void {
  trackedIndexIds.add(indexId)
}

export function untrackCodeGraphIndex(indexId: string): void {
  trackedIndexIds.delete(indexId)
}

function handleIndexProgress(raw: unknown): void {
  const p = raw as Partial<CgIndexProgress> | null
  if (!p || typeof p.indexId !== 'string' || !trackedIndexIds.has(p.indexId)) return
  useCodeGraphStore.setState({
    indexProgress: {
      indexId: p.indexId,
      phase: typeof p.phase === 'string' ? p.phase : 'indexing',
      filesDone: Number(p.filesDone ?? 0),
      filesTotal: Number(p.filesTotal ?? 0),
      nodeCount: Number(p.nodeCount ?? 0),
      edgeCount: Number(p.edgeCount ?? 0),
      message: p.message ?? null,
      done: p.done === true,
      state: p.state
    }
  })
}

if (typeof window !== 'undefined') {
  window.electron?.ipcRenderer?.on?.(IPC.CODEGRAPH_INDEX_PROGRESS, (_event, payload) =>
    handleIndexProgress(payload)
  )
}

// Feature-gate helper (plugin enabled + grammar assets ready), used by the page.
export async function getCodeGraphAssetStatus(): Promise<CgAssetStatus | null> {
  try {
    return (await ipcClient.invoke(IPC.CODEGRAPH_ASSET_STATUS)) as CgAssetStatus
  } catch {
    return null
  }
}
