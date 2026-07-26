import { filePathToMediaUrl } from '@renderer/lib/local-media-url'
import { useGraphStore } from './graph-store'
import type {
  BackgroundMode,
  CanvasEdge,
  CanvasGraph,
  CanvasNode,
  CanvasTrigger,
  ImageNode
} from './graph-types'
import { validateCanvasTriggers } from './canvas-triggers'

const SLOT_PREFIX = 'open-cowork.draw.graph.'
const LEGACY_KEY = 'open-cowork.draw.graph'

export interface StoredGraph {
  schemaVersion?: number
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  triggers?: CanvasTrigger[]
  background?: BackgroundMode
}

const GRAPH_SCHEMA_VERSION = 2
const NODE_KINDS = new Set(['text', 'image', 'config', 'video'])
const TRIGGER_EVENTS = new Set([
  'run.queued',
  'run.started',
  'run.progress',
  'run.succeeded',
  'run.failed',
  'run.cancelled',
  'run.interrupted',
  'node.updated'
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isValidNode(value: unknown): value is CanvasNode {
  if (!isRecord(value) || !isRecord(value.data)) return false
  return (
    typeof value.id === 'string' &&
    NODE_KINDS.has(String(value.kind)) &&
    ['x', 'y', 'w', 'h'].every((key) => Number.isFinite(value[key] as number))
  )
}

/** Drop heavy base64 image data before persisting; filePaths are kept for rehydration. */
function stripNodes(nodes: CanvasNode[]): CanvasNode[] {
  return nodes.map((n) => {
    if (n.kind === 'image') {
      return {
        ...n,
        data: {
          ...n.data,
          src: n.data.src?.startsWith('data:') ? undefined : n.data.src,
          groupSrcs: undefined
        }
      }
    }
    if (n.kind === 'video') {
      // keep filePath + poster (small); drop the heavy inline video src
      return {
        ...n,
        data: { ...n.data, src: n.data.src?.startsWith('data:') ? undefined : n.data.src }
      }
    }
    return n
  })
}

/**
 * Rehydrate image-node `src` from disk. Persistence strips inline image data,
 * keeping only `filePath`; on load each node gets an oc-media URL that streams
 * the file directly, so localStorage never holds heavy base64 blobs and files
 * of any size display.
 */
export async function rehydrateGraphImages(): Promise<void> {
  const { nodes, updateNode } = useGraphStore.getState()
  const pending = nodes.filter(
    (n): n is ImageNode => n.kind === 'image' && !!n.data.filePath && !n.data.src
  )

  for (const node of pending) {
    const { filePath } = node.data
    if (!filePath) continue
    const src = filePathToMediaUrl(filePath)
    updateNode(node.id, (n) => (n.kind === 'image' ? { ...n, data: { ...n.data, src } } : n))
  }
}

/** Persist the current graph into a project's localStorage slot (base64 stripped). */
export function saveProjectGraph(projectId: string): void {
  const { nodes, edges, triggers, background } = useGraphStore.getState()
  const payload: StoredGraph = {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    nodes: stripNodes(nodes),
    edges,
    triggers,
    background
  }
  try {
    localStorage.setItem(SLOT_PREFIX + projectId, JSON.stringify(payload))
  } catch {
    // quota errors are non-fatal — images live on disk, only structure is stored
  }
}

/** Load a project's graph into the store (or clear if the slot is empty), then rehydrate images. */
export function loadProjectGraph(projectId: string): void {
  const { loadGraph } = useGraphStore.getState()
  let stored: StoredGraph | null = null
  try {
    const raw = localStorage.getItem(SLOT_PREFIX + projectId)
    if (raw) stored = JSON.parse(raw) as StoredGraph
  } catch {
    stored = null
  }
  loadGraph({
    nodes: Array.isArray(stored?.nodes) ? stored!.nodes : [],
    edges: Array.isArray(stored?.edges) ? stored!.edges : [],
    triggers: Array.isArray(stored?.triggers) ? stored!.triggers : [],
    background: stored?.background
  })
  void rehydrateGraphImages()
}

export function deleteProjectGraph(projectId: string): void {
  try {
    localStorage.removeItem(SLOT_PREFIX + projectId)
  } catch {
    /* ignore */
  }
}

/** Read one persisted project without switching the visible graph. */
export function readPersistedProjectGraph(projectId: string): StoredGraph | null {
  try {
    const raw = localStorage.getItem(SLOT_PREFIX + projectId)
    if (!raw) return null
    const parsed = JSON.parse(raw) as StoredGraph
    return Array.isArray(parsed.nodes) && Array.isArray(parsed.edges) ? parsed : null
  } catch {
    return null
  }
}

/** Mutate an inactive project's persisted graph without switching the visible canvas. */
export function patchPersistedProjectGraph(
  projectId: string,
  patch: (graph: StoredGraph) => StoredGraph
): boolean {
  try {
    const raw = localStorage.getItem(SLOT_PREFIX + projectId)
    if (!raw) return false
    const parsed = JSON.parse(raw) as StoredGraph
    if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return false
    const next = patch(parsed)
    localStorage.setItem(
      SLOT_PREFIX + projectId,
      JSON.stringify({
        ...next,
        schemaVersion: GRAPH_SCHEMA_VERSION,
        nodes: stripNodes(next.nodes)
      })
    )
    return true
  } catch {
    return false
  }
}

/** Migrate the pre-multi-project single graph (old zustand-persist key) into a slot. */
export function migrateLegacyGraph(projectId: string): boolean {
  try {
    const raw = localStorage.getItem(LEGACY_KEY)
    if (!raw) return false
    const parsed = JSON.parse(raw) as { state?: StoredGraph } & StoredGraph
    const state = parsed.state ?? parsed
    if (!Array.isArray(state?.nodes)) return false
    const payload: StoredGraph = {
      schemaVersion: GRAPH_SCHEMA_VERSION,
      nodes: stripNodes(state.nodes),
      edges: Array.isArray(state.edges) ? state.edges : [],
      triggers: Array.isArray(state.triggers) ? state.triggers : [],
      background: state.background
    }
    localStorage.setItem(SLOT_PREFIX + projectId, JSON.stringify(payload))
    localStorage.removeItem(LEGACY_KEY)
    return true
  } catch {
    return false
  }
}

/** Serialize the current graph to a JSON string (base64 images dropped; filePaths kept). */
export function exportGraphJson(): string {
  const { nodes, edges, triggers, background } = useGraphStore.getState()
  const graph: CanvasGraph = {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    nodes: stripNodes(nodes),
    edges,
    triggers,
    background
  }
  return JSON.stringify(graph, null, 2)
}

/** Load a graph from a JSON string, replacing the current graph. */
export function importGraphJson(json: string): boolean {
  try {
    const parsed = JSON.parse(json) as CanvasGraph
    if (
      !Array.isArray(parsed.nodes) ||
      !parsed.nodes.every(isValidNode) ||
      !Array.isArray(parsed.edges) ||
      !parsed.edges.every(
        (edge) =>
          isRecord(edge) &&
          typeof edge.id === 'string' &&
          typeof edge.source === 'string' &&
          typeof edge.target === 'string'
      ) ||
      (parsed.triggers !== undefined &&
        (!Array.isArray(parsed.triggers) ||
          !parsed.triggers.every(
            (trigger) =>
              isRecord(trigger) &&
              typeof trigger.id === 'string' &&
              typeof trigger.sourceNodeId === 'string' &&
              typeof trigger.targetNodeId === 'string' &&
              TRIGGER_EVENTS.has(String(trigger.event))
          )))
    ) {
      return false
    }
    const nodeIds = new Set(parsed.nodes.map((node) => node.id))
    if (nodeIds.size !== parsed.nodes.length) return false
    const edgeIds = new Set(parsed.edges.map((edge) => edge.id))
    const triggerIds = new Set((parsed.triggers ?? []).map((trigger) => trigger.id))
    if (
      edgeIds.size !== parsed.edges.length ||
      triggerIds.size !== (parsed.triggers ?? []).length ||
      parsed.edges.some(
        (edge) =>
          !nodeIds.has(edge.source) || !nodeIds.has(edge.target) || edge.source === edge.target
      ) ||
      (parsed.triggers ?? []).some(
        (trigger) =>
          !nodeIds.has(trigger.sourceNodeId) ||
          !nodeIds.has(trigger.targetNodeId) ||
          typeof trigger.enabled !== 'boolean' ||
          !Number.isFinite(trigger.createdAt)
      ) ||
      (parsed.background !== undefined &&
        !(['dots', 'grid', 'blank'] as const).includes(parsed.background)) ||
      !validateCanvasTriggers(parsed.triggers ?? [])
    ) {
      return false
    }
    useGraphStore.getState().replaceGraph({
      ...parsed,
      triggers: Array.isArray(parsed.triggers) ? parsed.triggers : []
    })
    void rehydrateGraphImages()
    return true
  } catch {
    return false
  }
}
