import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  RefreshCw,
  Square,
  Globe,
  AlertCircle,
  History,
  Search,
  Trash2,
  Bot
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { useUIStore } from '@renderer/stores/ui-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import {
  getBrowserAccessDecision,
  normalizeBrowserUrl
} from '@renderer/lib/app-plugin/browser-access'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import {
  describeWebviewOperationError,
  isPromiseLike,
  isWebviewConnected,
  type MaybePromise
} from '@renderer/lib/browser/webview-helpers'
import { useTranslation } from 'react-i18next'
import { AuxiliaryDrawerHost } from '@renderer/components/workbench/AuxiliaryDrawerHost'
import {
  BUILTIN_BROWSER_PARTITION,
  stripElectronFromUserAgent
} from '../../../../shared/browser-plugin'

interface BrowserHistoryEntry {
  id: string
  url: string
  title: string
  timestamp: number
}

const BROWSER_HISTORY_STORAGE_KEY = 'opencowork_browser_history_v1'

function loadSavedHistory(): BrowserHistoryEntry[] {
  try {
    const raw = localStorage.getItem(BROWSER_HISTORY_STORAGE_KEY)
    if (!raw) return []
    return JSON.parse(raw) as BrowserHistoryEntry[]
  } catch {
    return []
  }
}

function saveHistory(entries: BrowserHistoryEntry[]): void {
  try {
    localStorage.setItem(BROWSER_HISTORY_STORAGE_KEY, JSON.stringify(entries.slice(0, 100)))
  } catch {
    // Ignore storage quota errors
  }
}

