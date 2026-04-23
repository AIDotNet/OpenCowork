import { getDb } from './database'

export interface MessageRow {
  id: string
  session_id: string
  role: string
  content: string
  meta: string | null
  created_at: number
  usage: string | null
  sort_order: number
}

export function getMessages(sessionId: string): MessageRow[] {
  const db = getDb()
  return db
    .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY sort_order ASC')
    .all(sessionId) as MessageRow[]
}

export function getMessagesPage(sessionId: string, limit: number, offset: number): MessageRow[] {
  const db = getDb()
  return db
    .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY sort_order ASC LIMIT ? OFFSET ?')
    .all(sessionId, limit, offset) as MessageRow[]
}

export function addMessage(msg: {
  id: string
  sessionId: string
  role: string
  content: string
  meta?: string | null
  createdAt: number
  usage?: string | null
  sortOrder: number
}): void {
  const db = getDb()
  const tx = db.transaction(() => {
    const existing = db.prepare('SELECT session_id FROM messages WHERE id = ?').get(msg.id) as
      | { session_id: string }
      | undefined

    db.prepare(
      `INSERT OR REPLACE INTO messages (id, session_id, role, content, meta, created_at, usage, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      msg.id,
      msg.sessionId,
      msg.role,
      msg.content,
      msg.meta ?? null,
      msg.createdAt,
      msg.usage ?? null,
      msg.sortOrder
    )

    if (!existing) {
      db.prepare(
        'UPDATE sessions SET message_count = COALESCE(message_count, 0) + 1 WHERE id = ?'
      ).run(msg.sessionId)
    }
  })
  tx()
}

export function addMessages(
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
): void {
  if (msgs.length === 0) return
  const db = getDb()
  const tx = db.transaction(() => {
    const select = db.prepare('SELECT session_id FROM messages WHERE id = ?')
    const insert = db.prepare(
      `INSERT OR REPLACE INTO messages (id, session_id, role, content, meta, created_at, usage, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const newCountBySession = new Map<string, number>()
    for (const msg of msgs) {
      const existing = select.get(msg.id) as { session_id: string } | undefined
      insert.run(
        msg.id,
        msg.sessionId,
        msg.role,
        msg.content,
        msg.meta ?? null,
        msg.createdAt,
        msg.usage ?? null,
        msg.sortOrder
      )
      if (!existing) {
        newCountBySession.set(msg.sessionId, (newCountBySession.get(msg.sessionId) ?? 0) + 1)
      }
    }
    for (const [sessionId, count] of newCountBySession) {
      db.prepare(
        'UPDATE sessions SET message_count = COALESCE(message_count, 0) + ? WHERE id = ?'
      ).run(count, sessionId)
    }
  })
  tx()
}

export function updateMessage(
  msgId: string,
  patch: Partial<{ content: string; meta: string | null; usage: string | null }>
): void {
  const db = getDb()
  const sets: string[] = []
  const values: unknown[] = []

  if (patch.content !== undefined) {
    sets.push('content = ?')
    values.push(patch.content)
  }
  if (patch.meta !== undefined) {
    sets.push('meta = ?')
    values.push(patch.meta)
  }
  if (patch.usage !== undefined) {
    sets.push('usage = ?')
    values.push(patch.usage)
  }

  if (sets.length === 0) return

  values.push(msgId)
  db.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id = ?`).run(...values)
}

export function clearMessages(sessionId: string): void {
  const db = getDb()
  db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId)
  db.prepare('UPDATE sessions SET message_count = 0 WHERE id = ?').run(sessionId)
}

export function replaceMessages(
  sessionId: string,
  messages: Array<{
    id: string
    role: string
    content: string
    meta?: string | null
    createdAt: number
    usage?: string | null
    sortOrder: number
  }>
): void {
  const db = getDb()
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId)
    const insert = db.prepare(
      `INSERT OR REPLACE INTO messages (id, session_id, role, content, meta, created_at, usage, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const msg of messages) {
      insert.run(
        msg.id,
        sessionId,
        msg.role,
        msg.content,
        msg.meta ?? null,
        msg.createdAt,
        msg.usage ?? null,
        msg.sortOrder
      )
    }
    db.prepare('UPDATE sessions SET message_count = ? WHERE id = ?').run(messages.length, sessionId)
  })
  tx()
}

export function truncateMessagesFrom(sessionId: string, fromSortOrder: number): void {
  const db = getDb()
  const removed = db
    .prepare('SELECT COUNT(*) as cnt FROM messages WHERE session_id = ? AND sort_order >= ?')
    .get(sessionId, fromSortOrder) as { cnt: number }

  db.prepare('DELETE FROM messages WHERE session_id = ? AND sort_order >= ?').run(
    sessionId,
    fromSortOrder
  )

  if (removed.cnt > 0) {
    db.prepare(
      'UPDATE sessions SET message_count = MAX(COALESCE(message_count, 0) - ?, 0) WHERE id = ?'
    ).run(removed.cnt, sessionId)
  }
}

export function deleteLastMessage(sessionId: string, role: string): MessageRow | null {
  const db = getDb()
  const last = db
    .prepare(
      'SELECT * FROM messages WHERE session_id = ? AND role = ? ORDER BY sort_order DESC LIMIT 1'
    )
    .get(sessionId, role) as MessageRow | undefined
  if (!last) return null
  db.prepare('DELETE FROM messages WHERE id = ?').run(last.id)
  db.prepare(
    'UPDATE sessions SET message_count = MAX(COALESCE(message_count, 0) - 1, 0) WHERE id = ?'
  ).run(sessionId)
  return last
}

export function getMessageCount(sessionId: string): number {
  const db = getDb()
  const row = db
    .prepare('SELECT message_count as cnt FROM sessions WHERE id = ?')
    .get(sessionId) as { cnt?: number } | undefined
  return row?.cnt ?? 0
}
