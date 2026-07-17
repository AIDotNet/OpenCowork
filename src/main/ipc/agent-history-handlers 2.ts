import {
  applySubAgentHistory,
  getSubAgentHistoryIndex,
  listSubAgentHistory,
  replaceSubAgentHistory,
  type SubAgentHistoryApplyRequest
} from '../db/sub-agent-history-dao'
import { initializeDatabase } from '../db/database'
import { registerMessagePackHandler } from './messagepack-handler'

export function registerAgentHistoryHandlers(): void {
  registerMessagePackHandler<void>('agent-history:index', async () => {
    await initializeDatabase()
    return await getSubAgentHistoryIndex()
  })

  registerMessagePackHandler<{ sessionId?: string }>('agent-history:read', async (args) => {
    await initializeDatabase()
    const sessionId = args?.sessionId?.trim()
    if (!sessionId) throw new Error('Missing sessionId for sub-agent history read')
    return await listSubAgentHistory(sessionId)
  })

  registerMessagePackHandler<SubAgentHistoryApplyRequest>('agent-history:apply', async (args) => {
    await initializeDatabase()
    await applySubAgentHistory(args)
    return { success: true }
  })

  registerMessagePackHandler<{ snapshot: unknown }>('agent-history:replace', async (args) => {
    await initializeDatabase()
    await replaceSubAgentHistory(args.snapshot)
    return { success: true }
  })
}
