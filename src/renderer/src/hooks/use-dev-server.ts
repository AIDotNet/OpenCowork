import { useState, useCallback, useEffect, useRef } from 'react'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'

export function useDevServer(projectDir: string | null) {
  const [processId, setProcessId] = useState<string | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const [port, setPort] = useState<number | undefined>()
  const [logs, setLogs] = useState<string[]>([])
  const cleanupRef = useRef<(() => void) | null>(null)

  const start = useCallback(async (command: string) => {
    if (!projectDir) return
    try {
      const result = await ipcClient.invoke(IPC.PROCESS_SPAWN, { command, cwd: projectDir }) as { id: string }
      setProcessId(result.id)
      setIsRunning(true)
      setLogs([])
    } catch (err) {
      console.error('[useDevServer] Failed to spawn:', err)
    }
  }, [projectDir])

  const stop = useCallback(async () => {
    if (!processId) return
    try {
      await ipcClient.invoke(IPC.PROCESS_KILL, { id: processId })
    } catch {
      // ignore
    }
    setProcessId(null)
    setIsRunning(false)
    setPort(undefined)
  }, [processId])

  // Listen for process output
  useEffect(() => {
    if (!processId) return

    const handler = (...args: unknown[]) => {
      const data = args[1] as { id: string; data: string; port?: number; exited?: boolean } | undefined
      if (!data || data.id !== processId) return
      setLogs((prev) => [...prev.slice(-200), data.data])
      if (data.port) setPort(data.port)
      if (data.exited) {
        setIsRunning(false)
        setProcessId(null)
      }
    }

    const cleanup = ipcClient.on(IPC.PROCESS_OUTPUT, handler)
    cleanupRef.current = cleanup

    return () => {
      cleanup()
      cleanupRef.current = null
    }
  }, [processId])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (processId) {
        ipcClient.invoke(IPC.PROCESS_KILL, { id: processId }).catch(() => {})
      }
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return { isRunning, port, logs, start, stop }
}
