import * as React from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useShallow } from 'zustand/react/shallow'
import { TodoStatusList } from '@renderer/components/chat/TodoCard'
import type { TeamTask } from '@renderer/lib/agent/teams/types'
import { useChatStore } from '@renderer/stores/chat-store'
import { useTaskStore, type TaskItem } from '@renderer/stores/task-store'
import { useTeamStore } from '@renderer/stores/team-store'
import { useUIStore } from '@renderer/stores/ui-store'

const EMPTY_TASKS: TaskItem[] = []
const PINNED_PANEL_MIN_WIDTH = 1040

interface RuntimeStatusPanelProps {
  sessionId?: string | null
}

function teamTaskToItem(task: TeamTask): TaskItem {
  return {
    id: task.id,
    sessionId: '',
    subject: task.subject,
    description: task.description,
    activeForm: task.activeForm,
    status: task.status,
    owner: task.owner,
    blocks: [],
    blockedBy: task.dependsOn ?? [],
    metadata: undefined,
    createdAt: 0,
    updatedAt: 0
  }
}

export function RuntimeStatusPanel({
  sessionId = null
}: RuntimeStatusPanelProps): React.JSX.Element {
  const panelRootRef = React.useRef<HTMLDivElement | null>(null)
  const hideTimerRef = React.useRef<number | null>(null)
  const [containerWidth, setContainerWidth] = React.useState(0)
  const [hoveringNarrowTrigger, setHoveringNarrowTrigger] = React.useState(false)
  const resolvedSessionId = useChatStore((state) => sessionId ?? state.activeSessionId)
  const rightPanelOpen = useUIStore((state) => state.rightPanelOpen)
  const triggerHovered = useUIStore((state) => state.runtimeStatusPanelTriggerHovered)
  const sessionTasks = useTaskStore(
    useShallow((state) => {
      if (!resolvedSessionId) return EMPTY_TASKS
      if (state.currentSessionId === resolvedSessionId) return state.tasks
      return state.tasksBySession[resolvedSessionId] ?? EMPTY_TASKS
    })
  )
  const activeTeam = useTeamStore((state) => state.activeTeam)

  const teamTasks = React.useMemo(
    () => (activeTeam?.tasks ?? []).map(teamTaskToItem),
    [activeTeam?.tasks]
  )
  const tasks = sessionTasks.length > 0 ? sessionTasks : teamTasks
  const hasContent = Boolean(resolvedSessionId && !rightPanelOpen && tasks.length > 0)
  const hasEnoughWidth = containerWidth >= PINNED_PANEL_MIN_WIDTH
  const visible = hasContent && (hasEnoughWidth || hoveringNarrowTrigger)

  const clearHideTimer = React.useCallback((): void => {
    if (hideTimerRef.current == null) return
    window.clearTimeout(hideTimerRef.current)
    hideTimerRef.current = null
  }, [])

  const scheduleNarrowHide = React.useCallback((): void => {
    if (hasEnoughWidth) return
    clearHideTimer()
    hideTimerRef.current = window.setTimeout(() => {
      setHoveringNarrowTrigger(false)
      hideTimerRef.current = null
    }, 200)
  }, [clearHideTimer, hasEnoughWidth])

  React.useEffect(() => {
    const node = panelRootRef.current
    if (!node) return

    const updateWidth = (): void => setContainerWidth(node.getBoundingClientRect().width)
    updateWidth()

    const observer = new ResizeObserver(updateWidth)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  React.useEffect(() => {
    if (!hasContent || hasEnoughWidth) {
      clearHideTimer()
      setHoveringNarrowTrigger(false)
    }
  }, [clearHideTimer, hasContent, hasEnoughWidth])

  React.useEffect(() => {
    if (!hasContent || hasEnoughWidth) return
    if (triggerHovered) {
      clearHideTimer()
      setHoveringNarrowTrigger(true)
      return
    }
    scheduleNarrowHide()
  }, [clearHideTimer, hasContent, hasEnoughWidth, scheduleNarrowHide, triggerHovered])

  React.useEffect(() => clearHideTimer, [clearHideTimer])

  return (
    <div ref={panelRootRef} className="pointer-events-none absolute inset-0 z-30">
      <AnimatePresence initial={false}>
        {visible ? (
          <motion.aside
            key="runtime-status-panel"
            initial={{ opacity: 0, y: -8, scale: 0.98, filter: 'blur(4px)' }}
            animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
            exit={{ opacity: 0, y: -8, scale: 0.98, filter: 'blur(4px)' }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="pointer-events-auto absolute right-3 top-12 max-h-[min(360px,calc(100%-4rem))] w-[min(320px,calc(100%-1.5rem))] overflow-y-auto rounded-lg border border-border/70 bg-background/95 p-3 shadow-[-8px_10px_34px_rgba(0,0,0,0.22)] backdrop-blur-xl"
            style={{ transformOrigin: 'top right' }}
            onMouseEnter={() => {
              clearHideTimer()
              if (!hasEnoughWidth) setHoveringNarrowTrigger(true)
            }}
            onMouseLeave={() => {
              if (!hasEnoughWidth) scheduleNarrowHide()
            }}
          >
            <TodoStatusList tasks={tasks} embedded />
          </motion.aside>
        ) : null}
      </AnimatePresence>
    </div>
  )
}
