import { ElectronAPI } from '@electron-toolkit/preload'
import type {
  AppendTeamRuntimeMessageArgs,
  ConsumeTeamRuntimeMessagesArgs,
  CreateTeamRuntimeArgs,
  DeleteTeamRuntimeArgs,
  GetTeamRuntimeSnapshotArgs,
  SpawnIsolatedTeamWorkerArgs,
  SpawnIsolatedTeamWorkerResult,
  StopIsolatedTeamWorkerArgs,
  StopIsolatedTeamWorkersArgs,
  UpdateTeamRuntimeManifestArgs,
  UpdateTeamRuntimeMemberArgs,
  TeamRuntimeCreateResult,
  TeamRuntimeMessageRecord,
  TeamRuntimeSnapshot
} from '../shared/team-runtime-types'

interface OpenCoworkAPI {
  downloadImage: (args: {
    url: string
    defaultName?: string
  }) => Promise<{ success?: boolean; canceled?: boolean; filePath?: string; error?: string }>
  fetchImageBase64: (args: {
    url: string
  }) => Promise<{ data?: string; mimeType?: string; error?: string }>
  writeImageToClipboard: (args: { data: string }) => Promise<{ success?: boolean; error?: string }>
  teamRuntimeCreate: (args: CreateTeamRuntimeArgs) => Promise<TeamRuntimeCreateResult>
  teamRuntimeDelete: (args: DeleteTeamRuntimeArgs) => Promise<{ success: true }>
  teamRuntimeAppendMessage: (args: AppendTeamRuntimeMessageArgs) => Promise<{ success: true }>
  teamRuntimeGetSnapshot: (args: GetTeamRuntimeSnapshotArgs) => Promise<TeamRuntimeSnapshot | null>
  teamRuntimeUpdateMember: (args: UpdateTeamRuntimeMemberArgs) => Promise<{ success: true }>
  teamRuntimeUpdateManifest: (args: UpdateTeamRuntimeManifestArgs) => Promise<{ success: true }>
  teamRuntimeConsumeMessages: (
    args: ConsumeTeamRuntimeMessagesArgs
  ) => Promise<TeamRuntimeMessageRecord[]>
  teamWorkerSpawn: (args: SpawnIsolatedTeamWorkerArgs) => Promise<SpawnIsolatedTeamWorkerResult>
  teamWorkerStop: (args: StopIsolatedTeamWorkerArgs) => Promise<{ success: true }>
  teamWorkerStopTeam: (args: StopIsolatedTeamWorkersArgs) => Promise<{ success: true }>
  // User system APIs
  userLogin: (credentials: { username: string; password: string }) => Promise<any>
  userRegister: (userData: { username: string; password: string; realName?: string; email?: string; phone?: string; departmentId?: number }) => Promise<any>
  userGetProfile: () => Promise<any>
  userLogout: () => Promise<any>
  userRefreshToken: () => Promise<any>
  userList: (filters?: any) => Promise<any>
  userGet: (id: number) => Promise<any>
  userCreate: (userData: any) => Promise<any>
  userUpdate: (id: number, userData: any) => Promise<any>
  userDelete: (id: number) => Promise<any>
  userAssignRoles: (id: number, roleIds: number[]) => Promise<any>
  departmentList: () => Promise<any>
  departmentTree: () => Promise<any>
  departmentGet: (id: number) => Promise<any>
  departmentCreate: (data: any) => Promise<any>
  departmentUpdate: (id: number, data: any) => Promise<any>
  departmentDelete: (id: number) => Promise<any>
  roleList: () => Promise<any>
  roleGet: (id: number) => Promise<any>
  roleCreate: (data: any) => Promise<any>
  roleUpdate: (id: number, data: any) => Promise<any>
  roleDelete: (id: number) => Promise<any>
  roleAssignPermissions: (id: number, permissionIds: number[]) => Promise<any>
  permissionList: () => Promise<any>
  importDownloadTemplate: () => Promise<any>
  importUsers: (fileBuffer: Buffer) => Promise<any>
  authSaveToken: (token: string) => Promise<any>
  authClear: () => Promise<any>
  authCheck: () => Promise<any>
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: OpenCoworkAPI
  }
}
