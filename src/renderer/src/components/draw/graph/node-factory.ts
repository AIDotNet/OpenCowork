import { nanoid } from 'nanoid'
import {
  NODE_DEFAULT_SIZE,
  type CanvasNode,
  type CanvasNodeKind,
  type ConfigNodeData
} from './graph-types'

/** Create a node of `kind` centered on a world-space point. */
export function createCanvasNode(
  kind: CanvasNodeKind,
  world: { x: number; y: number },
  configMode: ConfigNodeData['mode'] = 'image'
): CanvasNode {
  const size = NODE_DEFAULT_SIZE[kind]
  const base = {
    id: nanoid(),
    x: Math.round(world.x - size.w / 2),
    y: Math.round(world.y - size.h / 2),
    w: size.w,
    h: size.h
  }
  if (kind === 'text') return { ...base, kind: 'text', data: { text: '' } }
  if (kind === 'image') return { ...base, kind: 'image', data: {} }
  if (kind === 'video') return { ...base, kind: 'video', data: {} }
  if (configMode === 'image') {
    return { ...base, kind: 'config', data: { mode: 'image', aspect: '1:1', count: 1 } }
  }
  if (configMode === 'video') {
    return { ...base, kind: 'config', data: { mode: 'video', aspect: '16:9' } }
  }
  return { ...base, kind: 'config', data: { mode: 'text' } }
}
