import type { TeamEvent } from './types'

type TeamEventListener = (event: TeamEvent) => void

/**
 * Simple event bus for Team events.
 * Team tool handlers emit events here during execution,
 * and use-chat-actions subscribes to forward them to the team store.
 */
class TeamEventBus {
  private listeners = new Set<TeamEventListener>()

  on(listener: TeamEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(event: TeamEvent): void {
    for (const listener of this.listeners) {
      listener(event)
    }
  }
}

export const teamEvents = new TeamEventBus()
