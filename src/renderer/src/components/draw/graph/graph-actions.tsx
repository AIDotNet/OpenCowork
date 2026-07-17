import { createContext, useContext } from 'react'
import type { ImageSize } from '@renderer/lib/image-mask'

export interface GraphEditParams {
  maskDataUrl: string
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
  runConfigNode: (configNodeId: string) => void
  /** From a text node: create a connected config node and run it. */
  generateFromText: (textNodeId: string) => void
  /** Optimize/rewrite a text node's content via the chat text model. */
  rewriteText: (textNodeId: string) => Promise<void>
  /** Generate directly into an image node (uses its own content as reference if present). */
  generateImageNode: (imageNodeId: string) => void
  /** Generate (or regenerate) a video node from its upstream text/image context. */
  generateVideoNode: (videoNodeId: string) => void
  /** Apply an inpaint/outpaint edit; result lands in a new connected image node. */
  applyEdit: (imageNodeId: string, params: GraphEditParams) => void
  /** Persist a locally-processed image (crop/transform/upscale) into a new connected node. */
  addDerivedImage: (
    sourceNodeId: string,
    dataUrl: string,
    opts?: { prompt?: string; select?: boolean }
  ) => void
  downloadImage: (imageNodeId: string) => void
}

const GraphActionsContext = createContext<GraphActions | null>(null)

export const GraphActionsProvider = GraphActionsContext.Provider

export function useGraphActions(): GraphActions {
  const value = useContext(GraphActionsContext)
  if (!value) throw new Error('useGraphActions must be used within GraphActionsProvider')
  return value
}
