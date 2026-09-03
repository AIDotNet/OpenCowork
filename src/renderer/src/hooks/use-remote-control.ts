import { useCallback, useEffect, useState } from 'react'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import {
  REMOTE_CONTROL_INITIAL_STATE,
  type RemoteControlState
} from '../../../shared/remote-control'

export function useRemoteControl() {
  const [state, setState] = useState<RemoteControlState>(REMOTE_CONTROL_INITIAL_STATE)

  useEffect(() => {
    let mounted = true
    const offChanged = ipcClient.on(IPC.REMOTE_CONTROL_CHANGED, (value: unknown) => {
      if (mounted && value && typeof value === 'object') setState(value as RemoteControlState)
    })
    void ipcClient
      .invoke(IPC.REMOTE_CONTROL_GET)
      .then((value) => {
        if (mounted && value && typeof value === 'object') setState(value as RemoteControlState)
      })
      .catch(() => {})

    return () => {
      mounted = false
      offChanged()
    }
  }, [])

  const invoke = useCallback((channel: string, arg?: unknown) => {
    void ipcClient.invoke(channel, arg).catch(() => {})
  }, [])

  return {
    state,
    start: useCallback(
      (apiBaseUrl?: string) =>
        invoke(IPC.REMOTE_CONTROL_START, apiBaseUrl !== undefined ? { apiBaseUrl } : undefined),
      [invoke]
    ),
    stop: useCallback(() => invoke(IPC.REMOTE_CONTROL_STOP), [invoke]),
    rotate: useCallback(() => invoke(IPC.REMOTE_CONTROL_ROTATE), [invoke]),
    disconnectMobile: useCallback(
      (mobileId: string) => invoke(IPC.REMOTE_CONTROL_DISCONNECT_MOBILE, { id: mobileId }),
      [invoke]
    ),
    setTerminalWriteEnabled: useCallback(
      (enabled: boolean) => invoke(IPC.REMOTE_CONTROL_SET_TERMINAL_WRITE, { enabled }),
      [invoke]
    ),
    setGitWriteEnabled: useCallback(
      (enabled: boolean) => invoke(IPC.REMOTE_CONTROL_SET_GIT_WRITE, { enabled }),
      [invoke]
    ),
    setApiBaseUrl: useCallback(
      (apiBaseUrl: string) => invoke(IPC.REMOTE_CONTROL_SET_API_BASE_URL, { apiBaseUrl }),
      [invoke]
    )
  }
}
