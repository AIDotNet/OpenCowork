import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { DragDropContext, Droppable, type DropResult } from '@hello-pangea/dnd'
import { Check } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { SlideIn } from '@renderer/components/animate-ui'
import { Button } from '@renderer/components/ui/button'
import type { TaskStatus } from '@renderer/stores/task-store'
import {
  BOARD_COLUMN_STATUSES,
  useTaskBoardStore,
  type TaskBoardItem
} from '@renderer/stores/task-board-store'
import { computeInsertSortOrder, sortColumnItems, STATUS_DOT_CLASS } from './board-utils'
import { TaskCard } from './TaskCard'

interface KanbanViewProps {
  items: TaskBoardItem[]
}

export function KanbanView({ items }: KanbanViewProps): React.JSX.Element {
  const { t } = useTranslation('taskboard')
  const selectedTaskId = useTaskBoardStore((s) => s.selectedTaskId)
  const selectTask = useTaskBoardStore((s) => s.selectTask)

  const columns = useMemo(() => {
    const map = new Map<TaskStatus, TaskBoardItem[]>()
    for (const status of BOARD_COLUMN_STATUSES) map.set(status, [])
    for (const item of items) {
      map.get(item.status)?.push(item)
    }
    for (const status of BOARD_COLUMN_STATUSES) {
      map.set(status, sortColumnItems(map.get(status)!))
    }
    return map
  }, [items])

  const handleDragEnd = useCallback(
    (result: DropResult) => {
      const { source, destination, draggableId } = result
      if (!destination) return
      if (source.droppableId === destination.droppableId && source.index === destination.index) {
        return
      }

      const destStatus = destination.droppableId as TaskStatus
      const destItems = (columns.get(destStatus) ?? []).filter((it) => it.id !== draggableId)
      const { sortOrder, renumber } = computeInsertSortOrder(
        destItems,
        destination.index,
        destStatus
      )

      const board = useTaskBoardStore.getState()
      if (renumber) {
        for (const entry of renumber) {
          board.updateBoardTask(entry.id, { sortOrder: entry.sortOrder })
        }
      }
      board.moveTask(draggableId, destStatus, sortOrder)
    },
    [columns]
  )

  const handleConfirmDone = useCallback((id: string) => {
    useTaskBoardStore.getState().updateBoardTask(id, { status: 'completed' })
  }, [])

  return (
    <DragDropContext onDragEnd={handleDragEnd}>
      <div className="flex h-full min-h-0 gap-3 overflow-x-auto p-4">
        {BOARD_COLUMN_STATUSES.map((status, columnIndex) => {
          const columnItems = columns.get(status) ?? []
          return (
            <SlideIn
              key={status}
              direction="up"
              offset={16}
              delay={columnIndex * 0.06}
              className="flex h-full w-72 shrink-0 flex-col rounded-xl border bg-muted/30"
            >
              <div className="flex items-center gap-2 px-3 py-2.5">
                <span className={cn('size-2 rounded-full', STATUS_DOT_CLASS[status])} />
                <span className="text-sm font-medium">
                  {t(`columns.${status}`, { defaultValue: status })}
                </span>
                <span className="ml-1 rounded-full bg-muted px-1.5 text-xs text-muted-foreground">
                  {columnItems.length}
                </span>
              </div>

              <Droppable droppableId={status}>
                {(provided, snapshot) => (
                  <div
                    ref={provided.innerRef}
                    {...provided.droppableProps}
                    className={cn(
                      'min-h-0 flex-1 overflow-y-auto px-2 pb-2 transition-colors',
                      snapshot.isDraggingOver && 'bg-primary/5'
                    )}
                  >
                    {columnItems.length === 0 && !snapshot.isDraggingOver && (
                      <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                        {t('column.empty', { defaultValue: 'No tasks' })}
                      </p>
                    )}
                    {columnItems.map((item, index) => (
                      <div key={item.id} className="relative">
                        <TaskCard
                          item={item}
                          index={index}
                          selected={selectedTaskId === item.id}
                          onClick={selectTask}
                        />
                        {status === 'in_review' && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="absolute right-2 top-2 h-6 gap-1 px-2 text-[11px] opacity-0 transition-opacity group-hover:opacity-100 hover:opacity-100 focus:opacity-100 [.group:hover_&]:opacity-100"
                            onClick={(e) => {
                              e.stopPropagation()
                              handleConfirmDone(item.id)
                            }}
                          >
                            <Check className="size-3" />
                            {t('column.confirmDone', { defaultValue: 'Confirm done' })}
                          </Button>
                        )}
                      </div>
                    ))}
                    {provided.placeholder}
                  </div>
                )}
              </Droppable>
            </SlideIn>
          )
        })}
      </div>
    </DragDropContext>
  )
}
