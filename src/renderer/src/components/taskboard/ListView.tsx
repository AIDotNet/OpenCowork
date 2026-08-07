import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@renderer/lib/utils'
import { SlideIn } from '@renderer/components/animate-ui'
import { Checkbox } from '@renderer/components/ui/checkbox'
import type { TaskStatus } from '@renderer/stores/task-store'
import { useTaskBoardStore, type TaskBoardItem } from '@renderer/stores/task-board-store'
import {
  formatBoardDate,
  PRIORITY_BADGE_CLASS,
  shortTaskId,
  sortColumnItems,
  STATUS_DOT_CLASS,
  tagColorClass
} from './board-utils'

const LIST_GROUP_ORDER: TaskStatus[] = [
  'in_progress',
  'blocked',
  'in_review',
  'pending',
  'completed'
]

interface ListViewProps {
  items: TaskBoardItem[]
}

export function ListView({ items }: ListViewProps): React.JSX.Element {
  const { t, i18n } = useTranslation('taskboard')
  const selectedTaskId = useTaskBoardStore((s) => s.selectedTaskId)
  const selectTask = useTaskBoardStore((s) => s.selectTask)
  const [showCompleted, setShowCompleted] = useState(true)

  const groups = useMemo(() => {
    const map = new Map<TaskStatus, TaskBoardItem[]>()
    for (const status of LIST_GROUP_ORDER) map.set(status, [])
    for (const item of items) map.get(item.status)?.push(item)
    return LIST_GROUP_ORDER.map((status) => ({
      status,
      items: sortColumnItems(map.get(status) ?? [])
    })).filter((group) => group.items.length > 0 && (showCompleted || group.status !== 'completed'))
  }, [items, showCompleted])

  return (
    <div className="h-full overflow-y-auto p-4">
      <label className="mb-3 flex w-fit cursor-pointer items-center gap-2 text-xs text-muted-foreground">
        <Checkbox checked={showCompleted} onCheckedChange={(v) => setShowCompleted(v === true)} />
        {t('list.showCompleted', { defaultValue: 'Show completed' })}
      </label>

      {groups.map(({ status, items: groupItems }, groupIndex) => (
        <SlideIn key={status} direction="up" offset={12} delay={groupIndex * 0.05} className="mb-5">
          <div className="mb-1.5 flex items-center gap-2 px-1">
            <span className={cn('size-2 rounded-full', STATUS_DOT_CLASS[status])} />
            <span className="text-sm font-medium">
              {t(`columns.${status}`, { defaultValue: status })}
            </span>
            <span className="text-xs text-muted-foreground">{groupItems.length}</span>
          </div>

          <div className="overflow-hidden rounded-lg border">
            {groupItems.map((item, idx) => (
              <button
                key={item.id}
                type="button"
                onClick={() => selectTask(item.id)}
                className={cn(
                  'flex w-full items-center gap-3 bg-card px-3 py-2 text-left text-sm transition-colors hover:bg-accent/50',
                  idx > 0 && 'border-t',
                  selectedTaskId === item.id && 'bg-accent'
                )}
              >
                <span className="w-14 shrink-0 font-mono text-[11px] text-muted-foreground">
                  {shortTaskId(item.id)}
                </span>
                <span
                  className={cn(
                    'min-w-0 flex-1 truncate',
                    item.status === 'completed' && 'text-muted-foreground line-through'
                  )}
                >
                  {item.subject}
                </span>
                {item.priority && (
                  <span
                    className={cn(
                      'shrink-0 rounded-full border px-1.5 text-[10px] font-medium',
                      PRIORITY_BADGE_CLASS[item.priority]
                    )}
                  >
                    {t(`priority.${item.priority}`, { defaultValue: item.priority })}
                  </span>
                )}
                {item.tags.slice(0, 2).map((tag) => (
                  <span
                    key={tag}
                    className={cn(
                      'hidden shrink-0 rounded-full px-1.5 text-[10px] font-medium md:inline',
                      tagColorClass(tag)
                    )}
                  >
                    {tag}
                  </span>
                ))}
                <span className="hidden w-32 shrink-0 truncate text-xs text-muted-foreground lg:block">
                  {item.sessionTitle || item.sessionId.slice(0, 8)}
                </span>
                <span className="w-16 shrink-0 text-right text-[11px] text-muted-foreground">
                  {formatBoardDate(item.updatedAt, i18n.language)}
                </span>
              </button>
            ))}
          </div>
        </SlideIn>
      ))}
    </div>
  )
}
