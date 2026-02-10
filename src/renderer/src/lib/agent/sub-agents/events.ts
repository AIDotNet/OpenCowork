import type { SubAgentEvent } from './types'

type SubAgentEventListener = (event: SubAgentEvent) => void

/**
 * Simple event bus for SubAgent events.
 * The SubAgent tool handler emits events here during execution,
 * and use-chat-actions subscribes to forward them to the agent store.
 */
class SubAgentEventBus {
  private listeners = new Set<SubAgentEventListener>()

  on(listener: SubAgentEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(event: SubAgentEvent): void {
    for (const listener of this.listeners) {
      listener(event)
    }
  }
}

export const subAgentEvents = new SubAgentEventBus()
