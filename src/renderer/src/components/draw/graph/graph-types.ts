/**
 * Node-graph model for the draw canvas. A graph is a set of typed nodes wired
 * by edges (left = input, right = output). Config nodes read their upstream
 * text/image nodes and generate results into image/text nodes.
 */

export type CanvasNodeKind = 'text' | 'image' | 'config' | 'video'

export interface NodeBox {
  id: string
  x: number
  y: number
  w: number
  h: number
}

export interface TextNodeData {
  text: string
  fontScale?: number
}

export interface ImageNodeData {
  src?: string
  filePath?: string
  mediaType?: string
  /** prompt/meta captured at generation for retry. */
  prompt?: string
  providerId?: string
  modelId?: string
  generating?: boolean
  error?: string
  /** generation was cut off (stop / app restart) before producing a result. */
  interrupted?: boolean
  /** children of an image-group (batch) result. */
  groupSrcs?: Array<{ src: string; filePath?: string; mediaType?: string }>
}

export interface ConfigNodeData {
  mode: 'image' | 'text' | 'video'
  providerId?: string
  modelId?: string
  aspect?: string
  count?: number
  quality?: string
  // video (Seedance) params
  resolution?: string
  duration?: number
  fps?: number
  watermark?: boolean
}

export interface VideoNodeData {
  src?: string
  filePath?: string
  poster?: string
  mediaType?: string
  prompt?: string
  providerId?: string
  modelId?: string
  generating?: boolean
  status?: string
  error?: string
  /** generation was cut off (stop / app restart) before producing a result. */
  interrupted?: boolean
  /** Background generation job id (main-process). */
  jobId?: string
}

interface BaseNode extends NodeBox {
  selected?: boolean
}

export interface TextNode extends BaseNode {
  kind: 'text'
  data: TextNodeData
}

export interface ImageNode extends BaseNode {
  kind: 'image'
  data: ImageNodeData
}

export interface ConfigNode extends BaseNode {
  kind: 'config'
  data: ConfigNodeData
}

export interface VideoNode extends BaseNode {
  kind: 'video'
  data: VideoNodeData
}

export type CanvasNode = TextNode | ImageNode | ConfigNode | VideoNode

export interface CanvasEdge {
  id: string
  source: string
  target: string
}

export interface CanvasGraph {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
}

export type BackgroundMode = 'dots' | 'grid' | 'blank'

export const NODE_DEFAULT_SIZE: Record<CanvasNodeKind, { w: number; h: number }> = {
  text: { w: 280, h: 160 },
  image: { w: 320, h: 320 },
  config: { w: 300, h: 268 },
  video: { w: 360, h: 240 }
}

export const NODE_MIN_SIZE = { w: 140, h: 100 }

export function isTextNode(node: CanvasNode): node is TextNode {
  return node.kind === 'text'
}
export function isImageNode(node: CanvasNode): node is ImageNode {
  return node.kind === 'image'
}
export function isConfigNode(node: CanvasNode): node is ConfigNode {
  return node.kind === 'config'
}
