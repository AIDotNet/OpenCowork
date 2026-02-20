import { useState, useRef, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import appIconUrl from '../../../../../resources/icon.png'
import { formatTokens } from '@renderer/lib/format-tokens'
import { Plus, MessageSquare, Trash2, Eraser, Search, Briefcase, Code2, Download, Copy, X, Pin, PinOff, Pencil, Settings, Loader2, CheckCircle2 } from 'lucide-react'
import { DynamicIcon } from 'lucide-react/dynamic'
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import { toast } from 'sonner'
import { useChatStore, type SessionMode } from '@renderer/stores/chat-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { useAgentStore } from '@renderer/stores/agent-store'
import { useTeamStore } from '@renderer/stores/team-store'
import { abortSession } from '@renderer/hooks/use-chat-actions'
import { sessionToMarkdown } from '@renderer/lib/utils/export-chat'
import packageJson from '../../../../../package.json'

const modeIcons: Record<SessionMode, React.ReactNode> = {
  chat: <MessageSquare className="size-4" />,
  cowork: <Briefcase className="size-4" />,
  code: <Code2 className="size-4" />,
}

interface SessionListItem {
  id: string
  title: string
  icon?: string
  mode: SessionMode
  createdAt: number
  updatedAt: number
  pinned?: boolean
  messageCount: number
  pluginId?: string
}

export function AppSidebar(): React.JSX.Element {
  const { t } = useTranslation('layout')
  const sessionDigest = useChatStore(
    (s) =>
      s.sessions
        .map((session) =>
          [
            session.id,
            session.title,
            session.icon ?? '',
            session.mode,
            session.createdAt,
            session.updatedAt,
            session.pinned ? 1 : 0,
            session.messageCount,
            session.messagesLoaded ? 1 : 0,
            session.pluginId ?? '',
          ].join('|')
        )
        .join('¦')
  )
  const sessions = useMemo<SessionListItem[]>(
    () =>
      useChatStore.getState().sessions.map((session) => ({
        id: session.id,
        title: session.title,
        icon: session.icon,
        mode: session.mode,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        pinned: session.pinned,
        messageCount: session.messageCount,
        pluginId: session.pluginId,
      })),
    [sessionDigest]
  )
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const createSession = useChatStore((s) => s.createSession)
  const deleteSession = useChatStore((s) => s.deleteSession)
  const setActiveSession = useChatStore((s) => s.setActiveSession)
  const clearSessionMessages = useChatStore((s) => s.clearSessionMessages)
  const duplicateSession = useChatStore((s) => s.duplicateSession)
  const updateSessionMode = useChatStore((s) => s.updateSessionMode)
  const togglePinSession = useChatStore((s) => s.togglePinSession)
  const mode = useUIStore((s) => s.mode)
  const runningSessions = useAgentStore((s) => s.runningSessions)
  const activeSubAgents = useAgentStore((s) => s.activeSubAgents)
  const activeTeam = useTeamStore((s) => s.activeTeam)
  const [search, setSearch] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const editRef = useRef<HTMLInputElement>(null)
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string; msgCount: number } | null>(null)
  const appVersion = packageJson.version ?? '0.0.0'
  const getSessionSnapshot = useCallback(
    (sessionId: string) => useChatStore.getState().sessions.find((session) => session.id === sessionId),
    []
  )

  // Detect if the delete target has running tasks
  const deleteTargetRunningInfo = useMemo(() => {
    if (!deleteTarget) return null
    const id = deleteTarget.id
    const isAgentRunning = runningSessions[id] === 'running'
    const hasActiveSubAgents = Object.values(activeSubAgents).some((sa) => sa.sessionId === id)
    const hasActiveTeam = activeTeam?.sessionId === id
    const hasRunning = isAgentRunning || hasActiveSubAgents || hasActiveTeam
    return { isAgentRunning, hasActiveSubAgents, hasActiveTeam, hasRunning }
  }, [deleteTarget, runningSessions, activeSubAgents, activeTeam])

  const confirmDelete = useCallback(() => {
    if (!deleteTarget) return
    const session = getSessionSnapshot(deleteTarget.id)
    if (!session) { setDeleteTarget(null); return }
    // Abort running tasks before deleting
    if (runningSessions[session.id] === 'running') {
      abortSession(session.id)
    }
    const snapshot = JSON.parse(JSON.stringify(session))
    deleteSession(session.id)
    setDeleteTarget(null)
    toast.success(t('sidebar_toast.sessionDeleted'), {
      action: { label: t('action.undo', { ns: 'common' }), onClick: () => useChatStore.getState().restoreSession(snapshot) },
      duration: 5000,
    })
  }, [deleteTarget, deleteSession, getSessionSnapshot, runningSessions, t])


  const handleNewSession = (): void => {
    createSession(mode)
  }

  const handleExport = async (sessionId: string): Promise<void> => {
    await useChatStore.getState().loadSessionMessages(sessionId)
    const session = getSessionSnapshot(sessionId)
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
      return b.createdAt - a.createdAt
    })

  const searchQuery = search.trim().toLowerCase()
  const contentSearchMeta = useMemo(() => {
    const matchedIds = new Set<string>()
    const snippetBySessionId = new Map<string, string>()
    if (!searchQuery) return { matchedIds, snippetBySessionId }

    const rawSessions = useChatStore.getState().sessions
    for (const session of rawSessions) {
      if (session.title.toLowerCase().includes(searchQuery) || session.mode.toLowerCase().includes(searchQuery)) {
        continue
      }
      if (!session.messagesLoaded) continue
      for (const message of session.messages) {
        const text =
          typeof message.content === 'string'
            ? message.content
            : Array.isArray(message.content)
              ? message.content
                .filter((block) => block.type === 'text')
                .map((block) => block.text)
                .join('\n')
              : ''
        const lower = text.toLowerCase()
        const idx = lower.indexOf(searchQuery)
        if (idx === -1) continue
        matchedIds.add(session.id)
        const start = Math.max(0, idx - 20)
        const snippet =
          (start > 0 ? '...' : '') +
          text.slice(start, idx + searchQuery.length + 30).replace(/\n/g, ' ') +
          (idx + searchQuery.length + 30 < text.length ? '...' : '')
        snippetBySessionId.set(session.id, snippet)
        break
      }
    }

    return { matchedIds, snippetBySessionId }
  }, [searchQuery, sessions])

  const filtered = searchQuery
    ? sorted.filter((session) => {
      if (session.title.toLowerCase().includes(searchQuery)) return true
      if (session.mode.toLowerCase().includes(searchQuery)) return true
      return contentSearchMeta.matchedIds.has(session.id)
    })
    : sorted

  // Separate plugin sessions from regular sessions
  const regularFiltered = filtered.filter((s) => !s.pluginId)
  const pluginFiltered = filtered.filter((s) => !!s.pluginId)

  // Group regular sessions by date
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const yesterdayStart = todayStart - 86400000
  const weekStart = todayStart - 7 * 86400000
  const monthStart = todayStart - 30 * 86400000

  const groups: { label: string; items: typeof filtered }[] = []
  const today = regularFiltered.filter((s) => s.createdAt >= todayStart)
  const yesterday = regularFiltered.filter((s) => s.createdAt >= yesterdayStart && s.createdAt < todayStart)
  const thisWeek = regularFiltered.filter((s) => s.createdAt >= weekStart && s.createdAt < yesterdayStart)
  const thisMonth = regularFiltered.filter((s) => s.createdAt >= monthStart && s.createdAt < weekStart)
  const older = regularFiltered.filter((s) => s.createdAt < monthStart)
  if (today.length) groups.push({ label: t('sidebar.today'), items: today })
  if (yesterday.length) groups.push({ label: t('sidebar.yesterday'), items: yesterday })
  if (thisWeek.length) groups.push({ label: t('sidebar.thisWeek'), items: thisWeek })
  if (thisMonth.length) groups.push({ label: t('sidebar.thisMonth'), items: thisMonth })
  if (older.length) groups.push({ label: t('sidebar.older'), items: older })
  // Plugin sessions as a separate group at the bottom
  if (pluginFiltered.length) groups.push({ label: t('sidebar.pluginSessions'), items: pluginFiltered })

  return (
    <>
    <Sidebar side="left" variant="sidebar" collapsible="icon">
      <SidebarHeader>
        <div className="flex items-center gap-2.5 px-1 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
          <img
            src={appIconUrl}
            alt="OpenCowork"
            className="size-8 rounded-xl object-cover shadow-sm"
          />
          <span className="text-sm font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
            OpenCowork
          </span>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>
            {t('sidebar.conversations')}
            {sessions.length > 0 && (
              <span className="ml-1 text-muted-foreground">({sessions.length})</span>
            )}
          </SidebarGroupLabel>
          {sessions.some((s) => s.messageCount > 0) && (
            <SidebarGroupAction
              className="right-8"
              onClick={() => {
                const withMessages = sessions.filter((s) => s.messageCount > 0)
                Promise.all(withMessages.map((s) => handleExport(s.id)))
                  .then(() => toast.success(t('sidebar_toast.exported')))
                  .catch(() => {})
              }}
              title={t('sidebar.exportAll')}
            >
              <Download className="size-4" />
            </SidebarGroupAction>
          )}
          <SidebarGroupContent>
            <div className="flex gap-1.5 px-2 pt-1 pb-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
              <Button
                variant="outline"
                size="sm"
                className="flex-1 gap-2 rounded-lg group-data-[collapsible=icon]:h-9 group-data-[collapsible=icon]:w-9 group-data-[collapsible=icon]:flex-none group-data-[collapsible=icon]:p-0"
                onClick={handleNewSession}
                title={t('sidebar.newChat')}
              >
                <Plus className="size-4" />
                <span className="text-xs font-medium group-data-[collapsible=icon]:hidden">{t('sidebar.newChat')}</span>
              </Button>
            </div>
            {sessions.length > 3 && (
              <div className="px-2 pb-1.5 group-data-[collapsible=icon]:hidden">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3 text-muted-foreground/60" />
                  <Input
                    ref={searchRef}
                    placeholder={t('sidebar.filterSessions')}
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
                  {sessions.length === 0 ? t('sidebar.noConversations') : t('sidebar.noMatches')}
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
                              isActive={session.id === activeSessionId && !useUIStore.getState().settingsPageOpen}
                              onClick={() => {
                                setActiveSession(session.id)
                                useUIStore.getState().closeSettingsPage()
                              }}
                              onDoubleClick={(e) => {
                                e.preventDefault()
                                setEditingId(session.id)
                                setEditTitle(session.title)
                                setTimeout(() => editRef.current?.select(), 0)
                              }}
                              tooltip={`${session.title}\n${session.mode} · ${(() => { const m = Math.floor((Date.now() - session.updatedAt) / 60000); if (m < 1) return 'just now'; if (m < 60) return `${m}m ago`; const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`; return `${Math.floor(h / 24)}d ago`; })()} · ${session.messageCount} msgs${session.pinned ? ' · pinned' : ''}`}
                            >
                              {session.pinned ? <Pin className="size-3 shrink-0 text-muted-foreground/50" /> : session.icon ? <DynamicIcon name={session.icon as never} className="size-4 shrink-0" /> : modeIcons[session.mode]}
                              {editingId === session.id ? (
                                <input
                                  ref={editRef}
                                  value={editTitle}
                                  onChange={(e) => setEditTitle(e.target.value)}
                                  onBlur={() => {
                                    const trimmed = editTitle.trim()
                                    if (trimmed && trimmed !== session.title) {
                                      useChatStore.getState().updateSessionTitle(session.id, trimmed)
                                      toast.success(t('action.rename', { ns: 'common' }))
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
                                  {searchQuery && !session.title.toLowerCase().includes(searchQuery) && contentSearchMeta.snippetBySessionId.get(session.id) && (
                                    <span className="truncate text-[9px] text-muted-foreground/40">
                                      {contentSearchMeta.snippetBySessionId.get(session.id)}
                                    </span>
                                  )}
                                </div>
                              )}
                              {editingId !== session.id && (
                                <span className="ml-auto shrink-0 flex items-center gap-1">
                                  {runningSessions[session.id] === 'running' && (
                                    <Loader2 className="size-3 animate-spin text-blue-500" />
                                  )}
                                  {runningSessions[session.id] === 'completed' && (
                                    <CheckCircle2 className="size-3 text-emerald-500" />
                                  )}
                                  {session.pinned && (
                                    <Pin className="size-2.5 text-muted-foreground/30 -rotate-45" />
                                  )}
                                  {session.mode !== mode && (
                                    <span className="rounded bg-muted px-1 py-px text-[8px] uppercase text-muted-foreground/40">{session.mode}</span>
                                  )}
                                  {session.messageCount > 0 && (
                                    <span className="text-[10px] text-muted-foreground/40">{session.messageCount}</span>
                                  )}
                                </span>
                              )}
                            </SidebarMenuButton>
                            <SidebarMenuAction
                              showOnHover
                              onClick={(e) => {
                                e.stopPropagation()
                                const hasRunning = runningSessions[session.id] === 'running'
                                  || Object.values(activeSubAgents).some((sa) => sa.sessionId === session.id)
                                  || activeTeam?.sessionId === session.id
                                if (session.messageCount > 0 || hasRunning) {
                                  setDeleteTarget({ id: session.id, title: session.title, msgCount: session.messageCount })
                                  return
                                }
                                const snapshot = getSessionSnapshot(session.id)
                                if (!snapshot) return
                                deleteSession(snapshot.id)
                                toast.success(t('sidebar_toast.sessionDeleted'), {
                                  action: { label: t('action.undo', { ns: 'common' }), onClick: () => useChatStore.getState().restoreSession(snapshot) },
                                  duration: 5000,
                                })
                              }}
                              title={t('action.delete', { ns: 'common' })}
                            >
                              <Trash2 className="size-3.5" />
                            </SidebarMenuAction>
                          </SidebarMenuItem>
                        </ContextMenuTrigger>
                        <ContextMenuContent className="w-48">
                          <ContextMenuItem onClick={() => {
                            const newTitle = window.prompt(t('sidebar.renameSession'), session.title)
                            if (newTitle?.trim() && newTitle.trim() !== session.title) {
                              useChatStore.getState().updateSessionTitle(session.id, newTitle.trim())
                              toast.success(t('action.rename', { ns: 'common' }))
                            }
                          }}>
                            <Pencil className="size-4" />
                            {t('action.rename', { ns: 'common' })}
                          </ContextMenuItem>
                          {session.messageCount > 0 && (
                            <>
                              <ContextMenuItem onClick={async () => {
                                await handleExport(session.id)
                                toast.success(t('sidebar_toast.exportedOne'))
                              }}>
                                <Download className="size-4" />
                                {t('sidebar.exportAsMarkdown')}
                              </ContextMenuItem>
                              <ContextMenuItem onClick={async () => {
                                await useChatStore.getState().loadSessionMessages(session.id)
                                const snapshot = getSessionSnapshot(session.id)
                                if (!snapshot) return
                                const json = JSON.stringify(snapshot, null, 2)
                                const blob = new Blob([json], { type: 'application/json' })
                                const url = URL.createObjectURL(blob)
                                const a = document.createElement('a')
                                a.href = url
                                a.download = `${session.title.replace(/[^a-zA-Z0-9-_ ]/g, '').slice(0, 50).trim() || 'session'}.json`
                                a.click()
                                URL.revokeObjectURL(url)
                                toast.success(t('sidebar_toast.exportedAsJson'))
                              }}>
                                <Download className="size-4" />
                                {t('sidebar.exportAsJson')}
                              </ContextMenuItem>
                              <ContextMenuItem onClick={() => { duplicateSession(session.id); toast.success(t('sidebar_toast.sessionDuplicated')) }}>
                                <Copy className="size-4" />
                                {t('action.duplicate', { ns: 'common' })}
                              </ContextMenuItem>
                              <ContextMenuSeparator />
                              <ContextMenuItem onClick={() => { clearSessionMessages(session.id); toast.success(t('sidebar_toast.messagesCleared')) }}>
                                <Eraser className="size-4" />
                                {t('sidebar.clearMessages')}
                              </ContextMenuItem>
                            </>
                          )}
                          <ContextMenuItem onClick={() => { togglePinSession(session.id); toast.success(session.pinned ? t('sidebar_toast.unpinned') : t('sidebar_toast.pinnedMsg')) }}>
                            {session.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
                            {session.pinned ? t('action.unpin', { ns: 'common' }) : t('sidebar.pinToTop')}
                          </ContextMenuItem>
                          <ContextMenuSub>
                            <ContextMenuSubTrigger>
                              {modeIcons[session.mode]}
                              {t('sidebar.switchMode')}
                            </ContextMenuSubTrigger>
                            <ContextMenuSubContent>
                              {(['chat', 'cowork', 'code'] as const).map((m) => (
                                <ContextMenuItem
                                  key={m}
                                  disabled={session.mode === m}
                                  onClick={() => { updateSessionMode(session.id, m); toast.success(t('sidebar_toast.switchedMode', { mode: m })) }}
                                >
                                  {modeIcons[m]}
                                  <span className="capitalize">{m}</span>
                                </ContextMenuItem>
                              ))}
                            </ContextMenuSubContent>
                          </ContextMenuSub>
                          <ContextMenuSeparator />
                          <ContextMenuItem variant="destructive" onClick={() => {
                            const hasRunning = runningSessions[session.id] === 'running'
                              || Object.values(activeSubAgents).some((sa) => sa.sessionId === session.id)
                              || activeTeam?.sessionId === session.id
                            if (session.messageCount > 0 || hasRunning) {
                              setDeleteTarget({ id: session.id, title: session.title, msgCount: session.messageCount })
                              return
                            }
                            const snapshot = getSessionSnapshot(session.id)
                            if (!snapshot) return
                            deleteSession(snapshot.id)
                            toast.success(t('sidebar_toast.sessionDeleted'), {
                              action: { label: t('action.undo', { ns: 'common' }), onClick: () => useChatStore.getState().restoreSession(snapshot) },
                              duration: 5000,
                            })
                          }}>
                            <Trash2 className="size-4" />
                            {t('action.delete', { ns: 'common' })}
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
        <div className="flex flex-col gap-1.5 group-data-[collapsible=icon]:items-center">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-full justify-start gap-2 rounded-lg px-2 text-xs text-muted-foreground transition-all duration-200 hover:bg-muted/50 hover:text-foreground group-data-[collapsible=icon]:h-9 group-data-[collapsible=icon]:w-9 group-data-[collapsible=icon]:justify-center"
            title={t('sidebar.systemSettings')}
            onClick={() => useUIStore.getState().openSettingsPage()}
          >
            <Settings className="size-3.5" />
            <span className="font-medium group-data-[collapsible=icon]:hidden">{t('sidebar.systemSettings')}</span>
          </Button>
          <p className="text-center text-[10px] text-muted-foreground/40 group-data-[collapsible=icon]:hidden">
            v{appVersion}
          </p>
        </div>
        <p className="text-center text-[10px] text-muted-foreground/25 group-data-[collapsible=icon]:hidden">
          {sessions.length} {t('sidebar.sessions')} · {sessions.reduce((sum, session) => sum + session.messageCount, 0)} {t('sidebar.msgs')}
          {(() => {
            const rawSessions = useChatStore.getState().sessions
            let total = rawSessions.reduce((a, s) => a + s.messages.reduce((b, m) => b + (m.usage ? m.usage.inputTokens + m.usage.outputTokens : 0), 0), 0)
            // Include team member token usage
            const teamState = useTeamStore.getState()
            const allMembers = [
              ...(teamState.activeTeam?.members ?? []),
              ...teamState.teamHistory.flatMap((t) => t.members)
            ]
            for (const m of allMembers) {
              if (m.usage) total += m.usage.inputTokens + m.usage.outputTokens
            }
            return total > 0 ? ` · ${formatTokens(total)} tokens` : ''
          })()}
        </p>
      </SidebarFooter>
    </Sidebar>

    {/* Delete confirmation dialog */}
    <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('sidebar.deleteConversation')}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>
                {t('sidebar.deleteConfirm', { title: deleteTarget?.title })}
              </p>
              {deleteTargetRunningInfo?.hasRunning && (
                <p className="text-destructive font-medium">
                  ⚠ This session has active tasks that will be stopped:
                  {[
                    deleteTargetRunningInfo.isAgentRunning && 'running agent',
                    deleteTargetRunningInfo.hasActiveSubAgents && 'running sub-agents',
                    deleteTargetRunningInfo.hasActiveTeam && 'active team',
                  ].filter(Boolean).join(', ')}.
                </p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('action.cancel', { ns: 'common' })}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={confirmDelete}>
            {deleteTargetRunningInfo?.hasRunning ? t('sidebar.stopAndDelete') : t('action.delete', { ns: 'common' })}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  )
}
