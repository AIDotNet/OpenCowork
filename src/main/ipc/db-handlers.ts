import { ipcMain } from 'electron'
import { getDb } from '../db/database'
import * as sessionsDao from '../db/sessions-dao'
import * as projectsDao from '../db/projects-dao'
import * as messagesDao from '../db/messages-dao'
import * as plansDao from '../db/plans-dao'
import * as tasksDao from '../db/tasks-dao'
import * as goalsDao from '../db/goals-dao'
import * as drawRunsDao from '../db/draw-runs-dao'
import * as usageEventsDao from '../db/usage-events-dao'
import * as wikiDao from '../db/wiki-dao'
import { safeSendToAllWindows } from '../window-ipc'

const CHAT_SESSION_UPDATED = 'chat:session-updated'
const CHAT_SESSION_DELETED = 'chat:session-deleted'
const GOAL_UPDATED = 'goal:updated'
const GOAL_CLEARED = 'goal:cleared'
const GOAL_EVENT_ADDED = 'goal:event-added'
const MAX_GOAL_OBJECTIVE_CHARS = 4000
const GOAL_EVENT_TYPES = new Set<goalsDao.SessionGoalEventType>([
  'created',
  'replaced',
  'objective_updated',
  'budget_updated',
  'status_changed',
  'usage_accounted',
  'budget_limited',
  'completion_deferred',
  'completed',
  'stall_paused',
  'auto_continue_blocked',
  'cleared'
])

interface RegisterDbHandlersOptions {
  onSessionDeleted?: (sessionId: string) => void
}

function emitSessionUpdated(sessionId: string, reason: string): void {
  const session = sessionsDao.getSession(sessionId)
  if (!session) return

  safeSendToAllWindows(CHAT_SESSION_UPDATED, {
    reason,
    session
  })
}

function emitSessionDeleted(
  sessionId: string,
  reason: string,
  options?: RegisterDbHandlersOptions
): void {
  options?.onSessionDeleted?.(sessionId)
  safeSendToAllWindows(CHAT_SESSION_DELETED, {
    reason,
    sessionId
  })
}

function emitGoalUpdated(goal: goalsDao.SessionGoalRow, reason: string): void {
  safeSendToAllWindows(GOAL_UPDATED, { reason, goal })
}

function emitGoalCleared(sessionId: string, reason: string): void {
  safeSendToAllWindows(GOAL_CLEARED, { reason, sessionId })
}

function emitGoalEventAdded(event: goalsDao.SessionGoalEventRow, reason: string): void {
  safeSendToAllWindows(GOAL_EVENT_ADDED, { reason, event })
}

function normalizeGoalObjective(value: unknown): string {
  const objective = typeof value === 'string' ? value.trim() : ''
  if (!objective) {
    throw new Error('goal objective must not be empty')
  }
  if ([...objective].length > MAX_GOAL_OBJECTIVE_CHARS) {
    throw new Error(`goal objective must be at most ${MAX_GOAL_OBJECTIVE_CHARS} characters`)
  }
  return objective
}

function normalizeGoalStatus(value: unknown): goalsDao.SessionGoalStatus | undefined {
  if (
    value === 'active' ||
    value === 'paused' ||
    value === 'budget_limited' ||
    value === 'complete'
  ) {
    return value
  }
  return undefined
}

function normalizeGoalTokenBudget(value: unknown): number | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('goal token budget must be a finite number')
  }
  return Math.floor(value)
}

function normalizeGoalEventType(value: unknown): goalsDao.SessionGoalEventType {
  if (typeof value === 'string' && GOAL_EVENT_TYPES.has(value as goalsDao.SessionGoalEventType)) {
    return value as goalsDao.SessionGoalEventType
  }
  throw new Error('invalid goal event type')
}

function normalizeGoalEventMessage(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new Error('goal event message must be a string')
  return value.trim() || null
}

function normalizeGoalEventMetadata(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('goal event metadata must be an object')
  }
  return value as Record<string, unknown>
}

