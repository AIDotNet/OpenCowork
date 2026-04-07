import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal as XTerm, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import '@xterm/xterm/css/xterm.css'
import { useTheme } from 'next-themes'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@renderer/components/ui/context-menu'
import { Clipboard, Copy } from 'lucide-react'
import { toast } from 'sonner'

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
  brightWhite: '#f9fafb'
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
  brightWhite: '#f8fafc'
}

export function LocalTerminal({ terminalId }: { terminalId: string }): React.JSX.Element {
  const { resolvedTheme } = useTheme()
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const [hasSelection, setHasSelection] = useState(false)

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
      theme: DARK_THEME
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
      const data = payload as { id?: string; data?: string }
      if (data.id !== terminalId || !data.data) return
      term.write(data.data)
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
    term.options.theme = resolvedTheme === 'light' ? LIGHT_THEME : DARK_THEME
  }, [resolvedTheme])

  const handleCopy = useCallback(() => {
    const selection = termRef.current?.getSelection()
    if (!selection) return
    navigator.clipboard.writeText(selection).then(
      () => toast.success('已复制'),
      () => toast.error('复制失败')
    )
  }, [])

  const handlePaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (!text) return
      await ipcClient.invoke(IPC.TERMINAL_INPUT, { id: terminalId, data: text })
    } catch {
      toast.error('粘贴失败')
    }
  }, [terminalId])

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
            复制
          </ContextMenuItem>
          <ContextMenuItem onClick={() => void handlePaste()}>
            <Clipboard className="mr-2 size-4" />
            粘贴
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => termRef.current?.clear()}>清空</ContextMenuItem>
          <ContextMenuItem onClick={() => termRef.current?.selectAll()}>全选</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  )
}
