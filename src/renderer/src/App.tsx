import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTranslation } from 'react-i18next';
import { Layout } from './components/layout/Layout';
import { SshPage } from './components/ssh/SshPage';
import { Toaster } from './components/ui/sonner';
import { Button } from './components/ui/button';
import { ConfirmDialogProvider } from './components/ui/confirm-dialog';
import {
   Dialog,
   DialogContent,
   DialogFooter,
   DialogHeader,
   DialogTitle
} from './components/ui/dialog';
import { ThemeProvider } from './components/theme-provider';
import { ErrorBoundary } from './components/error-boundary';
import { useSettingsStore } from './stores/settings-store';
import { initProviderStore, useProviderStore } from './stores/provider-store';
import { initAppPluginStore, useAppPluginStore } from './stores/app-plugin-store';
import { useChatStore } from './stores/chat-store';
import { usePlanStore } from './stores/plan-store';
import { useSshStore } from './stores/ssh-store';
import { useTeamStore } from './stores/team-store';
import { useUIStore } from './stores/ui-store';
import { registerAllTools, updateWebSearchToolRegistration } from './lib/tools';
import { updateAppPluginToolRegistration } from './lib/app-plugin';
import { registerAllProviders } from './lib/api';
import { registerAllViewers } from './lib/preview/register-viewers';
import { createMarkdownComponents } from './lib/preview/viewers/markdown-components';
import { initChannelEventListener } from './stores/channel-store';
import { usePluginAutoReply } from './hooks/use-plugin-auto-reply';
import { toast } from 'sonner';
import i18n from './locales';
import { cronEvents } from './lib/tools/cron-events';
import { useCronStore, type CronAgentLogEntry } from './stores/cron-store';
import { ipcClient } from './lib/ipc/ipc-client';
import { getTeamRuntimeSnapshot } from './lib/agent/teams/runtime-client';
import { stopTeamInboxPoller } from './lib/agent/teams/inbox-poller';
import { runTeammate } from './lib/agent/teams/teammate-runner';
import { nanoid } from 'nanoid';
import type { UnifiedMessage } from './lib/api/types';
import { NotifyToastContainer } from './components/notify/NotifyWindow';
import { ChangelogDialog } from './components/changelog/ChangelogDialog';
import {
   getGlobalMemorySnapshot,
   loadGlobalMemorySnapshot,
   subscribeGlobalMemoryUpdates,
   type GlobalMemorySnapshot
} from './lib/agent/memory-files';

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
const RENDERER_OOM_RECOVERY_PARAM = 'ocRecoverRendererOom'
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

interface AvailableUpdate {
   currentVersion: string
   newVersion: string
   releaseNotes: string
}

interface TeamWorkerParams {
   teamName: string
   memberId: string
   memberName: string
   prompt: string
   taskId: string | null
   model: string | null
   agentName: string | null
   workingFolder?: string
}

function isSshWindowView(): boolean {
   const search = new URLSearchParams(window.location.search)
   return search.get('appView') === 'ssh'
}

