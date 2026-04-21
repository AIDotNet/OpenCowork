import { useEffect, useRef, useCallback, useState } from 'react'
import { useTheme } from 'next-themes'
import { useTranslation } from 'react-i18next'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import '@xterm/xterm/css/xterm.css'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { getTerminalTheme, resolveAppThemeMode } from '@renderer/lib/theme-presets'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useSshStore } from '@renderer/stores/ssh-store'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { RotateCcw, Copy, Clipboard } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  ContextMenuSeparator
} from '@renderer/components/ui/context-menu'
import { toast } from 'sonner'

interface SshTerminalProps {
  sessionId: string
  connectionName: string
}

export function SshTerminal({ sessionId }: SshTerminalProps): React.JSX.Element {
  const { t } = useTranslation('ssh')
  const { resolvedTheme } = useTheme()
  const terminalThemePreset = useSettingsStore((state) => state.sshTerminalThemePreset)
  const terminalTheme = getTerminalTheme(terminalThemePreset, resolveAppThemeMode(resolvedTheme))
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const searchAddonRef = useRef<SearchAddon | null>(null)
  const lastSeqRef = useRef(0)
  const initialThemeRef = useRef(terminalTheme)
  const [hasSelection, setHasSelection] = useState(false)
  const session = useSshStore((s) => s.sessions[sessionId])

  // Initialize xterm
  useEffect(() => {
    if (!containerRef.current) return
    lastSeqRef.current = 0

    const term = new XTerm({
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: 14,
      fontFamily:
        "'Cascadia Code', 'Fira Code', 'JetBrains Mono', Consolas, 'Courier New', monospace",
      allowProposedApi: true,
      scrollback: 2000,
      convertEol: true,
      theme: initialThemeRef.current
    })

    const fitAddon = new FitAddon()
    const searchAddon = new SearchAddon()
    const webLinksAddon = new WebLinksAddon()
    const unicodeAddon = new Unicode11Addon()

    term.loadAddon(fitAddon)
    term.loadAddon(searchAddon)
    term.loadAddon(webLinksAddon)
    term.loadAddon(unicodeAddon)
    term.unicode.activeVersion = '11'

    term.open(containerRef.current)
    fitAddon.fit()

    termRef.current = term
    fitAddonRef.current = fitAddon
    searchAddonRef.current = searchAddon

    // Track selection changes
    const selectionDisposable = term.onSelectionChange(() => {
      const selection = term.getSelection()
      setHasSelection(selection.length > 0)
    })

    // Send keyboard input to SSH
    const dataDisposable = term.onData((data) => {
      ipcClient.send(IPC.SSH_DATA, { sessionId, data })
    })

    // Also handle binary data (mouse events, etc.)
    const binaryDisposable = term.onBinary((data) => {
      ipcClient.send(IPC.SSH_DATA, { sessionId, data })
    })

    // Handle resize
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      ipcClient.send(IPC.SSH_RESIZE, { sessionId, cols, rows })
    })

    const pendingChunks: { seq: number; data: string }[] = []
    let bufferLoaded = false

    const decodeBase64 = (b64: string): Uint8Array => {
      const raw = atob(b64)
      const bytes = new Uint8Array(raw.length)
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
      return bytes
    }

    // Receive output from SSH
    const outputCleanup = window.electron.ipcRenderer.on(
      IPC.SSH_OUTPUT,
      (_event: unknown, payload: { sessionId: string; data: string; seq?: number }) => {
        if (payload.sessionId !== sessionId) return
        const seq = typeof payload.seq === 'number' ? payload.seq : 0

        if (!bufferLoaded) {
          pendingChunks.push({ seq, data: payload.data })
          return
        }

        if (seq && seq <= lastSeqRef.current) return
        if (seq) lastSeqRef.current = seq

        term.write(decodeBase64(payload.data))
      }
    )

    const loadBuffer = async (): Promise<void> => {
      try {
        const result = await ipcClient.invoke(IPC.SSH_OUTPUT_BUFFER, { sessionId, sinceSeq: 0 })
        if (result && typeof result === 'object') {
          const { chunks, lastSeq } = result as { chunks?: string[]; lastSeq?: number }
          if (Array.isArray(chunks)) {
            for (const chunk of chunks) {
              term.write(decodeBase64(chunk))
            }
          }
          if (typeof lastSeq === 'number') {
            lastSeqRef.current = Math.max(lastSeqRef.current, lastSeq)
          }
        }
      } catch {
        // ignore
      }

      bufferLoaded = true
      if (pendingChunks.length > 0) {
        pendingChunks.sort((a, b) => a.seq - b.seq)
        for (const chunk of pendingChunks) {
          if (chunk.seq && chunk.seq <= lastSeqRef.current) continue
          if (chunk.seq) lastSeqRef.current = chunk.seq
          term.write(decodeBase64(chunk.data))
        }
        pendingChunks.length = 0
      }
    }

    void loadBuffer()

    // Fit on window resize
    const handleWindowResize = (): void => {
      fitAddon.fit()
    }
    window.addEventListener('resize', handleWindowResize)

    // ResizeObserver for container resize
    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        try {
          fitAddon.fit()
        } catch {
          // ignore
        }
      })
    })
    resizeObserver.observe(containerRef.current)

    // Re-fit when terminal becomes visible again (e.g. page switch back)
    const intersectionObserver = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) {
        requestAnimationFrame(() => {
          try {
            fitAddon.fit()
            ipcClient.send(IPC.SSH_RESIZE, {
              sessionId,
              cols: term.cols,
              rows: term.rows
            })
          } catch {
            // ignore
          }
        })
      }
    })
    intersectionObserver.observe(containerRef.current)

    // Send initial size to remote
    setTimeout(() => {
      fitAddon.fit()
      ipcClient.send(IPC.SSH_RESIZE, {
        sessionId,
        cols: term.cols,
        rows: term.rows
      })
    }, 100)

    return () => {
      dataDisposable.dispose()
      binaryDisposable.dispose()
      resizeDisposable.dispose()
      selectionDisposable.dispose()
      outputCleanup()
      window.removeEventListener('resize', handleWindowResize)
      resizeObserver.disconnect()
      intersectionObserver.disconnect()
      term.dispose()
      termRef.current = null
      fitAddonRef.current = null
      searchAddonRef.current = null
    }
  }, [sessionId])

  useEffect(() => {
    if (!termRef.current) return
    termRef.current.options.theme = terminalTheme
  }, [terminalTheme])

  // Focus terminal on click
  const handleContainerClick = useCallback(() => {
    termRef.current?.focus()
  }, [])

  const handleReconnect = useCallback(async () => {
    if (!session) return
    const store = useSshStore.getState()
    await store.disconnect(sessionId)
    await store.connect(session.connectionId)
  }, [session, sessionId])

  const handleCopy = useCallback(() => {
    const term = termRef.current
    if (!term) return

    const selection = term.getSelection()
    if (selection) {
      navigator.clipboard.writeText(selection).then(
        () => {
          toast.success(t('terminal.copied'))
        },
        () => {
          toast.error(t('terminal.copyFailed'))
        }
      )
    }
  }, [t])

  const handlePaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (text) {
        ipcClient.send(IPC.SSH_DATA, { sessionId, data: text })
      }
    } catch {
      toast.error(t('terminal.pasteFailed'))
    }
  }, [sessionId, t])

  const handleSelectAll = useCallback(() => {
    termRef.current?.selectAll()
  }, [])

  const handleClear = useCallback(() => {
    termRef.current?.clear()
  }, [])

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-[#151b30]">
      {/* Disconnected overlay */}
      {session && session.status !== 'connected' && session.status !== 'connecting' && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#11162a]/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-2 text-center">
            <Badge variant="destructive" className="rounded-full px-3 py-1 text-xs">
              {session.status === 'error'
                ? t('terminal.errorMessage')
                : t('terminal.disconnectedMessage')}
            </Badge>
            {session.error && <p className="max-w-xs text-[10px] text-white/70">{session.error}</p>}
            <Button
              variant="outline"
              size="sm"
              className="mt-1 h-8 gap-1 rounded-full border-white/10 bg-white/5 text-xs text-white hover:bg-white/10"
              onClick={() => void handleReconnect()}
            >
              <RotateCcw className="size-3" />
              {t('terminal.reconnect')}
            </Button>
          </div>
        </div>
      )}

      {/* Terminal container with context menu */}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={containerRef}
            className="flex-1 overflow-hidden px-3 py-3"
            onClick={handleContainerClick}
            style={{ minHeight: 0 }}
          />
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={handleCopy} disabled={!hasSelection}>
            <Copy className="size-4 mr-2" />
            {t('terminal.copy')}
          </ContextMenuItem>
          <ContextMenuItem onClick={handlePaste}>
            <Clipboard className="size-4 mr-2" />
            {t('terminal.paste')}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={handleSelectAll}>{t('terminal.selectAll')}</ContextMenuItem>
          <ContextMenuItem onClick={handleClear}>{t('terminal.clear')}</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  )
}
