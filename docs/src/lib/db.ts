import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';

const DATA_DIR = join(process.cwd(), '.data');
const DB_PATH = join(DATA_DIR, 'skills.db');

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  // Ensure directory exists
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS skills_downloads (
      id TEXT PRIMARY KEY,
      skill_id TEXT NOT NULL UNIQUE,
      skill_name TEXT NOT NULL,
      category TEXT NOT NULL,
      download_count INTEGER DEFAULT 0,
      last_downloaded_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_skills_downloads_category
      ON skills_downloads(category);
    CREATE INDEX IF NOT EXISTS idx_skills_downloads_count
      ON skills_downloads(download_count DESC);
  `);

  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export interface SkillDownloadRecord {
  skillId: string;
  skillName: string;
  category: string;
  downloadCount: number;
  lastDownloadedAt: number | null;
}

export function recordSkillDownload(
  skillId: string,
  skillName: string,
  category: string
): void {
  const database = getDb();
  const now = Date.now();
  const id = `${skillId}-${Date.now()}`;

  // Check if skill already exists
  const existing = database
    .prepare('SELECT id FROM skills_downloads WHERE skill_id = ?')
    .get(skillId) as { id: string } | undefined;

  if (existing) {
    // Update existing record
    database
      .prepare(
        'UPDATE skills_downloads SET download_count = download_count + 1, last_downloaded_at = ?, updated_at = ? WHERE skill_id = ?'
      )
      .run(now, now, skillId);
  } else {
    // Insert new record
    database
      .prepare(
        'INSERT INTO skills_downloads (id, skill_id, skill_name, category, download_count, last_downloaded_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(id, skillId, skillName, category, 1, now, now, now);
  }
}

export function getSkillsDownloads(): SkillDownloadRecord[] {
  const database = getDb();
  const rows = database
    .prepare(
      'SELECT skill_id, skill_name, category, download_count, last_downloaded_at FROM skills_downloads ORDER BY download_count DESC, updated_at DESC'
    )
    .all() as Array<{
    skill_id: string;
    skill_name: string;
    category: string;
    download_count: number;
    last_downloaded_at: number | null;
  }>;

  return rows.map((row) => ({
    skillId: row.skill_id,
    skillName: row.skill_name,
    category: row.category,
    downloadCount: row.download_count,
    lastDownloadedAt: row.last_downloaded_at,
  }));
}

export function getCategoryStats(): Array<{
  category: string;
  totalDownloads: number;
  skillCount: number;
}> {
  const database = getDb();
  const rows = database
    .prepare(
      'SELECT category, SUM(download_count) as total_downloads, COUNT(*) as skill_count FROM skills_downloads GROUP BY category ORDER BY total_downloads DESC'
    )
    .all() as Array<{
    category: string;
    total_downloads: number;
    skill_count: number;
  }>;

  return rows.map((row) => ({
    category: row.category,
    totalDownloads: row.total_downloads,
    skillCount: row.skill_count,
  }));
}
