import * as React from 'react'
import {
  Wrench,
  ChevronDown,
  ChevronRight,
  Clock,
  MessageSquare,
  Square,
} from 'lucide-react'
import { Badge } from '@renderer/components/ui/badge'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@renderer/components/ui/collapsible'
import { cn } from '@renderer/lib/utils'
import type { TeamMember, TeamTask } from '@renderer/lib/agent/teams/types'

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const secs = ms / 1000
  if (secs < 60) return `${secs.toFixed(1)}s`
  return `${Math.floor(secs / 60)}m${Math.round(secs % 60)}s`
}

const statusColors: Record<string, string> = {
  working: 'bg-cyan-500 animate-pulse',
  idle: 'bg-cyan-500/60',
  waiting: 'bg-amber-500',
  stopped: 'bg-muted-foreground/40',
}

const statusDots: Record<string, string> = {
  working: 'bg-green-500',
  idle: 'bg-cyan-400',
  waiting: 'bg-amber-400',
  stopped: 'bg-muted-foreground/30',
}

interface TeammateCardProps {
  member: TeamMember
  task?: TeamTask
  onSendMessage?: (memberId: string) => void
  onStop?: (memberId: string) => void
}

export function TeammateCard({ member, task, onSendMessage, onStop }: TeammateCardProps): React.JSX.Element {
  const [toolsExpanded, setToolsExpanded] = React.useState(false)
  const isWorking = member.status === 'working'

  // Live elapsed time
  const [now, setNow] = React.useState(Date.now())
  React.useEffect(() => {
    if (!isWorking) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [isWorking])

  const elapsed = (member.completedAt ?? now) - member.startedAt

  return (
    <div
      className={cn(
        'rounded-lg border overflow-hidden transition-all duration-300',
        isWorking && 'border-cyan-500/40 shadow-sm shadow-cyan-500/5',
        member.status === 'idle' && 'border-cyan-500/20',
        member.status === 'stopped' && 'border-muted',
        member.status === 'waiting' && 'border-amber-500/30',
      )}
    >
      {/* Header */}
      <div
        className={cn(
          'flex items-center gap-2 px-3 py-2',
          isWorking && 'bg-cyan-500/5',
        )}
      >
        <span className={cn('size-2 rounded-full shrink-0', statusDots[member.status])} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-semibold text-cyan-600 dark:text-cyan-400 truncate">
              {member.name}
            </span>
            <Badge
              variant={isWorking ? 'default' : 'secondary'}
              className={cn('text-[8px] px-1 h-3.5', isWorking && statusColors[member.status])}
            >
              {member.status}
            </Badge>
            {member.model !== 'default' && (
              <span className="text-[8px] text-muted-foreground/40 truncate">{member.model}</span>
            )}
          </div>
          {task && (
            <p className="text-[10px] text-muted-foreground/60 truncate mt-0.5">
              {task.subject}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0 text-[9px] text-muted-foreground/50">
          {member.iteration > 0 && (
            <>
              <span className="tabular-nums">iter {member.iteration}</span>
              <span>·</span>
            </>
          )}
          {member.toolCalls.length > 0 && (
            <>
              <span className="tabular-nums">{member.toolCalls.length} calls</span>
              <span>·</span>
            </>
          )}
          <span className="tabular-nums flex items-center gap-0.5">
            <Clock className="size-2.5" />
            {formatElapsed(elapsed)}
          </span>
        </div>
      </div>

      {/* Tool Calls (collapsible) */}
      {member.toolCalls.length > 0 && (
        <Collapsible open={toolsExpanded} onOpenChange={setToolsExpanded}>
          <div className="border-t border-cyan-500/10 px-3 py-1">
            <CollapsibleTrigger asChild>
              <button className="flex w-full items-center gap-1.5 text-[9px] text-muted-foreground/50 hover:text-muted-foreground transition-colors">
                <Wrench className="size-2.5" />
                <span className="font-medium uppercase tracking-wider">Tools</span>
                <Badge variant="secondary" className="text-[8px] h-3 px-1">{member.toolCalls.length}</Badge>
                <span className="flex-1" />
                {toolsExpanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-1 space-y-0.5 max-h-32 overflow-y-auto">
                {member.toolCalls.map((tc) => (
                  <div key={tc.id} className="flex items-center gap-1.5 text-[9px] text-muted-foreground/60 py-0.5">
                    <span className={cn(
                      'size-1.5 rounded-full shrink-0',
                      tc.status === 'running' ? 'bg-cyan-400 animate-pulse' :
                      tc.status === 'completed' ? 'bg-green-400' :
                      tc.status === 'error' ? 'bg-destructive' : 'bg-muted-foreground/30'
                    )} />
                    <span className="font-mono truncate">{tc.name}</span>
                  </div>
                ))}
              </div>
            </CollapsibleContent>
          </div>
        </Collapsible>
      )}

      {/* Thinking indicator */}
      {isWorking && member.toolCalls.length === 0 && !member.streamingText && (
        <div className="border-t border-cyan-500/10 px-3 py-1.5 flex items-center gap-2">
          <span className="flex gap-1">
            <span className="size-1 rounded-full bg-cyan-400/50 animate-bounce" style={{ animationDelay: '0ms' }} />
            <span className="size-1 rounded-full bg-cyan-400/50 animate-bounce" style={{ animationDelay: '150ms' }} />
            <span className="size-1 rounded-full bg-cyan-400/50 animate-bounce" style={{ animationDelay: '300ms' }} />
          </span>
          <span className="text-[9px] text-cyan-400/60">Working...</span>
        </div>
      )}

      {/* Action buttons */}
      <div className="border-t border-cyan-500/10 px-3 py-1 flex items-center gap-1">
        {onSendMessage && (
          <button
            onClick={() => onSendMessage(member.id)}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] text-muted-foreground/50 hover:text-cyan-500 hover:bg-cyan-500/5 transition-colors"
          >
            <MessageSquare className="size-2.5" />
            Message
          </button>
        )}
        {onStop && isWorking && (
          <button
            onClick={() => onStop(member.id)}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] text-muted-foreground/50 hover:text-destructive hover:bg-destructive/5 transition-colors ml-auto"
          >
            <Square className="size-2.5" />
            Stop
          </button>
        )}
      </div>
    </div>
  )
}
