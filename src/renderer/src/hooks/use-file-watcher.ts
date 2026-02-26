import { useState, useEffect, useCallback } from 'react'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'

export function useFileWatcher(filePath: string | null, sshConnectionId?: string) {
  const [content, setContent] = useState<string>('')
  const [loading, setLoading] = useState(false)

  const loadContent = useCallback(async () => {
    if (!filePath) return
    setLoading(true)
    try {
      const channel = sshConnectionId ? IPC.SSH_FS_READ_FILE : IPC.FS_READ_FILE
      const args = sshConnectionId
        ? { connectionId: sshConnectionId, path: filePath }
        : { path: filePath }
      const result = await ipcClient.invoke(channel, args)
      if (result && typeof result === 'object' && 'error' in result) {
        throw new Error(String((result as { error?: unknown }).error))
      }
      setContent(String(result))
    } catch (err) {
      console.error('[useFileWatcher] Failed to read file:', err)
    } finally {
      setLoading(false)
    }
  }, [filePath, sshConnectionId])

  // Initial load
  useEffect(() => {
    loadContent()
  }, [loadContent])

  // Watch for changes
  useEffect(() => {
    if (!filePath || sshConnectionId) return

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
  }, [filePath, loadContent, sshConnectionId])

  return { content, setContent, loading, reload: loadContent }
}
