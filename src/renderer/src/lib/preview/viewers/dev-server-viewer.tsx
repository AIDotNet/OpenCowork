import { useState, useRef, useEffect } from 'react'
import { Play, Square, RefreshCw, Terminal } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import type { ViewerProps } from '../viewer-registry'

interface DevServerViewerProps extends ViewerProps {
  port?: number
  isRunning?: boolean
  logs?: string[]
  onStart?: () => void
  onStop?: () => void
}

export function DevServerViewer({ port, isRunning, logs = [], onStart, onStop }: DevServerViewerProps): React.JSX.Element {
  const [showLogs, setShowLogs] = useState(false)
  const [iframeKey, setIframeKey] = useState(0)
  const logsEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (showLogs && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [logs, showLogs])

  const url = port ? `http://localhost:${port}` : ''

  return (
    <div className="flex size-full flex-col">
      {/* Toolbar */}
      <div className="flex h-8 items-center gap-1 border-b px-2">
        {isRunning ? (
          <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-xs text-red-500" onClick={onStop}>
            <Square className="size-3" /> Stop
          </Button>
        ) : (
          <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-xs text-green-500" onClick={onStart}>
            <Play className="size-3" /> Start
          </Button>
        )}
        {port && (
          <>
            <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-xs" onClick={() => setIframeKey((k) => k + 1)}>
              <RefreshCw className="size-3" /> Refresh
            </Button>
            <span className="text-[10px] text-muted-foreground">:{port}</span>
          </>
        )}
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          className={`h-6 gap-1 px-2 text-xs ${showLogs ? 'bg-muted' : ''}`}
          onClick={() => setShowLogs(!showLogs)}
        >
          <Terminal className="size-3" /> Logs
        </Button>
      </div>

      {/* Content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Iframe */}
        <div className={`flex-1 ${showLogs ? 'border-r' : ''}`}>
          {port ? (
            <iframe
              key={iframeKey}
              src={url}
              className="size-full border-0 bg-white"
              title="Dev Server Preview"
            />
          ) : (
            <div className="flex size-full items-center justify-center text-sm text-muted-foreground">
              {isRunning ? 'Waiting for server to start...' : 'Click Start to launch dev server'}
            </div>
          )}
        </div>

        {/* Logs panel */}
        {showLogs && (
          <div className="w-80 overflow-auto bg-zinc-950 p-2 font-mono text-[11px] text-zinc-400">
            {logs.map((line, i) => (
              <div key={i} className="whitespace-pre-wrap break-all">{line}</div>
            ))}
            <div ref={logsEndRef} />
          </div>
        )}
      </div>
    </div>
  )
}
