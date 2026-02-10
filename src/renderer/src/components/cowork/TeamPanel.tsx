import { Users, ClipboardList, MessageSquare, ChevronDown, ChevronRight } from 'lucide-react'
import { Badge } from '@renderer/components/ui/badge'
import { Separator } from '@renderer/components/ui/separator'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@renderer/components/ui/collapsible'
import { useTeamStore } from '@renderer/stores/team-store'
import { abortTeammate } from '@renderer/lib/agent/teams/teammate-runner'
import { cn } from '@renderer/lib/utils'
import { TeammateCard } from './TeammateCard'
import { useState } from 'react'

// --- Task Board Column ---

function TaskColumn({ title, tasks, color }: {
  title: string
  tasks: { id: string; subject: string; owner: string | null }[]
  color: string
}): React.JSX.Element {
  return (
    <div className="flex-1 min-w-0">
      <div className={cn('text-[9px] font-medium uppercase tracking-wider mb-1.5 px-1', color)}>
        {title} <span className="text-muted-foreground/40">({tasks.length})</span>
      </div>
      <div className="space-y-1">
        {tasks.map((t) => (
          <div
            key={t.id}
            className="rounded-md border bg-muted/30 px-2 py-1.5 text-[10px]"
          >
            <p className="truncate font-medium">{t.subject}</p>
            {t.owner && (
              <p className="text-[9px] text-muted-foreground/50 mt-0.5 truncate">{t.owner}</p>
            )}
          </div>
        ))}
        {tasks.length === 0 && (
          <div className="rounded-md border border-dashed bg-muted/10 px-2 py-2 text-[9px] text-muted-foreground/30 text-center">
            None
          </div>
        )}
      </div>
    </div>
  )
}

// --- Message Feed ---

