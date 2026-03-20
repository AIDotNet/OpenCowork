import { useState, useEffect, useCallback } from 'react'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'

function getReadError(result: unknown): string | null {
  if (result && typeof result === 'object' && 'error' in result) {
    const error = (result as { error?: unknown }).error
    return typeof error === 'string' && error.length > 0 ? error : 'Failed to read file'
  }

  if (typeof result !== 'string' || !result.trim().startsWith('{')) return null

  try {
    const parsed = JSON.parse(result) as { error?: unknown }
    return typeof parsed.error === 'string' && parsed.error.length > 0 ? parsed.error : null
  } catch {
    return null
  }
}

export function useFileWatcher(filePath: string | null, sshConnectionId?: string) {
  const [content, setContent] = useState<string>('')
  const [loading, setLoading] = useState(false)

  const loadContent = useCallback(async () => {
    if (!filePath) {
      setContent('')
      return
    }
    setLoading(true)
    try {
      const channel = sshConnectionId ? IPC.SSH_FS_READ_FILE : IPC.FS_READ_FILE
      const args = sshConnectionId
        ? { connectionId: sshConnectionId, path: filePath }
        : { path: filePath }
      const result = await ipcClient.invoke(channel, args)
      const readError = getReadError(result)
      if (readError) {
        throw new Error(readError)
      }
      setContent(String(result))
    } catch (err) {
      console.error('[useFileWatcher] Failed to read file:', err)
      setContent('')
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