export function registerDbHandlers(options: RegisterDbHandlersOptions = {}): void {
  // Initialize DB on registration
  getDb()

  // --- Projects ---

  ipcMain.handle('db:projects:list', () => {
    return projectsDao.listProjects()
  })

  ipcMain.handle('db:projects:get', (_event, id: string) => {
    return projectsDao.getProject(id) ?? null
  })

  ipcMain.handle('db:projects:ensure-default', () => {
    return projectsDao.ensureDefaultProject()
  })

  ipcMain.handle(
    'db:projects:create',
    (
      _event,
      project: {
        id?: string
        name: string
        workingFolder?: string | null
        sshConnectionId?: string | null
        pluginId?: string | null
        pinned?: boolean
        createdAt?: number
        updatedAt?: number
      }
    ) => {
      return projectsDao.createProject(project)
    }
  )

  ipcMain.handle(
    'db:projects:update',
    (
      _event,
      args: {
        id: string
        patch: Partial<{
          name: string
          workingFolder: string | null
          sshConnectionId: string | null
          pluginId: string | null
          pinned: boolean
          updatedAt: number
        }>
      }
    ) => {
      projectsDao.updateProject(args.id, args.patch)
      return { success: true }
    }
  )

  ipcMain.handle('db:projects:delete', (_event, id: string) => {
    const result = projectsDao.deleteProject(id)
    for (const sessionId of result?.sessionIds ?? []) {
      emitSessionDeleted(sessionId, 'project-deleted', options)
    }
    return result
  })

  // --- Sessions ---

  ipcMain.handle('db:sessions:list', () => {
    return sessionsDao.listSessions()
  })

  ipcMain.handle('db:sessions:get', (_event, id: string) => {
    const session = sessionsDao.getSession(id)
    if (!session) return null
    const messages = messagesDao.getMessages(id)
    return { session, messages }
  })

  ipcMain.handle(
    'db:sessions:create',
    (
      _event,
      session: {
        id: string
        title: string
        mode: string
        createdAt: number
        updatedAt: number
        projectId?: string
        workingFolder?: string
        sshConnectionId?: string
        planId?: string | null
        pinned?: boolean
        pluginId?: string
        providerId?: string
        modelId?: string
      }
    ) => {
      const projectId = session.projectId
      let workingFolder = session.workingFolder
      let sshConnectionId = session.sshConnectionId

      if (projectId) {
        const project = projectsDao.getProject(projectId)
        if (project) {
          if (workingFolder === undefined) workingFolder = project.working_folder ?? undefined
          if (sshConnectionId === undefined)
            sshConnectionId = project.ssh_connection_id ?? undefined
        }
      }

      sessionsDao.createSession({
        ...session,
        projectId,
        workingFolder,
        sshConnectionId
      })
      emitSessionUpdated(session.id, 'session-created')
      return { success: true }
    }
  )

  ipcMain.handle(
    'db:sessions:update',
    (
      _event,
      args: {
        id: string
        patch: Partial<{
          title: string
          mode: string
          updatedAt: number
          projectId: string | null
          workingFolder: string | null
          sshConnectionId: string | null
          planId: string | null
          pinned: boolean
        }>
      }
    ) => {
      sessionsDao.updateSession(args.id, args.patch)
      emitSessionUpdated(args.id, 'session-updated')
      return { success: true }
    }
  )

  ipcMain.handle('db:sessions:delete', (_event, id: string) => {
    sessionsDao.deleteSession(id)
    emitSessionDeleted(id, 'session-deleted', options)
    return { success: true }
  })

  ipcMain.handle('db:sessions:clear-all', () => {
    const sessionIds = sessionsDao
      .listSessions()
      .filter((session) => !session.plugin_id)
      .map((session) => session.id)
    sessionsDao.clearAllSessions()
    for (const sessionId of sessionIds) {
      emitSessionDeleted(sessionId, 'session-cleared', options)
    }
    return { success: true }
  })

  // --- Messages ---

  ipcMain.handle('db:messages:list', (_event, sessionId: string) => {
    return messagesDao.getMessages(sessionId)
  })

  ipcMain.handle('db:messages:list-user', (_event, sessionId: string) => {
    return messagesDao.getUserMessages(sessionId)
  })

  ipcMain.handle(
    'db:messages:list-page',
    (_event, args: { sessionId: string; limit: number; offset: number }) => {
      return messagesDao.getMessagesPage(args.sessionId, args.limit, args.offset)
    }
  )

  ipcMain.handle(
    'db:messages:add',
    (
      _event,
      msg: {
        id: string
        sessionId: string
        role: string
        content: string
        meta?: string | null
        createdAt: number
        usage?: string | null
        sortOrder: number
      }
    ) => {
      // Ensure session exists to avoid FK constraint failure (race with fire-and-forget IPC)
      const existing = sessionsDao.getSession(msg.sessionId)
      if (!existing) {
        sessionsDao.createSession({
          id: msg.sessionId,
          title: 'New Conversation',
          mode: 'chat',
          createdAt: msg.createdAt,
          updatedAt: msg.createdAt
        })
      }
      messagesDao.addMessage(msg)
      emitSessionUpdated(msg.sessionId, existing ? 'message-added' : 'session-created-with-message')
      return { success: true }
    }
  )

  ipcMain.handle(
    'db:messages:add-batch',
    (
      _event,
      msgs: Array<{
        id: string
        sessionId: string
        role: string
        content: string
        meta?: string | null
        createdAt: number
        usage?: string | null
        sortOrder: number
      }>
    ) => {
      if (!Array.isArray(msgs) || msgs.length === 0) return { success: true }
      const sessionIds = new Set(msgs.map((m) => m.sessionId))
      for (const sessionId of sessionIds) {
        const existing = sessionsDao.getSession(sessionId)
        if (!existing) {
          const earliest = msgs.filter((m) => m.sessionId === sessionId)[0]
          sessionsDao.createSession({
            id: sessionId,
            title: 'New Conversation',
            mode: 'chat',
            createdAt: earliest.createdAt,
            updatedAt: earliest.createdAt
          })
        }
      }
      messagesDao.addMessages(msgs)
      for (const sessionId of sessionIds) {
        emitSessionUpdated(sessionId, 'message-added')
      }
      return { success: true }
    }
  )

  ipcMain.handle(
    'db:messages:update',
    (
      _event,
      args: {
        id: string
        patch: Partial<{ content: string; meta: string | null; usage: string | null }>
      }
    ) => {
      messagesDao.updateMessage(args.id, args.patch)
      return { success: true }
    }
  )

  ipcMain.handle('db:messages:clear', (_event, sessionId: string) => {
    messagesDao.clearMessages(sessionId)
    emitSessionUpdated(sessionId, 'messages-cleared')
    return { success: true }
  })

  ipcMain.handle(
    'db:messages:replace',
    (
      _event,
      args: {
        sessionId: string
        messages: Array<{
          id: string
          role: string
          content: string
          meta?: string | null
          createdAt: number
          usage?: string | null
          sortOrder: number
        }>
      }
    ) => {
      messagesDao.replaceMessages(args.sessionId, args.messages)
      emitSessionUpdated(args.sessionId, 'messages-replaced')
      return { success: true }
    }
  )

  ipcMain.handle(
    'db:messages:truncate-from',
    (_event, args: { sessionId: string; fromSortOrder: number }) => {
      messagesDao.truncateMessagesFrom(args.sessionId, args.fromSortOrder)
      emitSessionUpdated(args.sessionId, 'messages-truncated')
      return { success: true }
    }
  )

  ipcMain.handle('db:messages:count', (_event, sessionId: string) => {
    return messagesDao.getMessageCount(sessionId)
  })

  // --- Goals ---

  ipcMain.handle('db:goals:list', () => {
    return goalsDao.listGoals()
  })

  ipcMain.handle('db:goals:get', (_event, sessionId: string) => {
    return goalsDao.getGoal(sessionId) ?? null
  })

  ipcMain.handle(
    'db:goals:create',
    (
      _event,
      args: {
        sessionId: string
        objective: unknown
        tokenBudget?: unknown
      }
    ) => {
      const goal = goalsDao.createGoal({
        sessionId: args.sessionId,
        objective: normalizeGoalObjective(args.objective),
        tokenBudget: normalizeGoalTokenBudget(args.tokenBudget) ?? null
      })
      if (!goal) {
        return { success: false, error: 'A goal already exists for this session' }
      }
      emitGoalUpdated(goal, 'goal-created')
      return { success: true, goal }
    }
  )

  ipcMain.handle(
    'db:goals:set',
    (
      _event,
      args: {
        sessionId: string
        objective: unknown
        status?: unknown
        tokenBudget?: unknown
      }
    ) => {
      const goal = goalsDao.replaceGoal({
        sessionId: args.sessionId,
        objective: normalizeGoalObjective(args.objective),
        status: normalizeGoalStatus(args.status) ?? 'active',
        tokenBudget: normalizeGoalTokenBudget(args.tokenBudget) ?? null
      })
      emitGoalUpdated(goal, 'goal-set')
      return { success: true, goal }
    }
  )

  ipcMain.handle(
    'db:goals:update',
    (
      _event,
      args: {
        sessionId: string
        patch: {
          objective?: unknown
          status?: unknown
          tokenBudget?: unknown
        }
      }
    ) => {
      const patch: goalsDao.SessionGoalUpdate = {}
      if (args.patch.objective !== undefined) {
        patch.objective = normalizeGoalObjective(args.patch.objective)
      }
      if (args.patch.status !== undefined) {
        const status = normalizeGoalStatus(args.patch.status)
        if (!status) return { success: false, error: 'Invalid goal status' }
        patch.status = status
      }
      if (args.patch.tokenBudget !== undefined) {
        patch.tokenBudget = normalizeGoalTokenBudget(args.patch.tokenBudget) ?? null
      }

      const goal = goalsDao.updateGoal(args.sessionId, patch)
      if (!goal) return { success: false, error: 'No goal exists for this session' }
      emitGoalUpdated(goal, 'goal-updated')
      return { success: true, goal }
    }
  )

  ipcMain.handle('db:goals:clear', (_event, sessionId: string) => {
    const cleared = goalsDao.clearGoal(sessionId)
    if (cleared) {
      emitGoalCleared(sessionId, 'goal-cleared')
    }
    return { success: true, cleared }
  })

  ipcMain.handle(
    'db:goals:account',
    (
      _event,
      args: {
        sessionId: string
        timeDeltaSeconds: number
        tokenDelta: number
        expectedGoalId?: string | null
      }
    ) => {
      const goal = goalsDao.accountGoalUsage(args)
      if (goal) {
        emitGoalUpdated(goal, 'goal-accounted')
      }
      return { success: true, goal }
    }
  )

  ipcMain.handle(
    'db:goal-events:list',
    (_event, args: { sessionId: string; goalId?: string | null; limit?: number }) => {
      return goalsDao.listGoalEvents(args)
    }
  )

  ipcMain.handle(
    'db:goal-events:add',
    (
      _event,
      args: {
        sessionId: string
        goalId?: string | null
        eventType: unknown
        message?: unknown
        metadata?: unknown
      }
    ) => {
      const event = goalsDao.addGoalEvent({
        sessionId: args.sessionId,
        goalId: args.goalId,
        eventType: normalizeGoalEventType(args.eventType),
        message: normalizeGoalEventMessage(args.message),
        metadata: normalizeGoalEventMetadata(args.metadata)
      })
      emitGoalEventAdded(event, 'goal-event-added')
      return { success: true, event }
    }
  )

  // --- Usage Events ---

  ipcMain.handle('usage-events:add', (_event, payload) => {
    usageEventsDao.addUsageEvent(payload)
    return { success: true }
  })

  ipcMain.handle('usage-events:overview', (_event, query) => {
    return usageEventsDao.getUsageOverview(query)
  })

  ipcMain.handle('usage-events:daily', (_event, query) => {
    return usageEventsDao.getUsageDaily(query)
  })

  ipcMain.handle(
    'usage-events:timeline',
    (
      _event,
      args: {
        query: usageEventsDao.UsageEventsQuery
        bucket: usageEventsDao.UsageTimelineBucket
      }
    ) => {
      return usageEventsDao.getUsageTimeline(args.query, args.bucket)
    }
  )

  ipcMain.handle('usage-events:by-model', (_event, query) => {
    return usageEventsDao.getUsageByModel(query)
  })

  ipcMain.handle('usage-events:by-provider', (_event, query) => {
    return usageEventsDao.getUsageByProvider(query)
  })

  ipcMain.handle('usage-events:list', (_event, query) => {
    return usageEventsDao.listUsageEvents(query)
  })

  ipcMain.handle('usage-events:clear', (_event, query) => {
    return usageEventsDao.deleteUsageEvents(query)
  })

  // --- Draw Runs ---

  ipcMain.handle('db:draw-runs:list', () => {
    return drawRunsDao.listDrawRuns()
  })

  ipcMain.handle(
    'db:draw-runs:save',
    (
      _event,
      run: {
        id: string
        prompt: string
        providerName: string
        modelName: string
        mode?: string
        metaJson?: string | null
        createdAt: number
        isGenerating: boolean
        imagesJson: string
        errorJson?: string | null
        updatedAt: number
      }
    ) => {
      drawRunsDao.saveDrawRun(run)
      return { success: true }
    }
  )

  ipcMain.handle('db:draw-runs:delete', (_event, id: string) => {
    drawRunsDao.deleteDrawRun(id)
    return { success: true }
  })

  ipcMain.handle('db:draw-runs:clear', () => {
    drawRunsDao.clearDrawRuns()
    return { success: true }
  })

  // --- Plans ---

  ipcMain.handle('db:plans:list', () => {
    return plansDao.listPlans()
  })

  ipcMain.handle('db:plans:get', (_event, id: string) => {
    return plansDao.getPlan(id) ?? null
  })

  ipcMain.handle('db:plans:get-by-session', (_event, sessionId: string) => {
    return plansDao.getPlanBySession(sessionId) ?? null
  })

  ipcMain.handle(
    'db:plans:create',
    (
      _event,
      plan: {
        id: string
        sessionId: string
        title: string
        status?: string
        filePath?: string
        content?: string
        specJson?: string
        createdAt: number
        updatedAt: number
      }
    ) => {
      plansDao.createPlan(plan)
      return { success: true }
    }
  )

  ipcMain.handle(
    'db:plans:update',
    (
      _event,
      args: {
        id: string
        patch: Partial<{
          title: string
          status: string
          filePath: string | null
          content: string | null
          specJson: string | null
          updatedAt: number
        }>
      }
    ) => {
      plansDao.updatePlan(args.id, args.patch)
      return { success: true }
    }
  )

  ipcMain.handle('db:plans:delete', (_event, id: string) => {
    plansDao.deletePlan(id)
    return { success: true }
  })

  // --- Tasks (session-bound) ---

  ipcMain.handle('db:tasks:list-by-session', (_event, sessionId: string) => {
    return tasksDao.listTasksBySession(sessionId)
  })

  ipcMain.handle('db:tasks:get', (_event, id: string) => {
    return tasksDao.getTask(id) ?? null
  })

  ipcMain.handle(
    'db:tasks:create',
    (
      _event,
      task: {
        id: string
        sessionId: string
        planId?: string
        subject: string
        description: string
        activeForm?: string
        status?: string
        owner?: string
        blocks?: string[]
        blockedBy?: string[]
        metadata?: Record<string, unknown>
        sortOrder: number
        createdAt: number
        updatedAt: number
      }
    ) => {
      tasksDao.createTask(task)
      return { success: true }
    }
  )

  ipcMain.handle(
    'db:tasks:update',
    (
      _event,
      args: {
        id: string
        patch: Partial<{
          subject: string
          description: string
          activeForm: string | null
          status: string
          owner: string | null
          blocks: string[]
          blockedBy: string[]
          metadata: Record<string, unknown> | null
          sortOrder: number
          updatedAt: number
        }>
      }
    ) => {
      tasksDao.updateTask(args.id, args.patch)
      return { success: true }
    }
  )

  ipcMain.handle('db:tasks:delete', (_event, id: string) => {
    tasksDao.deleteTask(id)
    return { success: true }
  })

  ipcMain.handle('db:tasks:delete-by-session', (_event, sessionId: string) => {
    tasksDao.deleteTasksBySession(sessionId)
    return { success: true }
  })

  // --- Wiki ---

  ipcMain.handle('db:wiki:list-documents', (_event, projectId: string) => {
    return wikiDao.listWikiDocuments(projectId)
  })

  ipcMain.handle('db:wiki:get-document', (_event, id: string) => {
    return wikiDao.getWikiDocument(id) ?? null
  })

  ipcMain.handle(
    'db:wiki:get-document-by-name',
    (_event, args: { projectId: string; name: string }) => {
      return wikiDao.getWikiDocumentByName(args.projectId, args.name) ?? null
    }
  )

  ipcMain.handle('db:wiki:save-document', (_event, args) => {
    return wikiDao.saveWikiDocument(args)
  })

  ipcMain.handle('db:wiki:list-sections', (_event, documentId: string) => {
    return wikiDao.listWikiSections(documentId)
  })

  ipcMain.handle(
    'db:wiki:save-sections',
    (_event, args: { documentId: string; sections: Array<Record<string, unknown>> }) => {
      return wikiDao.replaceWikiSections(
        args.documentId,
        args.sections as Array<{
          id?: string
          title: string
          anchor: string
          sortOrder: number
          summary?: string
          contentMarkdown?: string
        }>
      )
    }
  )

  ipcMain.handle('db:wiki:list-section-sources', (_event, sectionId: string) => {
    return wikiDao.listWikiSectionSources(sectionId)
  })

  ipcMain.handle(
    'db:wiki:save-section-sources',
    (_event, args: { sectionId: string; sources: Array<Record<string, unknown>> }) => {
      return wikiDao.replaceWikiSectionSources(
        args.sectionId,
        args.sources as Array<{
          id?: string
          filePath: string
          symbolHint?: string | null
          reason?: string
        }>
      )
    }
  )

  ipcMain.handle('db:wiki:get-project-state', (_event, projectId: string) => {
    return wikiDao.getWikiProjectState(projectId) ?? null
  })

  ipcMain.handle(
    'db:wiki:save-project-state',
    (_event, args: { projectId: string; patch: Record<string, unknown> }) => {
      return wikiDao.saveWikiProjectState(args.projectId, args.patch)
    }
  )

  ipcMain.handle('db:wiki:clear-project', (_event, projectId: string) => {
    wikiDao.clearWikiProject(projectId)
    return { success: true }
  })

  ipcMain.handle('db:wiki:list-runs', (_event, projectId: string) => {
    return wikiDao.listWikiGenerationRuns(projectId)
  })

  ipcMain.handle('db:wiki:create-run', (_event, args) => {
    return wikiDao.createWikiGenerationRun(args)
  })

  ipcMain.handle(
    'db:wiki:update-run',
    (_event, args: { id: string; patch: Record<string, unknown> }) => {
      wikiDao.updateWikiGenerationRun(args.id, args.patch)
      return { success: true }
    }
  )
}
