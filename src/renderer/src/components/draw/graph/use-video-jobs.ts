import { useEffect } from 'react'
import { IPC } from '@renderer/lib/ipc/channels'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { useGraphStore } from './graph-store'
import { useProjectsStore } from './draw-projects-store'

function reconcileInFlightJobs(): void {
  const { nodes } = useGraphStore.getState()
  nodes.forEach((n) => {
    if (n.kind !== 'video' || !n.data.jobId || !n.data.generating) return
    void ipcClient
      .invoke(IPC.SEEDANCE_VIDEO_STATUS, { jobId: n.data.jobId })
      .then((res) => {
        const job = res as VideoJobUpdate & { error?: string }
        if (job?.error === 'unknown job') {
          // main process restarted / job gone — stop the spinner
          useGraphStore.getState().updateNode(n.id, (node) =>
            node.kind === 'video'
              ? {
                  ...node,
                  data: { ...node.data, generating: false, status: undefined, interrupted: true }
                }
              : node
          )
          return
        }
        applyJob(job)
      })
      .catch(() => undefined)
  })
}

interface VideoJobUpdate {
  jobId?: string
  status?: string
  filePath?: string
  mediaType?: string
  error?: string
  done?: boolean
}

function applyJob(job: VideoJobUpdate): void {
  if (!job?.jobId) return
  const { nodes, updateNode } = useGraphStore.getState()
  const node = nodes.find((n) => n.kind === 'video' && n.data.jobId === job.jobId)
  if (!node) return
  updateNode(node.id, (n) =>
    n.kind === 'video'
      ? {
          ...n,
          data: {
            ...n.data,
            status: job.done ? undefined : job.status,
            generating: !job.done,
            interrupted: undefined,
            filePath: job.filePath ?? n.data.filePath,
            mediaType: job.mediaType ?? n.data.mediaType,
            error: job.error,
            // clear inline src so the view lazily reloads the freshly-written file
            src: job.filePath ? undefined : n.data.src
          }
        }
      : n
  )
}

/**
 * Subscribe to background video-job updates and reconcile in-flight jobs on mount
 * (in case updates fired while the draw page was unmounted). Generation itself
 * runs in the main process — this only applies status/results to video nodes.
 */
export function useVideoJobs(): void {
  const activeProjectId = useProjectsStore((s) => s.activeProjectId)

  // Subscribe once to background job updates.
  useEffect(() => {
    const off = ipcClient.on(IPC.SEEDANCE_VIDEO_JOB_UPDATE, (payload: unknown) =>
      applyJob(payload as VideoJobUpdate)
    )
    return () => {
      if (typeof off === 'function') off()
    }
  }, [])

  // Reconcile in-flight jobs on mount and whenever the active project changes
  // (a job may have finished while another canvas was open).
  useEffect(() => {
    reconcileInFlightJobs()
  }, [activeProjectId])
}
