import { useEffect, useState, useCallback } from 'react'
import {
  MessageSquare,
  CircleHelp,
  Briefcase,
  Code2,
  ShieldCheck,
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
  Sparkles
} from 'lucide-react'
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator
} from '@renderer/components/ui/command'
import { useChatStore } from '@renderer/stores/chat-store'
import { useUIStore, type AppMode } from '@renderer/stores/ui-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { abortSession, clearPendingSessionMessages } from '@renderer/hooks/use-chat-actions'
import { useTheme } from 'next-themes'
import type { ProviderType } from '@renderer/lib/api/types'
import { sessionToMarkdown } from '@renderer/lib/utils/export-chat'
import { openSessionOrFocusDetached } from '@renderer/lib/session-window'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'

const MODEL_PRESETS: Record<ProviderType, string[]> = {
  anthropic: [
    'claude-sonnet-4-5-20250929',
    'claude-opus-4-5-20251101',
    'claude-haiku-4-5-20251001',
    'claude-sonnet-4-20250514',
    'claude-opus-4-20250514',
    '',
    'claude-3-5-haiku-20241022'
  ],
  gemini: [
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-3.1-flash-lite-preview',
    'gemini-3.1-flash-image-preview',
    'gemini-3-pro-image-preview'
  ],
  'vertex-ai': ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-3.1-flash-lite-preview'],
  'openai-chat': ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini', 'o3-mini', 'o4-mini'],
  'openai-responses': [
    'gpt-4.1',
    'gpt-4.1-mini',
    'gpt-4o',
    'gpt-4o-mini',
    'o3-mini',
    'o4-mini',
    'gpt-5',
    'gpt-5.1',
    'gpt-5.2',
    'gpt-5.2-mini',
    'gpt-5.2-codex',
    'gpt-5.1-codex-mini',
    'gpt-5.3-codex'
  ],
  'openai-images': ['dall-e-3', 'dall-e-2', 'gpt-image-1']
}

