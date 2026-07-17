import { create } from 'zustand'
import { nanoid } from 'nanoid'
import type { BackgroundMode, CanvasEdge, CanvasGraph, CanvasNode, NodeBox } from './graph-types'

export interface Camera {
  scale: number
  x: number
  y: number
}

/** Which image-node editor overlay/dialog is open. */
export type EditingMode = 'mask' | 'outpaint' | 'crop' | 'angle' | 'upscale' | 'split'

export const GRAPH_MIN_SCALE = 0.15
export const GRAPH_MAX_SCALE = 3
const HISTORY_LIMIT = 60

interface GraphState {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  camera: Camera
  stageSize: { width: number; height: number }
  selection: string[]
  selectedEdges: string[]
  background: BackgroundMode
  editing: { nodeId: string; mode: EditingMode } | null
  past: CanvasGraph[]
  future: CanvasGraph[]
  /** Set by loadGraph; the canvas fits the view once the stage is measured, then clears it. */
  pendingFit: boolean

  // view
  setCamera: (updater: Camera | ((c: Camera) => Camera)) => void
  setStageSize: (size: { width: number; height: number }) => void
  setBackground: (mode: BackgroundMode) => void
  setEditing: (value: { nodeId: string; mode: EditingMode } | null) => void
  resetView: () => void
  clearPendingFit: () => void

  // history
  pushHistory: () => void
  undo: () => void
  redo: () => void

  // nodes / edges
  addNode: (node: CanvasNode, opts?: { history?: boolean; select?: boolean }) => void
  updateNode: (id: string, patch: Partial<CanvasNode> | ((n: CanvasNode) => CanvasNode)) => void
  moveNodes: (deltas: Record<string, { x: number; y: number }>) => void
  resizeNode: (id: string, box: NodeBox) => void
  removeNodes: (ids: string[]) => void
  removeSelected: () => void
  addEdge: (source: string, target: string, opts?: { history?: boolean }) => void
  removeEdge: (id: string) => void

  // selection
  setSelection: (ids: string[]) => void
  toggleSelection: (id: string) => void
  selectAll: () => void
  clearSelection: () => void
  selectEdge: (id: string, additive?: boolean) => void

  duplicateSelection: () => void
  replaceGraph: (graph: CanvasGraph) => void
  /** Load a project graph, resetting history/selection/view (no undo entry). */
  loadGraph: (graph: {
    nodes: CanvasNode[]
    edges: CanvasEdge[]
    background?: BackgroundMode
  }) => void
}

function snapshot(state: GraphState): CanvasGraph {
  // Every mutation in this store replaces node/edge objects immutably
  // (updateNode/moveNodes/... never mutate in place), so history entries can
  // share references with live state. A deep clone here would copy multi-MB
  // base64 image payloads on every gesture start.
  return { nodes: state.nodes, edges: state.edges }
}

const INITIAL_CAMERA: Camera = { scale: 1, x: 0, y: 0 }

/**
 * A node persisted mid-generation can never complete after a reload — the
 * request died with the app. Convert stale `generating` flags into an
 * explicit interrupted state so the card doesn't spin forever.
 */
function sanitizeLoadedNodes(nodes: CanvasNode[]): CanvasNode[] {
  return nodes.map((n) => {
    if (n.kind === 'image' && n.data.generating) {
      return { ...n, data: { ...n.data, generating: false, interrupted: true } }
    }
    if (n.kind === 'video' && n.data.generating) {
      return { ...n, data: { ...n.data, generating: false, status: undefined, interrupted: true } }
    }
    return n
  })
}

