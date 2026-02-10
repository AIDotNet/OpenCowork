import { useEffect, useState, useCallback } from 'react'
import {
  MessageSquare,
  Briefcase,
  Code2,
  Plus,
  Settings,
  Keyboard,
  Sun,
  Moon,
  PanelLeft,
  PanelRight,
  Download,
  Upload,
  Trash2,
  Pin,
  Cpu,
  Sparkles,
} from 'lucide-react'
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
} from '@renderer/components/ui/command'
import { useChatStore } from '@renderer/stores/chat-store'
import { useUIStore, type AppMode } from '@renderer/stores/ui-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useTheme } from 'next-themes'
import type { ProviderType } from '@renderer/lib/api/types'
import { sessionToMarkdown } from '@renderer/lib/utils/export-chat'
import { toast } from 'sonner'

const MODEL_PRESETS: Record<ProviderType, string[]> = {
  anthropic: ['claude-sonnet-4-20250514', 'claude-opus-4-20250514', 'claude-3-5-haiku-20241022'],
  'openai-chat': ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini', 'o3-mini', 'o4-mini'],
  'openai-responses': ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini', 'o3-mini', 'o4-mini'],
}

export function CommandPalette(): React.JSX.Element {
  const [open, setOpen] = useState(false)

  const sessions = useChatStore((s) => s.sessions)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const createSession = useChatStore((s) => s.createSession)
  const setActiveSession = useChatStore((s) => s.setActiveSession)
  const deleteSession = useChatStore((s) => s.deleteSession)
  const togglePinSession = useChatStore((s) => s.togglePinSession)

  const mode = useUIStore((s) => s.mode)
  const setMode = useUIStore((s) => s.setMode)
  const toggleLeftSidebar = useUIStore((s) => s.toggleLeftSidebar)
  const toggleRightPanel = useUIStore((s) => s.toggleRightPanel)
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen)
  const setShortcutsOpen = useUIStore((s) => s.setShortcutsOpen)

  const { theme, setTheme } = useTheme()

  // Ctrl+K to toggle
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const runAndClose = useCallback((fn: () => void) => {
    fn()
    setOpen(false)
  }, [])

  const activeSession = sessions.find((s) => s.id === activeSessionId)
  const otherSessions = [...sessions]
    .filter((s) => s.id !== activeSessionId)
    .sort((a, b) => {
      if (a.pinned && !b.pinned) return -1
      if (!a.pinned && b.pinned) return 1
      return b.updatedAt - a.updatedAt
    })

  // Extract searchable text snippets from session messages
  const sessionKeywords = (s: typeof sessions[0]): string => {
    const texts: string[] = []
    for (const m of s.messages) {
      if (typeof m.content === 'string') {
        texts.push(m.content.slice(0, 200))
      } else if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b.type === 'text') texts.push(b.text.slice(0, 200))
        }
      }
      if (texts.length >= 5) break
    }
    return texts.join(' ').slice(0, 500)
  }

  return (
    <CommandDialog open={open} onOpenChange={setOpen} showCloseButton={false}>
      <CommandInput placeholder="Type a command or search sessions..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        {/* Quick Actions */}
        <CommandGroup heading="Actions">
          <CommandItem onSelect={() => runAndClose(() => { const id = createSession(mode); setActiveSession(id) })}>
            <Plus className="size-4" />
            <span>New Chat</span>
            <CommandShortcut>Ctrl+N</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => runAndClose(() => setSettingsOpen(true))}>
            <Settings className="size-4" />
            <span>Open Settings</span>
            <CommandShortcut>Ctrl+,</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => runAndClose(() => setShortcutsOpen(true))}>
            <Keyboard className="size-4" />
            <span>Keyboard Shortcuts</span>
            <CommandShortcut>Ctrl+/</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => runAndClose(() => setTheme(theme === 'dark' ? 'light' : 'dark'))}>
            {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
            <span>Toggle Theme</span>
            <CommandShortcut>Ctrl+Shift+D</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => runAndClose(toggleLeftSidebar)}>
            <PanelLeft className="size-4" />
            <span>Toggle Sidebar</span>
            <CommandShortcut>Ctrl+B</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => runAndClose(toggleRightPanel)}>
            <PanelRight className="size-4" />
            <span>Toggle Right Panel</span>
            <CommandShortcut>Ctrl+Shift+B</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => runAndClose(() => {
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', ctrlKey: true, shiftKey: true }))
          })}>
            <Upload className="size-4" />
            <span>Import Sessions from JSON</span>
            <CommandShortcut>Ctrl+Shift+O</CommandShortcut>
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        {/* Switch Model */}
        <CommandGroup heading="Switch Model">
          {MODEL_PRESETS[useSettingsStore.getState().provider]?.filter((m) => m !== useSettingsStore.getState().model).map((m) => (
            <CommandItem key={m} onSelect={() => runAndClose(() => {
              useSettingsStore.getState().updateSettings({ model: m })
              toast.success(`Model: ${m.replace(/-\d{8}$/, '')}`)
            })}>
              <Cpu className="size-4" />
              <span>{m.replace(/-\d{8}$/, '')}</span>
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandSeparator />

        {/* Mode Switch */}
        <CommandGroup heading="Switch Mode">
          {([
            { value: 'chat' as AppMode, label: 'Chat', icon: <MessageSquare className="size-4" /> },
            { value: 'cowork' as AppMode, label: 'Cowork', icon: <Briefcase className="size-4" /> },
            { value: 'code' as AppMode, label: 'Code', icon: <Code2 className="size-4" /> },
          ] as const).filter((m) => m.value !== mode).map((m) => (
            <CommandItem key={m.value} onSelect={() => runAndClose(() => setMode(m.value))}>
              {m.icon}
              <span>Switch to {m.label} Mode</span>
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandSeparator />

        {/* Current Session */}
        {activeSession && (
          <>
            <CommandGroup heading="Current Session">
              <CommandItem onSelect={() => runAndClose(() => {
                const md = sessionToMarkdown(activeSession)
                navigator.clipboard.writeText(md)
                toast.success('Copied conversation to clipboard')
              })}>
                <Download className="size-4" />
                <span>Export Current Chat</span>
                <CommandShortcut>Ctrl+Shift+E</CommandShortcut>
              </CommandItem>
              <CommandItem onSelect={() => runAndClose(() => togglePinSession(activeSessionId!))}>
                <Pin className="size-4" />
                <span>{activeSession.pinned ? 'Unpin Session' : 'Pin Session'}</span>
              </CommandItem>
              {sessions.length > 1 && (
                <CommandItem onSelect={() => runAndClose(() => deleteSession(activeSessionId!))}>
                  <Trash2 className="size-4 text-destructive" />
                  <span className="text-destructive">Delete Current Session</span>
                </CommandItem>
              )}
            </CommandGroup>
            <CommandSeparator />
          </>
        )}

        {/* Quick Prompts */}
        <CommandGroup heading="Quick Prompts">
          {[
            { label: 'Explain this code', prompt: 'Explain the following code in detail, including what it does and how it works:\n\n' },
            { label: 'Find bugs', prompt: 'Review the following code for bugs, edge cases, and potential issues:\n\n' },
            { label: 'Add error handling', prompt: 'Add comprehensive error handling to the following code:\n\n' },
            { label: 'Write tests', prompt: 'Write thorough unit tests for the following code:\n\n' },
            { label: 'Refactor', prompt: 'Refactor the following code for better readability and maintainability:\n\n' },
            { label: 'Add types', prompt: 'Add proper TypeScript types and interfaces to the following code:\n\n' },
          ].map((p) => (
            <CommandItem key={p.label} onSelect={() => runAndClose(() => {
              useUIStore.getState().setPendingInsertText(p.prompt)
            })}>
              <Sparkles className="size-4" />
              <span>{p.label}</span>
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandSeparator />

        {/* All Sessions (searchable by title + message content) */}
        {otherSessions.length > 0 && (
          <CommandGroup heading="Sessions">
            {otherSessions.map((s) => (
              <CommandItem
                key={s.id}
                value={`${s.title} ${sessionKeywords(s)}`}
                onSelect={() => runAndClose(() => setActiveSession(s.id))}
              >
                {s.mode === 'chat' ? <MessageSquare className="size-4" /> :
                 s.mode === 'cowork' ? <Briefcase className="size-4" /> :
                 <Code2 className="size-4" />}
                <span className="truncate">{s.title}</span>
                <span className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground/40">
                  {s.pinned && <Pin className="size-2.5" />}
                  {s.messages.length}msg
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  )
}
