import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Layout } from './components/layout/Layout'
import { Toaster } from './components/ui/sonner'
import { confirm, ConfirmDialogProvider } from './components/ui/confirm-dialog'
import { ThemeProvider } from './components/theme-provider'
import { ErrorBoundary } from './components/error-boundary'
import { useSettingsStore } from './stores/settings-store'
import { initProviderStore, useProviderStore } from './stores/provider-store'
import { initAppPluginStore, useAppPluginStore } from './stores/app-plugin-store'
import { useChatStore } from './stores/chat-store'
import { usePlanStore } from './stores/plan-store'
import { useSshStore } from './stores/ssh-store'
import { registerAllTools, updateWebSearchToolRegistration } from './lib/tools'
import { updateAppPluginToolRegistration } from './lib/app-plugin'
import { registerAllProviders } from './lib/api'
import { registerAllViewers } from './lib/preview/register-viewers'
import { initChannelEventListener } from './stores/channel-store'
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
initAppPluginStore()

// Register tools (async because SubAgents are loaded from .md files via IPC)
registerAllTools().catch((err) => console.error('[App] Failed to register tools:', err))

// Initialize channel incoming event listener
initChannelEventListener()

const GLOBAL_MEMORY_REMINDER_MARKER = '[global-memory-update]'
const globalMemoryVersionBySession = new Map<string, number>()

function normalizeVersion(version: string | null | undefined): string {
  return (version ?? '').trim().replace(/^v/i, '')
}

function compareVersions(left: string, right: string): number {
  const leftParts = normalizeVersion(left).split('-')[0].split('.')
  const rightParts = normalizeVersion(right).split('-')[0].split('.')
  const length = Math.max(leftParts.length, rightParts.length)

  for (let index = 0; index < length; index += 1) {
    const leftValue = Number.parseInt(leftParts[index] ?? '0', 10)
    const rightValue = Number.parseInt(rightParts[index] ?? '0', 10)
    const safeLeftValue = Number.isFinite(leftValue) ? leftValue : 0
    const safeRightValue = Number.isFinite(rightValue) ? rightValue : 0

    if (safeLeftValue !== safeRightValue) {
      return safeLeftValue > safeRightValue ? 1 : -1
    }
  }

  return 0
}

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
    createdAt: Date.now()
  }
  store.addMessage(sessionId, msg)
}

