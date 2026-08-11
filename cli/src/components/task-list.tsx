import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text } from 'ink'
import stringWidth from 'string-width'
import { fitText } from '../lib/text.js'
import { theme } from '../theme.js'
import type { TaskItem } from '../types.js'

const RECENT_COMPLETION_WINDOW_MS = 30_000

function visibleTaskLimit(rows: number): number {
  return rows <= 10 ? 0 : Math.min(5, Math.max(3, rows - 14))
}

function statusRank(task: TaskItem, completedAt: number | undefined, now: number): number {
  if (
    task.status === 'completed' &&
    completedAt !== undefined &&
    now - completedAt < RECENT_COMPLETION_WINDOW_MS
  ) {
    return 0
  }
  if (task.status === 'in_progress') return 1
  if (task.status === 'pending') return 2
  return 3
}

function hiddenTaskSummary(tasks: TaskItem[]): string {
  const inProgress = tasks.filter((task) => task.status === 'in_progress').length
  const pending = tasks.filter((task) => task.status === 'pending').length
  const completed = tasks.filter((task) => task.status === 'completed').length
  const parts = [
    inProgress > 0 ? `${inProgress} in progress` : '',
    pending > 0 ? `${pending} pending` : '',
    completed > 0 ? `${completed} completed` : ''
  ].filter(Boolean)
  return `… +${parts.join(', ')}`
}

function taskOwner(owner: string | null | undefined): string {
  if (!owner) return ''
  return ` (@${owner.replace(/^@/u, '')})`
}

function blockedByLabel(ids: string[]): string {
  return ids.map((id) => (id.startsWith('#') ? id : `#${id}`)).join(', ')
}

export function TaskList({
  tasks,
  width,
  rows
}: {
  tasks: TaskItem[]
  width: number
  rows: number
}): React.JSX.Element | null {
  const previousStatusesRef = useRef(new Map<string, TaskItem['status']>())
  const [completedAtById, setCompletedAtById] = useState<Map<string, number>>(() => new Map())
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const observedAt = Date.now()
    setCompletedAtById((current) => {
      const next = new Map<string, number>()
      for (const task of tasks) {
        if (task.status !== 'completed') continue
        const existing = current.get(task.id)
        const wasCompleted = previousStatusesRef.current.get(task.id) === 'completed'
        next.set(task.id, wasCompleted && existing !== undefined ? existing : observedAt)
      }
      return next
    })
    previousStatusesRef.current = new Map(tasks.map((task) => [task.id, task.status]))
    setNow(observedAt)
  }, [tasks])

  useEffect(() => {
    const nextExpiry = [...completedAtById.values()]
      .map((completedAt) => completedAt + RECENT_COMPLETION_WINDOW_MS)
      .filter((expiresAt) => expiresAt > now)
      .sort((left, right) => left - right)[0]
    if (nextExpiry === undefined) return
    const timer = setTimeout(() => setNow(Date.now()), Math.max(1, nextExpiry - now))
    return () => clearTimeout(timer)
  }, [completedAtById, now])

  const orderedTasks = useMemo(
    () =>
      tasks
        .map((task, index) => ({ task, index }))
        .sort((left, right) => {
          const leftRank = statusRank(left.task, completedAtById.get(left.task.id), now)
          const rightRank = statusRank(right.task, completedAtById.get(right.task.id), now)
          if (leftRank !== rightRank) return leftRank - rightRank
          if (leftRank === 0) {
            const leftCompletedAt = completedAtById.get(left.task.id) ?? 0
            const rightCompletedAt = completedAtById.get(right.task.id) ?? 0
            if (leftCompletedAt !== rightCompletedAt) return rightCompletedAt - leftCompletedAt
          }
          return left.index - right.index
        })
        .map(({ task }) => task),
    [completedAtById, now, tasks]
  )

  if (tasks.length === 0) return null

  const visibleTasks = orderedTasks.slice(0, visibleTaskLimit(rows))
  const hiddenTasks = orderedTasks.slice(visibleTasks.length)

  return (
    <Box flexDirection="column" paddingLeft={2} width={width}>
      {visibleTasks.map((task) => (
        <Box flexDirection="column" key={task.id}>
          <Box>
            <Text
              bold={task.status === 'in_progress'}
              color={
                task.status === 'completed'
                  ? theme.success
                  : task.status === 'in_progress'
                    ? theme.primary
                    : theme.dim
              }
            >
              {task.status === 'completed' ? '✔' : task.status === 'in_progress' ? '◼' : '◻'}
            </Text>
            {(() => {
              const owner = width >= 72 ? taskOwner(task.owner) : ''
              const label =
                task.status === 'in_progress' && task.activeForm ? task.activeForm : task.label
              return (
                <>
                  <Text
                    bold={task.status === 'in_progress'}
                    color={task.status === 'completed' ? theme.dim : theme.text}
                    strikethrough={task.status === 'completed'}
                  >
                    {' '}
                    {fitText(label, Math.max(8, width - 5 - stringWidth(owner)))}
                  </Text>
                  {owner ? <Text color={theme.dim}>{owner}</Text> : null}
                </>
              )
            })()}
          </Box>
          {task.blockedBy && task.blockedBy.length > 0 ? (
            <Box marginLeft={2}>
              <Text color={theme.muted}>
                {fitText(`❯ blocked by ${blockedByLabel(task.blockedBy)}`, Math.max(8, width - 4))}
              </Text>
            </Box>
          ) : null}
        </Box>
      ))}
      {hiddenTasks.length > 0 ? (
        <Text color={theme.dim}>
          {fitText(hiddenTaskSummary(hiddenTasks), Math.max(8, width - 2))}
        </Text>
      ) : null}
    </Box>
  )
}
