import { createContext, useContext } from 'react'
import type { ImageSize } from '@renderer/lib/image-mask'
import type { NodeExecutionSnapshot, NodeExecutionStatus } from './graph-types'

export interface CanvasRunResult {
  ok: boolean
  runId?: string
  nodeId?: string
  outputNodeIds: string[]
  status: NodeExecutionStatus
  error?: string
}

export interface GraphEditParams {
  /** Optional for whole-image edits; required only for masked inpaint/outpaint. */
  maskDataUrl?: string
  prompt: string
  sourceSize: ImageSize
  baseImageDataUrl?: string
  /** Model chosen in the edit toolbar; falls back to the source node's model. */
  providerId?: string
  modelId?: string
}

/** Generation/edit actions wired by the DrawPage shell to graph nodes. */
export interface GraphActions {
  /** Run a config node: read upstream text/images, generate into new image/text nodes. */
  runConfigNode: (configNodeId: string) => Promise<CanvasRunResult>
  /** From a text node: create a connected config node and run it. */
  generateFromText: (textNodeId: string) => Promise<CanvasRunResult>
  /** Optimize/rewrite a text node's content via the chat text model. */
  rewriteText: (textNodeId: string) => Promise<void>
  /** Generate directly into an image node (uses its own content as reference if present). */
  generateImageNode: (imageNodeId: string) => Promise<CanvasRunResult>
  /** Generate (or regenerate) a video node from its upstream text/image context. */
  generateVideoNode: (videoNodeId: string) => Promise<CanvasRunResult>
  /** Dispatch the appropriate operation for any executable node kind. */
  runNode: (nodeId: string) => Promise<CanvasRunResult>
  cancelNode: (nodeId: string) => Promise<boolean>
  retryNode: (nodeId: string) => Promise<CanvasRunResult>
  getNodeStatus: (nodeId: string) => NodeExecutionSnapshot | null
  /** Apply a whole-image or masked edit; result lands in a new connected image node. */
  applyEdit: (imageNodeId: string, params: GraphEditParams) => Promise<CanvasRunResult>
  /** Persist a locally-processed image (crop/transform/upscale) into a new connected node. */
  addDerivedImage: (
    sourceNodeId: string,
    dataUrl: string,
    opts?: { prompt?: string; select?: boolean }
  ) => Promise<string | null>
  downloadImage: (imageNodeId: string) => Promise<void>
}

const GraphActionsContext = createContext<GraphActions | null>(null)

export const GraphActionsProvider = GraphActionsContext.Provider

export function useGraphActions(): GraphActions {
  const value = useContext(GraphActionsContext)
  if (!value) throw new Error('useGraphActions must be used within GraphActionsProvider')
  return value
}
