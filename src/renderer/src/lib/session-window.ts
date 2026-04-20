import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { useChatStore } from '@renderer/stores/chat-store'
import { useUIStore } from '@renderer/stores/ui-store'

interface SessionWindowHandledResult {
  handled?: boolean
}

interface SessionWindowOpenResult extends SessionWindowHandledResult {
  error?: string
}

function openSessionLocally(sessionId: string): void {
  useChatStore.getState().setActiveSession(sessionId)
  useUIStore.getState().navigateToSession(sessionId)
}

export async function focusDetachedSessionWindowIfOpen(sessionId: string): Promise<boolean> {
  try {
    const result = (await ipcClient.invoke(
      IPC.SESSION_WINDOW_FOCUS_IF_OPEN,
      sessionId
    )) as SessionWindowHandledResult | null

    return result?.handled === true
  } catch (error) {
    console.error('[SessionWindow] Failed to focus detached session window:', sessionId, error)
    return false
  }
}

export async function openDetachedSessionWindow(sessionId: string): Promise<boolean> {
  try {
    const result = (await ipcClient.invoke(
      IPC.SESSION_WINDOW_OPEN,
      sessionId
    )) as SessionWindowOpenResult | null

    return result?.handled === true && !result?.error
  } catch (error) {
    console.error('[SessionWindow] Failed to open detached session window:', sessionId, error)
    return false
  }
}

export async function openSessionOrFocusDetached(sessionId: string): Promise<void> {
  const handled = await focusDetachedSessionWindowIfOpen(sessionId)
  if (handled) return
  openSessionLocally(sessionId)
}
