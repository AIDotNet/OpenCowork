import { useCallback, useEffect, useRef } from 'react'
import type { GraphActions } from './graph-actions'
import { onCanvasNodeEvent } from './canvas-events'
import { useGraphStore } from './graph-store'
import { useProjectsStore } from './draw-projects-store'
import type { CanvasNodeEvent, CanvasTrigger } from './graph-types'

const MAX_TRIGGER_DEPTH = 20
const MAX_EXECUTION_KEYS = 500
const triggerCache = new Map<string, CanvasTrigger[]>()

interface PendingTrigger {
  key: string
  triggerId: string
  event: CanvasNodeEvent
}

export function createsTriggerCycle(
  triggers: CanvasTrigger[],
  sourceNodeId: string,
  targetNodeId: string,
  ignoreTriggerId?: string
): boolean {
  if (sourceNodeId === targetNodeId) return true
  const outgoing = new Map<string, string[]>()
  for (const trigger of triggers) {
    if (!trigger.enabled || trigger.id === ignoreTriggerId) continue
    const targets = outgoing.get(trigger.sourceNodeId) ?? []
    targets.push(trigger.targetNodeId)
    outgoing.set(trigger.sourceNodeId, targets)
  }
  const proposed = outgoing.get(sourceNodeId) ?? []
  proposed.push(targetNodeId)
  outgoing.set(sourceNodeId, proposed)
  const seen = new Set<string>()
  const visit = (nodeId: string): boolean => {
    if (nodeId === sourceNodeId) return true
    if (seen.has(nodeId)) return false
    seen.add(nodeId)
    return (outgoing.get(nodeId) ?? []).some(visit)
  }
  return visit(targetNodeId)
}

export function validateCanvasTriggers(triggers: CanvasTrigger[]): boolean {
  return triggers.every(
    (trigger) =>
      !createsTriggerCycle(
        triggers.filter((candidate) => candidate.id !== trigger.id),
        trigger.sourceNodeId,
        trigger.targetNodeId
      )
  )
}

/** Execute persisted node-event triggers while the draw workspace is mounted. */
export function useCanvasTriggers(actions: GraphActions): void {
  const activeProjectId = useProjectsStore((state) => state.activeProjectId) ?? 'default'
  const executedRef = useRef(new Set<string>())
  const queuedRef = useRef(new Set<string>())
  const pendingRef = useRef(new Map<string, PendingTrigger[]>())
  const depthRef = useRef(0)

  const execute = useCallback(
    (trigger: CanvasTrigger, key: string): void => {
      const executed = executedRef.current
      queuedRef.current.delete(key)
      if (executed.has(key) || depthRef.current >= MAX_TRIGGER_DEPTH) return
      executed.add(key)
      if (executed.size > MAX_EXECUTION_KEYS) {
        const oldest = executed.values().next().value
        if (oldest) executed.delete(oldest)
      }
      const target = useGraphStore.getState().nodes.find((node) => node.id === trigger.targetNodeId)
      if (!target || ['queued', 'running'].includes(target.execution?.status ?? '')) return
      depthRef.current += 1
      void actions.runNode(target.id).finally(() => {
        depthRef.current = Math.max(0, depthRef.current - 1)
      })
    },
    [actions]
  )

  useEffect(() => {
    const cache = (triggers = useGraphStore.getState().triggers): void => {
      const projectId = useProjectsStore.getState().activeProjectId ?? 'default'
      triggerCache.set(projectId, triggers)
    }
    cache()
    return useGraphStore.subscribe((state, previous) => {
      if (state.triggers !== previous.triggers) cache(state.triggers)
    })
  }, [])

  useEffect(() => {
    return onCanvasNodeEvent((event) => {
      const currentProjectId = useProjectsStore.getState().activeProjectId ?? 'default'
      const triggers = (
        event.projectId === currentProjectId
          ? useGraphStore.getState().triggers
          : (triggerCache.get(event.projectId) ?? [])
      ).filter(
        (trigger) =>
          trigger.enabled && trigger.sourceNodeId === event.nodeId && trigger.event === event.type
      )
      for (const trigger of triggers) {
        const key = `${trigger.id}:${event.runId ?? event.eventId}:${event.type}`
        if (executedRef.current.has(key) || queuedRef.current.has(key)) continue
        if (event.projectId === currentProjectId) {
          execute(trigger, key)
          continue
        }
        queuedRef.current.add(key)
        const pending = pendingRef.current.get(event.projectId) ?? []
        pending.push({ key, triggerId: trigger.id, event })
        pendingRef.current.set(event.projectId, pending)
      }
    })
  }, [execute])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if ((useProjectsStore.getState().activeProjectId ?? 'default') !== activeProjectId) return
      const pending = pendingRef.current.get(activeProjectId)
      if (!pending?.length) return
      pendingRef.current.delete(activeProjectId)
      const triggers = useGraphStore.getState().triggers
      for (const item of pending) {
        const trigger = triggers.find(
          (candidate) =>
            candidate.id === item.triggerId &&
            candidate.enabled &&
            candidate.sourceNodeId === item.event.nodeId &&
            candidate.event === item.event.type
        )
        if (trigger) execute(trigger, item.key)
        else queuedRef.current.delete(item.key)
      }
    }, 0)
    return () => window.clearTimeout(timer)
  }, [activeProjectId, execute])
}