export function CommandPalette(): React.JSX.Element {
  const { t } = useTranslation('layout')
  const [open, setOpen] = useState(false)

  const sessions = useChatStore((s) => s.sessions)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const setActiveSession = useChatStore((s) => s.setActiveSession)
  const deleteSession = useChatStore((s) => s.deleteSession)
  const togglePinSession = useChatStore((s) => s.togglePinSession)
  const updateSessionMode = useChatStore((s) => s.updateSessionMode)
  const mode = useUIStore((s) => s.mode)
  const chatView = useUIStore((s) => s.chatView)
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

  const handleModeChange = useCallback(
    (nextMode: AppMode): void => {
      setMode(nextMode)
      if (chatView === 'session' && activeSessionId) {
        updateSessionMode(activeSessionId, nextMode)
      }
    },
    [activeSessionId, chatView, setMode, updateSessionMode]
  )

  const activeSession = sessions.find((s) => s.id === activeSessionId)
  const otherSessions = [...sessions]
    .filter((s) => s.id !== activeSessionId)
    .sort((a, b) => {
      if (a.pinned && !b.pinned) return -1
      if (!a.pinned && b.pinned) return 1
      return b.updatedAt - a.updatedAt
    })

  // Extract searchable text snippets from session messages
  const sessionKeywords = (s: (typeof sessions)[0]): string => {
    if (!s.messagesLoaded) return ''
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
      <CommandInput placeholder={t('commandPalette.placeholder')} />
      <CommandList>
        <CommandEmpty>{t('commandPalette.noResults')}</CommandEmpty>

        {/* Quick Actions */}
        <CommandGroup heading={t('commandPalette.actions')}>
          <CommandItem
            onSelect={() =>
              runAndClose(() => {
                const uiStore = useUIStore.getState()
                setActiveSession(null)
                uiStore.setMode('chat')
                uiStore.navigateToHome()
              })
            }
          >
            <Plus className="size-4" />
            <span>{t('commandPalette.newChat')}</span>
            <CommandShortcut>Ctrl+N</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => runAndClose(() => setSettingsOpen(true))}>
            <Settings className="size-4" />
            <span>{t('commandPalette.openSettings')}</span>
            <CommandShortcut>Ctrl+,</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => runAndClose(() => setShortcutsOpen(true))}>
            <Keyboard className="size-4" />
            <span>{t('commandPalette.keyboardShortcuts')}</span>
            <CommandShortcut>Ctrl+/</CommandShortcut>
          </CommandItem>
          <CommandItem
            onSelect={() => runAndClose(() => setTheme(theme === 'dark' ? 'light' : 'dark'))}
          >
            {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
            <span>{t('commandPalette.toggleTheme')}</span>
            <CommandShortcut>Ctrl+Shift+D</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => runAndClose(toggleLeftSidebar)}>
            <PanelLeft className="size-4" />
            <span>{t('commandPalette.toggleSidebar')}</span>
            <CommandShortcut>Ctrl+B</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => runAndClose(toggleRightPanel)}>
            <PanelRight className="size-4" />
            <span>{t('commandPalette.toggleRightPanel')}</span>
            <CommandShortcut>Ctrl+Shift+B</CommandShortcut>
          </CommandItem>
          <CommandItem
            onSelect={() =>
              runAndClose(() => {
                window.dispatchEvent(
                  new KeyboardEvent('keydown', { key: 'o', ctrlKey: true, shiftKey: true })
                )
              })
            }
          >
            <Upload className="size-4" />
            <span>{t('commandPalette.importSessions')}</span>
            <CommandShortcut>Ctrl+Shift+O</CommandShortcut>
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        {/* Switch Model */}
        <CommandGroup heading={t('commandPalette.switchModel')}>
          {MODEL_PRESETS[useSettingsStore.getState().provider]
            ?.filter((m) => m !== useSettingsStore.getState().model)
            .map((m) => (
              <CommandItem
                key={m}
                onSelect={() =>
                  runAndClose(() => {
                    useSettingsStore.getState().updateSettings({ model: m })
                    toast.success(`Model: ${m.replace(/-\d{8}$/, '')}`)
                  })
                }
              >
                <Cpu className="size-4" />
                <span>{m.replace(/-\d{8}$/, '')}</span>
              </CommandItem>
            ))}
        </CommandGroup>

        <CommandSeparator />

        <CommandSeparator />

        <CommandGroup heading={t('commandPalette.switchMode')}>
          {(
            [
              {
                value: 'clarify' as AppMode,
                label: t('commandPalette.switchToClarify'),
                icon: <CircleHelp className="size-4" />
              },
              {
                value: 'cowork' as AppMode,
                label: t('commandPalette.switchToCowork'),
                icon: <Briefcase className="size-4" />
              },
              {
                value: 'code' as AppMode,
                label: t('commandPalette.switchToCode'),
                icon: <Code2 className="size-4" />
              },
              {
                value: 'acp' as AppMode,
                label: t('commandPalette.switchToAcp'),
                icon: <ShieldCheck className="size-4" />
              }
            ] as const
          )
            .filter((m) => m.value !== mode)
            .map((m) => (
              <CommandItem
                key={m.value}
                onSelect={() => runAndClose(() => handleModeChange(m.value))}
              >
                {m.icon}
                <span>{m.label}</span>
              </CommandItem>
            ))}
        </CommandGroup>

        <CommandSeparator />

        {/* Current Session */}
        {activeSession && (
          <>
            <CommandGroup heading={t('commandPalette.currentSession')}>
              <CommandItem
                onSelect={() =>
                  runAndClose(() => {
                    if (!activeSessionId) return
                    useChatStore
                      .getState()
                      .loadSessionMessages(activeSessionId)
                      .then(() => {
                        const latest = useChatStore
                          .getState()
                          .sessions.find((s) => s.id === activeSessionId)
                        if (!latest) return
                        const md = sessionToMarkdown(latest)
                        navigator.clipboard.writeText(md)
                        toast.success(t('commandPalette.copiedConversation'))
                      })
                      .catch(() => {})
                  })
                }
              >
                <Download className="size-4" />
                <span>{t('commandPalette.exportCurrentChat')}</span>
                <CommandShortcut>Ctrl+Shift+E</CommandShortcut>
              </CommandItem>
              <CommandItem onSelect={() => runAndClose(() => togglePinSession(activeSessionId!))}>
                <Pin className="size-4" />
                <span>
                  {activeSession.pinned
                    ? t('commandPalette.unpinSession')
                    : t('commandPalette.pinSession')}
                </span>
              </CommandItem>
              {sessions.length > 1 && (
                <CommandItem
                  onSelect={() =>
                    runAndClose(() => {
                      abortSession(activeSessionId!)
                      clearPendingSessionMessages(activeSessionId!)
                      deleteSession(activeSessionId!)
                    })
                  }
                >
                  <Trash2 className="size-4 text-destructive" />
                  <span className="text-destructive">
                    {t('commandPalette.deleteCurrentSession')}
                  </span>
                </CommandItem>
              )}
            </CommandGroup>
            <CommandSeparator />
          </>
        )}

        {/* Quick Prompts */}
        <CommandGroup heading={t('commandPalette.quickPrompts')}>
          {[
            {
              label: t('commandPalette.explainCode'),
              prompt:
                'Explain the following code in detail, including what it does and how it works:\n\n'
            },
            {
              label: t('commandPalette.findBugs'),
              prompt: 'Review the following code for bugs, edge cases, and potential issues:\n\n'
            },
            {
              label: t('commandPalette.addErrorHandling'),
              prompt: 'Add comprehensive error handling to the following code:\n\n'
            },
            {
              label: t('commandPalette.writeTests'),
              prompt: 'Write thorough unit tests for the following code:\n\n'
            },
            {
              label: t('commandPalette.refactor'),
              prompt: 'Refactor the following code for better readability and maintainability:\n\n'
            },
            {
              label: t('commandPalette.addTypes'),
              prompt: 'Add proper TypeScript types and interfaces to the following code:\n\n'
            }
          ].map((p) => (
            <CommandItem
              key={p.label}
              onSelect={() =>
                runAndClose(() => {
                  useUIStore.getState().setPendingInsertText(p.prompt)
                })
              }
            >
              <Sparkles className="size-4" />
              <span>{p.label}</span>
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandSeparator />

        {/* All Sessions (searchable by title + message content) */}
        {otherSessions.length > 0 && (
          <CommandGroup heading={t('commandPalette.sessionsGroup')}>
            {otherSessions.map((s) => (
              <CommandItem
                key={s.id}
                value={`${s.title} ${sessionKeywords(s)}`}
                onSelect={() =>
                  runAndClose(() => {
                    void openSessionOrFocusDetached(s.id)
                  })
                }
              >
                {s.mode === 'chat' ? (
                  <MessageSquare className="size-4" />
                ) : s.mode === 'clarify' ? (
                  <CircleHelp className="size-4" />
                ) : s.mode === 'cowork' ? (
                  <Briefcase className="size-4" />
                ) : s.mode === 'acp' ? (
                  <ShieldCheck className="size-4" />
                ) : (
                  <Code2 className="size-4" />
                )}
                <span className="truncate">{s.title}</span>
                <span className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground/40">
                  {s.pinned && <Pin className="size-2.5" />}
                  {s.messageCount}msg
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  )
}