function consumeRendererOomRecoveryFlag(): boolean {
   const url = new URL(window.location.href)
   const shouldRecover = url.searchParams.get(RENDERER_OOM_RECOVERY_PARAM) === '1'
   if (!shouldRecover) return false

   url.searchParams.delete(RENDERER_OOM_RECOVERY_PARAM)
   window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
   return true
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
   const store = useChatStore.getState()
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
   const [availableUpdate, setAvailableUpdate] = useState<AvailableUpdate | null>(null)
   const [updateDialogOpen, setUpdateDialogOpen] = useState(false)
   const changelogDialogOpen = useUIStore((s) => s.changelogDialogOpen)
   const [updateDownloadPending, setUpdateDownloadPending] = useState(false)
   const [updateDownloadProgress, setUpdateDownloadProgress] = useState<number | null>(null)
   const teamWorkerParams = useMemo<TeamWorkerParams | null>(() => {
      const search = new URLSearchParams(window.location.search)
      if (search.get('ocWorker') !== 'team') return null
      const teamName = search.get('teamName')
      const memberId = search.get('memberId')
      const memberName = search.get('memberName')
      const prompt = search.get('prompt')
      if (!teamName || !memberId || !memberName || !prompt) return null
      return {
         teamName,
         memberId,
         memberName,
         prompt,
         taskId: search.get('taskId'),
         model: search.get('model'),
         agentName: search.get('agentName'),
         workingFolder: search.get('workingFolder') ?? undefined
      }
   }, [])
   const workerBootStartedRef = useRef(false)
   const [workerBootError, setWorkerBootError] = useState<string | null>(null)
   const workerMemberName = teamWorkerParams?.memberName ?? ''
   const sshWindowView = useMemo(() => isSshWindowView(), [])
   const rendererOomRecoveryRef = useRef(consumeRendererOomRecoveryFlag())
   const cronLogBufferRef = useRef<CronAgentLogEntry[]>([])
   const cronLogFlushTimerRef = useRef<number | null>(null)

   // Initialize plugin auto-reply agent loop listener
   usePluginAutoReply()

   useEffect(() => {
      if (!teamWorkerParams || workerBootStartedRef.current) return
      workerBootStartedRef.current = true
      stopTeamInboxPoller()

      void (async () => {
         try {
            const snapshot = await getTeamRuntimeSnapshot({ teamName: teamWorkerParams.teamName, limit: 20 })
            if (!snapshot) {
               throw new Error(`Team runtime not found: ${teamWorkerParams.teamName}`)
            }

            const sessionId = useChatStore.getState().activeSessionId ?? undefined
            useTeamStore.getState().syncRuntimeSnapshot(snapshot, sessionId)

            await runTeammate({
               memberId: teamWorkerParams.memberId,
               memberName: teamWorkerParams.memberName,
               prompt: teamWorkerParams.prompt,
               taskId: teamWorkerParams.taskId,
               model: teamWorkerParams.model,
               agentName: teamWorkerParams.agentName,
               workingFolder: teamWorkerParams.workingFolder
            })

            window.close()
         } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            console.error('[TeamWorker] Failed to boot worker window:', error)
            setWorkerBootError(message)
         }
      })()
   }, [teamWorkerParams])

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
      void useChatStore
         .getState()
         .loadFromDb()
         .then(async () => {
            await usePlanStore.getState().loadPlansFromDb()
            const activeSessionId = useChatStore.getState().activeSessionId
            const activePlan = activeSessionId
               ? await usePlanStore.getState().loadPlanForSession(activeSessionId)
               : undefined
            usePlanStore.getState().setActivePlan(activePlan?.id ?? null)
            useUIStore.getState().applyChatRouteFromLocation()

            if (rendererOomRecoveryRef.current && !teamWorkerParams) {
               const recoverySessionId = useChatStore.getState().activeSessionId
               useSettingsStore.getState().updateSettings({ animationsEnabled: false })
               useUIStore.setState({
                  detailPanelOpen: false,
                  detailPanelContent: null,
                  previewPanelOpen: false,
                  previewPanelState: null,
                  orchestrationConsoleOpen: false,
                  selectedOrchestrationRunId: null,
                  selectedOrchestrationMemberId: null,
                  subAgentExecutionDetailOpen: false,
                  subAgentExecutionDetailToolUseId: null,
                  subAgentExecutionDetailInlineText: null,
                  selectedSubAgentToolUseId: null,
                  miniSessionWindowOpen: false,
                  miniSessionWindowSessionId: null,
                  rightPanelOpen: false
               })
               await useChatStore.getState().recoverFromRendererOom(recoverySessionId)
               toast.warning('Renderer recovered in reduced-memory mode')
            }
         })
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
   }, [teamWorkerParams])

   useEffect(() => {
      const syncFromLocation = (): void => {
         useUIStore.getState().applyChatRouteFromLocation()
      }

      window.addEventListener('hashchange', syncFromLocation)
      return () => window.removeEventListener('hashchange', syncFromLocation)
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

         const sessionId = useChatStore.getState().activeSessionId
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
            firedAt?: number
            deliveryMode?: string
            deliveryTarget?: string | null
            maxIterations?: number
            pluginId?: string | null
            pluginChatId?: string | null
            error?: string
         }
         cronEvents.emit({ type: 'fired', ...d })
         useCronStore.getState().updateJob(d.jobId, { lastFiredAt: Date.now() })
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

      const offRunStarted = ipcClient.on('cron:run-started', (data: unknown) => {
         const d = data as { jobId: string; runId: string }
         useCronStore.getState().setExecutionStarted(d.jobId)
      })

      const offRunProgress = ipcClient.on('cron:run-progress', (data: unknown) => {
         const d = data as {
            jobId: string
            runId: string
            iteration: number
            toolCalls: number
            elapsed: number
            currentStep?: string
         }
         useCronStore.getState().updateExecutionProgress(d.jobId, {
            iteration: d.iteration,
            toolCalls: d.toolCalls,
            currentStep: d.currentStep
         })
      })

      const flushCronLogBuffer = (): void => {
         if (cronLogFlushTimerRef.current !== null) {
            window.clearTimeout(cronLogFlushTimerRef.current)
            cronLogFlushTimerRef.current = null
         }

         const entries = cronLogBufferRef.current
         if (entries.length === 0) return
         cronLogBufferRef.current = []
         useCronStore.getState().appendAgentLogs(entries)
      }

      const scheduleCronLogFlush = (): void => {
         if (cronLogFlushTimerRef.current !== null) return
         cronLogFlushTimerRef.current = window.setTimeout(() => {
            flushCronLogBuffer()
         }, 100)
      }

      const offRunLog = ipcClient.on('cron:run-log-appended', (data: unknown) => {
         const d = data as {
            jobId: string
            timestamp: number
            type: 'start' | 'text' | 'tool_call' | 'tool_result' | 'error' | 'end'
            content: string
         }
         cronLogBufferRef.current.push(d)
         scheduleCronLogFlush()
      })

      const offRunFinishedIpc = ipcClient.on('cron:run-finished', (data: unknown) => {
         flushCronLogBuffer()
         const d = data as {
            jobId: string
            runId: string
            status: 'success' | 'error' | 'aborted'
            toolCallCount: number
            jobName?: string
            sessionId?: string | null
            deliveryMode?: string
            deliveryTarget?: string | null
            outputSummary?: string
            error?: string
            run?: import('./stores/cron-store').CronRunEntry
            job?: import('./stores/cron-store').CronJobEntry | null
         }
         const cronStore = useCronStore.getState()
         cronStore.clearExecutionState(d.jobId)
         if (d.job) {
            cronStore.upsertJob(d.job)
         }
         if (d.run) {
            cronStore.recordRun(d.run)
         }
         cronEvents.emit({ type: 'run_finished', ...d })
      })

      // notify:session-message — inject a message into a session from the Notify tool
      const offNotify = ipcClient.on('notify:session-message', (data: unknown) => {
         const d = data as { sessionId: string; title: string; body: string }
         const sessions = useChatStore.getState().sessions
         if (!sessions.some((s) => s.id === d.sessionId)) return
         const msg: UnifiedMessage = {
            id: nanoid(),
            role: 'assistant',
            content: `<system-reminder>\n**${d.title}**\n</system-reminder>\n\n${d.body}`,
            createdAt: Date.now()
         }
         useChatStore.getState().addMessage(d.sessionId, msg)
      })

      // Subscribe to cron run_finished events for session delivery
      const offRunFinished = cronEvents.on((event) => {
         if (event.type !== 'run_finished') return
         if (event.deliveryMode !== 'session') return

         const targetSessionId =
            event.deliveryTarget || event.sessionId || useChatStore.getState().activeSessionId
         if (!targetSessionId) return
         const sessions = useChatStore.getState().sessions
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
         useChatStore.getState().addMessage(targetSessionId, msg)
      })

      return () => {
         offFired()
         offRemoved()
         offRunStarted()
         offRunProgress()
         offRunLog()
         offRunFinishedIpc()
         offNotify()
         offRunFinished()
         flushCronLogBuffer()
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
               `[App] Ignore non-newer update event: current=${currentVersion}, latest=${newVersion}`
            )
            return
         }

         if (shownUpdateVersionsRef.current.has(newVersion)) {
            console.log(`[App] Ignore duplicate update notification for version ${newVersion}`)
            return
         }

         shownUpdateVersionsRef.current.add(newVersion)
         setAvailableUpdate({
            currentVersion,
            newVersion,
            releaseNotes: d.releaseNotes || ''
         })
         setUpdateDownloadPending(false)
         setUpdateDownloadProgress(null)
      })

      const offUpdateProgress = ipcClient.on('update:download-progress', (data: unknown) => {
         const d = data as { percent: number }
         setUpdateDownloadPending(true)
         setUpdateDownloadProgress(typeof d.percent === 'number' ? d.percent : null)
      })

      const offUpdateDownloaded = ipcClient.on('update:downloaded', (data: unknown) => {
         const d = data as { version: string }
         setUpdateDownloadPending(false)
         setUpdateDownloadProgress(null)
         setUpdateDialogOpen(false)
         setAvailableUpdate(null)
         toast.success(t('app.update.downloadedTitle'), {
            description: t('app.update.downloadedDescription', { version: d.version })
         })
      })

      const offUpdateError = ipcClient.on('update:error', (data: unknown) => {
         const d = data as { error: string }
         setUpdateDownloadPending(false)
         setUpdateDownloadProgress(null)
         toast.error(t('app.update.failed'), { description: d.error })
      })

      return () => {
         offUpdateAvailable()
         offUpdateProgress()
         offUpdateDownloaded()
         offUpdateError()
      }
   }, [t])

   const handleUpdateNow = async (): Promise<void> => {
      if (!availableUpdate || updateDownloadPending) {
         return
      }

      setUpdateDownloadPending(true)
      setUpdateDownloadProgress(null)
      toast.info(t('app.update.downloading'))

      const result = (await window.electron.ipcRenderer.invoke('update:download')) as
         | { success: true }
         | { success: false; error: string }

      if (!result.success) {
         setUpdateDownloadPending(false)
         toast.error(t('app.update.downloadFailed'), { description: result.error })
      }
   }

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

   if (teamWorkerParams) {
      return (
         <div className="flex min-h-screen items-center justify-center bg-background text-foreground">
            <div className="flex max-w-md flex-col items-center gap-3 px-6 text-center">
               {workerBootError ? (
                  <>
                     <div className="text-sm font-medium">Team worker failed to start</div>
                     <div className="text-xs text-muted-foreground">{workerBootError}</div>
                  </>
               ) : (
                  <>
                     <Loader2 className="h-5 w-5 animate-spin" />
                     <div className="text-sm font-medium">Running background teammate…</div>
                     <div className="text-xs text-muted-foreground">{workerMemberName}</div>
                  </>
               )}
            </div>
         </div>
      )
   }

   if (sshWindowView) {
      return (
         <ErrorBoundary>
            <ThemeProvider defaultTheme={theme}>
               <SshPage />
               <Toaster position="bottom-left" theme="system" richColors />
               <ConfirmDialogProvider />
               <NotifyToastContainer />
            </ThemeProvider>
         </ErrorBoundary>
      )
   }

   return (
      <ErrorBoundary>
         <ThemeProvider defaultTheme={theme}>
            <Layout
               updateInfo={
                  availableUpdate
                     ? {
                        newVersion: availableUpdate.newVersion,
                        downloading: updateDownloadPending,
                        downloadProgress: updateDownloadProgress
                     }
                     : null
               }
               onOpenUpdateDialog={() => setUpdateDialogOpen(true)}
            />

            <Dialog open={!!availableUpdate && updateDialogOpen} onOpenChange={setUpdateDialogOpen}>
               <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-2xl">
                  <DialogHeader className="border-b px-6 py-5 pr-12">
                     <DialogTitle>
                        {t('app.update.availableTitle', { version: availableUpdate?.newVersion ?? '' })}
                     </DialogTitle>
                     <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span>
                           {t('app.update.currentVersion', {
                              version: availableUpdate?.currentVersion ?? '-'
                           })}
                        </span>
                        <span>→</span>
                        <span>
                           {t('app.update.latestVersion', {
                              version: availableUpdate?.newVersion ?? '-'
                           })}
                        </span>
                     </div>
                  </DialogHeader>

                  <div className="max-h-[min(60vh,36rem)] overflow-y-auto px-6 py-4">
                     <div className="mb-3 text-xs font-medium text-muted-foreground">
                        {t('app.update.releaseNotes')}
                     </div>
                     {availableUpdate?.releaseNotes ? (
                        <div className="prose prose-sm dark:prose-invert max-w-none">
                           <ReactMarkdown
                              remarkPlugins={[remarkGfm]}
                              components={createMarkdownComponents()}
                           >
                              {availableUpdate.releaseNotes}
                           </ReactMarkdown>
                        </div>
                     ) : (
                        <p className="text-sm text-muted-foreground">{t('app.update.noReleaseNotes')}</p>
                     )}
                  </div>

                  <DialogFooter className="border-t px-6 py-4 sm:justify-between">
                     <div className="text-xs text-muted-foreground">
                        {updateDownloadPending
                           ? typeof updateDownloadProgress === 'number'
                              ? t('app.update.downloadingProgress', {
                                 progress: Math.round(updateDownloadProgress)
                              })
                              : t('app.update.downloading')
                           : t('app.update.availableDescription')}
                     </div>
                     <div className="flex flex-col-reverse gap-2 sm:flex-row">
                        <Button variant="outline" onClick={() => setUpdateDialogOpen(false)}>
                           {t('app.update.actions.remindLater')}
                        </Button>
                        <Button onClick={() => void handleUpdateNow()} disabled={updateDownloadPending}>
                           {updateDownloadPending && <Loader2 className="mr-2 size-4 animate-spin" />}
                           {updateDownloadPending
                              ? typeof updateDownloadProgress === 'number'
                                 ? t('app.update.downloadingProgress', {
                                    progress: Math.round(updateDownloadProgress)
                                 })
                                 : t('app.update.downloading')
                              : t('app.update.actions.updateNow')}
                        </Button>
                     </div>
                  </DialogFooter>
               </DialogContent>
            </Dialog>

            <ChangelogDialog
               open={changelogDialogOpen}
               onOpenChange={(open) => useUIStore.getState().setChangelogDialogOpen(open)}
            />

            <Toaster position="bottom-left" theme="system" richColors />
            <ConfirmDialogProvider />
            <NotifyToastContainer />
         </ThemeProvider>
      </ErrorBoundary>
   )
}

export default App
