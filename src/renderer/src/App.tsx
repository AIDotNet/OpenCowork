import { useEffect } from 'react'
import { Layout } from './components/layout/Layout'
import { Toaster } from './components/ui/sonner'
import { ConfirmDialogProvider } from './components/ui/confirm-dialog'
import { ThemeProvider } from './components/theme-provider'
import { ErrorBoundary } from './components/error-boundary'
import { useSettingsStore } from './stores/settings-store'
import { initProviderStore } from './stores/provider-store'
import { useChatStore } from './stores/chat-store'
import { usePlanStore } from './stores/plan-store'
import { registerAllTools, updateWebSearchToolRegistration } from './lib/tools'
import { registerAllProviders } from './lib/api'
import { registerAllViewers } from './lib/preview/register-viewers'
import { initPluginEventListener } from './stores/plugin-store'
import { usePluginAutoReply } from './hooks/use-plugin-auto-reply'
import { toast } from 'sonner'
import i18n from './locales'
import { cronEvents } from './lib/tools/cron-events'
import { useCronStore } from './stores/cron-store'
import { ipcClient } from './lib/ipc/ipc-client'
import { runCronAgent } from './lib/tools/cron-agent-runner'
import { useChatStore as _useChatStore } from './stores/chat-store'
import { nanoid } from 'nanoid'
import type { UnifiedMessage } from './lib/api/types'
import { useNotifyStore } from './stores/notify-store'
import { NotifyToastContainer } from './components/notify/NotifyWindow'
import {
  getGlobalMemorySnapshot,
  loadGlobalMemorySnapshot,
  subscribeGlobalMemoryUpdates,
  type GlobalMemorySnapshot
} from './lib/agent/memory-files'

// Register synchronous providers and viewers immediately at startup
registerAllProviders()
registerAllViewers()
initProviderStore()

// Register tools (async because SubAgents are loaded from .md files via IPC)
registerAllTools().catch((err) => console.error('[App] Failed to register tools:', err))

// Initialize plugin incoming event listener
initPluginEventListener()

const GLOBAL_MEMORY_REMINDER_MARKER = '[global-memory-update]'
const globalMemoryVersionBySession = new Map<string, number>()

function buildGlobalMemoryReminder(snapshot: GlobalMemorySnapshot): string {
  const pathLabel = snapshot.path ? `\`${snapshot.path}\`` : 'path unavailable'
  const timeLabel = snapshot.updatedAt
    ? new Date(snapshot.updatedAt).toLocaleString()
    : new Date().toLocaleString()
  const statusLine = snapshot.content
    ? `Global memory updated (${timeLabel}).`
    : `Global memory unavailable or empty (${timeLabel}).`
  return [
    '<system-reminder>',
    GLOBAL_MEMORY_REMINDER_MARKER,
    statusLine,
    `Path: ${pathLabel}`,
    '</system-reminder>'
  ].join('\n')
}

function upsertGlobalMemoryReminder(sessionId: string, snapshot: GlobalMemorySnapshot): void {
  const store = _useChatStore.getState()
  const messages = store.getSessionMessages(sessionId)
  const reminder = buildGlobalMemoryReminder(snapshot)
  const existing = [...messages].reverse().find((msg) => {
    if (msg.role !== 'system') return false
    if (typeof msg.content !== 'string') return false
    return msg.content.includes(GLOBAL_MEMORY_REMINDER_MARKER)
  })

  if (existing) {
    store.updateMessage(sessionId, existing.id, { content: reminder })
    return
  }

  const msg: UnifiedMessage = {
    id: nanoid(),
    role: 'system',
    content: reminder,
    createdAt: Date.now(),
  }
  store.addMessage(sessionId, msg)
}

