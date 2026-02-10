import { useState, useEffect, useCallback } from 'react'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'

export function useFileWatcher(filePath: string | null) {
  const [content, setContent] = useState<string>('')
  const [loading, setLoading] = useState(false)

  const loadContent = useCallback(async () => {
    if (!filePath) return
    setLoading(true)
    try {
      const result = await ipcClient.invoke(IPC.FS_READ_FILE, { path: filePath })
      setContent(String(result))
    } catch (err) {
      console.error('[useFileWatcher] Failed to read file:', err)
    } finally {
      setLoading(false)
    }
  }, [filePath])

  // Initial load
  useEffect(() => {
    loadContent()
  }, [loadContent])

  // Watch for changes
  useEffect(() => {
    if (!filePath) return

    ipcClient.invoke(IPC.FS_WATCH_FILE, { path: filePath }).catch(() => {})

    const handler = (...args: unknown[]) => {
      const data = args[1] as { path: string } | undefined
      if (data?.path === filePath) {
        loadContent()
      }
    }
    const cleanup = ipcClient.on(IPC.FS_FILE_CHANGED, handler)

    return () => {
      cleanup()
      ipcClient.invoke(IPC.FS_UNWATCH_FILE, { path: filePath }).catch(() => {})
    }
  }, [filePath, loadContent])

  return { content, setContent, loading, reload: loadContent }
}
