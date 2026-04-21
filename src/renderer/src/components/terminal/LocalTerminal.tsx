import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import '@xterm/xterm/css/xterm.css'
import { useTheme } from 'next-themes'
import { useTranslation } from 'react-i18next'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { getTerminalTheme, resolveAppThemeMode } from '@renderer/lib/theme-presets'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@renderer/components/ui/context-menu'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { Clipboard, Copy } from 'lucide-react'
import { toast } from 'sonner'

interface TerminalOutputChunk {
  seq?: number
  data?: string
}

interface TerminalListEntry {
  id?: string
  buffer?: TerminalOutputChunk[]
}

export function LocalTerminal({ terminalId }: { terminalId: string }): React.JSX.Element {
  const { t } = useTranslation('ssh')
  const { resolvedTheme } = useTheme()
  const themePreset = useSettingsStore((state) => state.themePreset)
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const initialThemeRef = useRef(getTerminalTheme(themePreset, resolveAppThemeMode(resolvedTheme)))
  const [hasSelection, setHasSelection] = useState(false)
  const terminalTheme = getTerminalTheme(themePreset, resolveAppThemeMode(resolvedTheme))

  useEffect(() => {
    if (!containerRef.current) return

    const term = new XTerm({
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: 14,
      fontFamily:
        "'Cascadia Code', 'Fira Code', 'JetBrains Mono', Consolas, 'Courier New', monospace",
      allowProposedApi: true,
      scrollback: 5000,
      convertEol: false,
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
    term.focus()
    termRef.current = term
    let disposed = false
    let snapshotLoaded = false
    let latestSeq = 0
    const pendingChunks: Array<{ seq: number; data: string }> = []

    const writeChunk = (chunk: TerminalOutputChunk): void => {
      if (!chunk.data) return
      const seq = typeof chunk.seq === 'number' ? chunk.seq : latestSeq + 1
      if (seq <= latestSeq) return
      latestSeq = seq
      term.write(chunk.data)
    }

    const selectionDisposable = term.onSelectionChange(() => {
      setHasSelection(term.getSelection().length > 0)
    })

    const dataDisposable = term.onData((data) => {
      void ipcClient.invoke(IPC.TERMINAL_INPUT, { id: terminalId, data })
    })

    const resizeDisposable = term.onResize(({ cols, rows }) => {
      void ipcClient.invoke(IPC.TERMINAL_RESIZE, { id: terminalId, cols, rows })
    })

    const outputCleanup = ipcClient.on(IPC.TERMINAL_OUTPUT, (payload) => {
      const data = payload as { id?: string; data?: string; seq?: number }
      if (data.id !== terminalId || !data.data) return
      if (!snapshotLoaded) {
        pendingChunks.push({
          seq: typeof data.seq === 'number' ? data.seq : latestSeq + pendingChunks.length + 1,
          data: data.data
        })
        return
      }
      writeChunk(data)
    })

    void ipcClient
      .invoke(IPC.TERMINAL_LIST)
      .then((result) => {
        if (disposed) return
        const sessions = Array.isArray(result) ? (result as TerminalListEntry[]) : []
        const matched = sessions.find((item) => item.id === terminalId)
        const snapshot = Array.isArray(matched?.buffer) ? matched.buffer : []

        snapshot
          .slice()
          .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
          .forEach((chunk) => writeChunk(chunk))
      })
      .catch(() => {
        // ignore terminal snapshot failures; live output listener remains active
      })
      .finally(() => {
        if (disposed) return
        snapshotLoaded = true
        pendingChunks.sort((a, b) => a.seq - b.seq).forEach((chunk) => writeChunk(chunk))
        pendingChunks.length = 0
      })

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        try {
          fitAddon.fit()
          void ipcClient.invoke(IPC.TERMINAL_RESIZE, {
            id: terminalId,
            cols: term.cols,
            rows: term.rows
          })
        } catch {
          // ignore
        }
      })
    })
    resizeObserver.observe(containerRef.current)

    requestAnimationFrame(() => {
      fitAddon.fit()
      void ipcClient.invoke(IPC.TERMINAL_RESIZE, {
        id: terminalId,
        cols: term.cols,
        rows: term.rows
      })
    })

    return () => {
      disposed = true
      selectionDisposable.dispose()
      dataDisposable.dispose()
      resizeDisposable.dispose()
      outputCleanup()
      resizeObserver.disconnect()
      term.dispose()
      termRef.current = null
    }
  }, [terminalId])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.theme = terminalTheme
  }, [terminalTheme])

  const handleCopy = useCallback(() => {
    const selection = termRef.current?.getSelection()
    if (!selection) return
    navigator.clipboard.writeText(selection).then(
      () => toast.success(t('terminal.copied')),
      () => toast.error(t('terminal.copyFailed'))
    )
  }, [t])

  const handlePaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (!text) return
      await ipcClient.invoke(IPC.TERMINAL_INPUT, { id: terminalId, data: text })
    } catch {
      toast.error(t('terminal.pasteFailed'))
    }
  }, [terminalId, t])

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-background">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={containerRef}
            className="flex-1 overflow-hidden px-1 py-1"
            style={{ minHeight: 0 }}
            onClick={() => termRef.current?.focus()}
          />
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={handleCopy} disabled={!hasSelection}>
            <Copy className="mr-2 size-4" />
            {t('terminal.copy')}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => void handlePaste()}>
            <Clipboard className="mr-2 size-4" />
            {t('terminal.paste')}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => termRef.current?.clear()}>
            {t('terminal.clear')}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => termRef.current?.selectAll()}>
            {t('terminal.selectAll')}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  )
}
