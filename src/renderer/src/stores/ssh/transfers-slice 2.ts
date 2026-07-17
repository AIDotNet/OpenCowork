// Extracted from the former monolithic ssh-store.ts; behavior unchanged.
import type { StateCreator } from 'zustand'
import { ipcClient } from '../../lib/ipc/ipc-client'
import { IPC } from '../../lib/ipc/channels'
import type { SftpTransferRequest, SftpTransferTask, SshUploadTask } from './types'
import { ensureSshEventsSubscribed } from './events'
import type { SshStore } from './store'

export interface SshTransfersSlice {
  uploadTasks: Record<string, SshUploadTask>
  transferTasks: Record<string, SftpTransferTask>

  startUpload: (args: {
    connectionId: string
    remoteDir: string
    localPath: string
    kind?: 'file' | 'folder'
  }) => Promise<string | null>
  cancelUpload: (taskId: string) => Promise<void>
  clearUploadTask: (taskId: string) => void
  startTransfer: (args: SftpTransferRequest) => Promise<string | null>
  retryTransfer: (taskId: string) => Promise<string | null>
  cancelTransfer: (taskId: string) => Promise<void>
  clearTransferTask: (taskId: string) => void
}

export const createTransfersSlice: StateCreator<SshStore, [], [], SshTransfersSlice> = (
  set,
  _get,
  api
) => ({
  uploadTasks: {},
  transferTasks: {},

  startUpload: async (args) => {
    ensureSshEventsSubscribed(api)
    const result = await ipcClient.invoke(IPC.SSH_FS_UPLOAD_START, args)
    if (result && typeof result === 'object' && 'error' in result) return null
    const taskId = (result as { taskId?: string }).taskId
    if (!taskId) return null
    set((s) => ({
      uploadTasks: {
        ...s.uploadTasks,
        [taskId]: {
          taskId,
          connectionId: args.connectionId,
          stage: 'upload',
          updatedAt: Date.now()
        }
      }
    }))
    return taskId
  },

  cancelUpload: async (taskId) => {
    await ipcClient.invoke(IPC.SSH_FS_UPLOAD_CANCEL, { taskId })
  },

  clearUploadTask: (taskId) => {
    set((s) => {
      if (!s.uploadTasks[taskId]) return s
      const next = { ...s.uploadTasks }
      delete next[taskId]
      return { uploadTasks: next }
    })
  },

  startTransfer: async (args) => {
    ensureSshEventsSubscribed(api)
    const result = await ipcClient.invoke(IPC.SSH_FS_TRANSFER_START, args)
    if (result && typeof result === 'object' && 'error' in result) return null
    const taskId = (result as { taskId?: string }).taskId
    if (!taskId) return null

    set((state) => ({
      transferTasks: {
        ...state.transferTasks,
        [taskId]: {
          taskId,
          type: args.type,
          stage: 'preparing',
          sourceConnectionId:
            args.type === 'remote-copy' ? args.sourceConnectionId : args.connectionId,
          targetConnectionId:
            args.type === 'upload'
              ? args.connectionId
              : args.type === 'remote-copy'
                ? args.targetConnectionId
                : null,
          conflictPolicy: args.conflictPolicy,
          message: 'Preparing transfer...',
          updatedAt: Date.now(),
          request: args
        }
      }
    }))

    return taskId
  },

  retryTransfer: async (taskId) => {
    const state = api.getState()
    const task = state.transferTasks[taskId]
    if (!task?.request) return null
    state.clearTransferTask(taskId)
    return state.startTransfer({ ...task.request, resume: true })
  },

  cancelTransfer: async (taskId) => {
    await ipcClient.invoke(IPC.SSH_FS_TRANSFER_CANCEL, { taskId })
  },

  clearTransferTask: (taskId) => {
    set((state) => {
      if (!state.transferTasks[taskId]) return state
      const next = { ...state.transferTasks }
      delete next[taskId]
      return { transferTasks: next }
    })
  }
})
