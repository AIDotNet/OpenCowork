import { useEffect, useRef, useState, useCallback } from 'react'
import { ArrowLeft, ArrowRight, RefreshCw, Square, Globe, AlertCircle } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { useUIStore } from '@renderer/stores/ui-store'
import { getBrowserAccessDecision } from '@renderer/lib/app-plugin/browser-access'
import { useTranslation } from 'react-i18next'
import { BUILTIN_BROWSER_PARTITION } from '../../../../shared/browser-plugin'

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

  const [inputUrl, setInputUrl] = useState(storedUrl)
  const [committedUrl, setCommittedUrl] = useState(storedUrl)
  const webviewRef = useRef<Electron.WebviewTag | null>(null)
  const webviewSessionProps: Pick<React.ComponentProps<'webview'>, 'partition' | 'allowpopups'> = {
    partition: BUILTIN_BROWSER_PARTITION,
    allowpopups: true
  }

  useEffect(() => {
    setBrowserWebviewRef(webviewRef, sessionId, projectId)
    return () => {
      setBrowserWebviewRef(null, sessionId, projectId)
      setBrowserLoading(false, sessionId, projectId)
    }
  }, [projectId, sessionId, setBrowserLoading, setBrowserWebviewRef])

  useEffect(() => {
    setInputUrl(storedUrl)
    setCommittedUrl(storedUrl)
  }, [storedUrl])

  const normalizeUrl = (url: string): string => {
    let normalized = url.trim()
    if (!normalized) return ''
    if (!/^https?:\/\//i.test(normalized) && !normalized.startsWith('http://localhost')) {
      normalized = `https://${normalized}`
    }
    return normalized
  }

  const blockNavigation = useCallback(
    (url: string, reason?: string): void => {
      setBrowserErrorInfo(
        {
          code: -10,
          desc: reason ?? t('browser.blockedByRules'),
          url
        },
        sessionId,
        projectId
      )
      setBrowserLoading(false, sessionId, projectId)
    },
    [projectId, sessionId, setBrowserErrorInfo, setBrowserLoading]
  )

  const canNavigateTo = useCallback(
    (url: string): boolean => {
      const decision = getBrowserAccessDecision(url)
      if (decision.allowed) return true
      blockNavigation(url, decision.reason)
      return false
    },
    [blockNavigation]
  )

  const navigate = useCallback(
    (url: string): void => {
      const normalized = normalizeUrl(url)
      if (!normalized) return
      setInputUrl(normalized)
      if (!canNavigateTo(normalized)) return
      setCommittedUrl(normalized)
      setBrowserUrl(normalized, sessionId, projectId)
      setBrowserErrorInfo(null, sessionId, projectId)
      const wv = webviewRef.current
      if (wv) {
        wv.src = normalized
      }
    },
    [canNavigateTo, projectId, sessionId, setBrowserUrl, setBrowserErrorInfo]
  )

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') navigate(inputUrl)
  }

  const updateNavState = useCallback(() => {
    const wv = webviewRef.current
    if (!wv) return
    setBrowserCanGoBack(wv.canGoBack(), sessionId, projectId)
    setBrowserCanGoForward(wv.canGoForward(), sessionId, projectId)
  }, [projectId, sessionId, setBrowserCanGoBack, setBrowserCanGoForward])

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
      updateNavState()
    }

    const onNavigateInPage = (e: Electron.DidNavigateInPageEvent): void => {
      setInputUrl(e.url)
      setBrowserUrl(e.url, sessionId, projectId)
      updateNavState()
    }

    const onTitleUpdated = (e: Electron.PageTitleUpdatedEvent): void => {
      setBrowserPageTitle(e.title, sessionId, projectId)
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
      window.electron.ipcRenderer.invoke('shell:openExternal', e.url)
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
    projectId,
    sessionId,
    setBrowserLoading,
    setBrowserErrorInfo,
    setBrowserUrl,
    setBrowserPageTitle,
    updateNavState
  ])

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border/50 px-2">
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          onClick={() => webviewRef.current?.goBack()}
          disabled={!canGoBack}
          title={t('browser.back')}
        >
          <ArrowLeft className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          onClick={() => webviewRef.current?.goForward()}
          disabled={!canGoForward}
          title={t('browser.forward')}
        >
          <ArrowRight className="size-3.5" />
        </Button>
        {loading ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={() => webviewRef.current?.stop()}
            title={t('browser.stop')}
          >
            <Square className="size-3" />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={() => webviewRef.current?.reload()}
            title={t('browser.refresh')}
          >
            <RefreshCw className="size-3.5" />
          </Button>
        )}

        <div className="flex flex-1 items-center gap-1 rounded-md border border-border/60 bg-muted/30 px-2 h-6">
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
          className="h-6 px-2 text-[11px]"
          onClick={() => navigate(inputUrl)}
        >
          {t('browser.go')}
        </Button>
      </div>

      {/* Loading bar */}
      {loading && (
        <div className="h-0.5 w-full overflow-hidden bg-muted">
          <div className="h-full w-full animate-progress bg-primary/60" />
        </div>
      )}

      {/* Content */}
      <div className="relative min-h-0 flex-1">
        {committedUrl && (
          <webview
            ref={webviewRef as React.Ref<Electron.WebviewTag>}
            src={committedUrl}
            className="size-full"
            {...webviewSessionProps}
          />
        )}
        {errorInfo ? (
          <>
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background text-sm text-muted-foreground">
              <AlertCircle className="size-10 opacity-30" />
              <p className="font-medium">{t('rightPanel.browserLoadFailed')}</p>
              <p className="text-xs opacity-70">
                {errorInfo.desc} ({errorInfo.code})
              </p>
              <p className="max-w-[80%] truncate text-xs opacity-50">{errorInfo.url}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setBrowserErrorInfo(null, sessionId, projectId)
                  webviewRef.current?.reload()
                }}
              >
                {t('rightPanel.browserRetry')}
              </Button>
            </div>
          </>
        ) : !committedUrl ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
            <Globe className="size-8 opacity-20" />
            <span>{t('rightPanel.browserEmptyState')}</span>
          </div>
        ) : null}
      </div>
    </div>
  )
}
