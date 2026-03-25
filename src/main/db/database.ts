import Database from 'better-sqlite3'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import { nanoid } from 'nanoid'

const DATA_DIR = path.join(os.homedir(), '.open-cowork')
const DB_PATH = path.join(DATA_DIR, 'data.db')

let db: Database.Database | null = null

function hasColumn(database: Database.Database, tableName: string, columnName: string): boolean {
  try {
    const safeTable = tableName.replace(/"/g, '""')
    const rows = database.prepare(`PRAGMA table_info("${safeTable}")`).all() as Array<{
      name: string
    }>
    return rows.some((row) => row.name === columnName)
  } catch {
    return false
  }
}

function ensureColumn(
  database: Database.Database,
  tableName: string,
  columnName: string,
  definition: string
): void {
  if (hasColumn(database, tableName, columnName)) {
    return
  }

  const safeTable = tableName.replace(/"/g, '""')
  const safeColumn = columnName.replace(/"/g, '""')
  database.exec(`ALTER TABLE "${safeTable}" ADD COLUMN "${safeColumn}" ${definition}`)
}

function sanitizeProjectName(rawName: string): string {
  const cleaned = rawName
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || 'New Project'
}

function deriveProjectNameFromFolder(folderPath: string): string {
  const normalized = folderPath.trim().replace(/[\\/]+$/, '')
  const parts = normalized.split(/[\\/]/).filter(Boolean)
  const name = parts[parts.length - 1] || 'Project'
  return sanitizeProjectName(name)
}

function ensureUniqueLocalProjectDirectory(baseName: string): { name: string; folderPath: string } {
  const documentsDir = path.join(os.homedir(), 'Documents')
  if (!fs.existsSync(documentsDir)) {
    fs.mkdirSync(documentsDir, { recursive: true })
  }

  const safeBaseName = sanitizeProjectName(baseName)
  let candidateName = safeBaseName
  let suffix = 1
  let candidatePath = path.join(documentsDir, candidateName)

  while (fs.existsSync(candidatePath)) {
    candidateName = `${safeBaseName} (${suffix})`
    candidatePath = path.join(documentsDir, candidateName)
    suffix += 1
  }

  fs.mkdirSync(candidatePath, { recursive: true })
  return { name: candidateName, folderPath: candidatePath }
}

function projectDirectoryKey(workingFolder: string, sshConnectionId: string | null): string {
  const normalizedFolder = sshConnectionId
    ? workingFolder.trim()
    : path.normalize(workingFolder).trim().toLowerCase()
  return `${sshConnectionId ?? 'local'}::${normalizedFolder}`
}

interface ProjectRecord {
  id: string
  name: string
  working_folder: string | null
  ssh_connection_id: string | null
  plugin_id: string | null
  created_at: number
  updated_at: number
}

function ensureDefaultLocalProject(database: Database.Database): ProjectRecord {
  const existing = database
    .prepare(
      `SELECT id, name, working_folder, ssh_connection_id, plugin_id, created_at, updated_at
         FROM projects
        WHERE plugin_id IS NULL
        ORDER BY updated_at DESC
        LIMIT 1`
    )
    .get() as ProjectRecord | undefined

  if (existing) {
    return existing
  }

  const now = Date.now()
  const { name, folderPath } = ensureUniqueLocalProjectDirectory('New Project')
  const project: ProjectRecord = {
    id: nanoid(),
    name,
    working_folder: folderPath,
    ssh_connection_id: null,
    plugin_id: null,
    created_at: now,
    updated_at: now
  }

  database
    .prepare(
      `INSERT INTO projects (id, name, working_folder, ssh_connection_id, plugin_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      project.id,
      project.name,
      project.working_folder,
      project.ssh_connection_id,
      project.plugin_id,
      project.created_at,
      project.updated_at
    )

  return project
}

function migrateSessionsToProjects(database: Database.Database): void {
  if (!hasColumn(database, 'sessions', 'project_id')) return

  const sessionsWithoutProject = database
    .prepare(
      `SELECT id, working_folder, ssh_connection_id, plugin_id, created_at, updated_at
         FROM sessions
        WHERE project_id IS NULL`
    )
    .all() as Array<{
    id: string
    working_folder: string | null
    ssh_connection_id: string | null
    plugin_id: string | null
    created_at: number
    updated_at: number
  }>

  const defaultProject = ensureDefaultLocalProject(database)
  if (sessionsWithoutProject.length === 0) {
    return
  }

  const projects = database
    .prepare(
      `SELECT id, name, working_folder, ssh_connection_id, plugin_id, created_at, updated_at
         FROM projects`
    )
    .all() as ProjectRecord[]

  const projectByDirectory = new Map<string, string>()
  for (const project of projects) {
    if (!project.working_folder) continue
    const key = projectDirectoryKey(project.working_folder, project.ssh_connection_id ?? null)
    projectByDirectory.set(key, project.id)
  }

  const insertProjectStmt = database.prepare(
    `INSERT INTO projects (id, name, working_folder, ssh_connection_id, plugin_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
  const setSessionProjectStmt = database.prepare(`UPDATE sessions SET project_id = ? WHERE id = ?`)
  const setSessionDefaultProjectStmt = database.prepare(
    `UPDATE sessions
        SET project_id = ?,
            working_folder = COALESCE(working_folder, ?),
            ssh_connection_id = COALESCE(ssh_connection_id, ?)
      WHERE id = ?`
  )

  const tx = database.transaction(() => {
    for (const session of sessionsWithoutProject) {
      const workingFolder = session.working_folder?.trim() ?? ''
      if (!workingFolder) {
        setSessionDefaultProjectStmt.run(
          defaultProject.id,
          defaultProject.working_folder,
          defaultProject.ssh_connection_id,
          session.id
        )
        continue
      }

      const key = projectDirectoryKey(workingFolder, session.ssh_connection_id ?? null)
      let projectId = projectByDirectory.get(key)

      if (!projectId) {
        const createdAt = Number.isFinite(session.created_at) ? session.created_at : Date.now()
        const updatedAt = Number.isFinite(session.updated_at) ? session.updated_at : createdAt
        const newProject: ProjectRecord = {
          id: nanoid(),
          name: deriveProjectNameFromFolder(workingFolder),
          working_folder: workingFolder,
          ssh_connection_id: session.ssh_connection_id ?? null,
          plugin_id: session.plugin_id ?? null,
          created_at: createdAt,
          updated_at: updatedAt
        }

        insertProjectStmt.run(
          newProject.id,
          newProject.name,
          newProject.working_folder,
          newProject.ssh_connection_id,
          newProject.plugin_id,
          newProject.created_at,
          newProject.updated_at
        )
        projectId = newProject.id
        projectByDirectory.set(key, projectId)
      }

      setSessionProjectStmt.run(projectId, session.id)
    }
  })

  tx()
}

export function getDb(): Database.Database {
  if (db) return db

  // Ensure directory exists
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
  }

  db = new Database(DB_PATH)

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'chat',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      working_folder TEXT,
      pinned INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      usage TEXT,
      sort_order INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session
      ON messages(session_id, sort_order);
  `)

  // Migration: add icon column if missing
  try {
    db.exec(`ALTER TABLE sessions ADD COLUMN icon TEXT`)
  } catch {
    // Column already exists — ignore
  }

  // Migration: add plugin_id column for plugin-initiated sessions
  if (!hasColumn(db, 'sessions', 'plugin_id')) {
    try {
      db.exec(`ALTER TABLE sessions ADD COLUMN plugin_id TEXT`)
    } catch {
      // Column already exists — ignore
    }
  }

  // Ensure plugin_id index exists
  if (hasColumn(db, 'sessions', 'plugin_id')) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_plugin ON sessions(plugin_id)`)
  } else {
    console.warn('[DB] Skip idx_sessions_plugin: sessions.plugin_id is missing')
  }

  // Migration: add external_chat_id column for per-user/per-group plugin sessions
  if (!hasColumn(db, 'sessions', 'external_chat_id')) {
    try {
      db.exec(`ALTER TABLE sessions ADD COLUMN external_chat_id TEXT`)
    } catch {
      // Column already exists — ignore
    }
  }

  // Ensure external_chat_id index exists
  if (hasColumn(db, 'sessions', 'external_chat_id')) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_external_chat ON sessions(external_chat_id)`)
  } else {
    console.warn('[DB] Skip idx_sessions_external_chat: sessions.external_chat_id is missing')
  }

  // Migration: add plan_id column to sessions if missing
  try {
    db.exec(`ALTER TABLE sessions ADD COLUMN plan_id TEXT`)
  } catch {
    // Column already exists — ignore
  }

  // Migration: add provider_id and model_id columns for per-session provider binding
  try {
    db.exec(`ALTER TABLE sessions ADD COLUMN provider_id TEXT`)
  } catch {
    /* exists */
  }
  try {
    db.exec(`ALTER TABLE sessions ADD COLUMN model_id TEXT`)
  } catch {
    /* exists */
  }

  // Migration: add pinned column to sessions if missing
  if (!hasColumn(db, 'sessions', 'pinned')) {
    try {
      db.exec(`ALTER TABLE sessions ADD COLUMN pinned INTEGER DEFAULT 0`)
    } catch {
      /* exists */
    }
  }

  ensureColumn(db, 'sessions', 'message_count', 'INTEGER NOT NULL DEFAULT 0')
  db.exec(
    `UPDATE sessions
        SET message_count = (
          SELECT COUNT(*) FROM messages m WHERE m.session_id = sessions.id
        )`
  )

  // --- Plans table ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'drafting',
      file_path TEXT,
      content TEXT,
      spec_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_plans_session ON plans(session_id);
  `)

  // --- Tasks table (session-bound, persistent) ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      plan_id TEXT,
      subject TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      active_form TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      owner TEXT,
      blocks TEXT DEFAULT '[]',
      blocked_by TEXT DEFAULT '[]',
      metadata TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_plan ON tasks(plan_id);
  `)

  // --- Draw Runs table ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS draw_runs (
      id TEXT PRIMARY KEY,
      prompt TEXT NOT NULL,
      provider_name TEXT NOT NULL,
      model_name TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'image',
      meta_json TEXT,
      created_at INTEGER NOT NULL,
      is_generating INTEGER NOT NULL DEFAULT 0,
      images_json TEXT NOT NULL DEFAULT '[]',
      error_json TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_draw_runs_created_at ON draw_runs(created_at DESC);
  `)

  ensureColumn(db, 'draw_runs', 'mode', "TEXT NOT NULL DEFAULT 'image'")
  ensureColumn(db, 'draw_runs', 'meta_json', 'TEXT')

  // --- QQ wakeup windows table ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS qq_wakeup_windows (
      plugin_id TEXT NOT NULL,
      open_id TEXT NOT NULL,
      period_key TEXT NOT NULL,
      source_message_id TEXT,
      source_timestamp INTEGER NOT NULL,
      sent_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (plugin_id, open_id, period_key)
    );

    CREATE INDEX IF NOT EXISTS idx_qq_wakeup_windows_open_id
      ON qq_wakeup_windows(plugin_id, open_id, sent_at DESC);
  `)

  // --- Cron Jobs table ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS cron_jobs (
      id                   TEXT PRIMARY KEY,
      name                 TEXT NOT NULL,

      schedule_kind        TEXT NOT NULL,
      schedule_at          INTEGER,
      schedule_every       INTEGER,
      schedule_expr        TEXT,
      schedule_tz          TEXT DEFAULT 'UTC',

      prompt               TEXT NOT NULL,
      agent_id             TEXT,
      model                TEXT,
      working_folder       TEXT,
      session_id           TEXT,
      source_session_title TEXT,
      source_project_id    TEXT,
      source_project_name  TEXT,
      source_provider_id   TEXT,

      delivery_mode        TEXT DEFAULT 'desktop',
      delivery_target      TEXT,

      enabled              INTEGER DEFAULT 1,
      delete_after_run     INTEGER DEFAULT 0,
      max_iterations       INTEGER DEFAULT 15,
      deleted_at           INTEGER,

      last_fired_at        INTEGER,
      fire_count           INTEGER DEFAULT 0,
      created_at           INTEGER NOT NULL,
      updated_at           INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS cron_runs (
      id                          TEXT PRIMARY KEY,
      job_id                      TEXT NOT NULL,
      started_at                  INTEGER NOT NULL,
      finished_at                 INTEGER,
      status                      TEXT DEFAULT 'running',
      tool_call_count             INTEGER DEFAULT 0,
      output_summary              TEXT,
      error                       TEXT,
      scheduled_for               INTEGER,
      job_name_snapshot           TEXT,
      prompt_snapshot             TEXT,
      source_session_id_snapshot  TEXT,
      source_session_title_snapshot TEXT,
      source_project_id_snapshot  TEXT,
      source_project_name_snapshot TEXT,
      source_provider_id_snapshot TEXT,
      model_snapshot              TEXT,
      working_folder_snapshot     TEXT,
      delivery_mode_snapshot      TEXT,
      delivery_target_snapshot    TEXT,
      FOREIGN KEY (job_id) REFERENCES cron_jobs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS cron_run_messages (
      id            TEXT PRIMARY KEY,
      run_id        TEXT NOT NULL,
      role          TEXT NOT NULL,
      content       TEXT NOT NULL,
      usage         TEXT,
      message_source TEXT,
      sort_order    INTEGER NOT NULL,
      created_at    INTEGER NOT NULL,
      FOREIGN KEY (run_id) REFERENCES cron_runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS cron_run_logs (
      id          TEXT PRIMARY KEY,
      run_id      TEXT NOT NULL,
      timestamp   INTEGER NOT NULL,
      type        TEXT NOT NULL,
      content     TEXT NOT NULL,
      sort_order  INTEGER NOT NULL,
      FOREIGN KEY (run_id) REFERENCES cron_runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_cron_runs_job ON cron_runs(job_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_cron_runs_started_at ON cron_runs(started_at);
    CREATE INDEX IF NOT EXISTS idx_cron_run_messages_run ON cron_run_messages(run_id, sort_order);
    CREATE INDEX IF NOT EXISTS idx_cron_run_logs_run ON cron_run_logs(run_id, sort_order);
  `)

  // --- SSH Groups table ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS ssh_groups (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)

  // --- SSH Connections table ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS ssh_connections (
      id                   TEXT PRIMARY KEY,
      group_id             TEXT,
      name                 TEXT NOT NULL,
      host                 TEXT NOT NULL,
      port                 INTEGER NOT NULL DEFAULT 22,
      username             TEXT NOT NULL,
      auth_type            TEXT NOT NULL DEFAULT 'password',
      encrypted_password   TEXT,
      private_key_path     TEXT,
      encrypted_passphrase TEXT,
      startup_command      TEXT,
      default_directory    TEXT,
      proxy_jump           TEXT,
      keep_alive_interval  INTEGER DEFAULT 60,
      sort_order           INTEGER NOT NULL DEFAULT 0,
      last_connected_at    INTEGER,
      created_at           INTEGER NOT NULL,
      updated_at           INTEGER NOT NULL,
      FOREIGN KEY (group_id) REFERENCES ssh_groups(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_ssh_connections_group ON ssh_connections(group_id);
  `)

  // --- Projects table ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      working_folder TEXT,
      ssh_connection_id TEXT,
      plugin_id TEXT,
      pinned INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_projects_updated_at ON projects(updated_at);
    CREATE INDEX IF NOT EXISTS idx_projects_plugin_id ON projects(plugin_id);
  `)

  // Migration: add pinned column to projects if missing (before creating index on it)
  if (!hasColumn(db, 'projects', 'pinned')) {
    try {
      db.exec(`ALTER TABLE projects ADD COLUMN pinned INTEGER DEFAULT 0`)
    } catch {
      /* exists */
    }
  }
  if (hasColumn(db, 'projects', 'pinned')) {
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_projects_pinned_updated_at ON projects(pinned, updated_at DESC)`
    )
  }

  // Migration: add ssh_connection_id to sessions for remote working directory
  if (!hasColumn(db, 'sessions', 'ssh_connection_id')) {
    try {
      db.exec(`ALTER TABLE sessions ADD COLUMN ssh_connection_id TEXT`)
    } catch {
      /* exists */
    }
  }

  // Migration: add project_id to sessions
  if (!hasColumn(db, 'sessions', 'project_id')) {
    try {
      db.exec(`ALTER TABLE sessions ADD COLUMN project_id TEXT`)
    } catch {
      /* exists */
    }
  }
  if (hasColumn(db, 'sessions', 'project_id')) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_project_id ON sessions(project_id)`)
  } else {
    console.warn('[DB] Skip idx_sessions_project_id: sessions.project_id is missing')
  }

  // Backfill projects and project_id for legacy sessions
  migrateSessionsToProjects(db)

  // Migration: add plugin/source/delete columns to cron_jobs if missing
  try {
    db.exec(`ALTER TABLE cron_jobs ADD COLUMN plugin_id TEXT`)
  } catch {
    /* exists */
  }
  try {
    db.exec(`ALTER TABLE cron_jobs ADD COLUMN plugin_chat_id TEXT`)
  } catch {
    /* exists */
  }
  const cronJobColumns = [
    'session_id',
    'source_session_title',
    'source_project_id',
    'source_project_name',
    'source_provider_id',
    'deleted_at'
  ] as const
  for (const column of cronJobColumns) {
    if (!hasColumn(db, 'cron_jobs', column)) {
      try {
        db.exec(
          `ALTER TABLE cron_jobs ADD COLUMN ${column} ${column === 'deleted_at' ? 'INTEGER' : 'TEXT'}`
        )
      } catch {
        /* ignore */
      }
    }
  }
  if (hasColumn(db, 'cron_jobs', 'session_id')) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_cron_jobs_session ON cron_jobs(session_id)`)
  } else {
    console.warn('[DB] Skip idx_cron_jobs_session: cron_jobs.session_id is missing')
  }
  if (hasColumn(db, 'cron_jobs', 'deleted_at')) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_cron_jobs_deleted_at ON cron_jobs(deleted_at)`)
  }

  // Migration: add snapshot columns to cron_runs if missing
  const cronRunColumns: Array<{ name: string; type: string }> = [
    { name: 'scheduled_for', type: 'INTEGER' },
    { name: 'job_name_snapshot', type: 'TEXT' },
    { name: 'prompt_snapshot', type: 'TEXT' },
    { name: 'source_session_id_snapshot', type: 'TEXT' },
    { name: 'source_session_title_snapshot', type: 'TEXT' },
    { name: 'source_project_id_snapshot', type: 'TEXT' },
    { name: 'source_project_name_snapshot', type: 'TEXT' },
    { name: 'source_provider_id_snapshot', type: 'TEXT' },
    { name: 'model_snapshot', type: 'TEXT' },
    { name: 'working_folder_snapshot', type: 'TEXT' },
    { name: 'delivery_mode_snapshot', type: 'TEXT' },
    { name: 'delivery_target_snapshot', type: 'TEXT' }
  ]
  for (const column of cronRunColumns) {
    if (!hasColumn(db, 'cron_runs', column.name)) {
      try {
        db.exec(`ALTER TABLE cron_runs ADD COLUMN ${column.name} ${column.type}`)
      } catch {
        /* ignore */
      }
    }
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cron_runs_started_at ON cron_runs(started_at)`)

  // Migration: ensure transcript/log tables exist for cron runs
  db.exec(`
    CREATE TABLE IF NOT EXISTS cron_run_messages (
      id             TEXT PRIMARY KEY,
      run_id         TEXT NOT NULL,
      role           TEXT NOT NULL,
      content        TEXT NOT NULL,
      usage          TEXT,
      message_source TEXT,
      sort_order     INTEGER NOT NULL,
      created_at     INTEGER NOT NULL,
      FOREIGN KEY (run_id) REFERENCES cron_runs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_cron_run_messages_run ON cron_run_messages(run_id, sort_order);

    CREATE TABLE IF NOT EXISTS cron_run_logs (
      id         TEXT PRIMARY KEY,
      run_id     TEXT NOT NULL,
      timestamp  INTEGER NOT NULL,
      type       TEXT NOT NULL,
      content    TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      FOREIGN KEY (run_id) REFERENCES cron_runs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_cron_run_logs_run ON cron_run_logs(run_id, sort_order);
  `)

  return db
}

export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}

export function getDataDir(): string {
  return DATA_DIR
}
