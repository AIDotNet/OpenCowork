import { useEffect, useRef } from 'react'
import { useGraphStore } from './graph-store'
import { useProjectsStore, type ProjectMeta } from './draw-projects-store'
import { useAssistantStore } from './assistant/assistant-store'
import {
  ensureDrawAgentWorkspace,
  renameDrawAgentWorkspace,
  trashDrawAgentWorkspace
} from './draw-agent-workspace'
import {
  deleteProjectGraph,
  loadProjectGraph,
  migrateLegacyGraph,
  saveProjectGraph
} from './graph-persistence'

const AUTOSAVE_MS = 400

export interface DrawProjectsApi {
  projects: ProjectMeta[]
  activeProjectId: string | null
  newProject: () => Promise<void>
  switchProject: (id: string) => void
  renameProject: (id: string, name: string) => Promise<void>
  removeProject: (id: string) => Promise<void>
}

/**
 * Owns the multi-project lifecycle: first-run init + legacy migration, loading the
 * active project's graph, autosaving graph edits to the active slot, and switching.
 */
export function useDrawProjects(baseName: string): DrawProjectsApi {
  const projects = useProjectsStore((s) => s.projects)
  const activeProjectId = useProjectsStore((s) => s.activeProjectId)
  const baseNameRef = useRef(baseName)
  baseNameRef.current = baseName
  const initedRef = useRef(false)

  // First-run init + migration; then load the active project.
  useEffect(() => {
    if (initedRef.current) return
    initedRef.current = true
    const store = useProjectsStore.getState()
    if (store.projects.length === 0) {
      const id = store.createProject(`${baseNameRef.current} 1`, Date.now())
      migrateLegacyGraph(id)
      loadProjectGraph(id)
    } else {
      const id = store.activeProjectId ?? store.projects[0].id
      if (!store.activeProjectId) store.setActiveProject(id)
      loadProjectGraph(id)
    }
  }, [])

  // Debounced autosave of graph edits to the active project slot.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsub = useGraphStore.subscribe((s, prev) => {
      if (
        s.nodes === prev.nodes &&
        s.edges === prev.edges &&
        s.triggers === prev.triggers &&
        s.background === prev.background
      )
        return
      const id = useProjectsStore.getState().activeProjectId
      if (!id) return
      clearTimeout(timer)
      timer = setTimeout(() => {
        // Project switches flush synchronously. Never let an older debounced
        // save serialize the newly-loaded graph back into the previous slot.
        if (useProjectsStore.getState().activeProjectId !== id) return
        saveProjectGraph(id)
        useProjectsStore.getState().touchActive(Date.now())
      }, AUTOSAVE_MS)
    })
    return () => {
      clearTimeout(timer)
      unsub()
    }
  }, [])

  const flushCurrent = (): void => {
    const id = useProjectsStore.getState().activeProjectId
    if (id) saveProjectGraph(id)
  }

  const switchProject = (id: string): void => {
    const store = useProjectsStore.getState()
    if (store.activeProjectId === id) return
    flushCurrent()
    store.setActiveProject(id)
    loadProjectGraph(id)
  }

  const newProject = async (): Promise<void> => {
    flushCurrent()
    const store = useProjectsStore.getState()
    const id = store.createProject(
      `${baseNameRef.current} ${store.projects.length + 1}`,
      Date.now()
    )
    loadProjectGraph(id)
    await ensureDrawAgentWorkspace(id)
  }

  const renameProject = async (id: string, name: string): Promise<void> => {
    const nextName = name.trim() || baseNameRef.current
    await renameDrawAgentWorkspace(id, nextName)
    useProjectsStore.getState().renameProject(id, nextName)
  }

  const removeProject = async (id: string): Promise<void> => {
    const wasActive = useProjectsStore.getState().activeProjectId === id
    await trashDrawAgentWorkspace(id)
    deleteProjectGraph(id)
    useAssistantStore.getState().clearSession(id)
    const store = useProjectsStore.getState()
    store.deleteProject(id)
    if (!wasActive) return
    const next = useProjectsStore.getState().activeProjectId
    if (next) {
      loadProjectGraph(next)
    } else {
      const nid = store.createProject(`${baseNameRef.current} 1`, Date.now())
      loadProjectGraph(nid)
      await ensureDrawAgentWorkspace(nid)
    }
  }

  return { projects, activeProjectId, newProject, switchProject, renameProject, removeProject }
}
