import { BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { normalizeRendererRequestRecord, readNonEmptyString } from './request-utils'

export function isUsableRendererWindow(
  window: BrowserWindow | null | undefined
): window is BrowserWindow {
  return (
    !!window &&
    !window.isDestroyed() &&
    !window.webContents.isDestroyed() &&
    !window.webContents.isCrashed()
  )
}

function pickFallbackRendererWindow(): BrowserWindow | null {
  const focusedWindow = BrowserWindow.getFocusedWindow()
  const candidateWindows = focusedWindow
    ? [focusedWindow, ...BrowserWindow.getAllWindows().filter((win) => win !== focusedWindow)]
    : BrowserWindow.getAllWindows()

  return candidateWindows.find((win) => isUsableRendererWindow(win)) ?? null
}

export class RunTargetRouter {
  private readonly runWindowIds = new Map<string, number>()
  private readonly sessionWindowIds = new Map<string, number>()
  private readonly attachedWindowsByRun = new Map<string, Set<number>>()

  getRunWindowId(runId: string): number | null {
    return this.runWindowIds.get(runId) ?? null
  }

  getSessionWindowId(sessionId: string): number | null {
    return this.sessionWindowIds.get(sessionId) ?? null
  }

  rememberOrigin(event: IpcMainInvokeEvent, params: unknown, resolvedRunId?: string): void {
    const sourceWindow = BrowserWindow.fromWebContents(event.sender)
    if (!isUsableRendererWindow(sourceWindow)) return
    const record = normalizeRendererRequestRecord(params)
    this.bindPrimary(
      readNonEmptyString(record.runId),
      readNonEmptyString(record.sessionId),
      sourceWindow.id,
      resolvedRunId
    )
  }

  bindPrimary(
    runId: string | undefined,
    sessionId: string | undefined,
    windowId: number,
    resolvedRunId?: string
  ): void {
    if (runId) this.runWindowIds.set(runId, windowId)
    if (resolvedRunId) this.runWindowIds.set(resolvedRunId, windowId)
    if (sessionId) this.sessionWindowIds.set(sessionId, windowId)
  }

  attachObserver(runId: string, windowId: number): void {
    let attached = this.attachedWindowsByRun.get(runId)
    if (!attached) {
      attached = new Set()
      this.attachedWindowsByRun.set(runId, attached)
    }
    attached.add(windowId)
  }

  forgetPrimary(runId: string): void {
    this.runWindowIds.delete(runId)
  }

  forgetRun(runId: string): void {
    this.forgetPrimary(runId)
    this.attachedWindowsByRun.delete(runId)
  }

  setSessionWindow(sessionId: string, window: BrowserWindow, visible: boolean): void {
    if (visible) {
      this.sessionWindowIds.set(sessionId, window.id)
      return
    }
    if (this.sessionWindowIds.get(sessionId) === window.id) {
      this.sessionWindowIds.delete(sessionId)
    }
  }

  resolve(params: unknown, options?: { allowFallback?: boolean }): BrowserWindow | null {
    const record = normalizeRendererRequestRecord(params)
    const agentRunId = readNonEmptyString(record.agentRunId)
    const runId = readNonEmptyString(record.runId)
    const sessionId = readNonEmptyString(record.sessionId)
    const mappedWindowIds = [
      agentRunId ? this.runWindowIds.get(agentRunId) : undefined,
      runId ? this.runWindowIds.get(runId) : undefined,
      sessionId ? this.sessionWindowIds.get(sessionId) : undefined
    ]

    for (const windowId of mappedWindowIds) {
      if (typeof windowId !== 'number') continue
      const mappedWindow = BrowserWindow.fromId(windowId)
      if (isUsableRendererWindow(mappedWindow)) {
        return mappedWindow
      }
    }

    if (agentRunId) this.runWindowIds.delete(agentRunId)
    if (runId) this.runWindowIds.delete(runId)
    if (sessionId) this.sessionWindowIds.delete(sessionId)
    if (options?.allowFallback === false && sessionId) return null
    return pickFallbackRendererWindow()
  }

  forEachObserver(runId: string, visit: (window: BrowserWindow) => void): void {
    const attached = this.attachedWindowsByRun.get(runId)
    if (!attached) return
    for (const windowId of Array.from(attached)) {
      const extraWindow = BrowserWindow.fromId(windowId)
      if (!isUsableRendererWindow(extraWindow)) {
        attached.delete(windowId)
        continue
      }
      visit(extraWindow)
    }
    if (attached.size === 0) this.attachedWindowsByRun.delete(runId)
  }
}
