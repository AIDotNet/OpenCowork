import { BrowserWindow, webContents } from 'electron'
import {
  encodeMessagePackPayload,
  toMessagePackChannel
} from '../../../shared/messagepack/binary-ipc'
import { RUNTIME_PATCH_CHANNEL } from '../../../shared/runtime-contracts/generated/ipc'
import type { RuntimeEventEnvelope } from '../../../shared/runtime-contracts/generated/contracts'
import { safePostMessageToWindow } from '../../window-ipc'

type Subscriber = {
  subscriberId: string
  webContentsId: number
  sessionId: string | null
}

export class RuntimeWindowRouter {
  private readonly subscribers = new Map<string, Subscriber>()

  bind(subscriberId: string, contentsId: number, sessionId: string | null = null): void {
    this.subscribers.set(subscriberId, { subscriberId, webContentsId: contentsId, sessionId })
  }

  unbind(subscriberId: string): void {
    this.subscribers.delete(subscriberId)
  }

  setSessionFilter(subscriberId: string, sessionId: string | null): void {
    const existing = this.subscribers.get(subscriberId)
    if (!existing) return
    this.subscribers.set(subscriberId, { ...existing, sessionId })
  }

  fanout(envelopes: RuntimeEventEnvelope[]): void {
    if (envelopes.length === 0) return
    for (const subscriber of [...this.subscribers.values()]) {
      const filtered = subscriber.sessionId
        ? envelopes.filter(
            (envelope) => envelope.sessionId === subscriber.sessionId || envelope.sessionId === null
          )
        : envelopes
      if (filtered.length === 0) continue
      this.post(subscriber, filtered)
    }
  }

  private post(subscriber: Subscriber, envelopes: RuntimeEventEnvelope[]): void {
    const contents = webContents.fromId(subscriber.webContentsId)
    if (!contents || contents.isDestroyed() || contents.isCrashed()) {
      this.unbind(subscriber.subscriberId)
      return
    }
    const window = BrowserWindow.fromWebContents(contents)
    if (!window || window.isDestroyed()) {
      this.unbind(subscriber.subscriberId)
      return
    }
    const sent = safePostMessageToWindow(
      window,
      toMessagePackChannel(RUNTIME_PATCH_CHANNEL),
      encodeMessagePackPayload(envelopes)
    )
    if (!sent) this.unbind(subscriber.subscriberId)
  }
}
