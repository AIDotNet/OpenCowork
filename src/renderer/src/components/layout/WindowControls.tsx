import { useState, useEffect } from 'react'
import { Minus, Square, X, Copy } from 'lucide-react'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'

export function WindowControls(): React.JSX.Element {
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    // Get initial state
    ipcClient.invoke('window:isMaximized').then((val) => setIsMaximized(val as boolean))

    // Listen for maximize state changes from main process
    const unsub = ipcClient.on('window:maximized', (maximized: unknown) => {
      setIsMaximized(maximized as boolean)
    })
    return unsub
  }, [])

  return (
    <div className="titlebar-no-drag flex items-center">
      {/* Minimize */}
      <button
        onClick={() => ipcClient.invoke('window:minimize')}
        className="flex h-10 w-11 items-center justify-center text-foreground/60 transition-colors hover:bg-foreground/10 hover:text-foreground"
        aria-label="Minimize"
      >
        <Minus className="size-4" />
      </button>

      {/* Maximize / Restore */}
      <button
        onClick={() => ipcClient.invoke('window:maximize')}
        className="flex h-10 w-11 items-center justify-center text-foreground/60 transition-colors hover:bg-foreground/10 hover:text-foreground"
        aria-label={isMaximized ? 'Restore' : 'Maximize'}
      >
        {isMaximized ? <Copy className="size-3.5 -scale-x-100" /> : <Square className="size-3" />}
      </button>

      {/* Close */}
      <button
        onClick={() => ipcClient.invoke('window:close')}
        className="flex h-10 w-11 items-center justify-center text-foreground/60 transition-colors hover:bg-red-500 hover:text-white"
        aria-label="Close"
      >
        <X className="size-4" />
      </button>
    </div>
  )
}
