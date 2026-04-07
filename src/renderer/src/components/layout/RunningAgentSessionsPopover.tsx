import { Brain, MessageSquareText, FolderKanban, ExternalLink } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { useAgentStore } from '@renderer/stores/agent-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { useTeamStore } from '@renderer/stores/team-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { useTranslation } from 'react-i18next'
import { useEffect, useMemo } from 'react'

interface ProjectGroup {
  projectId: string
  projectName: string
  sessions: Array<{
    sessionId: string
    title: string
    updatedAt: number
    mode: string
    modelLabel?: string
    lastMessagePreview: string
  }>
  updatedAt: number
}

function sanitizePreviewText(value: string): string {
  return value
    .replace(/<system-[^>]*>[\s\S]*?<\/system-[^>]*>/gi, ' ')
    .replace(/<system-[^>]*>/gi, ' ')
    .replace(/<\/system-[^>]*>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractLastMessagePreview(content: unknown): { toolNames: string[]; text: string } {
  if (typeof content === 'string') {
    return { toolNames: [], text: sanitizePreviewText(content) }
  }
  if (!Array.isArray(content) || content.length === 0) return { toolNames: [], text: '' }

  const toolNames: string[] = []
  const textParts: string[] = []

  for (const block of content) {
    if (!block || typeof block !== 'object' || !('type' in block)) continue

    const typedBlock = block as {
      type?: string
      text?: string
      thinking?: string
      message?: string
      name?: string
      toolName?: string
      toolUseId?: string
      error?: string
    }

    if (typedBlock.type === 'tool_use') {
      const toolName = typedBlock.name || typedBlock.toolName || typedBlock.toolUseId || 'Unknown'
      if (toolName) toolNames.push(toolName)
      continue
    }

    if (typedBlock.type === 'tool_result') continue

    if (typedBlock.type === 'image_error' && typedBlock.message) {
      const text = sanitizePreviewText(typedBlock.message)
      if (text) textParts.push(text)
      continue
    }

    if (typedBlock.type === 'agent_error' && (typedBlock.message || typedBlock.error)) {
      const text = sanitizePreviewText(typedBlock.message || typedBlock.error || '')
      if (text) textParts.push(text)
      continue
    }

    if (typedBlock.type === 'text' && typedBlock.text) {
      const text = sanitizePreviewText(typedBlock.text)
      if (text) textParts.push(text)
      continue
    }

    if (typedBlock.type === 'thinking' && typedBlock.thinking) {
      const text = sanitizePreviewText(typedBlock.thinking)
      if (text) textParts.push(text)
    }
  }

  return { toolNames, text: textParts.join(' ').trim() }
}

function getSessionPreview(messages: Array<{ content: unknown }>): string {
  const mergedToolNames: string[] = []
  const textParts: string[] = []

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const preview = extractLastMessagePreview(messages[index]?.content)

    for (const toolName of preview.toolNames) {
      if (!mergedToolNames.includes(toolName)) mergedToolNames.push(toolName)
    }

    if (preview.text) {
      textParts.unshift(preview.text)
    }

    if (mergedToolNames.length > 0 && textParts.length > 0) break
    if (textParts.length > 0 && index < messages.length - 1) break
  }

  const toolLabel = mergedToolNames.length > 0 ? `Tool · ${mergedToolNames.join(', ')}` : ''
  const textLabel = textParts.join(' ').trim()
  return [toolLabel, textLabel].filter(Boolean).join(' · ')
}

function formatTime(ts: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).format(ts)
  } catch {
    return String(ts)
  }
}

