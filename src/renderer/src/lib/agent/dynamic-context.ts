import { useTaskStore } from '../../stores/task-store'
import { useTeamStore } from '../../stores/team-store'
import { useUIStore } from '../../stores/ui-store'
import { useChatStore } from '../../stores/chat-store'
import { usePlanStore } from '../../stores/plan-store'
import { useSettingsStore } from '../../stores/settings-store'

/**
 * Build dynamic context for the first user message in a session.
 * Includes current task list status and selected files (if any).
 * 
 * @param options - Configuration options
 * @returns A <system-reminder> block with context, or empty string if no context
 */
export function buildDynamicContext(options: {
  sessionId: string
}): string {
  const { sessionId } = options

  const contextParts: string[] = []
  let hasExistingTasks = false

  // ── Task List Status ──
  const hasActiveTeam = !!useTeamStore.getState().activeTeam
  
  if (hasActiveTeam) {
    // Team mode: get team tasks
    const team = useTeamStore.getState().activeTeam!
    const tasks = team.tasks
    
    if (tasks.length > 0) {
      hasExistingTasks = true
      const pending = tasks.filter(t => t.status === 'pending').length
      const inProgress = tasks.filter(t => t.status === 'in_progress').length
      const completed = tasks.filter(t => t.status === 'completed').length
      
      contextParts.push(`- Task List: ${tasks.length} tasks (${pending} pending, ${inProgress} in_progress, ${completed} completed)`)
      
      // Add guidance based on task status
      if (inProgress > 0 || pending > 0) {
        contextParts.push('  Reminder: Continue with existing tasks, use TaskUpdate to update status')
      }
    }
  } else {
    // Standalone mode: get session tasks
    const tasks = useTaskStore.getState().getTasksBySession(sessionId)
    
    if (tasks.length > 0) {
      hasExistingTasks = true
      const pending = tasks.filter(t => t.status === 'pending').length
      const inProgress = tasks.filter(t => t.status === 'in_progress').length
      const completed = tasks.filter(t => t.status === 'completed').length
      
      contextParts.push(`- Task List: ${tasks.length} tasks (${pending} pending, ${inProgress} in_progress, ${completed} completed)`)
      
      // Add guidance based on task status
      if (inProgress > 0 || pending > 0) {
        contextParts.push('  Reminder: Continue with existing tasks, use TaskUpdate to update status')
      }
    }
  }

  // ── Plan Status ──
  const plan = usePlanStore.getState().getPlanBySession(sessionId)
  if (plan) {
    contextParts.push(`- Plan: "${plan.title}" (status: ${plan.status})`)

    if (plan.status === 'approved' || plan.status === 'implementing') {
      contextParts.push(`  Reminder: An approved plan exists. Follow the plan steps for implementation. Plan file: ${plan.filePath ?? '.plan/' + plan.id + '.md'}`)
    }

    if (plan.filePath) {
      contextParts.push(`  Plan file: ${plan.filePath}`)
    }
  }

  // ── Selected Files ──
  const selectedFiles = useUIStore.getState().selectedFiles ?? []
  const session = useChatStore.getState().sessions.find(s => s.id === sessionId)
  const workingFolder = session?.workingFolder

  if (selectedFiles.length > 0) {
    contextParts.push(`- Selected Files: ${selectedFiles.length} file${selectedFiles.length > 1 ? 's' : ''}`)

    // Convert to relative paths if possible
    for (const filePath of selectedFiles) {
      let displayPath = filePath
      if (workingFolder && filePath.startsWith(workingFolder)) {
        displayPath = filePath.slice(workingFolder.length).replace(/^[\\\/]/, '')
      }
      contextParts.push(`  - ${displayPath}`)
    }
  }

  // ── Web Search Guidance ──
  const webSearchEnabled = useSettingsStore.getState().webSearchEnabled
  if (webSearchEnabled) {
    contextParts.push('  Guidance: Web search is enabled. Actively use the WebSearch tool to gather the latest information, documentation, code examples, and data relevant to the task. Search for current information, best practices, API documentation, and any external resources that can help complete the task more accurately and comprehensively.')
  }

  // ── Build final context ──
  const contextContent = contextParts.join('\n')

  // Add task creation reminder only if no existing tasks
  let footer = ''
  if (!hasExistingTasks) {
    footer = 'Note: If the user request is complex (3+ steps or multiple files), create tasks using TaskCreate first.'
  }

  // Only generate system-reminder if there's actual content
  if (!contextContent && !footer) {
    return ''
  }

  const parts: string[] = []
  if (contextContent) {
    parts.push('Current Context:')
    parts.push(contextContent)
  }
  if (footer) {
    parts.push(footer)
  }

  return `<system-reminder>\n${parts.join('\n')}\n</system-reminder>`
}
