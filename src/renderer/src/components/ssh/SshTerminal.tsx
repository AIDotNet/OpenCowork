import { useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Terminal as XTerm, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import '@xterm/xterm/css/xterm.css'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { useSshStore } from '@renderer/stores/ssh-store'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { RotateCcw } from 'lucide-react'
import { useTheme } from 'next-themes'

interface SshTerminalProps {
  sessionId: string
  connectionName: string
}

const DARK_THEME: ITheme = {
  background: '#0b0b0b',
  foreground: '#e5e7eb',
  cursor: '#e5e7eb',
  cursorAccent: '#0b0b0b',
  selectionBackground: 'rgba(148, 163, 184, 0.35)',
  black: '#0b0b0b',
  red: '#ef4444',
  green: '#22c55e',
  yellow: '#eab308',
  blue: '#3b82f6',
  magenta: '#a855f7',
  cyan: '#06b6d4',
  white: '#e5e7eb',
  brightBlack: '#6b7280',
  brightRed: '#f87171',
  brightGreen: '#4ade80',
  brightYellow: '#facc15',
  brightBlue: '#60a5fa',
  brightMagenta: '#c084fc',
  brightCyan: '#22d3ee',
  brightWhite: '#f9fafb',
}

const LIGHT_THEME: ITheme = {
  background: '#ffffff',
  foreground: '#0f172a',
  cursor: '#0f172a',
  cursorAccent: '#ffffff',
  selectionBackground: 'rgba(15, 23, 42, 0.15)',
  black: '#0f172a',
  red: '#dc2626',
  green: '#16a34a',
  yellow: '#ca8a04',
  blue: '#2563eb',
  magenta: '#7c3aed',
  cyan: '#0891b2',
  white: '#e2e8f0',
  brightBlack: '#64748b',
  brightRed: '#ef4444',
  brightGreen: '#22c55e',
  brightYellow: '#eab308',
  brightBlue: '#3b82f6',
  brightMagenta: '#a855f7',
  brightCyan: '#06b6d4',
  brightWhite: '#f8fafc',
}

export function SshTerminal({ sessionId, connectionName: _connectionName }: SshTerminalProps): React.JSX.Element {
  const { t } = useTranslation('ssh')
  const { resolvedTheme } = useTheme()
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const searchAddonRef = useRef<SearchAddon | null>(null)
  const lastSeqRef = useRef(0)

  const session = useSshStore((s) => s.sessions[sessionId])

  // Initialize xterm
  useEffect(() => {
    if (!containerRef.current) return
    lastSeqRef.current = 0

    const term = new XTerm({
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: 14,
      fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', Consolas, 'Courier New', monospace",
      allowProposedApi: true,
      scrollback: 10000,
      convertEol: true,
      theme: resolvedTheme === 'light' ? LIGHT_THEME : DARK_THEME,
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

    const pendingChunks: { seq: number; data: number[] }[] = []
    let bufferLoaded = false

    // Receive output from SSH
    const outputCleanup = window.electron.ipcRenderer.on(
      IPC.SSH_OUTPUT,
      (_event: unknown, payload: { sessionId: string; data: number[]; seq?: number }) => {
        if (payload.sessionId !== sessionId) return
        const seq = typeof payload.seq === 'number' ? payload.seq : 0

        if (!bufferLoaded) {
          pendingChunks.push({ seq, data: payload.data })
          return
        }

        if (seq && seq <= lastSeqRef.current) return
        if (seq) lastSeqRef.current = seq

        // Write binary data directly to preserve TUI rendering
        term.write(new Uint8Array(payload.data))
      }
    )

    const loadBuffer = async (): Promise<void> => {
      try {
        const result = await ipcClient.invoke(IPC.SSH_OUTPUT_BUFFER, { sessionId, sinceSeq: 0 })
        if (result && typeof result === 'object') {
          const { chunks, lastSeq } = result as { chunks?: number[][]; lastSeq?: number }
          if (Array.isArray(chunks)) {
            for (const chunk of chunks) {
              term.write(new Uint8Array(chunk))
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
          term.write(new Uint8Array(chunk.data))
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
              rows: term.rows,
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
        rows: term.rows,
      })
    }, 100)

    return () => {
      dataDisposable.dispose()
      binaryDisposable.dispose()
      resizeDisposable.dispose()
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
    const term = termRef.current
    if (!term) return
    term.options.theme = resolvedTheme === 'light' ? LIGHT_THEME : DARK_THEME
  }, [resolvedTheme])

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

  return (
    <div className="relative flex flex-col h-full overflow-hidden bg-background">
      {/* Disconnected overlay */}
      {session && session.status !== 'connected' && session.status !== 'connecting' && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-2 text-center">
            <Badge variant="destructive" className="text-xs">
              {session.status === 'error' ? t('terminal.errorMessage') : t('terminal.disconnectedMessage')}
            </Badge>
            {session.error && (
              <p className="text-[10px] text-muted-foreground max-w-xs">{session.error}</p>
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1 text-xs mt-1"
              onClick={() => void handleReconnect()}
            >
              <RotateCcw className="size-3" />
              {t('terminal.reconnect')}
            </Button>
          </div>
        </div>
      )}

      {/* Terminal container */}
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden px-1 py-1"
        onClick={handleContainerClick}
        style={{ minHeight: 0 }}
      />
    </div>
  )
}
