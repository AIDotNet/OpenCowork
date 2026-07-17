// Extracted from the former monolithic ssh-store.ts; behavior unchanged.
import type { StoreApi } from 'zustand'
import { toast } from 'sonner'
import i18n from '@renderer/locales'
import { ipcClient } from '../../lib/ipc/ipc-client'
import { IPC } from '../../lib/ipc/channels'
import type {
  SftpConflictPolicy,
  SftpTransferProgress,
  SftpTransferStage,
  SftpTransferTaskType,
  SshSession,
  SshUploadProgress,
  SshUploadStage,
  SshUploadTask
} from './types'
import type { SshStore } from './store'

type SshStoreApi = Pick<StoreApi<SshStore>, 'getState' | 'setState'>

let subscribed = false

function mapUploadStageToTransferStage(stage: SshUploadStage): SftpTransferStage {
  switch (stage) {
    case 'upload':
      return 'transferring'
    case 'cleanup':
      return 'cleanup'
    case 'done':
      return 'done'
    case 'error':
      return 'error'
    case 'canceled':
      return 'canceled'
    default:
      return 'transferring'
  }
}

// All renderer-side SSH event subscriptions live here; idempotent.
export function ensureSshEventsSubscribed(store: SshStoreApi): void {
  if (subscribed) return
  subscribed = true

  ipcClient.on(IPC.SSH_FS_UPLOAD_EVENTS, (evt) => {
    if (!evt || typeof evt !== 'object') return
    const data = evt as {
      taskId?: string
      connectionId?: string
      stage?: SshUploadStage
      progress?: SshUploadProgress
      message?: string
    }
    if (!data.taskId || !data.connectionId || !data.stage) return
    const taskId = data.taskId
    const connectionId = data.connectionId
    const stage = data.stage

    store.setState((s) => {
      const prev = s.uploadTasks[taskId]
      const nextTask: SshUploadTask = {
        taskId,
        connectionId,
        stage,
        progress: data.progress,
        message: data.message,
        updatedAt: Date.now()
      }
      return {
        uploadTasks: {
          ...s.uploadTasks,
          [taskId]: { ...prev, ...nextTask }
        },
        transferTasks: {
          ...s.transferTasks,
          [taskId]: {
            taskId,
            type: 'upload',
            stage: mapUploadStageToTransferStage(stage),
            targetConnectionId: connectionId,
            progress: data.progress
              ? {
                  currentBytes: data.progress.current,
                  totalBytes: data.progress.total,
                  percent: data.progress.percent
                }
              : undefined,
            message: data.message,
            updatedAt: Date.now()
          }
        }
      }
    })
  })

  ipcClient.on(IPC.SSH_FS_TRANSFER_EVENTS, (evt) => {
    if (!evt || typeof evt !== 'object') return
    const data = evt as {
      taskId?: string
      type?: SftpTransferTaskType
      stage?: SftpTransferStage
      sourceConnectionId?: string | null
      targetConnectionId?: string | null
      progress?: SftpTransferProgress
      message?: string
      currentItem?: string
      conflictPolicy?: SftpConflictPolicy
    }
    if (!data.taskId || !data.type || !data.stage) return

    store.setState((state) => ({
      transferTasks: {
        ...state.transferTasks,
        [data.taskId!]: {
          ...(state.transferTasks[data.taskId!] ?? {}),
          taskId: data.taskId!,
          type: data.type!,
          stage: data.stage!,
          sourceConnectionId: data.sourceConnectionId ?? null,
          targetConnectionId: data.targetConnectionId ?? null,
          progress: data.progress,
          message: data.message,
          currentItem: data.currentItem,
          conflictPolicy: data.conflictPolicy,
          updatedAt: Date.now()
        }
      }
    }))
  })

  ipcClient.on('ssh:config:changed', () => {
    void store.getState().loadAll()
  })

  ipcClient.on(IPC.SSH_STATUS, (payload) => {
    if (!payload || typeof payload !== 'object') return
    const data = payload as {
      sessionId?: string
      connectionId?: string
      status?: string
      error?: string
    }
    if (!data.sessionId || !data.status) return

    const state = store.getState()
    const status = data.status as SshSession['status']

    if (status === 'disconnected') {
      state.removeSession(data.sessionId)
      return
    }

    const existing = state.sessions[data.sessionId]
    if (!existing && data.connectionId) {
      store.setState((state) => ({
        sessions: {
          ...state.sessions,
          [data.sessionId!]: {
            id: data.sessionId!,
            connectionId: data.connectionId!,
            status,
            error: data.error
          }
        }
      }))
      return
    }

    state.updateSessionStatus(data.sessionId, status, data.error)
    if (status === 'error' && data.error) {
      toast.error(i18n.t('connectionFailed', { ns: 'ssh' }), { description: data.error })
    }
  })
}