function App(): React.JSX.Element {
  const theme = useSettingsStore((s) => s.theme)
  const backgroundColor = useSettingsStore((s) => s.backgroundColor)
  const fontFamily = useSettingsStore((s) => s.fontFamily)
  const fontSize = useSettingsStore((s) => s.fontSize)
  const animationsEnabled = useSettingsStore((s) => s.animationsEnabled)
  const { t } = useTranslation('common')
  const shownUpdateVersionsRef = useRef(new Set<string>())
  const updateDialogOpenRef = useRef(false)
  const updateDownloadPendingRef = useRef(false)

  // Initialize plugin auto-reply agent loop listener
  usePluginAutoReply()

  useEffect(() => {
    const root = document.documentElement

    if (backgroundColor && backgroundColor.trim()) {
      root.style.setProperty('--app-background', backgroundColor.trim())
    } else {
      root.style.removeProperty('--app-background')
    }

    if (fontFamily && fontFamily.trim()) {
      root.style.setProperty('--app-font-family', fontFamily.trim())
    } else {
      root.style.removeProperty('--app-font-family')
    }

    if (typeof fontSize === 'number' && Number.isFinite(fontSize)) {
      root.style.setProperty('--app-font-size', `${fontSize}px`)
    } else {
      root.style.removeProperty('--app-font-size')
    }

    root.dataset.animations = animationsEnabled ? 'enabled' : 'disabled'
  }, [backgroundColor, fontFamily, fontSize, animationsEnabled])

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

    const init = async (): Promise<void> => {
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
          pluginChatId: d.pluginChatId
        })
      }
    })

    const offRemoved = ipcClient.on('cron:job-removed', (data: unknown) => {
      const d = data as { jobId: string; reason: string }
      cronEvents.emit({
        type: 'job_removed',
        jobId: d.jobId,
        reason: d.reason as 'delete_after_run' | 'manual'
      })
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
        createdAt: Date.now()
      }
      _useChatStore.getState().addMessage(d.sessionId, msg)
    })

    // Subscribe to cron run_finished events for session delivery
    const offRunFinished = cronEvents.on((event) => {
      if (event.type !== 'run_finished') return
      if (event.deliveryMode !== 'session') return

      const targetSessionId =
        event.deliveryTarget || event.sessionId || _useChatStore.getState().activeSessionId
      if (!targetSessionId) return
      const sessions = _useChatStore.getState().sessions
      if (!sessions.some((s) => s.id === targetSessionId)) return

      const statusLabel =
        event.status === 'success'
          ? t('app.cron.status.success')
          : event.status === 'error'
            ? t('app.cron.status.error')
            : t('app.cron.status.stopped')
      const toolCallLabel = t('app.cron.toolCallCount', { count: event.toolCallCount ?? 0 })
      const content = [
        `<system-reminder>`,
        t('app.cron.runFinished', {
          jobName: event.jobName || event.jobId,
          statusLabel,
          toolCallLabel
        }),
        `</system-reminder>`,
        '',
        event.error
          ? t('app.cron.errorDetail', { message: event.error })
          : event.outputSummary || t('app.cron.noOutput')
      ].join('\n')

      const msg: UnifiedMessage = {
        id: nanoid(),
        role: 'user',
        content,
        createdAt: Date.now()
      }
      _useChatStore.getState().addMessage(targetSessionId, msg)
    })

    return () => {
      offFired()
      offRemoved()
      offNotify()
      offRunFinished()
    }
  }, [t])

  // Reload SSH config when local JSON changes
  useEffect(() => {
    const offSshConfigChanged = ipcClient.on('ssh:config:changed', () => {
      void useSshStore.getState().loadAll()
    })

    return () => {
      offSshConfigChanged()
    }
  }, [])

  // Listen for app update notifications from main process
  useEffect(() => {
    const offUpdateAvailable = ipcClient.on('update:available', (data: unknown) => {
      const d = data as { currentVersion: string; newVersion: string; releaseNotes: string }
      const currentVersion = normalizeVersion(d.currentVersion)
      const newVersion = normalizeVersion(d.newVersion)

      if (compareVersions(newVersion, currentVersion) <= 0) {
        console.log(
          `[App] Ignore non-newer update dialog: current=${currentVersion}, latest=${newVersion}`
        )
        return
      }

      if (shownUpdateVersionsRef.current.has(newVersion)) {
        console.log(`[App] Ignore duplicate update dialog for version ${newVersion}`)
        return
      }

      if (updateDialogOpenRef.current) {
        console.log('[App] Update dialog already open, ignore repeated trigger')
        return
      }

      shownUpdateVersionsRef.current.add(newVersion)
      updateDialogOpenRef.current = true

      void (async () => {
        try {
          const confirmed = await confirm({
            title: t('app.update.availableTitle', { version: newVersion }),
            description: d.releaseNotes || t('app.update.availableDescription'),
            confirmLabel: t('app.update.actions.updateNow'),
            cancelLabel: t('app.update.actions.remindLater')
          })

          if (!confirmed) {
            toast.info(t('app.update.delayed'))
            return
          }

          if (updateDownloadPendingRef.current) {
            console.log('[App] Update download already pending, ignore repeated confirm')
            return
          }

          updateDownloadPendingRef.current = true
          toast.info(t('app.update.downloading'))

          const result = (await window.electron.ipcRenderer.invoke('update:download')) as
            | { success: true }
            | { success: false; error: string }

          if (!result.success) {
            updateDownloadPendingRef.current = false
            toast.error(t('app.update.downloadFailed'), { description: result.error })
          }
        } finally {
          updateDialogOpenRef.current = false
        }
      })()
    })

    const offUpdateDownloaded = ipcClient.on('update:downloaded', (data: unknown) => {
      const d = data as { version: string }
      updateDownloadPendingRef.current = false
      toast.success(t('app.update.downloadedTitle'), {
        description: t('app.update.downloadedDescription', { version: d.version })
      })
    })

    const offUpdateError = ipcClient.on('update:error', (data: unknown) => {
      const d = data as { error: string }
      updateDownloadPendingRef.current = false
      toast.error(t('app.update.failed'), { description: d.error })
    })

    return () => {
      offUpdateAvailable()
      offUpdateDownloaded()
      offUpdateError()
    }
  }, [t])

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

  useEffect(() => {
    updateAppPluginToolRegistration()

    const unsubscribePlugin = useAppPluginStore.subscribe(() => {
      updateAppPluginToolRegistration()
    })
    const unsubscribeProvider = useProviderStore.subscribe(() => {
      updateAppPluginToolRegistration()
    })

    return () => {
      unsubscribePlugin()
      unsubscribeProvider()
    }
  }, [])

  // Global unhandled promise rejection handler
  useEffect(() => {
    const handler = (e: PromiseRejectionEvent): void => {
      console.error('[Unhandled Rejection]', e.reason)
      toast.error(t('app.errors.unhandledTitle'), {
        description: e.reason?.message || String(e.reason)
      })
    }
    window.addEventListener('unhandledrejection', handler)
    return () => window.removeEventListener('unhandledrejection', handler)
  }, [t])

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
