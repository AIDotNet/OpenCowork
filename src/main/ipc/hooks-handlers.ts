import { registerMessagePackHandler } from './messagepack-handler'
import type {
  HooksListArgs,
  HooksOpenSourceArgs,
  HooksRunHistoryArgs,
  HooksSetDisabledArgs,
  HooksSetTrustArgs,
  HookUserPromptSourceKind
} from '../../shared/hooks/types'
import { HOOK_EVENTS, HOOK_IPC_CHANNELS } from '../../shared/hooks/types'
import {
  getHookRunHistory,
  isHookRuntimeEnabled,
  listHooks,
  openHookSource,
  openUserHooksConfig,
  reloadHooks,
  runHooks,
  setHookDisabled,
  setHookTrust,
  startHookMaintenance
} from '../hooks/hooks-service'

let maintenanceStarted = false

function sanitizeRendererHooksArgs<T extends HooksListArgs>(args: T): T {
  return {
    ...args,
    projectRoot: undefined,
    sshConnectionId: undefined
  }
}

export function registerHooksHandlers(): void {
  if (!maintenanceStarted && isHookRuntimeEnabled()) {
    maintenanceStarted = true
    startHookMaintenance()
  }

  registerMessagePackHandler<HooksListArgs>(HOOK_IPC_CHANNELS.list, async (args) => {
    return await listHooks(sanitizeRendererHooksArgs(args ?? {}))
  })

  registerMessagePackHandler<HooksListArgs>(HOOK_IPC_CHANNELS.reload, async (args) => {
    return await reloadHooks(sanitizeRendererHooksArgs(args ?? {}))
  })

  registerMessagePackHandler<HooksSetTrustArgs>(HOOK_IPC_CHANNELS.setTrust, async (args) => {
    return await setHookTrust(sanitizeRendererHooksArgs(args))
  })

  registerMessagePackHandler<HooksSetDisabledArgs>(HOOK_IPC_CHANNELS.setDisabled, async (args) => {
    return await setHookDisabled(sanitizeRendererHooksArgs(args))
  })

  registerMessagePackHandler<HooksOpenSourceArgs>(HOOK_IPC_CHANNELS.openSource, async (args) => {
    return await openHookSource(sanitizeRendererHooksArgs(args))
  })

  registerMessagePackHandler<HooksRunHistoryArgs>(HOOK_IPC_CHANNELS.getRunHistory, async (args) => {
    return await getHookRunHistory(sanitizeRendererHooksArgs(args))
  })

  registerMessagePackHandler<undefined>(HOOK_IPC_CHANNELS.openUserConfig, async () => {
    return await openUserHooksConfig()
  })

  registerMessagePackHandler<{
    sessionId?: string
    projectId?: string
    projectRoot?: string
    sshConnectionId?: string | null
    prompt: string
    sourceKind: HookUserPromptSourceKind
    hasImages: boolean
  }>(HOOK_IPC_CHANNELS.runUserPromptSubmit, async (args) => {
    return await runHooks({
      eventName: HOOK_EVENTS.userPromptSubmit,
      sessionId: args.sessionId,
      projectId: args.projectId,
      input: {
        prompt: args.prompt,
        sourceKind: args.sourceKind,
        hasImages: args.hasImages
      }
    })
  })
}
