import { ipcMain } from 'electron'
import { getMessages, getSession } from '../db/messages-dao'
import { getSession as getSessionInfo } from '../db/sessions-dao'

interface ReportPayload {
  sessionId: string
  serverUrl: string
  token: string
}

// Queue for pending reports
const reportQueue: ReportPayload[] = []
let isProcessing = false

async function processQueue(): Promise<void> {
  if (isProcessing || reportQueue.length === 0) return
  
  isProcessing = true
  
  while (reportQueue.length > 0) {
    const payload = reportQueue.shift()
    if (!payload) continue
    
    try {
      await sendReportToServer(payload)
      console.log(`[SessionReport] ✅ Report sent for session: ${payload.sessionId}`)
    } catch (error) {
      console.error(`[SessionReport] ❌ Failed to send report:`, error)
      // Put back to queue for retry
      reportQueue.unshift(payload)
      break
    }
  }
  
  isProcessing = false
}

async function sendReportToServer(payload: ReportPayload): Promise<void> {
  const { sessionId, serverUrl, token } = payload
  
  // Get session info
  const sessionInfo = getSessionInfo(sessionId)
  if (!sessionInfo) {
    throw new Error(`Session not found: ${sessionId}`)
  }
  
  // Get all messages
  const messages = getMessages(sessionId)
  
  const reportData = {
    sessionId: sessionInfo.id,
    sessionTitle: sessionInfo.title,
    deviceInfo: `${process.platform} ${process.arch}`,
    messages: messages.map(msg => ({
      id: msg.id,
      role: msg.role,
      content: msg.content,
      meta: msg.meta,
      createdAt: msg.created_at,
      usage: msg.usage,
      sortOrder: msg.sort_order
    }))
  }
  
  const response = await fetch(`${serverUrl}/api/sessions/report`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify(reportData)
  })
  
  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Server responded with ${response.status}: ${error}`)
  }
  
  return response.json()
}

export function registerSessionReportHandlers(): void {
  // Trigger session report
  ipcMain.handle('session:report', async (_event, payload: ReportPayload) => {
    try {
      reportQueue.push(payload)
      // Process queue asynchronously
      setTimeout(() => processQueue(), 1000)
      return { success: true }
    } catch (error: any) {
      console.error('[SessionReport] Error:', error)
      return { success: false, error: error.message }
    }
  })
  
  // Get report status
  ipcMain.handle('session:report-status', async () => {
    return {
      queueLength: reportQueue.length,
      isProcessing
    }
  })
}

export function triggerSessionReport(sessionId: string, serverUrl: string, token: string): void {
  reportQueue.push({ sessionId, serverUrl, token })
  setTimeout(() => processQueue(), 2000)
}
