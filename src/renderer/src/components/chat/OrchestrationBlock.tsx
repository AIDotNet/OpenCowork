import { GitBranch } from 'lucide-react'
import type { OrchestrationRun } from '@renderer/lib/orchestration/types'
import { useUIStore } from '@renderer/stores/ui-store'
import { cn } from '@renderer/lib/utils'
import { OrchestrationMemberStrip } from './OrchestrationMemberStrip'

function getClusterTitle(run: OrchestrationRun): string {
  return run.kind === 'team' ? 'Agent Cluster' : 'Agent Execution'
}

function getTaskCountLabel(run: OrchestrationRun): string {
  if (run.kind === 'team') return `${run.members.length} parallel tasks`
  return `${run.members.length} tasks`
}

export function OrchestrationBlock({ run }: { run: OrchestrationRun }): React.JSX.Element {
  const openOrchestrationMember = useUIStore((s) => s.openOrchestrationMember)
  const openSubAgentExecutionDetail = useUIStore((s) => s.openSubAgentExecutionDetail)

  return (
    <div
      className={cn(
        'my-3 overflow-hidden rounded-[10px] border border-white/[0.08] bg-[#101010] p-3',
        'shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]',
        run.status === 'running' && 'border-emerald-400/15',
        run.status === 'failed' && 'border-destructive/25 bg-[#151010]'
      )}
    >
      <div className="mb-2 flex items-center gap-2 px-0.5 text-[12px] font-medium leading-none text-white/62">
        <GitBranch className="size-3.5 text-white/45" />
        <span className="text-white/72">{getClusterTitle(run)}</span>
        <span className="text-white/25">|</span>
        <span>{getTaskCountLabel(run)}</span>
      </div>

      <OrchestrationMemberStrip
        members={run.members}
        onOpenMember={(member) => {
          if (member.toolUseId) {
            openSubAgentExecutionDetail(
              member.toolUseId,
              member.report || member.summary || undefined,
              member.name,
              run.sessionId
            )
            return
          }
          openOrchestrationMember(run.id, member.id)
        }}
      />
    </div>
  )
}
