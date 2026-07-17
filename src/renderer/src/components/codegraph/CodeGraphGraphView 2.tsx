import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Minus, Plus, RotateCcw, Search } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Spinner } from '@renderer/components/ui/spinner'
import { cn } from '@renderer/lib/utils'
import { useCodeGraphStore, type CgEdge, type CgNode } from '@renderer/stores/codegraph-store'

// Self-contained code-graph canvas (plan/codex-graph/07 Tier 2): DOM nodes + an SVG
// edge overlay over a pan/zoom camera. Seeded by a symbol/node, expand-on-click pulls
// each node's neighbors (codegraph/query-neighbors) and radially lays out the new ones,
// then a force refinement pass (springs + repulsion + rect collision) untangles them.
// Node boxes keep a fixed pixel size (readable at any zoom); only positions scale.

interface Placed {
  node: CgNode
  x: number
  y: number
}

interface Camera {
  scale: number
  x: number
  y: number
}

const NODE_W = 150
const NODE_H = 34
const MIN_SCALE = 0.15
const MAX_SCALE = 2.5
const RING_START = 210
const RING_GAP = 150
const NODE_GAP = 46 // min arc gap between node centers on a ring

// Node accent by kind — a small, theme-neutral categorical set.
const KIND_COLORS: Record<string, string> = {
  function: 'border-l-sky-500',
  method: 'border-l-sky-500',
  class: 'border-l-violet-500',
  interface: 'border-l-violet-400',
  type: 'border-l-violet-400',
  struct: 'border-l-violet-500',
  enum: 'border-l-amber-500',
  variable: 'border-l-emerald-500',
  constant: 'border-l-emerald-500',
  route: 'border-l-rose-500',
  component: 'border-l-pink-500',
  file: 'border-l-muted-foreground'
}

// Edge stroke per kind — behavioral edges (calls/references/extends) get color,
// structural noise (imports/contains) stays muted. The legend chips double as
// a color key and per-kind visibility toggle.
const EDGE_COLORS: Record<string, string> = {
  calls: '#3987e5',
  references: '#10b981',
  extends: '#8b5cf6',
  implements: '#8b5cf6',
  instantiates: '#d98324',
  imports: '#898781',
  contains: '#898781'
}
const EDGE_COLOR_FALLBACK = '#898781'

// Edge kinds hidden by default: import edges dominate most neighborhoods while
// carrying the least insight per pixel. One chip click brings them back.
const DEFAULT_HIDDEN_EDGE_KINDS = ['imports']

function edgePath(fromX: number, fromY: number, toX: number, toY: number): string {
  const dx = Math.abs(toX - fromX)
  const c = Math.max(30, dx * 0.4)
  return `M ${fromX} ${fromY} C ${fromX + c} ${fromY}, ${toX - c} ${toY}, ${toX} ${toY}`
}

function edgeKey(e: CgEdge): string {
  return `${e.source}|${e.target}|${e.kind}`
}

// Concentric-ring placement that never overlaps: fill an inner ring to its arc
// capacity, then step outward. Returns offsets around (0,0), inner rings first.
// This is only the INITIAL guess — refineLayout untangles it afterwards.
function radialPositions(count: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = []
  let placed = 0
  let ring = 0
  while (placed < count) {
    const radius = RING_START + ring * RING_GAP
    const capacity = Math.max(1, Math.floor((2 * Math.PI * radius) / (NODE_W + NODE_GAP)))
    const n = Math.min(capacity, count - placed)
    for (let i = 0; i < n; i++) {
      const theta = (i / n) * Math.PI * 2 + ring * 0.6
      out.push({ x: Math.cos(theta) * radius, y: Math.sin(theta) * radius })
    }
    placed += n
    ring++
  }
  return out
}

