import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  AppendTeamRuntimeMessageArgs,
  ConsumeTeamRuntimeMessagesArgs,
  CreateTeamRuntimeArgs,
  DeleteTeamRuntimeArgs,
  GetTeamRuntimeSnapshotArgs,
  SpawnIsolatedTeamWorkerArgs,
  StopIsolatedTeamWorkerArgs,
  StopIsolatedTeamWorkersArgs,
  UpdateTeamRuntimeManifestArgs,
  UpdateTeamRuntimeMemberArgs
} from '../shared/team-runtime-types'

// Custom APIs for renderer
const api = {
  downloadImage: (args: { url: string; defaultName?: string }) =>
    ipcRenderer.invoke('image:download', args),
  fetchImageBase64: (args: { url: string }) => ipcRenderer.invoke('image:fetch-base64', args),
  writeImageToClipboard: (args: { data: string }) =>
    ipcRenderer.invoke('clipboard:write-image', args),
  teamRuntimeCreate: (args: CreateTeamRuntimeArgs) =>
    ipcRenderer.invoke('team-runtime:create', args),
  teamRuntimeDelete: (args: DeleteTeamRuntimeArgs) =>
    ipcRenderer.invoke('team-runtime:delete', args),
  teamRuntimeAppendMessage: (args: AppendTeamRuntimeMessageArgs) =>
    ipcRenderer.invoke('team-runtime:message:append', args),
  teamRuntimeGetSnapshot: (args: GetTeamRuntimeSnapshotArgs) =>
    ipcRenderer.invoke('team-runtime:snapshot', args),
  teamRuntimeUpdateMember: (args: UpdateTeamRuntimeMemberArgs) =>
    ipcRenderer.invoke('team-runtime:member:update', args),
  teamRuntimeUpdateManifest: (args: UpdateTeamRuntimeManifestArgs) =>
    ipcRenderer.invoke('team-runtime:manifest:update', args),
  teamRuntimeConsumeMessages: (args: ConsumeTeamRuntimeMessagesArgs) =>
    ipcRenderer.invoke('team-runtime:messages:consume', args),
  teamWorkerSpawn: (args: SpawnIsolatedTeamWorkerArgs) =>
    ipcRenderer.invoke('team-worker:spawn', args),
  teamWorkerStop: (args: StopIsolatedTeamWorkerArgs) =>
    ipcRenderer.invoke('team-worker:stop', args),
  teamWorkerStopTeam: (args: StopIsolatedTeamWorkersArgs) =>
    ipcRenderer.invoke('team-worker:stop-team', args)
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
