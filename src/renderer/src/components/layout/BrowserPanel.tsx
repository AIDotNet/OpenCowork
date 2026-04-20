import { useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, RefreshCw, Globe } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { useUIStore } from '@renderer/stores/ui-store'

export function BrowserPanel(): React.JSX.Element {
  const storedUrl = useUIStore((s) => s.browserUrl)
  const setBrowserUrl = useUIStore((s) => s.setBrowserUrl)

  const [lastSeenStoredUrl, setLastSeenStoredUrl] = useState(storedUrl)
  const [inputUrl, setInputUrl] = useState(storedUrl)
  const [committedUrl, setCommittedUrl] = useState(storedUrl)
  const [iframeKey, setIframeKey] = useState(0)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  // Derived state sync: when agent calls openBrowserTab, storedUrl changes externally
  if (storedUrl !== lastSeenStoredUrl && storedUrl) {
    setLastSeenStoredUrl(storedUrl)
    setInputUrl(storedUrl)
    setCommittedUrl(storedUrl)
  }

  const navigate = (url: string): void => {
    let normalized = url.trim()
    if (!normalized) return
    if (!/^https?:\/\//i.test(normalized) && !normalized.startsWith('http://localhost')) {
      normalized = `https://${normalized}`
    }
    setInputUrl(normalized)
    setCommittedUrl(normalized)
    setBrowserUrl(normalized)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') navigate(inputUrl)
  }

  const handleBack = (): void => {
    try {
      iframeRef.current?.contentWindow?.history.back()
    } catch {
      // cross-origin — ignore
    }
  }

  const handleForward = (): void => {
    try {
      iframeRef.current?.contentWindow?.history.forward()
    } catch {
      // cross-origin — ignore
    }
  }

  const handleRefresh = (): void => {
    try {
      iframeRef.current?.contentWindow?.location.reload()
    } catch {
      setIframeKey((k) => k + 1)
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border/50 px-2">
        <Button variant="ghost" size="icon" className="size-6" onClick={handleBack} title="Back">
          <ArrowLeft className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          onClick={handleForward}
          title="Forward"
        >
          <ArrowRight className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          onClick={handleRefresh}
          title="Refresh"
        >
          <RefreshCw className="size-3.5" />
        </Button>

        <div className="flex flex-1 items-center gap-1 rounded-md border border-border/60 bg-muted/30 px-2 h-6">
          <Globe className="size-3 shrink-0 text-muted-foreground" />
          <input
            className="flex-1 bg-transparent text-[11px] outline-none placeholder:text-muted-foreground"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Enter URL..."
            spellCheck={false}
          />
        </div>

        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-[11px]"
          onClick={() => navigate(inputUrl)}
        >
          Go
        </Button>
      </div>

      {/* Iframe */}
      <div className="min-h-0 flex-1">
        {committedUrl ? (
          <iframe
            key={iframeKey}
            ref={iframeRef}
            src={committedUrl}
            className="size-full border-0"
            title="Browser"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
            <Globe className="size-8 opacity-20" />
            <span>Enter a URL above to browse</span>
          </div>
        )}
      </div>
    </div>
  )
}
