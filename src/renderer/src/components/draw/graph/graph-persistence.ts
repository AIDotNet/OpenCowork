import { filePathToMediaUrl } from '@renderer/lib/local-media-url'
import { useGraphStore } from './graph-store'
import type { BackgroundMode, CanvasEdge, CanvasGraph, CanvasNode, ImageNode } from './graph-types'

const SLOT_PREFIX = 'open-cowork.draw.graph.'
const LEGACY_KEY = 'open-cowork.draw.graph'

interface StoredGraph {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  background?: BackgroundMode
}

/** Drop heavy base64 image data before persisting; filePaths are kept for rehydration. */
function stripNodes(nodes: CanvasNode[]): CanvasNode[] {
  return nodes.map((n) => {
    if (n.kind === 'image') {
      return { ...n, data: { ...n.data, src: undefined, groupSrcs: undefined } }
    }
    if (n.kind === 'video') {
      // keep filePath + poster (small); drop the heavy inline video src
      return { ...n, data: { ...n.data, src: undefined, generating: false, status: undefined } }
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
  const { nodes, edges, background } = useGraphStore.getState()
  const payload: StoredGraph = { nodes: stripNodes(nodes), edges, background }
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

/** Migrate the pre-multi-project single graph (old zustand-persist key) into a slot. */
export function migrateLegacyGraph(projectId: string): boolean {
  try {
    const raw = localStorage.getItem(LEGACY_KEY)
    if (!raw) return false
    const parsed = JSON.parse(raw) as { state?: StoredGraph } & StoredGraph
    const state = parsed.state ?? parsed
    if (!Array.isArray(state?.nodes)) return false
    const payload: StoredGraph = {
      nodes: stripNodes(state.nodes),
      edges: Array.isArray(state.edges) ? state.edges : [],
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
  const { nodes, edges } = useGraphStore.getState()
  const graph: CanvasGraph = { nodes: stripNodes(nodes), edges }
  return JSON.stringify(graph, null, 2)
}

/** Load a graph from a JSON string, replacing the current graph. */
export function importGraphJson(json: string): boolean {
  try {
    const parsed = JSON.parse(json) as CanvasGraph
    if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return false
    useGraphStore.getState().replaceGraph(parsed)
    void rehydrateGraphImages()
    return true
  } catch {
    return false
  }
}
