import { memo, useMemo } from 'react'
import { cn } from '@renderer/lib/utils'
import { edgePath, inputPortWorld, outputPortWorld, worldToScreen } from './graph-geometry'
import { downstreamNodeIds, upstreamNodeIds, useGraphStore, type Camera } from './graph-store'
import type { CanvasEdge, CanvasNode } from './graph-types'
import { useConnection } from './connection-context'

interface EdgeItemProps {
  edge: CanvasEdge
  source: CanvasNode
  target: CanvasNode
  camera: Camera
  isRelated: boolean
  isSelected: boolean
}

/**
 * One edge (hit path + visible path + midpoint delete button). Memoized so a
 * node drag only re-renders the edges attached to the moving node — untouched
 * nodes keep their object identity across store updates.
 */
const EdgeItem = memo(function EdgeItem({
  edge,
  source,
  target,
  camera,
  isRelated,
  isSelected
}: EdgeItemProps): React.JSX.Element {
  const selectEdge = useGraphStore((s) => s.selectEdge)
  const removeEdge = useGraphStore((s) => s.removeEdge)
  const from = worldToScreen(outputPortWorld(source), camera)
  const to = worldToScreen(inputPortWorld(target), camera)
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }
  return (
    <g className="group/edge">
      <path
        d={edgePath(from, to)}
        className="pointer-events-auto cursor-pointer"
        stroke="transparent"
        strokeWidth={16}
        fill="none"
        onMouseDown={(event) => {
          event.stopPropagation()
          selectEdge(edge.id, event.shiftKey)
        }}
      />
      <path
        d={edgePath(from, to)}
        fill="none"
        strokeWidth={isSelected || isRelated ? 2.5 : 1.75}
        stroke={isSelected || isRelated ? 'var(--primary)' : 'var(--border)'}
        strokeOpacity={isRelated && !isSelected ? 0.7 : 1}
      />
      {/* midpoint delete button — appears on hover / when selected */}
      <g
        className={cn(
          'pointer-events-auto cursor-pointer transition-opacity',
          isSelected ? 'opacity-100' : 'opacity-0 group-hover/edge:opacity-100'
        )}
        onMouseDown={(event) => {
          event.stopPropagation()
          removeEdge(edge.id)
        }}
      >
        <circle cx={mid.x} cy={mid.y} r={9} fill="var(--background)" stroke="var(--border)" />
        <path
          d={`M ${mid.x - 3.2} ${mid.y - 3.2} L ${mid.x + 3.2} ${mid.y + 3.2} M ${mid.x + 3.2} ${mid.y - 3.2} L ${mid.x - 3.2} ${mid.y + 3.2}`}
          stroke="var(--destructive)"
          strokeWidth={1.6}
          strokeLinecap="round"
        />
      </g>
    </g>
  )
})

/**
 * Edges are drawn in SCREEN space in a full-container SVG (rendered beneath the
 * nodes). Doing this — rather than a zero-size SVG inside the transformed world —
 * avoids the SVG viewport clipping its own paths.
 */
export function EdgeLayer(): React.JSX.Element {
  const nodes = useGraphStore((s) => s.nodes)
  const edges = useGraphStore((s) => s.edges)
  const camera = useGraphStore((s) => s.camera)
  const selection = useGraphStore((s) => s.selection)
  const selectedEdges = useGraphStore((s) => s.selectedEdges)
  const { pending } = useConnection()

  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])

  const related = useMemo(() => {
    if (selection.length !== 1) return null
    const id = selection[0]
    return {
      id,
      up: new Set(upstreamNodeIds(edges, id)),
      down: new Set(downstreamNodeIds(edges, id))
    }
  }, [edges, selection])

  const pendingFrom = pending ? nodeById.get(pending.sourceId) : undefined

  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full">
      {edges.map((edge) => {
        const source = nodeById.get(edge.source)
        const target = nodeById.get(edge.target)
        if (!source || !target) return null
        return (
          <EdgeItem
            key={edge.id}
            edge={edge}
            source={source}
            target={target}
            camera={camera}
            isRelated={!!related && (edge.source === related.id || edge.target === related.id)}
            isSelected={selectedEdges.includes(edge.id)}
          />
        )
      })}

      {pending && pendingFrom && (
        <path
          d={edgePath(
            worldToScreen(outputPortWorld(pendingFrom), camera),
            worldToScreen(pending.cursor, camera)
          )}
          fill="none"
          strokeWidth={2}
          strokeDasharray="5 4"
          className="stroke-primary"
        />
      )}
    </svg>
  )
}
