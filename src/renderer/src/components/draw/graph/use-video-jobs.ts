import { useEffect } from 'react'
import { IPC } from '@renderer/lib/ipc/channels'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { upstreamNodeIds, useGraphStore } from './graph-store'
import { useProjectsStore } from './draw-projects-store'
import { updateNodeExecution } from './canvas-events'
import { patchPersistedProjectGraph } from './graph-persistence'

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
          updateNodeExecution(n.id, 'interrupted', {
            runId: n.execution?.runId ?? n.data.jobId,
            error: 'Video job is no longer available'
          })
          return
        }
        applyJob(job)
      })
      .catch(() => undefined)
  })
}

interface VideoJobUpdate {
  jobId?: string
  projectId?: string
  nodeId?: string
  runId?: string
  status?: string
  filePath?: string
  mediaType?: string
  error?: string
  done?: boolean
}

function applyJob(job: VideoJobUpdate): void {
  if (!job?.jobId) return
  const executionStatus = job.done
    ? job.status === 'cancelled'
      ? 'cancelled'
      : job.error || job.status === 'failed'
        ? 'failed'
        : 'succeeded'
    : job.status === 'queued'
      ? 'queued'
      : 'running'
  const activeProjectId = useProjectsStore.getState().activeProjectId ?? 'default'
  if (job.projectId && job.projectId !== activeProjectId) {
    let persistedNodeId = job.nodeId
    const configIds: string[] = []
    patchPersistedProjectGraph(job.projectId, (stored) => {
      const target = stored.nodes.find(
        (node) => node.kind === 'video' && (node.id === job.nodeId || node.data.jobId === job.jobId)
      )
      if (!target || target.kind !== 'video') return stored
      persistedNodeId = target.id
      for (const edge of stored.edges) {
        if (edge.target !== target.id) continue
        const source = stored.nodes.find((node) => node.id === edge.source)
        if (source?.kind === 'config') configIds.push(source.id)
      }
      return {
        ...stored,
        nodes: stored.nodes.map((node) =>
          node.id === target.id && node.kind === 'video'
            ? {
                ...node,
                data: {
                  ...node.data,
                  status: job.done ? undefined : job.status,
                  generating: !job.done,
                  interrupted: undefined,
                  filePath: job.filePath ?? node.data.filePath,
                  mediaType: job.mediaType ?? node.data.mediaType,
                  error: job.error,
                  src: undefined
                }
              }
            : node
        )
      }
    })
    if (persistedNodeId) {
      updateNodeExecution(persistedNodeId, executionStatus, {
        runId: job.runId ?? job.jobId,
        projectId: job.projectId,
        error: job.error,
        payload: { status: job.status ?? executionStatus, filePath: job.filePath }
      })
      if (job.done) {
        for (const configId of configIds) {
          updateNodeExecution(configId, executionStatus, {
            projectId: job.projectId,
            error: job.error,
            outputNodeIds: [persistedNodeId]
          })
        }
      }
    }
    return
  }
  const { nodes, edges, updateNode } = useGraphStore.getState()
  const node = nodes.find(
    (n) =>
      n.kind === 'video' && (n.data.jobId === job.jobId || (!!job.nodeId && n.id === job.nodeId))
  )
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
  updateNodeExecution(node.id, executionStatus, {
    runId: job.runId ?? node.execution?.runId ?? job.jobId,
    projectId: job.projectId,
    error: job.error,
    payload: { status: job.status ?? executionStatus, filePath: job.filePath }
  })
  if (job.done) {
    for (const sourceId of upstreamNodeIds(edges, node.id)) {
      const source = nodes.find((candidate) => candidate.id === sourceId)
      if (source?.kind !== 'config' || !source.execution) continue
      updateNodeExecution(source.id, executionStatus, {
        runId: source.execution.runId,
        projectId: job.projectId,
        error: job.error,
        outputNodeIds: [node.id]
      })
    }
  }
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
