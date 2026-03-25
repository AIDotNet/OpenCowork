import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useTranslation } from 'react-i18next'
import {
  Database,
  FolderOpen,
  FolderPlus,
  RefreshCw,
  MessageSquare,
  Clock,
  Cpu,
  Zap,
  ExternalLink,
  Copy,
  Check,
  Wrench,
  Brain,
  ShieldCheck,
  Archive
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Separator } from '@renderer/components/ui/separator'
import { useChatStore } from '@renderer/stores/chat-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useAgentStore } from '@renderer/stores/agent-store'
import { useProviderStore } from '@renderer/stores/provider-store'
import { useTeamStore } from '@renderer/stores/team-store'
import { useUIStore } from '@renderer/stores/ui-store'
import {
  formatTokens,
  calculateCost,
  formatCost,
  getBillableInputTokens,
  getBillableTotalTokens
} from '@renderer/lib/format-tokens'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { useChatActions } from '@renderer/hooks/use-chat-actions'

export function ContextPanel(): React.JSX.Element {
  const { t } = useTranslation('cowork')
  const { t: tCommon } = useTranslation('common')
  const [copiedPath, setCopiedPath] = useState(false)
  const [compressing, setCompressing] = useState(false)
  const [showCompressPanel, setShowCompressPanel] = useState(false)
  const [focusPrompt, setFocusPrompt] = useState('')
  const { manualCompressContext } = useChatActions()
  const {
    activeSessionId,
    resolvedProjectId,
    activeSession,
    activeProject,
    ensureDefaultProject,
    updateProjectDirectory
  } = useChatStore(
    useShallow((s) => {
      const activeSession = s.sessions.find((session) => session.id === s.activeSessionId)
      const resolvedProjectId = activeSession?.projectId ?? s.activeProjectId ?? null
      const activeProject = resolvedProjectId
        ? s.projects.find((project) => project.id === resolvedProjectId)
        : undefined
      return {
        activeSessionId: s.activeSessionId,
        resolvedProjectId,
        activeSession,
        activeProject,
        ensureDefaultProject: s.ensureDefaultProject,
        updateProjectDirectory: s.updateProjectDirectory
      }
    })
  )
  const workingFolder = activeProject?.workingFolder
  const runningCommandIdsSig = useAgentStore((s) =>
    Object.values(s.backgroundProcesses)
      .filter(
        (p) =>
          p.source === 'bash-tool' &&
          p.status === 'running' &&
          (!activeSessionId || p.sessionId === activeSessionId)
      )
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((p) => p.id)
      .join('\u0000')
  )
  const stopBackgroundProcess = useAgentStore((s) => s.stopBackgroundProcess)
  const openDetailPanel = useUIStore((s) => s.openDetailPanel)
  const providerState = useProviderStore(
    useShallow((s) => ({
      providers: s.providers,
      activeProviderId: s.activeProviderId,
      activeModelId: s.activeModelId
    }))
  )
  const activeProvider =
    providerState.providers.find((provider) => provider.id === providerState.activeProviderId) ?? null
  const activeModelCfg =
    activeProvider?.models.find((model) => model.id === providerState.activeModelId) ?? null
  const fallbackProvider = useSettingsStore((s) => s.provider)
  const fallbackModel = useSettingsStore((s) => s.model)
  const provider = activeProvider?.name ?? fallbackProvider
  const model = activeModelCfg?.name ?? fallbackModel
  const runningCommands = runningCommandIdsSig
    ? runningCommandIdsSig.split('\u0000').reduce(
        (list, id) => {
          const process = useAgentStore.getState().backgroundProcesses[id]
          if (process) list.push(process)
          return list
        },
        [] as Array<ReturnType<typeof useAgentStore.getState>['backgroundProcesses'][string]>
      )
    : []

  const handleSelectFolder = async (): Promise<void> => {
    const result = (await ipcClient.invoke('fs:select-folder')) as {
      canceled?: boolean
      path?: string
    }
    if (result.canceled || !result.path) return

    let projectId = resolvedProjectId
    if (!projectId) {
      const ensured = await ensureDefaultProject()
      projectId = ensured?.id ?? null
    }
    if (!projectId) return

    updateProjectDirectory(projectId, {
      workingFolder: result.path,
      sshConnectionId: null
    })
  }

  return (
    <div className="space-y-4">
      {/* Working Folder */}
      <div className="space-y-2">
        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          {t('context.workingFolder')}
        </h4>
        {workingFolder ? (
          <div className="space-y-1.5">
            <button
              className="flex w-full items-center gap-2 rounded-md border px-3 py-2 text-sm text-left hover:bg-muted/50 transition-colors group"
              onClick={() => {
                navigator.clipboard.writeText(workingFolder!)
                setCopiedPath(true)
                setTimeout(() => setCopiedPath(false), 1500)
              }}
              title={t('context.clickToCopy')}
            >
              <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate flex-1">{workingFolder}</span>
              {copiedPath ? (
                <Check className="size-3 shrink-0 text-green-500" />
              ) : (
                <Copy className="size-3 shrink-0 text-muted-foreground/0 group-hover:text-muted-foreground transition-colors" />
              )}
            </button>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1.5 px-2 text-[10px] text-muted-foreground"
                onClick={handleSelectFolder}
              >
                <RefreshCw className="size-3" />
                {t('context.changeFolder')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1.5 px-2 text-[10px] text-muted-foreground"
                onClick={() => window.electron.ipcRenderer.invoke('shell:openPath', workingFolder)}
              >
                <ExternalLink className="size-3" />
                {t('context.open')}
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="w-full gap-2 text-xs"
            onClick={handleSelectFolder}
          >
            <FolderPlus className="size-3.5" />
            {t('context.selectFolder')}
          </Button>
        )}
      </div>

      {/* Session Info */}
      {activeSession && (
        <>
          <Separator />
          <div className="space-y-2">
            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              {t('context.sessionInfo')}
            </h4>
            <div className="space-y-1.5 text-xs">
              <div className="flex items-center gap-2 text-muted-foreground">
                <MessageSquare className="size-3 shrink-0" />
                <span>
                  {activeSession.messages.filter((m) => m.role !== 'system').length}{' '}
                  {tCommon('unit.messages')}
                  <span className="text-muted-foreground/50">
                    {' '}
                    ({activeSession.messages.filter((m) => m.role === 'user').length}{' '}
                    {tCommon('unit.turns')})
                  </span>
                </span>
              </div>
              <div className="flex items-center gap-2 text-muted-foreground">
                <Clock className="size-3 shrink-0" />
                <span>
                  Created {new Date(activeSession.createdAt).toLocaleDateString()}
                  {activeSession.messages.length >= 2 &&
                    (() => {
                      const first = activeSession.messages[0]?.createdAt
                      const last =
                        activeSession.messages[activeSession.messages.length - 1]?.createdAt
                      if (!first || !last || last <= first) return null
                      const secs = Math.floor((last - first) / 1000)
                      if (secs < 60) return ` · ${secs}s session`
                      const mins = Math.floor(secs / 60)
                      if (mins < 60) return ` · ${mins}m session`
                      return ` · ${Math.floor(mins / 60)}h${mins % 60}m session`
                    })()}
                </span>
              </div>
              {(() => {
                let toolUseCount = 0
                let subAgentCount = 0
                for (const m of activeSession.messages) {
                  if (Array.isArray(m.content)) {
                    for (const b of m.content) {
                      if (b.type === 'tool_use') {
                        toolUseCount++
                        if (b.name === 'Task') subAgentCount++
                      }
                    }
                  }
                }
                return toolUseCount > 0 ? (
                  <>
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Wrench className="size-3 shrink-0" />
                      <span>{t('context.toolCalls', { count: toolUseCount })}</span>
                    </div>
                    {subAgentCount > 0 && (
                      <div className="flex items-center gap-2 text-violet-500/70">
                        <Brain className="size-3 shrink-0" />
                        <span>{t('context.subAgentRuns', { count: subAgentCount })}</span>
                      </div>
                    )}
                  </>
                ) : null
              })()}
              {(() => {
                const approved = useAgentStore.getState().approvedToolNames
                return approved.length > 0 ? (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <ShieldCheck className="size-3 shrink-0 text-green-500/60" />
                    <span className="text-muted-foreground/60">
                      Auto-approved: {approved.join(', ')}
                    </span>
                  </div>
                ) : null
              })()}
              <div className="flex items-center gap-2 text-muted-foreground">
                <Cpu className="size-3 shrink-0" />
                <span className="truncate">
                  {model} ({provider})
                </span>
              </div>
              {runningCommands.length > 0 && (
                <div className="space-y-1.5 pt-1">
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Wrench className="size-3 shrink-0" />
                    <span>{t('context.runningCommands', { count: runningCommands.length })}</span>
                  </div>
                  <div className="space-y-1">
                    {runningCommands.map((proc) => (
                      <div key={proc.id} className="rounded-md border px-2 py-1.5 text-[11px]">
                        <div className="truncate font-mono text-foreground/85">{proc.command}</div>
                        {proc.cwd && (
                          <div className="truncate text-muted-foreground/50">{proc.cwd}</div>
                        )}
                        <div className="mt-1 flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-5 gap-1 px-1.5 text-[10px] text-muted-foreground"
                            onClick={() =>
                              openDetailPanel({ type: 'terminal', processId: proc.id })
                            }
                          >
                            {t('context.openSession')}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-5 gap-1 px-1.5 text-[10px] text-destructive/80"
                            onClick={() => void stopBackgroundProcess(proc.id)}
                          >
                            {t('context.stopCommand')}
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {(() => {
                const totals = activeSession.messages.reduce(
                  (acc, m) => {
                    if (m.usage) {
                      acc.input += getBillableInputTokens(m.usage, activeModelCfg?.type)
                      acc.output += m.usage.outputTokens
                      if (m.usage.cacheCreationTokens)
                        acc.cacheCreation += m.usage.cacheCreationTokens
                      if (m.usage.cacheReadTokens) acc.cacheRead += m.usage.cacheReadTokens
                      if (m.usage.reasoningTokens) acc.reasoning += m.usage.reasoningTokens
                    }
                    return acc
                  },
                  { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, reasoning: 0 }
                )
                // Include team member token usage (active team + history for this session)
                const teamStore = useTeamStore.getState()
                const allTeamMembers = [
                  ...(teamStore.activeTeam?.sessionId === activeSessionId
                    ? teamStore.activeTeam.members
                    : []),
                  ...teamStore.teamHistory
                    .filter((t) => t.sessionId === activeSessionId)
                    .flatMap((t) => t.members)
                ]
                for (const member of allTeamMembers) {
                  if (member.usage) {
                    totals.input += getBillableInputTokens(member.usage, activeModelCfg?.type)
                    totals.output += member.usage.outputTokens
                    if (member.usage.cacheCreationTokens)
                      totals.cacheCreation += member.usage.cacheCreationTokens
                    if (member.usage.cacheReadTokens)
                      totals.cacheRead += member.usage.cacheReadTokens
                    if (member.usage.reasoningTokens)
                      totals.reasoning += member.usage.reasoningTokens
                  }
                }
                if (totals.input + totals.output === 0) return null
                const totalUsage = {
                  inputTokens: totals.input,
                  outputTokens: totals.output,
                  billableInputTokens: totals.input,
                  cacheCreationTokens: totals.cacheCreation || undefined,
                  cacheReadTokens: totals.cacheRead || undefined
                }
                const cost = calculateCost(totalUsage, activeModelCfg)
                const totalTokens = getBillableTotalTokens(totalUsage, activeModelCfg?.type)
                const ctxLimit = activeModelCfg?.contextLength ?? null
                // Context window = last API call's input tokens (stored as contextTokens, not accumulated)
                // Fallback to inputTokens for older messages that don't have contextTokens
                const lastUsage = [...activeSession.messages].reverse().find((m) => m.usage)?.usage
                const ctxUsed = lastUsage?.contextTokens ?? lastUsage?.inputTokens ?? 0
                const pct =
                  ctxLimit && ctxUsed > 0 ? Math.min((ctxUsed / ctxLimit) * 100, 100) : null
                const barColor =
                  pct === null
                    ? ''
                    : pct > 80
                      ? 'bg-red-500'
                      : pct > 50
                        ? 'bg-amber-500'
                        : 'bg-green-500'
                return (
                  <>
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Zap className="size-3 shrink-0" />
                      <span>
                        {formatTokens(totalTokens)} tokens
                        <span className="text-muted-foreground/50">
                          {' '}
                          ({formatTokens(totals.input)}↓ {formatTokens(totals.output)}↑)
                        </span>
                        {cost !== null && (
                          <span className="text-emerald-500/70"> · {formatCost(cost)}</span>
                        )}
                        {totals.cacheRead > 0 && (
                          <span className="text-green-500/60">
                            {' '}
                            · {formatTokens(totals.cacheRead)} {tCommon('unit.cached')}
                          </span>
                        )}
                        {totals.reasoning > 0 && (
                          <span className="text-blue-500/60">
                            {' '}
                            · {formatTokens(totals.reasoning)} {tCommon('unit.reasoning')}
                          </span>
                        )}
                      </span>
                    </div>
                    {pct !== null && (
                      <div className="mt-1 space-y-0.5">
                        <div className="flex items-center justify-between text-[9px] text-muted-foreground/40">
                          <span>{tCommon('contextWindow')}</span>
                          <span>
                            {formatTokens(ctxUsed)} / {formatTokens(ctxLimit!)} ({pct.toFixed(0)}%)
                          </span>
                        </div>
                        <div className="h-1.5 w-full rounded-full bg-muted/40 overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all duration-500 ${barColor}`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    )}
                    {activeSession.messages.length >= 8 && !showCompressPanel && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="mt-1 h-6 gap-1.5 px-2 text-[10px] text-muted-foreground"
                        disabled={compressing}
                        onClick={() => setShowCompressPanel(true)}
                      >
                        <Archive className="size-3" />
                        {compressing ? '压缩中...' : '压缩上下文'}
                      </Button>
                    )}
                    {showCompressPanel && (
                      <div className="mt-1.5 space-y-1.5 rounded-md border p-2">
                        <input
                          type="text"
                          className="w-full rounded border bg-background px-2 py-1 text-[11px] placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring"
                          placeholder="聚焦方向（可选），如：保留 API 相关变更"
                          value={focusPrompt}
                          onChange={(e) => setFocusPrompt(e.target.value)}
                          disabled={compressing}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !compressing) {
                              e.preventDefault()
                              setCompressing(true)
                              manualCompressContext(focusPrompt || undefined).finally(() => {
                                setCompressing(false)
                                setShowCompressPanel(false)
                                setFocusPrompt('')
                              })
                            }
                          }}
                        />
                        <div className="flex items-center gap-1">
                          <Button
                            variant="default"
                            size="sm"
                            className="h-5 px-2 text-[10px]"
                            disabled={compressing}
                            onClick={() => {
                              setCompressing(true)
                              manualCompressContext(focusPrompt || undefined).finally(() => {
                                setCompressing(false)
                                setShowCompressPanel(false)
                                setFocusPrompt('')
                              })
                            }}
                          >
                            <Archive className="size-3 mr-1" />
                            {compressing ? '压缩中...' : '确认压缩'}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-5 px-2 text-[10px] text-muted-foreground"
                            disabled={compressing}
                            onClick={() => {
                              setShowCompressPanel(false)
                              setFocusPrompt('')
                            }}
                          >
                            取消
                          </Button>
                        </div>
                      </div>
                    )}
                  </>
                )
              })()}
            </div>
          </div>
        </>
      )}

      {!workingFolder && !activeSession && (
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <Database className="mb-3 size-8 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">{t('context.noContext')}</p>
          <p className="mt-1 text-xs text-muted-foreground/60">{t('context.noContextDesc')}</p>
        </div>
      )}
    </div>
  )
}
