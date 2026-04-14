import { ipcMain } from 'electron'
import { getDb } from '../db/database'
import * as sessionsDao from '../db/sessions-dao'
import * as projectsDao from '../db/projects-dao'
import * as messagesDao from '../db/messages-dao'
import * as plansDao from '../db/plans-dao'
import * as tasksDao from '../db/tasks-dao'
import * as drawRunsDao from '../db/draw-runs-dao'
import * as usageEventsDao from '../db/usage-events-dao'
import * as wikiDao from '../db/wiki-dao'

export function registerDbHandlers(): void {
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
    return projectsDao.deleteProject(id)
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
        pinned?: boolean
        pluginId?: string
        providerId?: string
        modelId?: string
        longRunningMode?: boolean
      }
    ) => {
      let projectId = session.projectId
      let workingFolder = session.workingFolder
      let sshConnectionId = session.sshConnectionId

      if (!projectId) {
        const project = projectsDao.ensureDefaultProject()
        projectId = project.id
        if (workingFolder === undefined) workingFolder = project.working_folder ?? undefined
        if (sshConnectionId === undefined) sshConnectionId = project.ssh_connection_id ?? undefined
      } else {
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
          pinned: boolean
          longRunningMode: boolean
        }>
      }
    ) => {
      sessionsDao.updateSession(args.id, args.patch)
      return { success: true }
    }
  )

  ipcMain.handle('db:sessions:delete', (_event, id: string) => {
    sessionsDao.deleteSession(id)
    return { success: true }
  })

  ipcMain.handle('db:sessions:clear-all', () => {
    sessionsDao.clearAllSessions()
    return { success: true }
  })

  // --- Messages ---

  ipcMain.handle('db:messages:list', (_event, sessionId: string) => {
    return messagesDao.getMessages(sessionId)
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
        createdAt: number
        usage?: string | null
        sortOrder: number
      }
    ) => {
      // Ensure session exists to avoid FK constraint failure (race with fire-and-forget IPC)
      const existing = sessionsDao.getSession(msg.sessionId)
      if (!existing) {
        const project = projectsDao.ensureDefaultProject()
        sessionsDao.createSession({
          id: msg.sessionId,
          title: 'New Conversation',
          mode: 'chat',
          createdAt: msg.createdAt,
          updatedAt: msg.createdAt,
          projectId: project.id,
          workingFolder: project.working_folder ?? undefined,
          sshConnectionId: project.ssh_connection_id ?? undefined
        })
      }
      messagesDao.addMessage(msg)
      return { success: true }
    }
  )

  ipcMain.handle(
    'db:messages:update',
    (_event, args: { id: string; patch: Partial<{ content: string; usage: string | null }> }) => {
      messagesDao.updateMessage(args.id, args.patch)
      return { success: true }
    }
  )

  ipcMain.handle('db:messages:clear', (_event, sessionId: string) => {
    messagesDao.clearMessages(sessionId)
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
          createdAt: number
          usage?: string | null
          sortOrder: number
        }>
      }
    ) => {
      messagesDao.replaceMessages(args.sessionId, args.messages)
      return { success: true }
    }
  )

  ipcMain.handle(
    'db:messages:truncate-from',
    (_event, args: { sessionId: string; fromSortOrder: number }) => {
      messagesDao.truncateMessagesFrom(args.sessionId, args.fromSortOrder)
      return { success: true }
    }
  )

  ipcMain.handle('db:messages:count', (_event, sessionId: string) => {
    return messagesDao.getMessageCount(sessionId)
  })

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