// Force refinement: spring attraction along edges + pairwise repulsion, then a
// rectangle-separation sweep that guarantees no two node boxes overlap. Runs
// synchronously (n ≤ a few hundred → n² per iteration stays in the microsecond
// range) and mutates the passed positions in place. `pinnedId` stays fixed so
// the seed/expansion origin doesn't drift out from under the camera.
// `filePathById` adds weak star-topology springs between nodes of the same file,
// so files form visible clusters without explicit hulls.
function refineLayout(
  positions: Record<string, { x: number; y: number }>,
  edges: CgEdge[],
  pinnedId: string | null,
  filePathById?: Map<string, string>
): void {
  const ids = Object.keys(positions)
  const n = ids.length
  if (n <= 1) return
  const index = new Map(ids.map((id, i) => [id, i] as const))
  const px = ids.map((id) => positions[id].x)
  const py = ids.map((id) => positions[id].y)
  const pinned = pinnedId ? (index.get(pinnedId) ?? -1) : -1

  const springs: [number, number][] = []
  for (const e of edges) {
    const a = index.get(e.source)
    const b = index.get(e.target)
    if (a !== undefined && b !== undefined && a !== b) springs.push([a, b])
  }

  // Same-file cohesion: star springs to each file's first node (linear, not n²).
  const fileSprings: [number, number][] = []
  if (filePathById) {
    const anchorByFile = new Map<string, number>()
    for (const id of ids) {
      const fp = filePathById.get(id)
      if (!fp) continue
      const i = index.get(id)!
      const anchor = anchorByFile.get(fp)
      if (anchor === undefined) anchorByFile.set(fp, i)
      else fileSprings.push([anchor, i])
    }
  }

  const IDEAL = 235
  const ITERATIONS = 160
  for (let it = 0; it < ITERATIONS; it++) {
    const cool = 1 - it / ITERATIONS
    const dx = new Float64Array(n)
    const dy = new Float64Array(n)

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let ax = px[i] - px[j]
        let ay = py[i] - py[j]
        let d2 = ax * ax + ay * ay
        if (d2 < 1) {
          // Coincident nodes: deterministic nudge so they separate.
          ax = ((i % 7) - 3) * 0.5 + 0.25
          ay = ((j % 5) - 2) * 0.5 + 0.25
          d2 = ax * ax + ay * ay
        }
        const d = Math.sqrt(d2)
        const f = Math.min(14, (IDEAL * IDEAL) / d2)
        dx[i] += (ax / d) * f
        dy[i] += (ay / d) * f
        dx[j] -= (ax / d) * f
        dy[j] -= (ay / d) * f
      }
    }

    for (const [a, b] of springs) {
      const ax = px[b] - px[a]
      const ay = py[b] - py[a]
      const d = Math.sqrt(ax * ax + ay * ay) || 1
      const f = (d - IDEAL) * 0.02
      dx[a] += (ax / d) * f
      dy[a] += (ay / d) * f
      dx[b] -= (ax / d) * f
      dy[b] -= (ay / d) * f
    }

    // Weaker, shorter springs pull same-file nodes toward their anchor.
    for (const [a, b] of fileSprings) {
      const ax = px[b] - px[a]
      const ay = py[b] - py[a]
      const d = Math.sqrt(ax * ax + ay * ay) || 1
      const f = (d - IDEAL * 0.7) * 0.008
      dx[a] += (ax / d) * f
      dy[a] += (ay / d) * f
      dx[b] -= (ax / d) * f
      dy[b] -= (ay / d) * f
    }

    const cap = 20 * cool + 2
    for (let i = 0; i < n; i++) {
      if (i === pinned) continue
      const m = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i])
      if (m > cap) {
        dx[i] = (dx[i] / m) * cap
        dy[i] = (dy[i] / m) * cap
      }
      px[i] += dx[i]
      py[i] += dy[i]
    }
  }

  // Hard de-overlap: boxes are wide, so separate along the axis of least overlap.
  const padW = NODE_W + 28
  const padH = NODE_H + 22
  for (let pass = 0; pass < 40; pass++) {
    let moved = false
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const ox = padW - Math.abs(px[i] - px[j])
        const oy = padH - Math.abs(py[i] - py[j])
        if (ox <= 0 || oy <= 0) continue
        moved = true
        if (ox < oy) {
          const s = (px[i] < px[j] ? -1 : 1) * (ox / 2 + 0.5)
          if (i !== pinned) px[i] += s
          if (j !== pinned) px[j] -= s
        } else {
          const s = (py[i] < py[j] ? -1 : 1) * (oy / 2 + 0.5)
          if (i !== pinned) py[i] += s
          if (j !== pinned) py[j] -= s
        }
      }
    }
    if (!moved) break
  }

  ids.forEach((id, i) => {
    positions[id].x = px[i]
    positions[id].y = py[i]
  })
}

