import * as React from 'react'
import { ZoomIn, ZoomOut, RotateCw, Maximize2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import type { ViewerProps } from '../viewer-registry'

export function ImageViewer({ filePath }: ViewerProps): React.JSX.Element {
  const [scale, setScale] = React.useState(1)
  const [rotation, setRotation] = React.useState(0)

  const src = `file://${filePath}`

  const zoomIn = () => setScale((s) => Math.min(s + 0.25, 5))
  const zoomOut = () => setScale((s) => Math.max(s - 0.25, 0.25))
  const rotate = () => setRotation((r) => (r + 90) % 360)
  const resetView = () => { setScale(1); setRotation(0) }

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