function MessageFeed({ messages }: {
  messages: { id: string; from: string; to: string | 'all'; content: string; type: string; timestamp: number }[]
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(messages.length <= 5)

  if (messages.length === 0) {
    return (
      <div className="text-[10px] text-muted-foreground/30 text-center py-2">
        No messages yet
      </div>
    )
  }

  const shown = expanded ? messages : messages.slice(-3)

  return (
    <div className="space-y-1">
      {!expanded && messages.length > 3 && (
        <button
          onClick={() => setExpanded(true)}
          className="text-[9px] text-cyan-500/60 hover:text-cyan-500 transition-colors"
        >
          Show {messages.length - 3} older messages...
        </button>
      )}
      {shown.map((msg) => (
        <div key={msg.id} className="flex gap-1.5 text-[10px]">
          <span className="shrink-0 font-medium text-cyan-600 dark:text-cyan-400">
            {msg.from}
          </span>
          <span className="text-muted-foreground/40 shrink-0">→</span>
          <span className="shrink-0 text-muted-foreground/60">
            {msg.to === 'all' ? 'all' : msg.to}:
          </span>
          <span className="text-muted-foreground/80 truncate">{msg.content}</span>
        </div>
      ))}
    </div>
  )
}

// --- Main TeamPanel ---

export function TeamPanel(): React.JSX.Element {
  const activeTeam = useTeamStore((s) => s.activeTeam)
  const [messagesExpanded, setMessagesExpanded] = useState(true)

  const handleStopMember = (memberId: string): void => {
    abortTeammate(memberId)
  }

  if (!activeTeam) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <Users className="mb-3 size-8 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">No active team</p>
        <p className="mt-1 text-xs text-muted-foreground/60">
          Ask the assistant to create a team for parallel collaboration
        </p>
      </div>
    )
  }

  const { members, tasks, messages } = activeTeam
  const completedTasks = tasks.filter((t) => t.status === 'completed')
  const activeTasks = tasks.filter((t) => t.status === 'in_progress')
  const pendingTasks = tasks.filter((t) => t.status === 'pending')
  const workingMembers = members.filter((m) => m.status === 'working')
  const progress = tasks.length === 0 ? 0 : Math.round((completedTasks.length / tasks.length) * 100)

  return (
    <div className="space-y-4">
      {/* Team Header */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <div className="flex items-center justify-center rounded-lg bg-cyan-500/15 p-1.5 text-cyan-500">
            <Users className="size-4" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-semibold text-cyan-600 dark:text-cyan-400 truncate">
                {activeTeam.name}
              </span>
              <Badge variant="secondary" className="text-[8px] h-3.5 px-1">
                {members.length} members
              </Badge>
            </div>
            <p className="text-[10px] text-muted-foreground/60 truncate">{activeTeam.description}</p>
          </div>
        </div>

        {/* Progress */}
        {tasks.length > 0 && (
          <div className="space-y-1">
            <div className="flex items-center justify-between text-[10px] text-muted-foreground/60">
              <span>{completedTasks.length}/{tasks.length} tasks</span>
              <span>{progress}%</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-cyan-500 transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        )}

        {/* Summary badges */}
        <div className="flex flex-wrap gap-1">
          {workingMembers.length > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-cyan-500/10 px-2 py-0.5 text-[9px] text-cyan-500">
              <span className="size-1.5 rounded-full bg-cyan-500 animate-pulse" />
              {workingMembers.length} working
            </span>
          )}
          {activeTasks.length > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 px-2 py-0.5 text-[9px] text-blue-500">
              {activeTasks.length} active
            </span>
          )}
          {pendingTasks.length > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[9px] text-muted-foreground/60">
              {pendingTasks.length} pending
            </span>
          )}
        </div>
      </div>

      <Separator />

      {/* Task Board */}
      {tasks.length > 0 && (
        <div>
          <div className="flex items-center gap-1.5 mb-2">
            <ClipboardList className="size-3 text-muted-foreground/50" />
            <span className="text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wider">
              Task Board
            </span>
          </div>
          <div className="flex gap-2">
            <TaskColumn
              title="Pending"
              tasks={pendingTasks.map((t) => ({ id: t.id, subject: t.subject, owner: t.owner }))}
              color="text-muted-foreground/60"
            />
            <TaskColumn
              title="Active"
              tasks={activeTasks.map((t) => ({ id: t.id, subject: t.subject, owner: t.owner }))}
              color="text-blue-500"
            />
            <TaskColumn
              title="Done"
              tasks={completedTasks.map((t) => ({ id: t.id, subject: t.subject, owner: t.owner }))}
              color="text-green-500"
            />
          </div>
        </div>
      )}

      {tasks.length > 0 && <Separator />}

      {/* Teammate List */}
      {members.length > 0 && (
        <div>
          <div className="flex items-center gap-1.5 mb-2">
            <Users className="size-3 text-muted-foreground/50" />
            <span className="text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wider">
              Teammates
            </span>
            <Badge variant="secondary" className="text-[8px] h-3.5 px-1 ml-auto">
              {members.length}
            </Badge>
          </div>
          <div className="space-y-2">
            {members.map((member) => {
              const task = member.currentTaskId
                ? tasks.find((t) => t.id === member.currentTaskId)
                : undefined
              return (
                <TeammateCard
                  key={member.id}
                  member={member}
                  task={task}
                  onStop={handleStopMember}
                />
              )
            })}
          </div>
        </div>
      )}

      {members.length > 0 && messages.length > 0 && <Separator />}

      {/* Message Feed */}
      {messages.length > 0 && (
        <Collapsible open={messagesExpanded} onOpenChange={setMessagesExpanded}>
          <CollapsibleTrigger asChild>
            <button className="flex w-full items-center gap-1.5 text-[10px] text-muted-foreground/60 hover:text-muted-foreground transition-colors mb-2">
              <MessageSquare className="size-3" />
              <span className="font-medium uppercase tracking-wider">Messages</span>
              <Badge variant="secondary" className="text-[8px] h-3.5 px-1">{messages.length}</Badge>
              <span className="flex-1" />
              {messagesExpanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <MessageFeed messages={messages} />
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  )
}