function App(): React.JSX.Element {
  const theme = useSettingsStore((s) => s.theme)

  // Initialize plugin auto-reply agent loop listener
  usePluginAutoReply()

  // Load sessions and plans from SQLite on startup
  useEffect(() => {
    useChatStore.getState().loadFromDb()
    usePlanStore.getState().loadPlansFromDb()
    window.electron.ipcRenderer
      .invoke('settings:get', 'apiKey')
      .then((key) => {
        if (typeof key === 'string' && key) {
          useSettingsStore.getState().updateSettings({ apiKey: key })
        }
      })
      .catch(() => {
        // Ignore — main process may not have a stored key yet
      })
  }, [])

  // Watch global memory file and refresh system context on changes
  useEffect(() => {
    let disposed = false
    let ready = false
    let baselineVersion = 0

    const init = async () => {
      await loadGlobalMemorySnapshot(ipcClient)
      const snapshot = getGlobalMemorySnapshot()
      baselineVersion = snapshot.version
      ready = true
    }

    void init()

    const unsubscribe = subscribeGlobalMemoryUpdates((snapshot) => {
      if (disposed || !ready) return
      if (snapshot.version <= baselineVersion) return

      const sessionId = _useChatStore.getState().activeSessionId
      if (!sessionId) return

      const lastVersion = globalMemoryVersionBySession.get(sessionId) ?? 0
      if (snapshot.version <= lastVersion) return

      globalMemoryVersionBySession.set(sessionId, snapshot.version)
      upsertGlobalMemoryReminder(sessionId, snapshot)
    })

    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])

  // Cron data is global: load once on mount.
  useEffect(() => {
    void useCronStore.getState().loadJobs()
    void useCronStore.getState().loadRuns()
  }, [])

  // Forward cron:fired IPC events to the renderer-side event bus
  useEffect(() => {
    const offFired = ipcClient.on('cron:fired', (data: unknown) => {
      const d = data as {
        jobId: string
        sessionId?: string | null
        name?: string
        prompt?: string
        agentId?: string | null
        model?: string | null
        workingFolder?: string | null
        deliveryMode?: string
        deliveryTarget?: string | null
        maxIterations?: number
        pluginId?: string | null
        pluginChatId?: string | null
        error?: string
      }
      cronEvents.emit({ type: 'fired', ...d })
      useCronStore.getState().updateJob(d.jobId, { lastFiredAt: Date.now() })

      // Launch Agent autonomously
      if (d.prompt) {
        runCronAgent({
          jobId: d.jobId,
          name: d.name,
          sessionId: d.sessionId ?? null,
          prompt: d.prompt,
          agentId: d.agentId,
          model: d.model,
          workingFolder: d.workingFolder,
          deliveryMode: d.deliveryMode,
          deliveryTarget: d.deliveryTarget,
          maxIterations: d.maxIterations,
          pluginId: d.pluginId,
          pluginChatId: d.pluginChatId,
        })
      }
    })

    const offRemoved = ipcClient.on('cron:job-removed', (data: unknown) => {
      const d = data as { jobId: string; reason: string }
      cronEvents.emit({ type: 'job_removed', jobId: d.jobId, reason: d.reason as 'delete_after_run' | 'manual' })
      useCronStore.getState().removeJob(d.jobId)
    })

    // notify:session-message — inject a message into a session from the Notify tool
    const offNotify = ipcClient.on('notify:session-message', (data: unknown) => {
      const d = data as { sessionId: string; title: string; body: string }
      const sessions = _useChatStore.getState().sessions
      if (!sessions.some((s) => s.id === d.sessionId)) return
      const msg: UnifiedMessage = {
        id: nanoid(),
        role: 'assistant',
        content: `<system-reminder>\n**${d.title}**\n</system-reminder>\n\n${d.body}`,
        createdAt: Date.now(),
      }
      _useChatStore.getState().addMessage(d.sessionId, msg)
    })

    // Subscribe to cron run_finished events for session delivery
    const offRunFinished = cronEvents.on((event) => {
      if (event.type !== 'run_finished') return
      if (event.deliveryMode !== 'session') return

      const targetSessionId = event.deliveryTarget || event.sessionId || _useChatStore.getState().activeSessionId
      if (!targetSessionId) return
      const sessions = _useChatStore.getState().sessions
      if (!sessions.some((s) => s.id === targetSessionId)) return

      const statusLabel = event.status === 'success' ? '✅ 成功' : event.status === 'error' ? '❌ 失败' : '⚠️ 中止'
      const content = [
        `<system-reminder>`,
        `Cron 任务 "${event.jobName || event.jobId}" 执行完成 (${statusLabel}, ${event.toolCallCount} tool calls)`,
        `</system-reminder>`,
        '',
        event.error ? `**Error:** ${event.error}` : (event.outputSummary || '(no output)'),
      ].join('\n')

      const msg: UnifiedMessage = {
        id: nanoid(),
        role: 'user',
        content,
        createdAt: Date.now(),
      }
      _useChatStore.getState().addMessage(targetSessionId, msg)
    })

    return () => {
      offFired()
      offRemoved()
      offNotify()
      offRunFinished()
    }
  }, [])

  // Listen for app update notifications from main process
  useEffect(() => {
    const offUpdateAvailable = ipcClient.on('update:available', (data: unknown) => {
      const d = data as { currentVersion: string; newVersion: string; releaseNotes: string }
      console.log('[App] Update available:', d)

      useNotifyStore.getState().push(
        `🎉 新版本 ${d.newVersion} 可用`,
        d.releaseNotes || '点击下载按钮开始更新',
        {
          type: 'info',
          persistent: true,
          actions: [
            {
              label: '立即更新',
              onClick: async () => {
                toast.info('开始下载更新...')
                const result = await window.electron.ipcRenderer.invoke('update:download')
                if (!result.success) {
                  toast.error('下载失败', { description: result.error })
                }
              },
            },
            {
              label: '稍后提醒',
              onClick: () => {
                toast.info('已推迟更新')
              },
            },
          ],
        }
      )
    })

    const offUpdateDownloaded = ipcClient.on('update:downloaded', (data: unknown) => {
      const d = data as { version: string }
      toast.success('更新已下载', {
        description: `版本 ${d.version} 将在应用重启后安装`,
      })
    })

    const offUpdateError = ipcClient.on('update:error', (data: unknown) => {
      const d = data as { error: string }
      toast.error('更新失败', { description: d.error })
    })

    return () => {
      offUpdateAvailable()
      offUpdateDownloaded()
      offUpdateError()
    }
  }, [])

  // Sync i18n language with settings store
  const language = useSettingsStore((s) => s.language)
  useEffect(() => {
    if (i18n.language !== language) {
      i18n.changeLanguage(language)
    }
  }, [language])

  // Update web search tool registration based on settings
  const webSearchEnabled = useSettingsStore((s) => s.webSearchEnabled)
  useEffect(() => {
    updateWebSearchToolRegistration(webSearchEnabled)
  }, [webSearchEnabled])

  // Global unhandled promise rejection handler
  useEffect(() => {
    const handler = (e: PromiseRejectionEvent): void => {
      console.error('[Unhandled Rejection]', e.reason)
      toast.error('Unhandled Error', {
        description: e.reason?.message || String(e.reason),
      })
    }
    window.addEventListener('unhandledrejection', handler)
    return () => window.removeEventListener('unhandledrejection', handler)
  }, [])

  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme={theme}>
        <Layout />
        <Toaster position="bottom-left" theme="system" richColors />
        <ConfirmDialogProvider />
        <NotifyToastContainer />
      </ThemeProvider>
    </ErrorBoundary>
  )
}

export default App
