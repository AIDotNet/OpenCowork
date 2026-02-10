import { useState, useRef } from 'react'
import { nanoid } from 'nanoid'
import { Plus, MessageSquare, Trash2, Eraser, Search, Briefcase, Code2, Download, Copy, X, Pin, PinOff, Pencil, Upload } from 'lucide-react'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@renderer/components/ui/sidebar'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu'
import { Input } from '@renderer/components/ui/input'
import { Button } from '@renderer/components/ui/button'
import { toast } from 'sonner'
import { useChatStore, type SessionMode } from '@renderer/stores/chat-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { sessionToMarkdown } from '@renderer/lib/utils/export-chat'

const modeIcons: Record<SessionMode, React.ReactNode> = {
  chat: <MessageSquare className="size-4" />,
  cowork: <Briefcase className="size-4" />,
  code: <Code2 className="size-4" />,
}

export function AppSidebar(): React.JSX.Element {
  const sessions = useChatStore((s) => s.sessions)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const createSession = useChatStore((s) => s.createSession)
  const deleteSession = useChatStore((s) => s.deleteSession)
  const setActiveSession = useChatStore((s) => s.setActiveSession)
  const clearSessionMessages = useChatStore((s) => s.clearSessionMessages)
  const duplicateSession = useChatStore((s) => s.duplicateSession)
  const updateSessionMode = useChatStore((s) => s.updateSessionMode)
  const togglePinSession = useChatStore((s) => s.togglePinSession)
  const mode = useUIStore((s) => s.mode)
  const [search, setSearch] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const editRef = useRef<HTMLInputElement>(null)


  const handleNewSession = (): void => {
    createSession(mode)
  }

  const handleExport = (sessionId: string): void => {
    const session = sessions.find((s) => s.id === sessionId)
    if (!session) return
    const md = sessionToMarkdown(session)
    const filename = session.title.replace(/[^a-zA-Z0-9-_ ]/g, '').slice(0, 50).trim() || 'conversation'
    const blob = new Blob([md], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${filename}.md`
    a.click()
    URL.revokeObjectURL(url)
  }

  const sorted = sessions
    .slice()
    .sort((a, b) => {
      // Pinned sessions first
      if (a.pinned && !b.pinned) return -1
      if (!a.pinned && b.pinned) return 1
      return b.updatedAt - a.updatedAt
    })

  const filtered = search.trim()
    ? sorted.filter((s) => {
        const q = search.toLowerCase()
        if (s.title.toLowerCase().includes(q)) return true
        if (s.mode.toLowerCase().includes(q)) return true
        return s.messages.some((m) => {
          const text = typeof m.content === 'string' ? m.content : ''
          return text.toLowerCase().includes(q)
        })
      })
    : sorted

  // Group by date
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const yesterdayStart = todayStart - 86400000
  const weekStart = todayStart - 7 * 86400000
  const monthStart = todayStart - 30 * 86400000

  const groups: { label: string; items: typeof filtered }[] = []
  const today = filtered.filter((s) => s.updatedAt >= todayStart)
  const yesterday = filtered.filter((s) => s.updatedAt >= yesterdayStart && s.updatedAt < todayStart)
  const thisWeek = filtered.filter((s) => s.updatedAt >= weekStart && s.updatedAt < yesterdayStart)
  const thisMonth = filtered.filter((s) => s.updatedAt >= monthStart && s.updatedAt < weekStart)
  const older = filtered.filter((s) => s.updatedAt < monthStart)
  if (today.length) groups.push({ label: 'Today', items: today })
  if (yesterday.length) groups.push({ label: 'Yesterday', items: yesterday })
  if (thisWeek.length) groups.push({ label: 'This Week', items: thisWeek })
  if (thisMonth.length) groups.push({ label: 'This Month', items: thisMonth })
  if (older.length) groups.push({ label: 'Older', items: older })

  return (
    <Sidebar side="left" variant="sidebar" collapsible="icon">
      <SidebarHeader>
        <div className="flex items-center gap-2.5 px-1">
          <div className="flex size-7 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-primary/80 text-primary-foreground text-[10px] font-bold tracking-tight shadow-sm">
            OC
          </div>
          <span className="text-sm font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
            OpenCowork
          </span>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>
            Conversations
            {sessions.length > 0 && (
              <span className="ml-1 text-muted-foreground">({sessions.length})</span>
            )}
          </SidebarGroupLabel>
          <SidebarGroupAction onClick={handleNewSession} title="New conversation (Ctrl+N)">
            <Plus className="size-4" />
          </SidebarGroupAction>
          {sessions.some((s) => s.messages.length > 0) && (
            <SidebarGroupAction
              className="right-8"
              onClick={() => {
                const withMessages = sessions.filter((s) => s.messages.length > 0)
                withMessages.forEach((s) => handleExport(s.id))
                toast.success(`Exported ${withMessages.length} conversations`)
              }}
              title="Export all conversations"
            >
              <Download className="size-4" />
            </SidebarGroupAction>
          )}
          <SidebarGroupContent>
            {sessions.length > 3 && (
              <div className="px-2 pb-1.5 group-data-[collapsible=icon]:hidden">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3 text-muted-foreground/60" />
                  <Input
                    ref={searchRef}
                    placeholder="Filter sessions..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        setSearch('')
                        searchRef.current?.blur()
                      }
                    }}
                    className={`h-7 rounded-lg pl-7 text-xs bg-muted/50 border-transparent focus:border-border transition-colors ${search ? 'pr-6' : ''}`}
                  />
                  {search && (
                    <>
                      <span className="absolute right-6 top-1/2 -translate-y-1/2 text-[9px] text-muted-foreground/40 pointer-events-none">
                        {filtered.length}/{sorted.length}
                      </span>
                      <button
                        onClick={() => { setSearch(''); searchRef.current?.focus() }}
                        className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground hover:text-foreground transition-colors"
                      >
                        <X className="size-3" />
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}
            <SidebarMenu>
              {filtered.length === 0 ? (
                <div className="px-2 py-4 text-center text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
                  {sessions.length === 0 ? 'No conversations yet' : 'No matches'}
                </div>
              ) : (
                groups.map((group) => (
                  <div key={group.label}>
                    {groups.length > 1 && (
                      <div className="px-3 pt-2 pb-0.5 text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wider group-data-[collapsible=icon]:hidden">
                        {group.label}
                      </div>
                    )}
                    {group.items.map((session) => (
                      <ContextMenu key={session.id}>
                        <ContextMenuTrigger asChild>
                          <SidebarMenuItem>
                            <SidebarMenuButton
                              isActive={session.id === activeSessionId}
                              onClick={() => setActiveSession(session.id)}
                              onDoubleClick={(e) => {
                                e.preventDefault()
                                setEditingId(session.id)
                                setEditTitle(session.title)
                                setTimeout(() => editRef.current?.select(), 0)
                              }}
                              tooltip={`${session.title}\n${session.mode} · ${(() => { const m = Math.floor((Date.now() - session.updatedAt) / 60000); if (m < 1) return 'just now'; if (m < 60) return `${m}m ago`; const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`; return `${Math.floor(h / 24)}d ago`; })()} · ${session.messages.length} msgs${session.pinned ? ' · pinned' : ''}`}
                            >
                              {session.pinned ? <Pin className="size-3 shrink-0 text-muted-foreground/50" /> : modeIcons[session.mode]}
                              {editingId === session.id ? (
                                <input
                                  ref={editRef}
                                  value={editTitle}
                                  onChange={(e) => setEditTitle(e.target.value)}
                                  onBlur={() => {
                                    const trimmed = editTitle.trim()
                                    if (trimmed && trimmed !== session.title) {
                                      useChatStore.getState().updateSessionTitle(session.id, trimmed)
                                      toast.success('Renamed')
                                    }
                                    setEditingId(null)
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                                    if (e.key === 'Escape') { setEditingId(null) }
                                  }}
                                  onClick={(e) => e.stopPropagation()}
                                  className="h-5 w-full min-w-0 rounded border bg-background px-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                                />
                              ) : (
                                <div className="flex flex-col min-w-0 flex-1">
                                  <span className="truncate">{session.title}</span>
                                  {search.trim() && !session.title.toLowerCase().includes(search.toLowerCase()) && (() => {
                                    const q = search.toLowerCase()
                                    const match = session.messages.find((m) => typeof m.content === 'string' && m.content.toLowerCase().includes(q))
                                    if (!match || typeof match.content !== 'string') return null
                                    const idx = match.content.toLowerCase().indexOf(q)
                                    const start = Math.max(0, idx - 20)
                                    const snippet = (start > 0 ? '...' : '') + match.content.slice(start, idx + q.length + 30).replace(/\n/g, ' ') + (idx + q.length + 30 < match.content.length ? '...' : '')
                                    return <span className="truncate text-[9px] text-muted-foreground/40">{snippet}</span>
                                  })()}
                                </div>
                              )}
                              {editingId !== session.id && (
                                <span className="ml-auto shrink-0 flex items-center gap-1">
                                  {session.pinned && (
                                    <Pin className="size-2.5 text-muted-foreground/30 -rotate-45" />
                                  )}
                                  {session.mode !== mode && (
                                    <span className="rounded bg-muted px-1 py-px text-[8px] uppercase text-muted-foreground/40">{session.mode}</span>
                                  )}
                                  {session.messages.length > 0 && (
                                    <span className="text-[10px] text-muted-foreground/40">{session.messages.length}</span>
                                  )}
                                </span>
                              )}
                            </SidebarMenuButton>
                            <SidebarMenuAction
                              showOnHover
                              onClick={(e) => {
                                e.stopPropagation()
                                if (session.messages.length > 0 && !window.confirm(`Delete "${session.title}" (${session.messages.length} messages)?`)) return
                                const snapshot = JSON.parse(JSON.stringify(session))
                                deleteSession(session.id)
                                toast.success('Session deleted', {
                                  action: { label: 'Undo', onClick: () => useChatStore.getState().restoreSession(snapshot) },
                                  duration: 5000,
                                })
                              }}
                              title="Delete"
                            >
                              <Trash2 className="size-3.5" />
                            </SidebarMenuAction>
                          </SidebarMenuItem>
                        </ContextMenuTrigger>
                        <ContextMenuContent className="w-48">
                          <ContextMenuItem onClick={() => {
                            const newTitle = window.prompt('Rename session:', session.title)
                            if (newTitle?.trim() && newTitle.trim() !== session.title) {
                              useChatStore.getState().updateSessionTitle(session.id, newTitle.trim())
                              toast.success('Session renamed')
                            }
                          }}>
                            <Pencil className="size-4" />
                            Rename
                          </ContextMenuItem>
                          {session.messages.length > 0 && (
                            <>
                              <ContextMenuItem onClick={() => { handleExport(session.id); toast.success('Exported conversation') }}>
                                <Download className="size-4" />
                                Export as Markdown
                              </ContextMenuItem>
                              <ContextMenuItem onClick={() => {
                                const json = JSON.stringify(session, null, 2)
                                const blob = new Blob([json], { type: 'application/json' })
                                const url = URL.createObjectURL(blob)
                                const a = document.createElement('a')
                                a.href = url
                                a.download = `${session.title.replace(/[^a-zA-Z0-9-_ ]/g, '').slice(0, 50).trim() || 'session'}.json`
                                a.click()
                                URL.revokeObjectURL(url)
                                toast.success('Exported as JSON')
                              }}>
                                <Download className="size-4" />
                                Export as JSON
                              </ContextMenuItem>
                              <ContextMenuItem onClick={() => { duplicateSession(session.id); toast.success('Session duplicated') }}>
                                <Copy className="size-4" />
                                Duplicate
                              </ContextMenuItem>
                              <ContextMenuSeparator />
                              <ContextMenuItem onClick={() => { clearSessionMessages(session.id); toast.success('Messages cleared') }}>
                                <Eraser className="size-4" />
                                Clear Messages
                              </ContextMenuItem>
                            </>
                          )}
                          <ContextMenuItem onClick={() => { togglePinSession(session.id); toast.success(session.pinned ? 'Unpinned' : 'Pinned') }}>
                            {session.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
                            {session.pinned ? 'Unpin' : 'Pin to Top'}
                          </ContextMenuItem>
                          <ContextMenuSub>
                            <ContextMenuSubTrigger>
                              {modeIcons[session.mode]}
                              Switch Mode
                            </ContextMenuSubTrigger>
                            <ContextMenuSubContent>
                              {(['chat', 'cowork', 'code'] as const).map((m) => (
                                <ContextMenuItem
                                  key={m}
                                  disabled={session.mode === m}
                                  onClick={() => { updateSessionMode(session.id, m); toast.success(`Switched to ${m} mode`) }}
                                >
                                  {modeIcons[m]}
                                  <span className="capitalize">{m}</span>
                                </ContextMenuItem>
                              ))}
                            </ContextMenuSubContent>
                          </ContextMenuSub>
                          <ContextMenuSeparator />
                          <ContextMenuItem variant="destructive" onClick={() => {
                            if (session.messages.length > 0 && !window.confirm(`Delete "${session.title}" (${session.messages.length} messages)?`)) return
                            const snapshot = JSON.parse(JSON.stringify(session))
                            deleteSession(session.id)
                            toast.success('Session deleted', {
                              action: { label: 'Undo', onClick: () => useChatStore.getState().restoreSession(snapshot) },
                              duration: 5000,
                            })
                          }}>
                            <Trash2 className="size-4" />
                            Delete
                          </ContextMenuItem>
                        </ContextMenuContent>
                      </ContextMenu>
                    ))}
                  </div>
                ))
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <div className="flex gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="flex-1 gap-2 rounded-lg group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:p-0 transition-all duration-200 hover:shadow-sm"
            onClick={handleNewSession}
          >
            <Plus className="size-4" />
            <span className="group-data-[collapsible=icon]:hidden">New Chat</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="size-8 shrink-0 p-0 group-data-[collapsible=icon]:size-8"
            title="Import session (JSON)"
            onClick={() => {
              const input = document.createElement('input')
              input.type = 'file'
              input.accept = '.json'
              input.onchange = () => {
                const file = input.files?.[0]
                if (!file) return
                const reader = new FileReader()
                reader.onload = () => {
                  try {
                    const data = JSON.parse(reader.result as string)
                    if (data.id && data.messages && data.title) {
                      data.id = nanoid()
                      useChatStore.getState().restoreSession(data)
                      toast.success(`Imported "${data.title}"`)
                    } else {
                      toast.error('Invalid session file')
                    }
                  } catch {
                    toast.error('Failed to parse JSON')
                  }
                }
                reader.readAsText(file)
              }
              input.click()
            }}
          >
            <Upload className="size-3.5" />
          </Button>
        </div>
        <p className="text-center text-[10px] text-muted-foreground/25 group-data-[collapsible=icon]:hidden">
          {sessions.length} sessions · {sessions.reduce((a, s) => a + s.messages.length, 0)} msgs
          {(() => {
            const total = sessions.reduce((a, s) => a + s.messages.reduce((b, m) => b + (m.usage ? m.usage.inputTokens + m.usage.outputTokens : 0), 0), 0)
            return total > 0 ? ` · ${total >= 1000 ? `${(total / 1000).toFixed(1)}K` : total} tokens` : ''
          })()}
        </p>
      </SidebarFooter>
    </Sidebar>
  )
}
