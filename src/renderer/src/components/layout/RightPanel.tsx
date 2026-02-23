import { ListChecks, FileOutput, Database, Sparkles, FolderTree, Users, ClipboardList, Clock } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Separator } from '@renderer/components/ui/separator'
import { useUIStore, type RightPanelTab } from '@renderer/stores/ui-store'
import { useAgentStore } from '@renderer/stores/agent-store'
import { useTaskStore } from '@renderer/stores/task-store'
import { StepsPanel } from '@renderer/components/cowork/StepsPanel'
import { ArtifactsPanel } from '@renderer/components/cowork/ArtifactsPanel'
import { ContextPanel } from '@renderer/components/cowork/ContextPanel'
import { SkillsPanel } from '@renderer/components/cowork/SkillsPanel'
import { FileTreePanel } from '@renderer/components/cowork/FileTreePanel'
import { TeamPanel } from '@renderer/components/cowork/TeamPanel'
import { PlanPanel } from '@renderer/components/cowork/PlanPanel'
import { CronPanel } from '@renderer/components/cowork/CronPanel'
import { usePlanStore } from '@renderer/stores/plan-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { useTeamStore } from '@renderer/stores/team-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useCronStore } from '@renderer/stores/cron-store'
import { useTranslation } from 'react-i18next'
import { cn } from '@renderer/lib/utils'
import { AnimatePresence } from 'motion/react'
import { FadeIn } from '@renderer/components/animate-ui'

const ALL_FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'Delete'])

const tabDefs: { value: RightPanelTab; labelKey: string; icon: React.ReactNode }[] = [
  { value: 'steps', labelKey: 'steps', icon: <ListChecks className="size-4" /> },
  { value: 'plan', labelKey: 'plan', icon: <ClipboardList className="size-4" /> },
  { value: 'team', labelKey: 'team', icon: <Users className="size-4" /> },
  { value: 'files', labelKey: 'files', icon: <FolderTree className="size-4" /> },
  { value: 'artifacts', labelKey: 'artifacts', icon: <FileOutput className="size-4" /> },
  { value: 'context', labelKey: 'context', icon: <Database className="size-4" /> },
  { value: 'skills', labelKey: 'skills', icon: <Sparkles className="size-4" /> },
  { value: 'cron', labelKey: 'cron', icon: <Clock className="size-4" /> },
]

export function RightPanel({ compact = false }: { compact?: boolean }): React.JSX.Element {
  const { t } = useTranslation('layout')
  const tab = useUIStore((s) => s.rightPanelTab)
  const setTab = useUIStore((s) => s.setRightPanelTab)
  const executedToolCalls = useAgentStore((s) => s.executedToolCalls)
  const todos = useTaskStore((s) => s.todos)
  const activeTeam = useTeamStore((s) => s.activeTeam)
  const teamToolsEnabled = useSettingsStore((s) => s.teamToolsEnabled)
  const cronEnabledCount = useCronStore((s) => s.jobs.filter((j) => j.enabled).length)

  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const runningCommandCount = useAgentStore((s) =>
    Object.values(s.backgroundProcesses).filter(
      (p) =>
        p.source === 'bash-tool' &&
        p.status === 'running' &&
        (!activeSessionId || p.sessionId === activeSessionId)
    ).length
  )
  const hasPlan = usePlanStore((s) => {
    if (!activeSessionId) return false
    return Object.values(s.plans).some((p) => p.sessionId === activeSessionId)
  })
  const planMode = useUIStore((s) => s.planMode)

  const visibleTabs = tabDefs
    .filter((t) => teamToolsEnabled || t.value !== 'team')
    .filter((t) => (hasPlan || planMode) || t.value !== 'plan')
    // Cron tab is always visible

  const badgeCounts: Partial<Record<RightPanelTab, number>> = {
    steps: todos.length,
    plan: hasPlan ? 1 : 0,
    team: activeTeam ? activeTeam.members.length : 0,
    artifacts: executedToolCalls.filter((tc) => ALL_FILE_TOOLS.has(tc.name)).length,
    context: runningCommandCount,
    cron: cronEnabledCount,
  }

  return (
    <aside className={cn('flex shrink-0 flex-col border-l bg-background/50 backdrop-blur-sm transition-all duration-200', compact ? 'w-64' : 'w-96')}>
      {/* Tab Bar */}
      <div className="flex h-10 min-w-0 items-center gap-0.5 overflow-x-auto px-2">
        {visibleTabs.map((tDef) => {
          const count = badgeCounts[tDef.value] ?? 0
          return (
            <Button
              key={tDef.value}
              variant={tab === tDef.value ? 'secondary' : 'ghost'}
              size="sm"
              className={cn(
                'h-6 shrink-0 gap-1.5 rounded-md px-2 text-xs transition-all duration-200',
                tab === tDef.value
                  ? 'bg-muted shadow-sm ring-1 ring-border/50'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              onClick={() => setTab(tDef.value)}
            >
              {tDef.icon}
              <span className="hidden lg:inline">{t(`rightPanel.${tDef.labelKey}`)}</span>
              {count > 0 && tab !== tDef.value && (
                <span className="flex size-4 items-center justify-center rounded-full bg-muted-foreground/10 text-[9px] font-medium text-muted-foreground">
                  {count}
                </span>
              )}
            </Button>
          )
        })}
      </div>
      <Separator />

      {/* Panel Content */}
      <div className="flex-1 overflow-auto px-3 py-2">
        <AnimatePresence mode="wait">
          {tab === 'steps' && (
            <FadeIn key="steps" className="h-full">
              <StepsPanel />
            </FadeIn>
          )}

          {tab === 'team' && (
            <FadeIn key="team" className="h-full">
              <TeamPanel />
            </FadeIn>
          )}

          {tab === 'files' && (
            <FadeIn key="files" className="h-full">
              <FileTreePanel />
            </FadeIn>
          )}

          {tab === 'artifacts' && (
            <FadeIn key="artifacts" className="h-full">
              <ArtifactsPanel />
            </FadeIn>
          )}

          {tab === 'context' && (
            <FadeIn key="context" className="h-full">
              <ContextPanel />
            </FadeIn>
          )}

          {tab === 'skills' && (
            <FadeIn key="skills" className="h-full">
              <SkillsPanel />
            </FadeIn>
          )}

          {tab === 'plan' && (
            <FadeIn key="plan" className="h-full">
              <PlanPanel />
            </FadeIn>
          )}

          {tab === 'cron' && (
            <FadeIn key="cron" className="h-full">
              <CronPanel />
            </FadeIn>
          )}
        </AnimatePresence>
      </div>
    </aside>
  )
}
