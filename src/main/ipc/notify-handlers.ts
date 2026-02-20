import { ipcMain, BrowserWindow } from 'electron'

// Send a toast notification to the renderer process
export function showNotifyWindow(title: string, body: string, type: string = 'info', duration: number = 4000, persistent: boolean = false): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (win && !win.isDestroyed()) {
    win.webContents.send('notify:toast', { title, body, type, duration, persistent })
  }
}

export function registerNotifyHandlers(): void {
  ipcMain.handle('notify:desktop', async (_event, args: { title: string; body: string; type?: string; duration?: number; persistent?: boolean }) => {
    try {
      showNotifyWindow(
        args.title ?? 'OpenCowork',
        args.body ?? '',
        args.type ?? 'info',
        args.duration ?? 4000,
        args.persistent ?? false,
      )
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // notify:session — push a message into the renderer's session event bus
  // The renderer's App.tsx listens for 'notify:session-message' and injects it
  ipcMain.handle('notify:session', async (_event, args: { sessionId: string; title: string; body: string }) => {
    try {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win || win.isDestroyed()) {
        return { success: false, error: 'No renderer window available' }
      }
      win.webContents.send('notify:session-message', {
        sessionId: args.sessionId,
        title: args.title,
        body: args.body,
      })
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
