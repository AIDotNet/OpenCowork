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
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: OpenCoworkAPI
  }
}
