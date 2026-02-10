import { ListChecks, FileOutput, Database, Sparkles, FolderTree } from 'lucide-react'
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
import { cn } from '@renderer/lib/utils'

const ALL_FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'Read', 'Delete'])

const tabDefs: { value: RightPanelTab; label: string; icon: React.ReactNode }[] = [
  { value: 'steps', label: 'Steps', icon: <ListChecks className="size-4" /> },
  { value: 'files', label: 'Files', icon: <FolderTree className="size-4" /> },
  { value: 'artifacts', label: 'Artifacts', icon: <FileOutput className="size-4" /> },
  { value: 'context', label: 'Context', icon: <Database className="size-4" /> },
  { value: 'skills', label: 'Skills', icon: <Sparkles className="size-4" /> },
]

export function RightPanel(): React.JSX.Element {
  const tab = useUIStore((s) => s.rightPanelTab)
  const setTab = useUIStore((s) => s.setRightPanelTab)
  const executedToolCalls = useAgentStore((s) => s.executedToolCalls)
  const todos = useTaskStore((s) => s.todos)

  const pendingToolCalls = useAgentStore((s) => s.pendingToolCalls)
  const activeSubAgent = useAgentStore((s) => s.activeSubAgent)

  const subAgentCallCount = activeSubAgent?.toolCalls.length ?? 0
  const badgeCounts: Partial<Record<RightPanelTab, number>> = {
    steps: todos.length + executedToolCalls.length + pendingToolCalls.length + subAgentCallCount,
    artifacts: executedToolCalls.filter((tc) => ALL_FILE_TOOLS.has(tc.name)).length,
  }

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l bg-background/50 backdrop-blur-sm">
      {/* Tab Bar */}
      <div className="flex h-10 items-center gap-0.5 px-2">
        {tabDefs.map((t) => {
          const count = badgeCounts[t.value] ?? 0
          return (
            <Button
              key={t.value}
              variant={tab === t.value ? 'secondary' : 'ghost'}
              size="sm"
              className={cn(
                'h-6 gap-1.5 rounded-md px-2 text-xs transition-all duration-200',
                tab === t.value
                  ? 'bg-muted shadow-sm ring-1 ring-border/50'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              onClick={() => setTab(t.value)}
            >
              {t.icon}
              <span className="hidden lg:inline">{t.label}</span>
              {count > 0 && tab !== t.value && (
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
      <div className="flex-1 overflow-auto p-3">
        {tab === 'steps' && <StepsPanel />}
        {tab === 'files' && <FileTreePanel />}
        {tab === 'artifacts' && <ArtifactsPanel />}
        {tab === 'context' && <ContextPanel />}
        {tab === 'skills' && <SkillsPanel />}
      </div>
    </aside>
  )
}
