import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { Draggable } from '@hello-pangea/dnd'
import { CalendarClock, Link2, MessageSquare } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { useAgentStore } from '@renderer/stores/agent-store'
import { useChatStore } from '@renderer/stores/chat-store'
import type { TaskBoardItem } from '@renderer/stores/task-board-store'
import { formatBoardDate, PRIORITY_BADGE_CLASS, shortTaskId, tagColorClass } from './board-utils'

function RunningDots(): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-0.5" aria-hidden>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="size-1 rounded-full bg-blue-500 animate-pulse"
          style={{ animationDelay: `${i * 160}ms` }}
        />
      ))}
    </span>
  )
}

interface TaskCardProps {
  item: TaskBoardItem
  index: number
  selected: boolean
  onClick: (id: string) => void
}

export const TaskCard = memo(function TaskCard({
  item,
  index,
  selected,
  onClick
}: TaskCardProps): React.JSX.Element {
  const { t, i18n } = useTranslation('taskboard')
  const hasStreaming = useChatStore((s) => Boolean(s.streamingMessages[item.sessionId]))
  const agentRunning = useAgentStore((s) => s.isSessionActive(item.sessionId)) || hasStreaming
  const isAgentBusy = agentRunning && item.status === 'in_progress'
  const overdue = item.dueAt !== undefined && item.dueAt < Date.now() && item.status !== 'completed'

  return (
    <Draggable draggableId={item.id} index={index}>
      {(provided, snapshot) => (
        <div
          ref={provided.innerRef}
          {...provided.draggableProps}
          {...provided.dragHandleProps}
          onClick={() => onClick(item.id)}
          className={cn(
            'group mb-2 cursor-pointer rounded-lg border bg-card p-3 text-left shadow-xs transition-shadow hover:shadow-md',
            snapshot.isDragging && 'rotate-1 shadow-lg ring-2 ring-primary/30',
            selected && 'ring-2 ring-primary/50'
          )}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[11px] text-muted-foreground">
              {shortTaskId(item.id)}
            </span>
            {isAgentBusy && (
              <span
                className="flex items-center gap-1 text-[11px] text-blue-500"
                title={t('card.running', { defaultValue: 'Agent running' })}
              >
                <RunningDots />
              </span>
            )}
          </div>

          <p className="mt-1 line-clamp-3 text-sm leading-snug">
            {isAgentBusy && item.activeForm ? item.activeForm : item.subject}
          </p>

          {(item.priority || item.tags.length > 0) && (
            <div className="mt-2 flex flex-wrap items-center gap-1">
              {item.priority && (
                <span
                  className={cn(
                    'rounded-full border px-1.5 py-0 text-[10px] font-medium',
                    PRIORITY_BADGE_CLASS[item.priority]
                  )}
                >
                  {t(`priority.${item.priority}`, { defaultValue: item.priority })}
                </span>
              )}
              {item.tags.slice(0, 3).map((tag) => (
                <span
                  key={tag}
                  className={cn(
                    'rounded-full px-1.5 py-0 text-[10px] font-medium',
                    tagColorClass(tag)
                  )}
                >
                  {tag}
                </span>
              ))}
              {item.tags.length > 3 && (
                <span className="text-[10px] text-muted-foreground">+{item.tags.length - 3}</span>
              )}
            </div>
          )}

          <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
            {item.sessionTitle && (
              <span className="flex min-w-0 items-center gap-1">
                <MessageSquare className="size-3 shrink-0" />
                <span className="truncate max-w-[120px]">{item.sessionTitle}</span>
              </span>
            )}
            {item.blockedBy.length > 0 && (
              <span
                className="flex items-center gap-0.5"
                title={t('card.blockedByCount', {
                  count: item.blockedBy.length,
                  defaultValue: '{{count}} blocking'
                })}
              >
                <Link2 className="size-3" />
                {item.blockedBy.length}
              </span>
            )}
            {item.dueAt !== undefined && (
              <span
                className={cn(
                  'ml-auto flex items-center gap-0.5',
                  overdue && 'text-red-500 font-medium'
                )}
              >
                <CalendarClock className="size-3" />
                {formatBoardDate(item.dueAt, i18n.language)}
              </span>
            )}
          </div>
        </div>
      )}
    </Draggable>
  )
})
