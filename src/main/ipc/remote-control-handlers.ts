import { ipcMain } from 'electron'

const IPC = {
  REMOTE_CONTROL_GET: 'remote-control:get',
  REMOTE_CONTROL_START: 'remote-control:start',
  REMOTE_CONTROL_STOP: 'remote-control:stop',
  REMOTE_CONTROL_ROTATE: 'remote-control:rotate',
  REMOTE_CONTROL_DISCONNECT_MOBILE: 'remote-control:disconnect-mobile',
  REMOTE_CONTROL_SET_TERMINAL_WRITE: 'remote-control:set-terminal-write',
  REMOTE_CONTROL_SET_GIT_WRITE: 'remote-control:set-git-write',
  REMOTE_CONTROL_SET_API_BASE_URL: 'remote-control:set-api-base-url',
  REMOTE_CONTROL_RESPONSE: 'remote-control:response',
  REMOTE_CONTROL_EVENT: 'remote-control:event'
} as const
import { toMessagePackChannel, decodeMessagePackPayload } from '../../shared/messagepack/binary-ipc'
import { registerMessagePackHandler } from './messagepack-handler'
import {
  disconnectMobile,
  dispatchRendererEvent,
  getRemoteControlState,
  rotatePairingCode,
  setApiBaseUrl,
  setGitWriteEnabled,
  setTerminalWriteEnabled,
  startRemoteControl,
  stopRemoteControl
} from '../remote-control/remote-control-client'
import { resolveRendererResponse } from '../remote-control/request-router'
import type { RemoteRendererEvent, RemoteRendererResponse } from '../../shared/remote-control'

export function registerRemoteControlHandlers(): void {
  registerMessagePackHandler<void>(IPC.REMOTE_CONTROL_GET, async () => getRemoteControlState())
  registerMessagePackHandler<{ apiBaseUrl?: string } | undefined>(
    IPC.REMOTE_CONTROL_START,
    async (args) => startRemoteControl(args)
  )
  registerMessagePackHandler<void>(IPC.REMOTE_CONTROL_STOP, async () => {
    await stopRemoteControl()
    return { success: true }
  })
  registerMessagePackHandler<void>(IPC.REMOTE_CONTROL_ROTATE, async () => rotatePairingCode())
  registerMessagePackHandler<{ id: string }>(IPC.REMOTE_CONTROL_DISCONNECT_MOBILE, async (args) =>
    disconnectMobile(args.id)
  )
  registerMessagePackHandler<{ enabled: boolean }>(
    IPC.REMOTE_CONTROL_SET_TERMINAL_WRITE,
    async (args) => setTerminalWriteEnabled(args.enabled)
  )
  registerMessagePackHandler<{ enabled: boolean }>(
    IPC.REMOTE_CONTROL_SET_GIT_WRITE,
    async (args) => setGitWriteEnabled(args.enabled)
  )
  registerMessagePackHandler<{ apiBaseUrl: string }>(
    IPC.REMOTE_CONTROL_SET_API_BASE_URL,
    async (args) => setApiBaseUrl(args?.apiBaseUrl ?? '')
  )

  ipcMain.on(toMessagePackChannel(IPC.REMOTE_CONTROL_RESPONSE), (_event, bytes: Uint8Array) => {
    resolveRendererResponse(decodeMessagePackPayload<RemoteRendererResponse>(bytes))
  })
  ipcMain.on(toMessagePackChannel(IPC.REMOTE_CONTROL_EVENT), (_event, bytes: Uint8Array) => {
    dispatchRendererEvent(decodeMessagePackPayload<RemoteRendererEvent>(bytes))
  })
}
