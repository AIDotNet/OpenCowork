import { nanoid } from 'nanoid'
import { useProjectsStore } from './draw-projects-store'
import { useGraphStore } from './graph-store'
import { patchPersistedProjectGraph, readPersistedProjectGraph } from './graph-persistence'
import type {
  CanvasNode,
  CanvasNodeEvent,
  CanvasNodeEventType,
  NodeExecutionSnapshot,
  NodeExecutionStatus
} from './graph-types'

const MAX_WAIT_MS = 10 * 60 * 1000
const listeners = new Set<(event: CanvasNodeEvent) => void>()
const subscriptionListeners = new Set<() => void>()

interface EventSubscription {
  id: string
  projectId: string
  nodeId: string
  events: Set<CanvasNodeEventType>
  queue: CanvasNodeEvent[]
  waiters: Array<(event: CanvasNodeEvent | null) => void>
}

const subscriptions = new Map<string, EventSubscription>()

function activeProjectId(): string {
  return useProjectsStore.getState().activeProjectId ?? 'default'
}

function eventTypeForStatus(status: NodeExecutionStatus): CanvasNodeEventType | null {
  switch (status) {
    case 'queued':
      return 'run.queued'
    case 'running':
      return 'run.started'
    case 'succeeded':
      return 'run.succeeded'
    case 'failed':
      return 'run.failed'
    case 'cancelled':
      return 'run.cancelled'
    case 'interrupted':
      return 'run.interrupted'
    default:
      return null
  }
}

export function emitCanvasNodeEvent(
  event: Omit<CanvasNodeEvent, 'eventId' | 'timestamp' | 'projectId'> & {
    projectId?: string
  }
): CanvasNodeEvent {
  const complete: CanvasNodeEvent = {
    ...event,
    eventId: nanoid(),
    projectId: event.projectId ?? activeProjectId(),
    timestamp: Date.now()
  }
  for (const listener of listeners) listener(complete)
  for (const subscription of subscriptions.values()) {
    if (
      subscription.projectId !== complete.projectId ||
      subscription.nodeId !== complete.nodeId ||
      !subscription.events.has(complete.type)
    ) {
      continue
    }
    const waiter = subscription.waiters.shift()
    if (waiter) waiter(complete)
    else subscription.queue.push(complete)
  }
  return complete
}

