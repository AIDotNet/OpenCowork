import { IPC } from '@renderer/lib/ipc/channels'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { useGraphStore } from './graph-store'
import { useProjectsStore } from './draw-projects-store'
import { patchPersistedProjectGraph } from './graph-persistence'
import { createCanvasNode } from './node-factory'
import type { CanvasNode } from './graph-types'

/** Read a File/Blob as a data URL. */
export function fileToDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

/**
 * Persist a pasted/dropped image to disk and drop an image node at `world`.
 * Falls back to the inline data URL if persistence fails.
 */
export async function addImageNodeFromDataUrl(
  dataUrl: string,
  world: { x: number; y: number },
  projectId = useProjectsStore.getState().activeProjectId ?? 'default'
): Promise<string> {
  const comma = dataUrl.indexOf(',')
  const data = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
  const mediaType = /data:(.*?);/.exec(dataUrl)?.[1] || 'image/png'

  let src = dataUrl
  let filePath: string | undefined
  try {
    const res = (await ipcClient.invoke(IPC.IMAGE_PERSIST_GENERATED, { data, mediaType })) as {
      filePath?: string
      mediaType?: string
      data?: string
      error?: string
    }
    if (res?.data && !res.error) {
      src = `data:${res.mediaType || mediaType};base64,${res.data}`
      filePath = res.filePath
    }
  } catch {
    // keep inline data URL
  }

  const base = createCanvasNode('image', world)
  const node: CanvasNode = { ...base, kind: 'image', data: { src, filePath, mediaType } }
  if ((useProjectsStore.getState().activeProjectId ?? 'default') === projectId) {
    useGraphStore.getState().addNode(node, { select: true })
  } else {
    patchPersistedProjectGraph(projectId, (stored) => ({
      ...stored,
      nodes: [
        ...stored.nodes,
        {
          ...node,
          selected: undefined,
          data: {
            ...node.data,
            src: node.data.src?.startsWith('data:') ? undefined : node.data.src
          }
        }
      ]
    }))
  }
  return node.id
}

/** Extract image files from a clipboard or drag data-transfer. */
export function imageFilesFromTransfer(dt: DataTransfer | null): File[] {
  if (!dt) return []
  const files: File[] = []
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile()
      if (file) files.push(file)
    }
  }
  if (files.length === 0) {
    for (const file of Array.from(dt.files ?? [])) {
      if (file.type.startsWith('image/')) files.push(file)
    }
  }
  return files
}
