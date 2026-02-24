import * as React from 'react'
import { ZoomIn, ZoomOut, RotateCw, Maximize2, ImageOff } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import type { ViewerProps } from '../viewer-registry'

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

function getMimeType(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
  return MIME_TYPES[ext] || 'application/octet-stream'
}

export function ImageViewer({ filePath }: ViewerProps): React.JSX.Element {
  const [scale, setScale] = React.useState(1)
  const [rotation, setRotation] = React.useState(0)
  const [src, setSrc] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    let objectUrl: string | null = null

    ipcClient.invoke(IPC.FS_READ_FILE_BINARY, { path: filePath }).then((raw: unknown) => {
      if (cancelled) return
      const result = raw as { data?: string; error?: string }
      if (result.error || !result.data) {
        setError(result.error || 'Failed to read image file')
        return
      }
      try {
        const byteString = atob(result.data)
        const bytes = new Uint8Array(byteString.length)
        for (let i = 0; i < byteString.length; i++) bytes[i] = byteString.charCodeAt(i)
        const blob = new Blob([bytes], { type: getMimeType(filePath) })
        objectUrl = URL.createObjectURL(blob)
        if (!cancelled) setSrc(objectUrl)
      } catch (err) {
        if (!cancelled) setError(String(err))
      }
    })

    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [filePath])

  const zoomIn = () => setScale((s) => Math.min(s + 0.25, 5))
  const zoomOut = () => setScale((s) => Math.max(s - 0.25, 0.25))
  const rotate = () => setRotation((r) => (r + 90) % 360)
  const resetView = () => { setScale(1); setRotation(0) }

  if (error) {
    return (
      <div className="flex size-full items-center justify-center gap-2 text-sm text-destructive">
        <ImageOff className="size-5" />
        {error}
      </div>
    )
  }

  if (!src) {
    return (
      <div className="flex size-full items-center justify-center gap-2 text-sm text-muted-foreground">
        Loading image...
      </div>
    )
  }

  return (
    <div className="flex size-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-1 border-b px-3 py-1">
        <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-[10px]" onClick={zoomOut}>
          <ZoomOut className="size-3" />
        </Button>
        <span className="text-[10px] text-muted-foreground min-w-[3rem] text-center">
          {Math.round(scale * 100)}%
        </span>
        <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-[10px]" onClick={zoomIn}>
          <ZoomIn className="size-3" />
        </Button>
        <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-[10px]" onClick={rotate}>
          <RotateCw className="size-3" />
        </Button>
        <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-[10px]" onClick={resetView}>
          <Maximize2 className="size-3" />
        </Button>
        <div className="flex-1" />
        <span className="text-[10px] text-muted-foreground/50 truncate">{filePath.split(/[\\/]/).pop()}</span>
      </div>

      {/* Image display */}
      <div className="flex-1 overflow-auto flex items-center justify-center bg-[repeating-conic-gradient(hsl(var(--muted))_0%_25%,transparent_0%_50%)] bg-[length:16px_16px]">
        <img
          src={src}
          alt={filePath.split(/[\\/]/).pop() || ''}
          className="max-w-none transition-transform duration-200"
          style={{
            transform: `scale(${scale}) rotate(${rotation}deg)`,
          }}
          draggable={false}
        />
      </div>
    </div>
  )
}
