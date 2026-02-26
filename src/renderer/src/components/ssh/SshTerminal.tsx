import { useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Terminal as XTerm } from '@xterm/xterm'
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

interface SshTerminalProps {
  sessionId: string
  connectionName: string
}

export function SshTerminal({ sessionId, connectionName: _connectionName }: SshTerminalProps): React.JSX.Element {
  const { t } = useTranslation('ssh')
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
      theme: {
        background: '#0a0a0a',
        foreground: '#e4e4e7',
        cursor: '#e4e4e7',
        cursorAccent: '#0a0a0a',
        selectionBackground: '#3f3f46',
        selectionForeground: '#fafafa',
        black: '#18181b',
        red: '#ef4444',
        green: '#22c55e',
        yellow: '#eab308',
        blue: '#3b82f6',
        magenta: '#a855f7',
        cyan: '#06b6d4',
        white: '#e4e4e7',
        brightBlack: '#52525b',
        brightRed: '#f87171',
        brightGreen: '#4ade80',
        brightYellow: '#facc15',
        brightBlue: '#60a5fa',
        brightMagenta: '#c084fc',
        brightCyan: '#22d3ee',
        brightWhite: '#fafafa',
      },
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
    <div className="relative flex flex-col h-full overflow-hidden bg-[#0a0a0a]">
      {/* Disconnected overlay */}
      {session && session.status !== 'connected' && session.status !== 'connecting' && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-2 text-center">
            <Badge variant="destructive" className="text-xs">
              {session.status === 'error' ? t('terminal.errorMessage') : t('terminal.disconnectedMessage')}
            </Badge>
            {session.error && (
              <p className="text-[10px] text-zinc-500 max-w-xs">{session.error}</p>
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