export function onCanvasNodeEvent(listener: (event: CanvasNodeEvent) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function subscribeCanvasNodeEvents(args: {
  nodeId: string
  events: CanvasNodeEventType[]
  projectId?: string
}): string {
  const id = nanoid()
  subscriptions.set(id, {
    id,
    projectId: args.projectId ?? activeProjectId(),
    nodeId: args.nodeId,
    events: new Set(args.events),
    queue: [],
    waiters: []
  })
  for (const listener of subscriptionListeners) listener()
  return id
}

export function unsubscribeCanvasNodeEvents(subscriptionId: string): void {
  const subscription = subscriptions.get(subscriptionId)
  if (!subscription) return
  subscriptions.delete(subscriptionId)
  subscription.waiters.splice(0).forEach((resolve) => resolve(null))
  for (const listener of subscriptionListeners) listener()
}

export function onCanvasSubscriptionChange(listener: () => void): () => void {
  subscriptionListeners.add(listener)
  return () => subscriptionListeners.delete(listener)
}

export function getCanvasNodeSubscriptionSnapshot(subscriptionId: string): {
  nodeId: string
  execution: NodeExecutionSnapshot | null
} | null {
  const subscription = subscriptions.get(subscriptionId)
  return subscription
    ? {
        nodeId: subscription.nodeId,
        execution: getNodeExecution(subscription.nodeId, subscription.projectId)
      }
    : null
}

export function getCanvasNodeSubscriptionCount(
  nodeId: string,
  projectId = activeProjectId()
): number {
  return [...subscriptions.values()].filter(
    (subscription) => subscription.projectId === projectId && subscription.nodeId === nodeId
  ).length
}

export async function waitForCanvasNodeEvent(args: {
  subscriptionId: string
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<CanvasNodeEvent | null> {
  const subscription = subscriptions.get(args.subscriptionId)
  if (!subscription) return null
  const queued = subscription.queue.shift()
  if (queued) return queued
  const timeoutMs = Math.min(Math.max(0, args.timeoutMs ?? MAX_WAIT_MS), MAX_WAIT_MS)
  return await new Promise<CanvasNodeEvent | null>((resolve) => {
    let settled = false
    const finish = (event: CanvasNodeEvent | null): void => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      args.signal?.removeEventListener('abort', onAbort)
      const index = subscription.waiters.indexOf(finish)
      if (index >= 0) subscription.waiters.splice(index, 1)
      resolve(event)
    }
    const onAbort = (): void => finish(null)
    const timer = window.setTimeout(() => finish(null), timeoutMs)
    subscription.waiters.push(finish)
    args.signal?.addEventListener('abort', onAbort, { once: true })
    if (args.signal?.aborted) onAbort()
  })
}

export function getNodeExecution(
  nodeId: string,
  projectId = activeProjectId()
): NodeExecutionSnapshot | null {
  if (projectId !== activeProjectId()) {
    return (
      readPersistedProjectGraph(projectId)?.nodes.find((node) => node.id === nodeId)?.execution ??
      null
    )
  }
  return useGraphStore.getState().nodes.find((node) => node.id === nodeId)?.execution ?? null
}

function withLegacyState(node: CanvasNode, execution: NodeExecutionSnapshot): CanvasNode {
  if (node.kind !== 'image' && node.kind !== 'video') return { ...node, execution }
  const generating = execution.status === 'queued' || execution.status === 'running'
  const error = execution.status === 'failed' ? execution.error : undefined
  const interrupted = execution.status === 'interrupted' ? true : undefined
  return {
    ...node,
    execution,
    data: {
      ...node.data,
      generating,
      error,
      interrupted,
      ...(node.kind === 'video'
        ? { status: generating ? (node.data.status ?? execution.status) : undefined }
        : {})
    }
  } as CanvasNode
}

export function startNodeExecution(
  nodeId: string,
  options?: { runId?: string; projectId?: string; outputNodeIds?: string[] }
): NodeExecutionSnapshot | null {
  const graph = useGraphStore.getState()
  const node = graph.nodes.find((candidate) => candidate.id === nodeId)
  if (!node) return null
  const execution: NodeExecutionSnapshot = {
    runId: options?.runId ?? nanoid(),
    status: 'queued',
    startedAt: Date.now(),
    ...(options?.outputNodeIds ? { outputNodeIds: options.outputNodeIds } : {})
  }
  graph.updateNode(nodeId, (current) => withLegacyState(current, execution))
  emitCanvasNodeEvent({
    projectId: options?.projectId,
    nodeId,
    runId: execution.runId,
    type: 'run.queued',
    payload: { status: execution.status, outputNodeIds: execution.outputNodeIds ?? [] }
  })
  return execution
}

export function updateNodeExecution(
  nodeId: string,
  status: NodeExecutionStatus,
  options?: {
    runId?: string
    projectId?: string
    progress?: number
    error?: string
    outputNodeIds?: string[]
    payload?: Record<string, unknown>
  }
): NodeExecutionSnapshot | null {
  const requestedProjectId = options?.projectId
  if (requestedProjectId && requestedProjectId !== activeProjectId()) {
    const holder: { execution: NodeExecutionSnapshot | null } = { execution: null }
    patchPersistedProjectGraph(requestedProjectId, (stored) => ({
      ...stored,
      nodes: stored.nodes.map((node) => {
        if (node.id !== nodeId) return node
        const previous = node.execution
        const now = Date.now()
        const terminal = ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(status)
        holder.execution = {
          runId: options?.runId ?? previous?.runId ?? nanoid(),
          status,
          startedAt: previous?.startedAt ?? now,
          ...(terminal ? { finishedAt: now } : {}),
          ...(typeof options?.progress === 'number' ? { progress: options.progress } : {}),
          ...(options?.error ? { error: options.error } : {}),
          ...((options?.outputNodeIds ?? previous?.outputNodeIds)
            ? { outputNodeIds: options?.outputNodeIds ?? previous?.outputNodeIds }
            : {})
        }
        return withLegacyState(node, holder.execution)
      })
    }))
    const persistedExecution = holder.execution
    if (!persistedExecution) return null
    const type =
      typeof options?.progress === 'number' && status === 'running'
        ? 'run.progress'
        : eventTypeForStatus(status)
    if (type) {
      emitCanvasNodeEvent({
        projectId: requestedProjectId,
        nodeId,
        runId: persistedExecution.runId,
        type,
        payload: {
          status,
          ...(typeof persistedExecution.progress === 'number'
            ? { progress: persistedExecution.progress }
            : {}),
          ...(persistedExecution.error ? { error: persistedExecution.error } : {}),
          ...(persistedExecution.outputNodeIds
            ? { outputNodeIds: persistedExecution.outputNodeIds }
            : {}),
          ...options?.payload
        }
      })
    }
    return persistedExecution
  }
  const graph = useGraphStore.getState()
  const node = graph.nodes.find((candidate) => candidate.id === nodeId)
  if (!node) return null
  const previous = node.execution
  const now = Date.now()
  const terminal = ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(status)
  const execution: NodeExecutionSnapshot = {
    runId: options?.runId ?? previous?.runId ?? nanoid(),
    status,
    startedAt: previous?.startedAt ?? now,
    ...(terminal ? { finishedAt: now } : {}),
    ...(typeof options?.progress === 'number' ? { progress: options.progress } : {}),
    ...(options?.error ? { error: options.error } : {}),
    ...((options?.outputNodeIds ?? previous?.outputNodeIds)
      ? { outputNodeIds: options?.outputNodeIds ?? previous?.outputNodeIds }
      : {})
  }
  graph.updateNode(nodeId, (current) => withLegacyState(current, execution))
  const type =
    typeof options?.progress === 'number' && status === 'running'
      ? 'run.progress'
      : eventTypeForStatus(status)
  if (type) {
    emitCanvasNodeEvent({
      projectId: options?.projectId,
      nodeId,
      runId: execution.runId,
      type,
      payload: {
        status,
        ...(typeof execution.progress === 'number' ? { progress: execution.progress } : {}),
        ...(execution.error ? { error: execution.error } : {}),
        ...(execution.outputNodeIds ? { outputNodeIds: execution.outputNodeIds } : {}),
        ...options?.payload
      }
    })
  }
  return execution
}

export function emitNodeUpdated(nodeId: string, payload?: Record<string, unknown>): void {
  emitCanvasNodeEvent({ nodeId, type: 'node.updated', payload })
}