export function BrowserPanel({
  sessionId = null,
  projectId = null
}: {
  sessionId?: string | null
  projectId?: string | null
}): React.JSX.Element {
  const { t } = useTranslation('layout')

  const storedUrl = useUIStore((s) => s.getBrowserState(sessionId, projectId).url)
  const setBrowserUrl = useUIStore((s) => s.setBrowserUrl)
  const loading = useUIStore((s) => s.getBrowserState(sessionId, projectId).loading)
  const setBrowserLoading = useUIStore((s) => s.setBrowserLoading)
  const setBrowserPageTitle = useUIStore((s) => s.setBrowserPageTitle)
  const canGoBack = useUIStore((s) => s.getBrowserState(sessionId, projectId).canGoBack)
  const setBrowserCanGoBack = useUIStore((s) => s.setBrowserCanGoBack)
  const canGoForward = useUIStore((s) => s.getBrowserState(sessionId, projectId).canGoForward)
  const setBrowserCanGoForward = useUIStore((s) => s.setBrowserCanGoForward)
  const errorInfo = useUIStore((s) => s.getBrowserState(sessionId, projectId).errorInfo)
  const setBrowserErrorInfo = useUIStore((s) => s.setBrowserErrorInfo)
  const setBrowserWebviewRef = useUIStore((s) => s.setBrowserWebviewRef)
  const browserUserDataReuseEnabled = useSettingsStore((s) => s.browserUserDataReuseEnabled)

  const [inputUrl, setInputUrl] = useState(storedUrl)
  const [committedUrl, setCommittedUrl] = useState(storedUrl)
  const [historyDrawerOpen, setHistoryDrawerOpen] = useState(false)
  const [historySearchQuery, setHistorySearchQuery] = useState('')
  const [historyEntries, setHistoryEntries] = useState<BrowserHistoryEntry[]>(() =>
    loadSavedHistory()
  )
  const [showErrorDetails, setShowErrorDetails] = useState(false)

  const [runtimeBrowserUserDataReuseEnabled, setRuntimeBrowserUserDataReuseEnabled] = useState(
    browserUserDataReuseEnabled
  )
  const [runtimeBrowserUserAgent, setRuntimeBrowserUserAgent] = useState<string | undefined>(
    browserUserDataReuseEnabled ? stripElectronFromUserAgent(navigator.userAgent) : undefined
  )
  const webviewRef = useRef<Electron.WebviewTag | null>(null)
  const initialBrowserUserDataReuseEnabledRef = useRef(browserUserDataReuseEnabled)
  const webviewUserAgent = runtimeBrowserUserDataReuseEnabled ? runtimeBrowserUserAgent : undefined
  const webviewSessionProps: Pick<
    React.ComponentProps<'webview'>,
    'partition' | 'allowpopups' | 'plugins' | 'useragent'
  > = {
    ...(runtimeBrowserUserDataReuseEnabled ? {} : { partition: BUILTIN_BROWSER_PARTITION }),
    allowpopups: true,
    plugins: runtimeBrowserUserDataReuseEnabled,
    ...(webviewUserAgent ? { useragent: webviewUserAgent } : {})
  }

  useEffect(() => {
    let cancelled = false

    async function loadRuntimeBrowserMode(): Promise<void> {
      try {
        const result = (await ipcClient.invoke(IPC.BROWSER_EMULATION_STATUS)) as
          | { success: true; status: { reuseEnabled: boolean; userAgent: string } }
          | { success: false; error?: string }
        if (!cancelled && result.success) {
          setRuntimeBrowserUserDataReuseEnabled(result.status.reuseEnabled)
          setRuntimeBrowserUserAgent(result.status.userAgent)
        }
      } catch {
        if (!cancelled) {
          setRuntimeBrowserUserDataReuseEnabled(initialBrowserUserDataReuseEnabledRef.current)
          setRuntimeBrowserUserAgent(stripElectronFromUserAgent(navigator.userAgent))
        }
      }
    }

    void loadRuntimeBrowserMode()
    return () => {
      cancelled = true
    }
  }, [])

  const handleWebviewOperationError = useCallback(
    (action: string, error: unknown): void => {
      console.warn('[BrowserPanel] Webview operation failed:', {
        action,
        message: describeWebviewOperationError(action, error)
      })
      setBrowserLoading(false, sessionId, projectId)
      setBrowserCanGoBack(false, sessionId, projectId)
      setBrowserCanGoForward(false, sessionId, projectId)
    },
    [projectId, sessionId, setBrowserCanGoBack, setBrowserCanGoForward, setBrowserLoading]
  )

  const runWebviewCommand = useCallback(
    (action: string, command: (webview: Electron.WebviewTag) => MaybePromise<void>): void => {
      const wv = webviewRef.current
      if (!isWebviewConnected(wv)) return

      try {
        const result = command(wv)
        if (isPromiseLike(result)) {
          void Promise.resolve(result).catch((error) => handleWebviewOperationError(action, error))
        }
      } catch (error) {
        handleWebviewOperationError(action, error)
      }
    },
    [handleWebviewOperationError]
  )

  const updateNavState = useCallback((): void => {
    runWebviewCommand('update navigation state', (wv) => {
      setBrowserCanGoBack(wv.canGoBack(), sessionId, projectId)
      setBrowserCanGoForward(wv.canGoForward(), sessionId, projectId)
    })
  }, [projectId, runWebviewCommand, sessionId, setBrowserCanGoBack, setBrowserCanGoForward])

  const canNavigateTo = useCallback(
    (targetUrl: string): boolean => {
      const decision = getBrowserAccessDecision(targetUrl)
      if (decision.allowed) return true

      toast.error(
        decision.reason ?? t('browser.accessBlocked', { defaultValue: 'URL is blocked by policy' })
      )
      return false
    },
    [t]
  )

  const recordHistory = useCallback((url: string, title?: string) => {
    if (!url || url.startsWith('about:')) return
    setHistoryEntries((prev) => {
      const filtered = prev.filter((item) => item.url !== url)
      const next = [
        { id: `${Date.now()}-${url}`, url, title: title || url, timestamp: Date.now() },
        ...filtered
      ]
      saveHistory(next)
      return next
    })
  }, [])

  const navigate = useCallback(
    (rawUrl: string): void => {
      const target = normalizeBrowserUrl(rawUrl)
      if (!target) return
      if (!canNavigateTo(target)) return
      setInputUrl(target)
      setCommittedUrl(target)
      setBrowserUrl(target, sessionId, projectId)
      setBrowserErrorInfo(null, sessionId, projectId)
      recordHistory(target)
    },
    [canNavigateTo, projectId, recordHistory, sessionId, setBrowserErrorInfo, setBrowserUrl]
  )

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      navigate(inputUrl)
    }
  }

  const handleAskAgentToFix = (): void => {
    if (!errorInfo) return
    const prompt = `The built-in browser failed to connect to ${errorInfo.url} with error ${errorInfo.desc} (${errorInfo.code}). Please check if the local server is running and help diagnose or start it.`
    useUIStore.getState().setPendingInsertText(prompt)
    toast.success('Added diagnostic prompt to chat input')
  }

  const handleClearHistory = (): void => {
    setHistoryEntries([])
    saveHistory([])
    toast.success('History cleared')
  }

  useEffect(() => {
    if (storedUrl !== committedUrl) {
      setInputUrl(storedUrl)
      setCommittedUrl(storedUrl)
    }
  }, [committedUrl, storedUrl])

  useEffect(() => {
    setBrowserWebviewRef(webviewRef, sessionId, projectId)
    return () => {
      setBrowserWebviewRef(null, sessionId, projectId)
    }
  }, [projectId, sessionId, setBrowserWebviewRef])

  useEffect(() => {
    const wv = webviewRef.current
    if (!wv) return

    const onStartLoading = (): void => {
      setBrowserLoading(true, sessionId, projectId)
      setBrowserErrorInfo(null, sessionId, projectId)
    }

    const onStopLoading = (): void => {
      setBrowserLoading(false, sessionId, projectId)
      updateNavState()
    }

    const onNavigate = (e: Electron.DidNavigateEvent): void => {
      setInputUrl(e.url)
      setBrowserUrl(e.url, sessionId, projectId)
      recordHistory(e.url, wv.getTitle?.())
      updateNavState()
    }

    const onNavigateInPage = (e: Electron.DidNavigateInPageEvent): void => {
      setInputUrl(e.url)
      setBrowserUrl(e.url, sessionId, projectId)
      recordHistory(e.url, wv.getTitle?.())
      updateNavState()
    }

    const onTitleUpdated = (e: Electron.PageTitleUpdatedEvent): void => {
      setBrowserPageTitle(e.title, sessionId, projectId)
      if (e.title) {
        setHistoryEntries((prev) =>
          prev.map((item) => (item.url === inputUrl ? { ...item, title: e.title } : item))
        )
      }
    }

    const onFailLoad = (e: Electron.DidFailLoadEvent): void => {
      if (!e.isMainFrame || e.errorCode === -3) return
      setBrowserErrorInfo(
        { code: e.errorCode, desc: e.errorDescription, url: e.validatedURL },
        sessionId,
        projectId
      )
      setBrowserLoading(false, sessionId, projectId)
    }

    const onWillNavigate = (e: Event & { url?: string; preventDefault: () => void }): void => {
      if (!e.url || canNavigateTo(e.url)) return
      e.preventDefault()
    }

    const onNewWindow = (e: Event & { url: string; preventDefault: () => void }): void => {
      e.preventDefault()
      if (!canNavigateTo(e.url)) return
      ipcClient.invoke(IPC.SHELL_OPEN_EXTERNAL, e.url)
    }

    wv.addEventListener('did-start-loading', onStartLoading)
    wv.addEventListener('did-stop-loading', onStopLoading)
    wv.addEventListener('did-navigate', onNavigate as EventListener)
    wv.addEventListener('did-navigate-in-page', onNavigateInPage as EventListener)
    wv.addEventListener('page-title-updated', onTitleUpdated as EventListener)
    wv.addEventListener('did-fail-load', onFailLoad as EventListener)
    wv.addEventListener('will-navigate', onWillNavigate as EventListener)
    wv.addEventListener('new-window', onNewWindow as EventListener)

    return () => {
      wv.removeEventListener('did-start-loading', onStartLoading)
      wv.removeEventListener('did-stop-loading', onStopLoading)
      wv.removeEventListener('did-navigate', onNavigate as EventListener)
      wv.removeEventListener('did-navigate-in-page', onNavigateInPage as EventListener)
      wv.removeEventListener('page-title-updated', onTitleUpdated as EventListener)
      wv.removeEventListener('did-fail-load', onFailLoad as EventListener)
      wv.removeEventListener('will-navigate', onWillNavigate as EventListener)
      wv.removeEventListener('new-window', onNewWindow as EventListener)
    }
  }, [
    canNavigateTo,
    committedUrl,
    inputUrl,
    projectId,
    recordHistory,
    sessionId,
    setBrowserErrorInfo,
    setBrowserLoading,
    setBrowserPageTitle,
    setBrowserUrl,
    updateNavState
  ])

  const groupedHistory = useMemo(() => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const todayMs = today.getTime()
    const yesterdayMs = todayMs - 86400000

    const filtered = historyEntries.filter(
      (item) =>
        item.url.toLowerCase().includes(historySearchQuery.toLowerCase()) ||
        item.title.toLowerCase().includes(historySearchQuery.toLowerCase())
    )

    const todayItems: BrowserHistoryEntry[] = []
    const yesterdayItems: BrowserHistoryEntry[] = []
    const olderItems: BrowserHistoryEntry[] = []

    for (const item of filtered) {
      if (item.timestamp >= todayMs) {
        todayItems.push(item)
      } else if (item.timestamp >= yesterdayMs) {
        yesterdayItems.push(item)
      } else {
        olderItems.push(item)
      }
    }

    return { today: todayItems, yesterday: yesterdayItems, older: olderItems }
  }, [historyEntries, historySearchQuery])

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* Tier 2 Context Sub-Header Toolbar */}
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border/50 bg-background/80 px-2 backdrop-blur-sm">
        <Button
          variant="ghost"
          size="icon"
          className="size-6 rounded text-muted-foreground hover:text-foreground"
          onClick={() => runWebviewCommand('go back', (wv) => wv.goBack())}
          disabled={!canGoBack}
          title={t('browser.back')}
        >
          <ArrowLeft className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6 rounded text-muted-foreground hover:text-foreground"
          onClick={() => runWebviewCommand('go forward', (wv) => wv.goForward())}
          disabled={!canGoForward}
          title={t('browser.forward')}
        >
          <ArrowRight className="size-3.5" />
        </Button>
        {loading ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-6 rounded text-muted-foreground hover:text-foreground"
            onClick={() => runWebviewCommand('stop loading', (wv) => wv.stop())}
            title={t('browser.stop')}
          >
            <Square className="size-3" />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            className="size-6 rounded text-muted-foreground hover:text-foreground"
            onClick={() => runWebviewCommand('refresh', (wv) => wv.reload())}
            title={t('browser.refresh')}
          >
            <RefreshCw className="size-3" />
          </Button>
        )}

        <div className="flex h-6 flex-1 items-center gap-1.5 rounded border border-border/50 bg-muted/25 px-2">
          <Globe className="size-3 shrink-0 text-muted-foreground" />
          <input
            className="flex-1 bg-transparent text-[11px] outline-none placeholder:text-muted-foreground"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('browser.urlPlaceholder')}
            spellCheck={false}
          />
        </div>

        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground"
          onClick={() => navigate(inputUrl)}
        >
          {t('browser.go')}
        </Button>

        <Button
          variant={historyDrawerOpen ? 'secondary' : 'ghost'}
          size="icon"
          className="size-6 rounded text-muted-foreground hover:text-foreground"
          onClick={() => setHistoryDrawerOpen((prev) => !prev)}
          title="Browsing History"
        >
          <History className="size-3.5" />
        </Button>
      </div>

      {/* Loading bar */}
      {loading && (
        <div className="h-0.5 w-full overflow-hidden bg-muted">
          <div className="h-full w-full animate-progress bg-primary/60" />
        </div>
      )}

      {/* Content Area & Auxiliary History Drawer */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="relative min-h-0 flex-1 overflow-hidden">
          {committedUrl && (
            <webview
              key={
                runtimeBrowserUserDataReuseEnabled ? 'user-browser-profile' : 'opencowork-profile'
              }
              ref={webviewRef as React.Ref<Electron.WebviewTag>}
              src={committedUrl}
              className="size-full"
              {...webviewSessionProps}
            />
          )}

          {errorInfo ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-background p-6 text-center select-none">
              <div className="grid size-12 place-items-center rounded-2xl border border-destructive/20 bg-destructive/10">
                <AlertCircle className="size-6 text-destructive/70" />
              </div>

              <div className="space-y-1">
                <p className="text-sm font-semibold text-foreground">
                  Can&apos;t connect to server
                </p>
                <p className="font-mono text-xs text-muted-foreground">
                  {errorInfo.url} refused to connect. ({errorInfo.code})
                </p>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  className="gap-1.5 text-xs font-medium"
                  onClick={handleAskAgentToFix}
                >
                  <Bot className="size-3.5" />
                  Ask Agent
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs"
                  onClick={() => setShowErrorDetails((prev) => !prev)}
                >
                  {showErrorDetails ? 'Hide Details' : 'Show Details'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs"
                  onClick={() => {
                    setBrowserErrorInfo(null, sessionId, projectId)
                    runWebviewCommand('retry load', (wv) => wv.reload())
                  }}
                >
                  Retry
                </Button>
              </div>

              {showErrorDetails && (
                <div className="max-w-sm rounded border border-border/50 bg-muted/20 p-2 text-left font-mono text-[10px] text-muted-foreground">
                  <div>Error description: {errorInfo.desc}</div>
                  <div>Error code: {errorInfo.code}</div>
                  <div>Target URL: {errorInfo.url}</div>
                </div>
              )}
            </div>
          ) : !committedUrl ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-xs text-muted-foreground select-none">
              <Globe className="size-8 opacity-20" />
              <span>{t('rightPanel.browserEmptyState')}</span>
            </div>
          ) : null}
        </div>

        {/* Auxiliary History Drawer */}
        <AuxiliaryDrawerHost
          open={historyDrawerOpen}
          title="History"
          width={220}
          onClose={() => setHistoryDrawerOpen(false)}
          actions={
            <Button
              variant="ghost"
              size="icon"
              className="size-5 rounded p-0 text-muted-foreground hover:text-foreground"
              onClick={handleClearHistory}
              title="Clear History"
            >
              <Trash2 className="size-3" />
            </Button>
          }
        >
          <div className="flex h-full flex-col p-2">
            <div className="relative mb-2">
              <Search className="absolute left-2 top-1.5 size-3 text-muted-foreground" />
              <Input
                placeholder="Search history..."
                value={historySearchQuery}
                onChange={(e) => setHistorySearchQuery(e.target.value)}
                className="h-6 pl-7 text-[11px]"
              />
            </div>

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-0.5">
              {groupedHistory.today.length > 0 && (
                <div>
                  <div className="mb-1 text-[10px] font-semibold text-muted-foreground/70 uppercase">
                    Today
                  </div>
                  <div className="space-y-0.5">
                    {groupedHistory.today.map((item) => (
                      <div
                        key={item.id}
                        onClick={() => navigate(item.url)}
                        className="group flex cursor-pointer flex-col rounded p-1.5 text-[11px] transition-colors hover:bg-muted/40"
                      >
                        <div className="flex items-center gap-1.5 font-medium text-foreground">
                          <Globe className="size-3 shrink-0 text-sky-400 opacity-70" />
                          <span className="truncate">{item.title}</span>
                        </div>
                        <span className="truncate pl-4 font-mono text-[9px] text-muted-foreground">
                          {item.url}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {groupedHistory.yesterday.length > 0 && (
                <div>
                  <div className="mb-1 text-[10px] font-semibold text-muted-foreground/70 uppercase">
                    Yesterday
                  </div>
                  <div className="space-y-0.5">
                    {groupedHistory.yesterday.map((item) => (
                      <div
                        key={item.id}
                        onClick={() => navigate(item.url)}
                        className="group flex cursor-pointer flex-col rounded p-1.5 text-[11px] transition-colors hover:bg-muted/40"
                      >
                        <div className="flex items-center gap-1.5 font-medium text-foreground">
                          <Globe className="size-3 shrink-0 text-sky-400 opacity-70" />
                          <span className="truncate">{item.title}</span>
                        </div>
                        <span className="truncate pl-4 font-mono text-[9px] text-muted-foreground">
                          {item.url}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {groupedHistory.older.length > 0 && (
                <div>
                  <div className="mb-1 text-[10px] font-semibold text-muted-foreground/70 uppercase">
                    Earlier
                  </div>
                  <div className="space-y-0.5">
                    {groupedHistory.older.map((item) => (
                      <div
                        key={item.id}
                        onClick={() => navigate(item.url)}
                        className="group flex cursor-pointer flex-col rounded p-1.5 text-[11px] transition-colors hover:bg-muted/40"
                      >
                        <div className="flex items-center gap-1.5 font-medium text-foreground">
                          <Globe className="size-3 shrink-0 text-sky-400 opacity-70" />
                          <span className="truncate">{item.title}</span>
                        </div>
                        <span className="truncate pl-4 font-mono text-[9px] text-muted-foreground">
                          {item.url}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {historyEntries.length === 0 && (
                <div className="py-6 text-center text-xs text-muted-foreground">
                  No browsing history yet
                </div>
              )}
            </div>
          </div>
        </AuxiliaryDrawerHost>
      </div>
    </div>
  )
}
