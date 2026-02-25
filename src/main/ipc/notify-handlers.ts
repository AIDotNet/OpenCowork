import { ipcMain, Notification } from 'electron'

// Deduplication cache to prevent duplicate notifications
const notificationCache = new Map<string, number>()
const DEBOUNCE_MS = 2000 // Prevent same notification within 2 seconds

// Send a system notification using Electron's native Notification API
export function showSystemNotification(title: string, body: string): void {
  console.log('[Notify] Attempting to show notification:', { title, body })

  // Create a cache key from title + body
  const cacheKey = `${title}:${body}`
  const now = Date.now()
  const lastShown = notificationCache.get(cacheKey)

  // Skip if same notification was shown recently
  if (lastShown && now - lastShown < DEBOUNCE_MS) {
    console.log('[Notify] Skipping duplicate notification:', title)
    return
  }

  // Update cache
  notificationCache.set(cacheKey, now)

  // Clean up old cache entries (older than 5 seconds)
  for (const [key, timestamp] of notificationCache.entries()) {
    if (now - timestamp > 5000) {
      notificationCache.delete(key)
    }
  }

  try {
    const notification = new Notification({
      title,
      body,
      silent: false,
      urgency: 'critical', // Force notification to show even in focus assist mode
      timeoutType: 'default',
    })

    notification.on('show', () => {
      console.log('[Notify] Notification shown successfully')
    })

    notification.on('failed', (event, error) => {
      console.error('[Notify] Notification failed:', error)
    })

    notification.show()
    console.log('[Notify] Notification.show() called')
  } catch (err) {
    console.error('[Notify] Error creating notification:', err)
  }
}

export function registerNotifyHandlers(): void {
  ipcMain.handle('notify:desktop', async (_event, args: { title: string; body: string; type?: string; duration?: number }) => {
    try {
      showSystemNotification(
        args.title ?? 'OpenCowork',
        args.body ?? '',
      )
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
