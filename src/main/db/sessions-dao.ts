import { getDb } from './database'

export interface SessionRow {
  id: string
  title: string
  icon: string | null
  mode: string
  created_at: number
  updated_at: number
  working_folder: string | null
  ssh_connection_id: string | null
  pinned: number
  plugin_id: string | null
  provider_id: string | null
  model_id: string | null
  message_count?: number
}

export function listSessions(): SessionRow[] {
  const db = getDb()
  return db
    .prepare(
      `SELECT s.*,
              (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count
         FROM sessions s
        ORDER BY s.updated_at DESC`
    )
    .all() as SessionRow[]
}

export function getSession(id: string): SessionRow | undefined {
  const db = getDb()
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined
}

export function createSession(session: {
  id: string
  title: string
  icon?: string
  mode: string
  createdAt: number
  updatedAt: number
  workingFolder?: string
  sshConnectionId?: string
  pinned?: boolean
  pluginId?: string
  providerId?: string
  modelId?: string
}): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO sessions (id, title, icon, mode, created_at, updated_at, working_folder, ssh_connection_id, pinned, plugin_id, provider_id, model_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    session.id,
    session.title,
    session.icon ?? null,
    session.mode,
    session.createdAt,
    session.updatedAt,
    session.workingFolder ?? null,
    session.sshConnectionId ?? null,
    session.pinned ? 1 : 0,
    session.pluginId ?? null,
    session.providerId ?? null,
    session.modelId ?? null
  )
}

export function updateSession(
  id: string,
  patch: Partial<{
    title: string
    icon: string | null
    mode: string
    updatedAt: number
    workingFolder: string | null
    sshConnectionId: string | null
    pinned: boolean
    pluginId: string | null
    providerId: string | null
    modelId: string | null
  }>
): void {
  const db = getDb()
  const sets: string[] = []
  const values: unknown[] = []

  if (patch.title !== undefined) {
    sets.push('title = ?')
    values.push(patch.title)
  }
  if (patch.icon !== undefined) {
    sets.push('icon = ?')
    values.push(patch.icon)
  }
  if (patch.mode !== undefined) {
    sets.push('mode = ?')
    values.push(patch.mode)
  }
  if (patch.updatedAt !== undefined) {
    sets.push('updated_at = ?')
    values.push(patch.updatedAt)
  }
  if (patch.workingFolder !== undefined) {
    sets.push('working_folder = ?')
    values.push(patch.workingFolder)
  }
  if (patch.sshConnectionId !== undefined) {
    sets.push('ssh_connection_id = ?')
    values.push(patch.sshConnectionId)
  }
  if (patch.pinned !== undefined) {
    sets.push('pinned = ?')
    values.push(patch.pinned ? 1 : 0)
  }
  if (patch.pluginId !== undefined) {
    sets.push('plugin_id = ?')
    values.push(patch.pluginId)
  }
  if (patch.providerId !== undefined) {
    sets.push('provider_id = ?')
    values.push(patch.providerId)
  }
  if (patch.modelId !== undefined) {
    sets.push('model_id = ?')
    values.push(patch.modelId)
  }

  if (sets.length === 0) return

  values.push(id)
  db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...values)
}

export function deleteSession(id: string): void {
  const db = getDb()
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
}

export function clearAllSessions(): void {
  const db = getDb()
  // Only clear non-plugin sessions and their messages
  db.prepare(
    `DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE plugin_id IS NULL)`
  ).run()
  db.prepare('DELETE FROM sessions WHERE plugin_id IS NULL').run()
}
