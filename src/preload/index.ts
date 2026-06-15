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
    ipcRenderer.invoke('team-worker:stop-team', args),
  // User system APIs
  userLogin: (credentials: { username: string; password: string }) =>
    ipcRenderer.invoke('user:login', credentials),
  userRegister: (userData: { username: string; password: string; realName?: string; email?: string; phone?: string; departmentId?: number }) =>
    ipcRenderer.invoke('user:register', userData),
  userGetProfile: () => ipcRenderer.invoke('user:getProfile'),
  userLogout: () => ipcRenderer.invoke('user:logout'),
  userRefreshToken: () => ipcRenderer.invoke('user:refreshToken'),
  userList: (filters?: any) => ipcRenderer.invoke('user:list', filters),
  userGet: (id: number) => ipcRenderer.invoke('user:get', id),
  userCreate: (userData: any) => ipcRenderer.invoke('user:create', userData),
  userUpdate: (id: number, userData: any) => ipcRenderer.invoke('user:update', id, userData),
  userDelete: (id: number) => ipcRenderer.invoke('user:delete', id),
  userAssignRoles: (id: number, roleIds: number[]) => ipcRenderer.invoke('user:assignRoles', id, roleIds),
  departmentList: () => ipcRenderer.invoke('department:list'),
  departmentTree: () => ipcRenderer.invoke('department:tree'),
  departmentGet: (id: number) => ipcRenderer.invoke('department:get', id),
  departmentCreate: (data: any) => ipcRenderer.invoke('department:create', data),
  departmentUpdate: (id: number, data: any) => ipcRenderer.invoke('department:update', id, data),
  departmentDelete: (id: number) => ipcRenderer.invoke('department:delete', id),
  roleList: () => ipcRenderer.invoke('role:list'),
  roleGet: (id: number) => ipcRenderer.invoke('role:get', id),
  roleCreate: (data: any) => ipcRenderer.invoke('role:create', data),
  roleUpdate: (id: number, data: any) => ipcRenderer.invoke('role:update', id, data),
  roleDelete: (id: number) => ipcRenderer.invoke('role:delete', id),
  roleAssignPermissions: (id: number, permissionIds: number[]) => ipcRenderer.invoke('role:assignPermissions', id, permissionIds),
  permissionList: () => ipcRenderer.invoke('permission:list'),
  importDownloadTemplate: () => ipcRenderer.invoke('import:downloadTemplate'),
  importUsers: (fileBuffer: Buffer) => ipcRenderer.invoke('import:users', fileBuffer),
  authSaveToken: (token: string) => ipcRenderer.invoke('auth:saveToken', token),
  authClear: () => ipcRenderer.invoke('auth:clear'),
  authCheck: () => ipcRenderer.invoke('auth:check'),
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
