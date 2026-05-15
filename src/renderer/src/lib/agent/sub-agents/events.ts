import type { SubAgentEvent } from './types'

type SubAgentEventListener = (event: SubAgentEvent) => void

/**
 * Session-scoped event bus for SubAgent events.
 * The SubAgent tool handler emits events here during execution,
 * and use-chat-actions subscribes per session to forward them to the agent store.
 */
class SubAgentEventBus {
  private listenersBySession = new Map<string, Set<SubAgentEventListener>>()

  on(sessionId: string | null | undefined, listener: SubAgentEventListener): () => void {
    const key = sessionId?.trim() || '__global__'
    let listeners = this.listenersBySession.get(key)
    if (!listeners) {
      listeners = new Set()
      this.listenersBySession.set(key, listeners)
    }
    listeners.add(listener)

    return () => {
      const current = this.listenersBySession.get(key)
      if (!current) return
      current.delete(listener)
      if (current.size === 0) {
        this.listenersBySession.delete(key)
      }
    }
  }

  emit(sessionId: string | null | undefined, event: SubAgentEvent): void {
    const key = sessionId?.trim() || '__global__'
    const listeners = this.listenersBySession.get(key)
    if (!listeners) return

    for (const listener of listeners) {
      listener(event)
    }
  }
}

export const subAgentEvents = new SubAgentEventBus()
