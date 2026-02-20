import Database from 'better-sqlite3'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'

const DATA_DIR = path.join(os.homedir(), '.open-cowork')
const DB_PATH = path.join(DATA_DIR, 'data.db')

let db: Database.Database | null = null

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
  try {
    db.exec(`ALTER TABLE sessions ADD COLUMN plugin_id TEXT`)
  } catch {
    // Column already exists — ignore
  }

  // Ensure plugin_id index exists
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_plugin ON sessions(plugin_id)`)

  // Migration: add external_chat_id column for per-user/per-group plugin sessions
  try {
    db.exec(`ALTER TABLE sessions ADD COLUMN external_chat_id TEXT`)
  } catch {
    // Column already exists — ignore
  }

  // Ensure external_chat_id index exists
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_external_chat ON sessions(external_chat_id)`)

  // Migration: add plan_id column to sessions if missing
  try {
    db.exec(`ALTER TABLE sessions ADD COLUMN plan_id TEXT`)
  } catch {
    // Column already exists — ignore
  }

  // Migration: add provider_id and model_id columns for per-session provider binding
  try { db.exec(`ALTER TABLE sessions ADD COLUMN provider_id TEXT`) } catch { /* exists */ }
  try { db.exec(`ALTER TABLE sessions ADD COLUMN model_id TEXT`) } catch { /* exists */ }

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

  // --- Cron Jobs table ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS cron_jobs (
      id               TEXT PRIMARY KEY,
      name             TEXT NOT NULL,

      schedule_kind    TEXT NOT NULL,
      schedule_at      INTEGER,
      schedule_every   INTEGER,
      schedule_expr    TEXT,
      schedule_tz      TEXT DEFAULT 'UTC',

      prompt           TEXT NOT NULL,
      agent_id         TEXT,
      model            TEXT,
      working_folder   TEXT,

      delivery_mode    TEXT DEFAULT 'desktop',
      delivery_target  TEXT,

      enabled          INTEGER DEFAULT 1,
      delete_after_run INTEGER DEFAULT 0,
      max_iterations   INTEGER DEFAULT 15,

      last_fired_at    INTEGER,
      fire_count       INTEGER DEFAULT 0,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cron_runs (
      id               TEXT PRIMARY KEY,
      job_id           TEXT NOT NULL,
      started_at       INTEGER NOT NULL,
      finished_at      INTEGER,
      status           TEXT DEFAULT 'running',
      tool_call_count  INTEGER DEFAULT 0,
      output_summary   TEXT,
      error            TEXT,
      FOREIGN KEY (job_id) REFERENCES cron_jobs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_cron_runs_job ON cron_runs(job_id, started_at);
  `)

  // Migration: add plugin columns to cron_jobs if missing
  try { db.exec(`ALTER TABLE cron_jobs ADD COLUMN plugin_id TEXT`) } catch { /* exists */ }
  try { db.exec(`ALTER TABLE cron_jobs ADD COLUMN plugin_chat_id TEXT`) } catch { /* exists */ }

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