export function CodeGraphGraphView({
  root,
  seed
}: {
  root: string
  seed: { node?: CgNode; symbol?: string } | null
}): React.JSX.Element {
  const { t } = useTranslation('layout')
  const queryNeighbors = useCodeGraphStore((s) => s.queryNeighbors)
  const pickDefaultSeed = useCodeGraphStore((s) => s.pickDefaultSeed)
  const autoSeededRoot = useRef<string | null>(null)

  const containerRef = useRef<HTMLDivElement>(null)
  const [placed, setPlaced] = useState<Record<string, Placed>>({})
  const [edges, setEdges] = useState<CgEdge[]>([])
  const [camera, setCamera] = useState<Camera>({ scale: 1, x: 0, y: 0 })
  const [loading, setLoading] = useState(false)
  const [depth, setDepth] = useState(1)
  const [searchText, setSearchText] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [rootId, setRootId] = useState<string | null>(null)
  const [hiddenKinds, setHiddenKinds] = useState<Set<string>>(
    () => new Set(DEFAULT_HIDDEN_EDGE_KINDS)
  )
  const [hoverId, setHoverId] = useState<string | null>(null)
  // Click-pinned focus: survives mouse-out so dense neighborhoods stay readable
  // while you move toward them. Cleared by clicking the canvas background.
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const panRef = useRef<{ startX: number; startY: number; camX: number; camY: number } | null>(null)

  // Fit the camera so the whole node set is visible and centered.
  const fitToContent = useCallback((nodes: Placed[]) => {
    const el = containerRef.current
    const w = el?.clientWidth ?? 800
    const h = el?.clientHeight ?? 600
    if (nodes.length === 0) {
      setCamera({ scale: 1, x: w / 2, y: h / 2 })
      return
    }
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const n of nodes) {
      minX = Math.min(minX, n.x - NODE_W / 2)
      maxX = Math.max(maxX, n.x + NODE_W / 2)
      minY = Math.min(minY, n.y - NODE_H / 2)
      maxY = Math.max(maxY, n.y + NODE_H / 2)
    }
    const pad = 56
    const scale = Math.min(
      MAX_SCALE,
      Math.max(MIN_SCALE, Math.min(w / (maxX - minX + pad * 2), h / (maxY - minY + pad * 2)))
    )
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    setCamera({ scale, x: w / 2 - cx * scale, y: h / 2 - cy * scale })
  }, [])

  // Seed the graph from a symbol name or a node.
  const seedGraph = useCallback(
    async (params: { node?: CgNode; symbol?: string }) => {
      setLoading(true)
      try {
        const sub = await queryNeighbors(root, {
          symbol: params.symbol ?? params.node?.name,
          nodeId: params.node?.id,
          depth,
          limit: 48
        })
        const seedRootId = sub.roots[0] ?? params.node?.id ?? sub.nodes[0]?.id
        const rootNode = sub.nodes.find((n) => n.id === seedRootId) ?? params.node
        const others = sub.nodes.filter((n) => n.id !== rootNode?.id)
        const next: Record<string, Placed> = {}
        if (rootNode) next[rootNode.id] = { node: rootNode, x: 0, y: 0 }
        const pos = radialPositions(others.length)
        others.forEach((n, i) => {
          next[n.id] = { node: n, x: pos[i].x, y: pos[i].y }
        })
        refineLayout(
          next,
          sub.edges,
          rootNode?.id ?? null,
          new Map(Object.entries(next).map(([id, p]) => [id, p.node.filePath]))
        )
        setPlaced(next)
        setEdges(sub.edges)
        setRootId(rootNode?.id ?? null)
        setExpanded(new Set(rootNode ? [rootNode.id] : []))
        setSelectedId(null)
        setHoverId(null)
        fitToContent(Object.values(next))
      } finally {
        setLoading(false)
      }
    },
    [queryNeighbors, root, depth, fitToContent]
  )

  useEffect(() => {
    if (seed && (seed.node || seed.symbol)) void seedGraph(seed)
    // Only re-seed when the seed identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed])

  // Default project graph: with no explicit seed, auto-seed from the largest
  // file's top symbol so opening the graph tab shows something meaningful
  // instead of an empty canvas. Runs once per project root.
  useEffect(() => {
    if (seed && (seed.node || seed.symbol)) return
    if (autoSeededRoot.current === root) return
    autoSeededRoot.current = root
    let cancelled = false
    void (async () => {
      setLoading(true)
      const node = await pickDefaultSeed(root)
      if (cancelled) return
      if (node) await seedGraph({ node })
      else setLoading(false)
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, seed])

  const expandNode = useCallback(
    async (id: string) => {
      const origin = placed[id]
      if (!origin || expanded.has(id)) return
      setExpanded((prev) => new Set(prev).add(id))
      setLoading(true)
      try {
        const sub = await queryNeighbors(root, { nodeId: id, depth: 1, limit: 32 })
        const next = { ...placed }
        const fresh = sub.nodes.filter((n) => !next[n.id])
        const pos = radialPositions(fresh.length)
        fresh.forEach((n, i) => {
          next[n.id] = { node: n, x: origin.x + pos[i].x * 0.7, y: origin.y + pos[i].y * 0.7 }
        })
        const seen = new Set(edges.map(edgeKey))
        const mergedEdges = [...edges]
        for (const e of sub.edges) {
          if (!seen.has(edgeKey(e))) {
            seen.add(edgeKey(e))
            mergedEdges.push(e)
          }
        }
        refineLayout(
          next,
          mergedEdges,
          id,
          new Map(Object.entries(next).map(([nid, p]) => [nid, p.node.filePath]))
        )
        setPlaced(next)
        setEdges(mergedEdges)
        fitToContent(Object.values(next))
      } finally {
        setLoading(false)
      }
    },
    [placed, edges, expanded, queryNeighbors, root, fitToContent]
  )

  // Pan. A background press also clears the pinned focus (node buttons stop
  // propagation on mousedown, so this only fires for the canvas itself).
  const onMouseDown = (e: React.MouseEvent): void => {
    if (e.button !== 0) return
    setSelectedId(null)
    panRef.current = { startX: e.clientX, startY: e.clientY, camX: camera.x, camY: camera.y }
  }
  const onMouseMove = (e: React.MouseEvent): void => {
    const pan = panRef.current
    if (!pan) return
    setCamera((c) => ({
      ...c,
      x: pan.camX + (e.clientX - pan.startX),
      y: pan.camY + (e.clientY - pan.startY)
    }))
  }
  const endPan = (): void => {
    panRef.current = null
  }

  // Zoom at cursor.
  const onWheel = (e: React.WheelEvent): void => {
    const el = containerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const px = e.clientX - rect.left
    const py = e.clientY - rect.top
    setCamera((c) => {
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, c.scale * factor))
      const k = scale / c.scale
      return { scale, x: px - (px - c.x) * k, y: py - (py - c.y) * k }
    })
  }

  const zoomBy = (factor: number): void => {
    const el = containerRef.current
    const w = el?.clientWidth ?? 800
    const h = el?.clientHeight ?? 600
    setCamera((c) => {
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, c.scale * factor))
      const k = scale / c.scale
      return { scale, x: w / 2 - (w / 2 - c.x) * k, y: h / 2 - (h / 2 - c.y) * k }
    })
  }

  const submitSearch = (): void => {
    const q = searchText.trim()
    if (q) void seedGraph({ symbol: q })
  }

  const toggleKind = (kind: string): void => {
    setHiddenKinds((prev) => {
      const next = new Set(prev)
      if (next.has(kind)) next.delete(kind)
      else next.add(kind)
      return next
    })
  }

  // Legend chips: every kind present in the loaded edges, with counts, toggleable.
  const kindCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const e of edges) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [edges])

  const visibleEdges = useMemo(
    () => edges.filter((e) => !hiddenKinds.has(e.kind)),
    [edges, hiddenKinds]
  )

  // A node stays visible while it has at least one visible edge; the seed root
  // and explicitly expanded nodes always stay (they're the user's anchors).
  const visibleIds = useMemo(() => {
    const s = new Set<string>()
    for (const e of visibleEdges) {
      s.add(e.source)
      s.add(e.target)
    }
    if (rootId) s.add(rootId)
    for (const id of expanded) s.add(id)
    return s
  }, [visibleEdges, rootId, expanded])

  // Focus: hover is transient, click pins. The focused node + its direct
  // neighbors stay crisp, everything else fades so a dense neighborhood reads
  // at a glance.
  const focusId = hoverId ?? selectedId
  const focusNeighbors = useMemo(() => {
    if (!focusId) return null
    const s = new Set<string>([focusId])
    for (const e of visibleEdges) {
      if (e.source === focusId) s.add(e.target)
      if (e.target === focusId) s.add(e.source)
    }
    return s
  }, [focusId, visibleEdges])

  const nodeList = Object.values(placed)
  const visibleNodeList = nodeList.filter((p) => visibleIds.has(p.node.id))
  const hasGraph = nodeList.length > 0

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-2 border-b p-2">
        <div className="relative w-72 max-w-full">
          <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitSearch()
            }}
            placeholder={t('codegraphPage.graph.searchPlaceholder')}
            className="w-full rounded-md border bg-background py-1.5 pl-7 pr-2 text-xs outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
          {t('codegraphPage.graph.depth')}
          <select
            value={depth}
            onChange={(e) => setDepth(Number(e.target.value))}
            className="rounded border bg-background px-1 py-0.5 text-xs"
          >
            <option value={1}>1</option>
            <option value={2}>2</option>
            <option value={3}>3</option>
          </select>
        </label>
        <div className="flex-1" />
        {hasGraph ? (
          <span className="text-[11px] text-muted-foreground">
            {t('codegraphPage.graph.nodesEdges', {
              nodes: visibleNodeList.length,
              edges: visibleEdges.length
            })}
          </span>
        ) : null}
        {loading ? <Spinner className="size-4 text-muted-foreground" /> : null}
        <Button variant="outline" size="icon" className="size-7" onClick={() => zoomBy(1.1)}>
          <Plus className="size-3.5" />
        </Button>
        <Button variant="outline" size="icon" className="size-7" onClick={() => zoomBy(1 / 1.1)}>
          <Minus className="size-3.5" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="size-7"
          onClick={() => hasGraph && fitToContent(visibleNodeList)}
        >
          <RotateCcw className="size-3.5" />
        </Button>
      </div>

      {/* Edge-kind legend + filter chips */}
      {hasGraph && kindCounts.length > 0 ? (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b px-2 py-1.5">
          {kindCounts.map(([kind, count]) => {
            const active = !hiddenKinds.has(kind)
            const color = EDGE_COLORS[kind] ?? EDGE_COLOR_FALLBACK
            return (
              <button
                key={kind}
                onClick={() => toggleKind(kind)}
                title={`${kind}: ${count}`}
                className={cn(
                  'flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] transition-colors',
                  active
                    ? 'border-border bg-background text-foreground'
                    : 'border-transparent bg-muted/40 text-muted-foreground/60 line-through'
                )}
              >
                <span
                  className="size-2 rounded-full"
                  style={{ backgroundColor: color, opacity: active ? 1 : 0.35 }}
                />
                {kind}
                <span className="text-muted-foreground">{count}</span>
              </button>
            )
          })}
          <span className="ml-auto text-[10px] text-muted-foreground/70">
            {t('codegraphPage.graph.interactionHint')}
          </span>
        </div>
      ) : null}

      {/* Canvas */}
      <div
        ref={containerRef}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={endPan}
        onMouseLeave={endPan}
        onWheel={onWheel}
        className="relative min-h-0 flex-1 cursor-grab overflow-hidden bg-muted/10 active:cursor-grabbing"
      >
        {!hasGraph ? (
          <div className="flex h-full items-center justify-center px-6 text-center">
            <p className="max-w-sm text-sm text-muted-foreground">
              {loading ? t('codegraphPage.graph.loading') : t('codegraphPage.graph.seedHint')}
            </p>
          </div>
        ) : (
          <>
            {/* Edges */}
            <svg className="pointer-events-none absolute inset-0 h-full w-full">
              {visibleEdges.map((e) => {
                const a = placed[e.source]
                const b = placed[e.target]
                if (!a || !b) return null
                const ax = a.x * camera.scale + camera.x
                const ay = a.y * camera.scale + camera.y
                const bx = b.x * camera.scale + camera.x
                const by = b.y * camera.scale + camera.y
                const heuristic = e.provenance === 'heuristic'
                const incident = focusId !== null && (e.source === focusId || e.target === focusId)
                const dimmed = focusId !== null && !incident
                const color = EDGE_COLORS[e.kind] ?? EDGE_COLOR_FALLBACK
                const opacity = dimmed ? 0.08 : incident ? 0.9 : 0.45
                // Direction marker at the curve midpoint (endpoints hide under the
                // node boxes). With edgePath's control points the midpoint is the
                // plain average; the tangent there is (bx-ax-c, by-ay).
                const c = Math.max(30, Math.abs(bx - ax) * 0.4)
                const angle = (Math.atan2(by - ay, bx - ax - c) * 180) / Math.PI
                return (
                  <g key={edgeKey(e)}>
                    <path
                      d={edgePath(ax, ay, bx, by)}
                      fill="none"
                      stroke={color}
                      strokeOpacity={opacity}
                      strokeWidth={incident ? 2 : 1.5}
                      strokeDasharray={heuristic ? '4 3' : undefined}
                    />
                    <polygon
                      points="-2.5,-3.5 5,0 -2.5,3.5"
                      transform={`translate(${(ax + bx) / 2} ${(ay + by) / 2}) rotate(${angle})`}
                      fill={color}
                      fillOpacity={opacity}
                    />
                  </g>
                )
              })}
            </svg>

            {/* Nodes */}
            {visibleNodeList.map(({ node, x, y }) => {
              const sx = x * camera.scale + camera.x
              const sy = y * camera.scale + camera.y
              const accent = KIND_COLORS[node.kind] ?? 'border-l-muted-foreground'
              const isRoot = node.id === rootId
              const isSelected = node.id === selectedId
              const dimmed = focusNeighbors !== null && !focusNeighbors.has(node.id)
              const baseName = node.filePath.split(/[\\/]/).pop() ?? node.filePath
              return (
                <button
                  key={node.id}
                  onMouseDown={(e) => e.stopPropagation()}
                  onMouseEnter={() => setHoverId(node.id)}
                  onMouseLeave={() => setHoverId(null)}
                  onClick={() => {
                    setSelectedId(node.id)
                    void expandNode(node.id)
                  }}
                  onDoubleClick={() => void seedGraph({ node })}
                  title={`${node.kind} · ${node.filePath}:${node.startLine}`}
                  style={{
                    left: sx - NODE_W / 2,
                    top: sy - NODE_H / 2,
                    width: NODE_W,
                    height: NODE_H,
                    opacity: dimmed ? 0.25 : 1
                  }}
                  className={cn(
                    'absolute flex flex-col justify-center overflow-hidden rounded-md border border-l-4 bg-card px-2 text-left shadow-sm transition-[opacity,colors] hover:border-primary hover:bg-accent',
                    accent,
                    isRoot
                      ? 'ring-2 ring-primary/60 shadow-md'
                      : isSelected
                        ? 'ring-2 ring-primary/50'
                        : expanded.has(node.id) && 'ring-1 ring-primary/40'
                  )}
                >
                  <span className="truncate text-[11px] font-medium leading-tight">
                    {node.name}
                  </span>
                  <span className="truncate text-[9px] text-muted-foreground leading-tight">
                    {node.kind} · {baseName}
                  </span>
                </button>
              )
            })}
          </>
        )}
      </div>
    </div>
  )
}