export function RunningAgentSessionsPopover(): React.JSX.Element | null {
  const { t } = useTranslation('layout')
  const sessions = useChatStore((s) => s.sessions)
  const projects = useChatStore((s) => s.projects)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const runningSessions = useAgentStore((s) => s.runningSessions)
  const runningSubAgentSessionIdsSig = useAgentStore((s) => s.runningSubAgentSessionIdsSig)
  const backgroundProcesses = useAgentStore((s) => s.backgroundProcesses)
  const activeTeamSessionId = useTeamStore((s) => s.activeTeam?.sessionId)

  const groups = useMemo<ProjectGroup[]>(() => {
    const projectMap = new Map(projects.map((project) => [project.id, project]))
    const runningSessionIds = new Set<string>()

    for (const [sessionId, status] of Object.entries(runningSessions)) {
      if (status === 'running') runningSessionIds.add(sessionId)
    }

    for (const sessionId of runningSubAgentSessionIdsSig ? runningSubAgentSessionIdsSig.split('\u0000') : []) {
      if (sessionId) runningSessionIds.add(sessionId)
    }

    for (const process of Object.values(backgroundProcesses)) {
      if (process.status === 'running' && process.sessionId) {
        runningSessionIds.add(process.sessionId)
      }
    }

    if (activeTeamSessionId) {
      runningSessionIds.add(activeTeamSessionId)
    }

    const grouped = new Map<string, ProjectGroup>()
    for (const session of sessions) {
      if (!runningSessionIds.has(session.id) || !session.projectId) continue
      const project = projectMap.get(session.projectId)
      const existing = grouped.get(session.projectId)
      const sessionEntry = {
        sessionId: session.id,
        title: session.title,
        updatedAt: session.updatedAt,
        mode: session.mode,
        modelLabel: session.modelId,
        lastMessagePreview: getSessionPreview(session.messages)
      }
      if (existing) {
        existing.sessions.push(sessionEntry)
        existing.updatedAt = Math.max(existing.updatedAt, session.updatedAt)
      } else {
        grouped.set(session.projectId, {
          projectId: session.projectId,
          projectName: project?.name ?? t('sidebar.unknownProject'),
          sessions: [sessionEntry],
          updatedAt: session.updatedAt
        })
      }
    }

    return Array.from(grouped.values())
      .map((group) => ({
        ...group,
        sessions: group.sessions.sort((a, b) => b.updatedAt - a.updatedAt)
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }, [activeTeamSessionId, backgroundProcesses, projects, runningSessions, runningSubAgentSessionIdsSig, sessions, t])

  const totalSessions = groups.reduce((sum, group) => sum + group.sessions.length, 0)

  useEffect(() => {
    const chatState = useChatStore.getState()
    const runningIds = groups.flatMap((group) => group.sessions.map((session) => session.sessionId))
    for (const sessionId of runningIds) {
      void chatState.loadRecentSessionMessages(sessionId, false, 12)
    }
  }, [groups])

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <PopoverTrigger asChild>
              <Button variant="ghost" size="sm" className="titlebar-no-drag h-7 gap-1.5 px-2 text-[10px]">
                <Brain className="size-3.5 text-violet-500" />
                {t('topbar.runningSessionsCount', { count: totalSessions })}
              </Button>
            </PopoverTrigger>
          </span>
        </TooltipTrigger>
        <TooltipContent>{t('topbar.runningSessionsTooltip')}</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-[28rem] p-2">
        <div className="mb-2 text-xs font-medium text-foreground/85">
          {t('topbar.runningSessionsTitle', { count: totalSessions })}
        </div>
        <div className="max-h-[26rem] space-y-2 overflow-y-auto">
          {groups.map((group) => (
            <div key={group.projectId} className="rounded-lg border bg-muted/20 p-2">
              <div className="mb-1 flex items-center gap-2 text-xs font-medium text-foreground">
                <FolderKanban className="size-3.5 text-muted-foreground" />
                <span className="truncate">{group.projectName}</span>
              </div>
              <div className="space-y-1">
                {group.sessions.map((session) => {
                  const isCurrentSession = session.sessionId === activeSessionId

                  return (
                    <div key={session.sessionId} className="rounded-md border bg-background px-2 py-1.5">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate text-[11px] font-medium text-foreground">
                            {session.title}
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
                            <span>{session.mode}</span>
                            <span>·</span>
                            <span>{formatTime(session.updatedAt)}</span>
                            {session.modelLabel && (
                              <>
                                <span>·</span>
                                <span className="truncate">{session.modelLabel}</span>
                              </>
                            )}
                            {isCurrentSession && (
                              <>
                                <span>·</span>
                                <span>{t('topbar.currentSession')}</span>
                              </>
                            )}
                          </div>
                          <div className="mt-1 line-clamp-2 text-[10px] text-muted-foreground/85">
                            {session.lastMessagePreview || '--'}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-[10px]"
                            disabled={isCurrentSession}
                            onClick={() => {
                              const chatState = useChatStore.getState()
                              const targetSession = chatState.sessions.find((item) => item.id === session.sessionId)
                              if (targetSession?.projectId) {
                                chatState.setActiveProject(targetSession.projectId)
                              }
                              chatState.setActiveSession(session.sessionId)
                              useUIStore.getState().navigateToSession()
                            }}
                          >
                            <ExternalLink className="mr-1 size-3" />
                            {t('topbar.openSession')}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-[10px]"
                            disabled={isCurrentSession}
                            onClick={() => useUIStore.getState().openMiniSessionWindow(session.sessionId)}
                          >
                            <MessageSquareText className="mr-1 size-3" />
                            {t('topbar.openMiniWindow')}
                          </Button>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
