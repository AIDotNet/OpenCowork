import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  AppendTeamRuntimeMessageArgs,
  ConsumeTeamRuntimeMessagesArgs,
  CreateTeamRuntimeArgs,
  DeleteTeamRuntimeArgs,
  GetTeamRuntimeSnapshotArgs,
  UpdateTeamRuntimeManifestArgs,
  UpdateTeamRuntimeMemberArgs
} from '../shared/team-runtime-types'
import {
  decodeMessagePackPayload,
  encodeMessagePackPayload,
  toMessagePackChannel
} from '../shared/messagepack/binary-ipc'
import { createOpenCoworkRuntimeAPI } from '../shared/runtime-contracts/generated/ipc'

async function invokeMessagePackBinary<T>(channel: string, payload: unknown): Promise<T> {
  const response = await ipcRenderer.invoke(
    toMessagePackChannel(channel),
    encodeMessagePackPayload(payload)
  )
  return decodeMessagePackPayload<T>(response as ArrayBuffer | ArrayBufferView)
}

const runtime = createOpenCoworkRuntimeAPI({
  invoke: (channel, payload) => invokeMessagePackBinary(channel, payload),
  subscribe: (channel, listener) => {
    const binaryChannel = toMessagePackChannel(channel)
    const handler = (_event: unknown, bytes: ArrayBuffer | ArrayBufferView): void => {
      listener(decodeMessagePackPayload(bytes))
    }
    ipcRenderer.on(binaryChannel, handler)
    return () => {
      ipcRenderer.removeListener(binaryChannel, handler)
    }
  }
})

// Custom APIs for renderer
const api = {
  downloadImage: (args: { url: string; defaultName?: string }) =>
    invokeMessagePackBinary('image:download', args),
  fetchImageBase64: (args: { url: string }) => invokeMessagePackBinary('image:fetch-base64', args),
  writeImageToClipboard: (args: { data: string }) =>
    invokeMessagePackBinary('clipboard:write-image', args),
  teamRuntimeCreate: (args: CreateTeamRuntimeArgs) =>
    invokeMessagePackBinary('team-runtime:create', args),
  teamRuntimeDelete: (args: DeleteTeamRuntimeArgs) =>
    invokeMessagePackBinary('team-runtime:delete', args),
  teamRuntimeAppendMessage: (args: AppendTeamRuntimeMessageArgs) =>
    invokeMessagePackBinary('team-runtime:message:append', args),
  teamRuntimeGetSnapshot: (args: GetTeamRuntimeSnapshotArgs) =>
    invokeMessagePackBinary('team-runtime:snapshot', args),
  teamRuntimeUpdateMember: (args: UpdateTeamRuntimeMemberArgs) =>
    invokeMessagePackBinary('team-runtime:member:update', args),
  teamRuntimeUpdateManifest: (args: UpdateTeamRuntimeManifestArgs) =>
    invokeMessagePackBinary('team-runtime:manifest:update', args),
  teamRuntimeConsumeMessages: (args: ConsumeTeamRuntimeMessagesArgs) =>
    invokeMessagePackBinary('team-runtime:messages:consume', args),
  runtime
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
