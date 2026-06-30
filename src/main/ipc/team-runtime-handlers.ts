import { getNativeWorker } from '../lib/native-worker'
import { registerMessagePackHandler } from './messagepack-handler'
import type {
  AppendTeamRuntimeMessageArgs,
  ConsumeTeamRuntimeMessagesArgs,
  CreateTeamRuntimeArgs,
  DeleteTeamRuntimeArgs,
  GetTeamRuntimeSnapshotArgs,
  TeamRuntimeCreateResult,
  TeamRuntimeMessageRecord,
  TeamRuntimeSnapshot,
  UpdateTeamRuntimeManifestArgs,
  UpdateTeamRuntimeMemberArgs
} from '../../shared/team-runtime-types'

type NativeErrorResult = {
  error: string
}

async function nativeTeamRuntimeRequest<TResult>(
  method: string,
  args: unknown,
  timeoutMs = 60_000
): Promise<TResult> {
  const result = await getNativeWorker().request<TResult | NativeErrorResult>(method, args, timeoutMs)
  if (isNativeErrorResult(result)) {
    throw new Error(result.error)
  }
  return result as TResult
}

function isNativeErrorResult(value: unknown): value is Required<NativeErrorResult> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof (value as Partial<NativeErrorResult>).error === 'string' &&
    Boolean((value as Partial<NativeErrorResult>).error)
  )
}

export function registerTeamRuntimeHandlers(): void {
  registerMessagePackHandler<CreateTeamRuntimeArgs>('team-runtime:create', async (args) => {
    return nativeTeamRuntimeRequest<TeamRuntimeCreateResult>('team-runtime/create', args)
  })

  registerMessagePackHandler<DeleteTeamRuntimeArgs>('team-runtime:delete', async (args) => {
    return nativeTeamRuntimeRequest<{ success: true }>('team-runtime/delete', args)
  })

  registerMessagePackHandler<AppendTeamRuntimeMessageArgs>(
    'team-runtime:message:append',
    async (args) => {
      return nativeTeamRuntimeRequest<{ success: true }>('team-runtime/message-append', args)
    }
  )

  registerMessagePackHandler<GetTeamRuntimeSnapshotArgs>(
    'team-runtime:snapshot',
    async (args) => {
      return nativeTeamRuntimeRequest<TeamRuntimeSnapshot | null>('team-runtime/snapshot', args)
    }
  )

  registerMessagePackHandler<UpdateTeamRuntimeMemberArgs>(
    'team-runtime:member:update',
    async (args) => {
      return nativeTeamRuntimeRequest<{ success: true }>('team-runtime/member-update', args)
    }
  )

  registerMessagePackHandler<UpdateTeamRuntimeManifestArgs>(
    'team-runtime:manifest:update',
    async (args) => {
      return nativeTeamRuntimeRequest<{ success: true }>('team-runtime/manifest-update', args)
    }
  )

  registerMessagePackHandler<ConsumeTeamRuntimeMessagesArgs>(
    'team-runtime:messages:consume',
    async (args) => {
      return nativeTeamRuntimeRequest<TeamRuntimeMessageRecord[]>(
        'team-runtime/messages-consume',
        args
      )
    }
  )
}
