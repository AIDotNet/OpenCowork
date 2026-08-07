import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ArrowUpRight, Trash2, X } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Textarea } from '@renderer/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { useChatStore } from '@renderer/stores/chat-store'
import { useTaskStore, type TaskPriority, type TaskStatus } from '@renderer/stores/task-store'
import { useTaskBoardStore, type TaskBoardItem } from '@renderer/stores/task-board-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { emitAgentRuntimeSync } from '@renderer/lib/agent-runtime-sync'
import { invokeMessagePackBinary } from '@renderer/lib/ipc/messagepack-ipc-client'
import { DB_TASKS_DELETE_MSGPACK_CHANNEL } from '../../../../shared/messagepack/binary-ipc'
import { formatBoardDate, shortTaskId, STATUS_DOT_CLASS } from './board-utils'

const ALL_STATUSES: TaskStatus[] = ['pending', 'in_progress', 'blocked', 'in_review', 'completed']
const ALL_PRIORITIES: TaskPriority[] = ['urgent', 'high', 'medium', 'low']
const NONE = '__none__'

interface TaskDetailPanelProps {
  item: TaskBoardItem
}

export function TaskDetailPanel({ item }: TaskDetailPanelProps): React.JSX.Element {
  const { t, i18n } = useTranslation('taskboard')
  const selectTask = useTaskBoardStore((s) => s.selectTask)

  const [subject, setSubject] = useState(item.subject)
  const [tagsText, setTagsText] = useState(item.tags.join(', '))
  useEffect(() => {
    setSubject(item.subject)
    setTagsText(item.tags.join(', '))
  }, [item.id, item.subject, item.tags])

  const dueValue = useMemo(() => {
    if (item.dueAt === undefined) return ''
    const d = new Date(item.dueAt)
    const pad = (n: number): string => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }, [item.dueAt])

  const commitSubject = (): void => {
    const trimmed = subject.trim()
    if (trimmed && trimmed !== item.subject) {
      useTaskBoardStore.getState().updateBoardTask(item.id, { subject: trimmed })
    } else {
      setSubject(item.subject)
    }
  }

  const commitTags = (): void => {
    const tags = tagsText
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean)
    useTaskBoardStore.getState().updateBoardTask(item.id, { tags })
  }

  const handleOpenSession = async (): Promise<void> => {
    const message = t('detail.dispatchMessage', {
      subject: item.subject,
      defaultValue: 'Please continue working on the task: {{subject}}'
    })
    // Session may belong to a project never expanded in the sidebar (not yet in
    // chatStore.sessions) — hydrate it first, otherwise activeSessionId points at
    // a session with no backing record and downstream session UI loops forever.
    const chatStore = useChatStore.getState()
    const loaded = await chatStore.ensureSessionLoaded(item.sessionId)
    if (!loaded) {
      toast.error(t('detail.sessionLoadFailed', { defaultValue: 'Could not find that session' }))
      return
    }
    chatStore.setActiveSession(item.sessionId)
    // navigateToSession resets pendingInsertText (CHAT_SURFACE_NAV_RESET), so set it after.
    useUIStore.getState().navigateToSession(item.sessionId)
    useUIStore.getState().setPendingInsertText(message)
  }

  const handleDelete = (): void => {
    const deleted = useTaskStore.getState().deleteTask(item.id)
    if (!deleted) {
      // Task not cached in task-store (dormant session): delete directly and broadcast.
      invokeMessagePackBinary(DB_TASKS_DELETE_MSGPACK_CHANNEL, item.id).catch(() => {})
      emitAgentRuntimeSync({ kind: 'task_delete', id: item.id })
    }
    useTaskBoardStore.setState((s) => ({ items: s.items.filter((t) => t.id !== item.id) }))
    selectTask(null)
  }

  return (
    <div className="flex h-full w-80 shrink-0 flex-col border-l bg-background">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <span className="font-mono text-xs text-muted-foreground">{shortTaskId(item.id)}</span>
        <Button variant="ghost" size="icon" className="size-7" onClick={() => selectTask(null)}>
          <X className="size-4" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            {t('detail.subject', { defaultValue: 'Title' })}
          </label>
          <Textarea
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            onBlur={commitSubject}
            rows={2}
            className="resize-none text-sm"
          />
        </div>

        {item.description && (
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              {t('detail.description', { defaultValue: 'Description' })}
            </label>
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">{item.description}</p>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              {t('detail.status', { defaultValue: 'Status' })}
            </label>
            <Select
              value={item.status}
              onValueChange={(v) =>
                useTaskBoardStore.getState().updateBoardTask(item.id, { status: v as TaskStatus })
              }
            >
              <SelectTrigger className="h-8 w-full text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ALL_STATUSES.map((status) => (
                  <SelectItem key={status} value={status} className="text-xs">
                    <span className="flex items-center gap-2">
                      <span className={cn('size-2 rounded-full', STATUS_DOT_CLASS[status])} />
                      {t(`columns.${status}`, { defaultValue: status })}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              {t('detail.priority', { defaultValue: 'Priority' })}
            </label>
            <Select
              value={item.priority ?? NONE}
              onValueChange={(v) =>
                useTaskBoardStore.getState().updateBoardTask(item.id, {
                  priority: v === NONE ? null : (v as TaskPriority)
                })
              }
            >
              <SelectTrigger className="h-8 w-full text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE} className="text-xs">
                  {t('priority.none', { defaultValue: 'No priority' })}
                </SelectItem>
                {ALL_PRIORITIES.map((p) => (
                  <SelectItem key={p} value={p} className="text-xs">
                    {t(`priority.${p}`, { defaultValue: p })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            {t('detail.tags', { defaultValue: 'Tags' })}
          </label>
          <Input
            value={tagsText}
            onChange={(e) => setTagsText(e.target.value)}
            onBlur={commitTags}
            placeholder={t('detail.tagsPlaceholder', { defaultValue: 'tag1, tag2' })}
            className="h-8 text-xs"
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            {t('detail.dueAt', { defaultValue: 'Due date' })}
          </label>
          <div className="flex items-center gap-2">
            <Input
              type="date"
              value={dueValue}
              onChange={(e) => {
                const v = e.target.value
                useTaskBoardStore.getState().updateBoardTask(item.id, {
                  dueAt: v ? new Date(`${v}T23:59:59`).getTime() : null
                })
              }}
              className="h-8 flex-1 text-xs"
            />
            {item.dueAt !== undefined && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 px-2 text-xs"
                onClick={() =>
                  useTaskBoardStore.getState().updateBoardTask(item.id, { dueAt: null })
                }
              >
                {t('detail.clearDue', { defaultValue: 'Clear' })}
              </Button>
            )}
          </div>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            {t('detail.session', { defaultValue: 'Session' })}
          </label>
          <div className="rounded-md border px-3 py-2">
            <p className="truncate text-sm">{item.sessionTitle || item.sessionId.slice(0, 8)}</p>
            {item.sessionWorkingFolder && (
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                {item.sessionWorkingFolder}
              </p>
            )}
            <Button
              variant="outline"
              size="sm"
              className="mt-2 h-7 w-full gap-1 text-xs"
              onClick={handleOpenSession}
            >
              <ArrowUpRight className="size-3" />
              {t('detail.openSession', { defaultValue: 'Work on it in session' })}
            </Button>
          </div>
        </div>

        {(item.blocks.length > 0 || item.blockedBy.length > 0) && (
          <div className="space-y-1 text-xs text-muted-foreground">
            <label className="block font-medium">
              {t('detail.dependencies', { defaultValue: 'Dependencies' })}
            </label>
            {item.blocks.length > 0 && (
              <p>
                {t('detail.blocks', { defaultValue: 'Blocks' })}:{' '}
                {item.blocks.map(shortTaskId).join(', ')}
              </p>
            )}
            {item.blockedBy.length > 0 && (
              <p>
                {t('detail.blockedBy', { defaultValue: 'Blocked by' })}:{' '}
                {item.blockedBy.map(shortTaskId).join(', ')}
              </p>
            )}
          </div>
        )}

        <div className="space-y-1 text-[11px] text-muted-foreground">
          <p>
            {t('detail.createdAt', { defaultValue: 'Created' })}:{' '}
            {formatBoardDate(item.createdAt, i18n.language)}
          </p>
          <p>
            {t('detail.updatedAt', { defaultValue: 'Updated' })}:{' '}
            {formatBoardDate(item.updatedAt, i18n.language)}
          </p>
        </div>
      </div>

      <div className="border-t p-3">
        <Button
          variant="ghost"
          size="sm"
          className="w-full gap-1 text-xs text-destructive hover:text-destructive"
          onClick={handleDelete}
        >
          <Trash2 className="size-3" />
          {t('detail.delete', { defaultValue: 'Delete task' })}
        </Button>
      </div>
    </div>
  )
}
