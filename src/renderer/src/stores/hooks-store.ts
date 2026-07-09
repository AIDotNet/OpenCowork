import { create } from 'zustand'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { HOOK_IPC_CHANNELS } from '../../../shared/hooks/types'
import type {
  HookDefinitionView,
  HookListView,
  HooksListArgs,
  HooksSetDisabledArgs,
  HooksSetTrustArgs
} from '../../../shared/hooks/types'

interface HooksState {
  list: HookListView | null
  loading: boolean
  error: string | null
  load: (context?: HooksListArgs) => Promise<void>
  reload: (context?: HooksListArgs) => Promise<void>
  trust: (hook: HookDefinitionView, context: HooksListArgs) => Promise<void>
  deny: (hook: HookDefinitionView, context: HooksListArgs) => Promise<void>
  setDisabled: (
    hook: HookDefinitionView,
    disabled: boolean,
    context: HooksListArgs
  ) => Promise<void>
  openSource: (
    hook: HookDefinitionView,
    target: 'config' | 'artifact',
    context: HooksListArgs
  ) => Promise<void>
  openUserConfig: () => Promise<void>
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const useHooksStore = create<HooksState>((set, get) => ({
  list: null,
  loading: false,
  error: null,
  load: async (context = {}) => {
    set({ loading: true, error: null })
    try {
      const list = (await ipcClient.invoke(HOOK_IPC_CHANNELS.list, context)) as HookListView
      set({ list, loading: false })
    } catch (error) {
      set({ error: normalizeError(error), loading: false })
    }
  },
  reload: async (context = {}) => {
    set({ loading: true, error: null })
    try {
      const list = (await ipcClient.invoke(HOOK_IPC_CHANNELS.reload, context)) as HookListView
      set({ list, loading: false })
    } catch (error) {
      set({ error: normalizeError(error), loading: false })
    }
  },
  trust: async (hook, context) => {
    const args: HooksSetTrustArgs = {
      ...context,
      hookId: hook.id,
      decision: 'trusted',
      expectedTrustKey: hook.trustKey,
      expectedDefinitionHash: hook.definitionHash,
      expectedSourceConfigHash: hook.sourceConfigHash
    }
    const list = (await ipcClient.invoke(HOOK_IPC_CHANNELS.setTrust, args)) as HookListView
    set({ list })
  },
  deny: async (hook, context) => {
    const args: HooksSetTrustArgs = {
      ...context,
      hookId: hook.id,
      decision: 'denied',
      expectedTrustKey: hook.trustKey,
      expectedDefinitionHash: hook.definitionHash,
      expectedSourceConfigHash: hook.sourceConfigHash
    }
    const list = (await ipcClient.invoke(HOOK_IPC_CHANNELS.setTrust, args)) as HookListView
    set({ list })
  },
  setDisabled: async (hook, disabled, context) => {
    const args: HooksSetDisabledArgs = {
      ...context,
      hookId: hook.id,
      disabled,
      expectedTrustKey: hook.trustKey
    }
    const list = (await ipcClient.invoke(HOOK_IPC_CHANNELS.setDisabled, args)) as HookListView
    set({ list })
  },
  openSource: async (hook, target, context) => {
    await ipcClient.invoke(HOOK_IPC_CHANNELS.openSource, {
      ...context,
      hookId: hook.id,
      target,
      expectedTrustKey: hook.trustKey
    })
  },
  openUserConfig: async () => {
    await ipcClient.invoke(HOOK_IPC_CHANNELS.openUserConfig)
    await get().reload()
  }
}))