export const useGraphStore = create<GraphState>()((set, get) => ({
  nodes: [],
  edges: [],
  camera: INITIAL_CAMERA,
  stageSize: { width: 0, height: 0 },
  selection: [],
  selectedEdges: [],
  background: 'dots',
  editing: null,
  past: [],
  future: [],
  pendingFit: false,

  setCamera: (updater) =>
    set((s) => ({ camera: typeof updater === 'function' ? updater(s.camera) : updater })),
  setStageSize: (size) => set({ stageSize: size }),
  setBackground: (mode) => set({ background: mode }),
  setEditing: (value) => set({ editing: value }),
  resetView: () => set({ camera: INITIAL_CAMERA }),
  clearPendingFit: () => set({ pendingFit: false }),

  pushHistory: () =>
    set((s) => ({
      past: [...s.past.slice(-HISTORY_LIMIT + 1), snapshot(s)],
      future: []
    })),

  undo: () =>
    set((s) => {
      const prev = s.past[s.past.length - 1]
      if (!prev) return s
      return {
        past: s.past.slice(0, -1),
        future: [...s.future, snapshot(s)],
        nodes: prev.nodes,
        edges: prev.edges,
        selection: [],
        selectedEdges: []
      }
    }),

  redo: () =>
    set((s) => {
      const next = s.future[s.future.length - 1]
      if (!next) return s
      return {
        future: s.future.slice(0, -1),
        past: [...s.past, snapshot(s)],
        nodes: next.nodes,
        edges: next.edges,
        selection: [],
        selectedEdges: []
      }
    }),

  addNode: (node, opts) => {
    if (opts?.history !== false) get().pushHistory()
    set((s) => ({
      nodes: [...s.nodes, node],
      selection: opts?.select ? [node.id] : s.selection
    }))
  },

  updateNode: (id, patch) =>
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === id
          ? typeof patch === 'function'
            ? patch(n)
            : ({ ...n, ...patch } as CanvasNode)
          : n
      )
    })),

  moveNodes: (deltas) =>
    set((s) => ({
      nodes: s.nodes.map((n) => {
        const d = deltas[n.id]
        return d ? { ...n, x: n.x + d.x, y: n.y + d.y } : n
      })
    })),

  resizeNode: (id, box) =>
    set((s) => ({
      nodes: s.nodes.map((n) => (n.id === id ? { ...n, ...box } : n))
    })),

  removeNodes: (ids) => {
    if (ids.length === 0) return
    get().pushHistory()
    const idSet = new Set(ids)
    set((s) => ({
      nodes: s.nodes.filter((n) => !idSet.has(n.id)),
      edges: s.edges.filter((e) => !idSet.has(e.source) && !idSet.has(e.target)),
      selection: s.selection.filter((id) => !idSet.has(id))
    }))
  },

  removeSelected: () => {
    const { selection, selectedEdges } = get()
    if (selection.length === 0 && selectedEdges.length === 0) return
    get().pushHistory()
    const nodeSet = new Set(selection)
    const edgeSet = new Set(selectedEdges)
    set((s) => ({
      nodes: s.nodes.filter((n) => !nodeSet.has(n.id)),
      edges: s.edges.filter(
        (e) => !edgeSet.has(e.id) && !nodeSet.has(e.source) && !nodeSet.has(e.target)
      ),
      selection: [],
      selectedEdges: []
    }))
  },

  addEdge: (source, target, opts) => {
    if (source === target) return
    const exists = get().edges.some((e) => e.source === source && e.target === target)
    if (exists) return
    if (opts?.history !== false) get().pushHistory()
    set((s) => ({ edges: [...s.edges, { id: nanoid(), source, target }] }))
  },

  removeEdge: (id) => {
    get().pushHistory()
    set((s) => ({ edges: s.edges.filter((e) => e.id !== id) }))
  },

  setSelection: (ids) => set({ selection: ids, selectedEdges: [] }),
  toggleSelection: (id) =>
    set((s) => ({
      selection: s.selection.includes(id)
        ? s.selection.filter((x) => x !== id)
        : [...s.selection, id],
      selectedEdges: []
    })),
  selectAll: () => set((s) => ({ selection: s.nodes.map((n) => n.id), selectedEdges: [] })),
  clearSelection: () => set({ selection: [], selectedEdges: [] }),
  selectEdge: (id, additive) =>
    set((s) => ({
      selectedEdges: additive ? [...s.selectedEdges, id] : [id],
      selection: additive ? s.selection : []
    })),

  duplicateSelection: () => {
    const { selection, nodes, edges } = get()
    if (selection.length === 0) return
    get().pushHistory()
    const idMap = new Map<string, string>()
    const clones = nodes
      .filter((n) => selection.includes(n.id))
      .map((n) => {
        const id = nanoid()
        idMap.set(n.id, id)
        return { ...structuredClone(n), id, x: n.x + 32, y: n.y + 32 }
      })
    const clonedEdges = edges
      .filter((e) => idMap.has(e.source) && idMap.has(e.target))
      .map((e) => ({
        id: nanoid(),
        source: idMap.get(e.source) as string,
        target: idMap.get(e.target) as string
      }))
    set((s) => ({
      nodes: [...s.nodes, ...clones],
      edges: [...s.edges, ...clonedEdges],
      selection: clones.map((n) => n.id)
    }))
  },

  replaceGraph: (graph) => {
    get().pushHistory()
    set({
      nodes: sanitizeLoadedNodes(graph.nodes),
      edges: graph.edges,
      selection: [],
      selectedEdges: []
    })
  },
  loadGraph: (graph) =>
    set({
      nodes: sanitizeLoadedNodes(graph.nodes),
      edges: graph.edges,
      background: graph.background ?? 'dots',
      selection: [],
      selectedEdges: [],
      editing: null,
      past: [],
      future: [],
      camera: INITIAL_CAMERA,
      pendingFit: graph.nodes.length > 0
    })
}))

/** Node ids directly upstream of `id` (edges pointing into it). */
export function upstreamNodeIds(edges: CanvasEdge[], id: string): string[] {
  return edges.filter((e) => e.target === id).map((e) => e.source)
}

/** Node ids directly downstream of `id`. */
export function downstreamNodeIds(edges: CanvasEdge[], id: string): string[] {
  return edges.filter((e) => e.source === id).map((e) => e.target)
}
