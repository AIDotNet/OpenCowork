import { nanoid } from 'nanoid'
import { getDb } from './database'

export interface WikiDocumentRow {
  id: string
  project_id: string
  name: string
  slug: string
  description: string
  status: string
  content_markdown: string
  generation_mode: string
  last_generated_commit_id: string | null
  parent_id: string | null
  sort_order: number
  level: number
  is_leaf: number
  source_files_json: string
  created_at: number
  updated_at: number
}

export interface WikiSectionRow {
  id: string
  document_id: string
  title: string
  anchor: string
  sort_order: number
  summary: string
  content_markdown: string
  created_at: number
  updated_at: number
}

export interface WikiSectionSourceRow {
  id: string
  section_id: string
  file_path: string
  symbol_hint: string | null
  reason: string
  created_at: number
  updated_at: number
}

export interface WikiProjectStateRow {
  project_id: string
  wiki_enabled: number
  wiki_search_enabled: number
  last_full_generated_commit_id: string | null
  last_incremental_generated_commit_id: string | null
  last_exported_at: number | null
  last_generation_status: string
  last_generation_error: string | null
  updated_at: number
}

export interface WikiGenerationRunRow {
  id: string
  project_id: string
  mode: string
  status: string
  base_commit_id: string | null
  head_commit_id: string | null
  changed_files_json: string
  affected_documents_json: string
  output_summary: string | null
  error: string | null
  created_at: number
  updated_at: number
}

export function listWikiDocuments(projectId: string): WikiDocumentRow[] {
  return getDb()
    .prepare(
      'SELECT * FROM wiki_documents WHERE project_id = ? ORDER BY level ASC, parent_id ASC, sort_order ASC, name ASC'
    )
    .all(projectId) as WikiDocumentRow[]
}

export function getWikiDocument(id: string): WikiDocumentRow | undefined {
  return getDb().prepare('SELECT * FROM wiki_documents WHERE id = ?').get(id) as
    | WikiDocumentRow
    | undefined
}

export function getWikiDocumentByName(
  projectId: string,
  name: string
): WikiDocumentRow | undefined {
  return getDb()
    .prepare('SELECT * FROM wiki_documents WHERE project_id = ? AND name = ?')
    .get(projectId, name) as WikiDocumentRow | undefined
}

export function listWikiLeafDocuments(projectId: string): WikiDocumentRow[] {
  return getDb()
    .prepare(
      'SELECT * FROM wiki_documents WHERE project_id = ? AND is_leaf = 1 ORDER BY level ASC, sort_order ASC, name ASC'
    )
    .all(projectId) as WikiDocumentRow[]
}

export function saveWikiDocument(input: {
  id?: string
  projectId: string
  name: string
  slug: string
  description?: string
  status?: string
  contentMarkdown?: string
  generationMode?: string
  lastGeneratedCommitId?: string | null
  parentId?: string | null
  sortOrder?: number
  level?: number
  isLeaf?: boolean
  sourceFiles?: string[]
  preserveCreatedAt?: boolean
}): WikiDocumentRow {
  const now = Date.now()
  const existing = input.id ? getWikiDocument(input.id) : undefined
  const row: WikiDocumentRow = {
    id: input.id ?? nanoid(),
    project_id: input.projectId,
    name: input.name,
    slug: input.slug,
    description: input.description ?? '',
    status: input.status ?? 'draft',
    content_markdown: input.contentMarkdown ?? '',
    generation_mode: input.generationMode ?? 'full',
    last_generated_commit_id: input.lastGeneratedCommitId ?? null,
    parent_id: input.parentId !== undefined ? input.parentId : (existing?.parent_id ?? null),
    sort_order: input.sortOrder ?? existing?.sort_order ?? 0,
    level: input.level ?? existing?.level ?? 0,
    is_leaf: input.isLeaf !== undefined ? (input.isLeaf ? 1 : 0) : (existing?.is_leaf ?? 1),
    source_files_json: JSON.stringify(
      input.sourceFiles ?? JSON.parse(existing?.source_files_json ?? '[]')
    ),
    created_at: existing ? existing.created_at : now,
    updated_at: now
  }
  getDb()
    .prepare(
      `INSERT INTO wiki_documents (id, project_id, name, slug, description, status, content_markdown, generation_mode, last_generated_commit_id, parent_id, sort_order, level, is_leaf, source_files_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         slug = excluded.slug,
         description = excluded.description,
         status = excluded.status,
         content_markdown = excluded.content_markdown,
         generation_mode = excluded.generation_mode,
         last_generated_commit_id = excluded.last_generated_commit_id,
         parent_id = excluded.parent_id,
         sort_order = excluded.sort_order,
         level = excluded.level,
         is_leaf = excluded.is_leaf,
         source_files_json = excluded.source_files_json,
         updated_at = excluded.updated_at`
    )
    .run(
      row.id,
      row.project_id,
      row.name,
      row.slug,
      row.description,
      row.status,
      row.content_markdown,
      row.generation_mode,
      row.last_generated_commit_id,
      row.parent_id,
      row.sort_order,
      row.level,
      row.is_leaf,
      row.source_files_json,
      row.created_at,
      row.updated_at
    )
  return getWikiDocument(row.id) ?? row
}

export function listWikiSections(documentId: string): WikiSectionRow[] {
  return getDb()
    .prepare(
      'SELECT * FROM wiki_sections WHERE document_id = ? ORDER BY sort_order ASC, created_at ASC'
    )
    .all(documentId) as WikiSectionRow[]
}

export function replaceWikiSections(
  documentId: string,
  sections: Array<{
    id?: string
    title: string
    anchor: string
    sortOrder: number
    summary?: string
    contentMarkdown?: string
  }>
): WikiSectionRow[] {
  const db = getDb()
  const now = Date.now()
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM wiki_sections WHERE document_id = ?').run(documentId)
    const stmt = db.prepare(
      `INSERT INTO wiki_sections (id, document_id, title, anchor, sort_order, summary, content_markdown, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const section of sections) {
      stmt.run(
        section.id ?? nanoid(),
        documentId,
        section.title,
        section.anchor,
        section.sortOrder,
        section.summary ?? '',
        section.contentMarkdown ?? '',
        now,
        now
      )
    }
  })
  tx()
  return listWikiSections(documentId)
}

export function listWikiSectionSources(sectionId: string): WikiSectionSourceRow[] {
  return getDb()
    .prepare('SELECT * FROM wiki_section_sources WHERE section_id = ? ORDER BY file_path ASC')
    .all(sectionId) as WikiSectionSourceRow[]
}

export function replaceWikiSectionSources(
  sectionId: string,
  sources: Array<{
    id?: string
    filePath: string
    symbolHint?: string | null
    reason?: string
  }>
): WikiSectionSourceRow[] {
  const db = getDb()
  const now = Date.now()
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM wiki_section_sources WHERE section_id = ?').run(sectionId)
    const stmt = db.prepare(
      `INSERT INTO wiki_section_sources (id, section_id, file_path, symbol_hint, reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    for (const source of sources) {
      stmt.run(
        source.id ?? nanoid(),
        sectionId,
        source.filePath,
        source.symbolHint ?? null,
        source.reason ?? '',
        now,
        now
      )
    }
  })
  tx()
  return listWikiSectionSources(sectionId)
}

export function getWikiProjectState(projectId: string): WikiProjectStateRow | undefined {
  return getDb().prepare('SELECT * FROM wiki_project_state WHERE project_id = ?').get(projectId) as
    | WikiProjectStateRow
    | undefined
}

export function saveWikiProjectState(
  projectId: string,
  patch: Partial<{
    wikiEnabled: boolean
    wikiSearchEnabled: boolean
    lastFullGeneratedCommitId: string | null
    lastIncrementalGeneratedCommitId: string | null
    lastExportedAt: number | null
    lastGenerationStatus: string
    lastGenerationError: string | null
  }>
): WikiProjectStateRow {
  const existing = getWikiProjectState(projectId)
  const now = Date.now()
  const row: WikiProjectStateRow = {
    project_id: projectId,
    wiki_enabled:
      patch.wikiEnabled !== undefined ? (patch.wikiEnabled ? 1 : 0) : (existing?.wiki_enabled ?? 0),
    wiki_search_enabled:
      patch.wikiSearchEnabled !== undefined
        ? patch.wikiSearchEnabled
          ? 1
          : 0
        : (existing?.wiki_search_enabled ?? 0),
    last_full_generated_commit_id:
      patch.lastFullGeneratedCommitId !== undefined
        ? patch.lastFullGeneratedCommitId
        : (existing?.last_full_generated_commit_id ?? null),
    last_incremental_generated_commit_id:
      patch.lastIncrementalGeneratedCommitId !== undefined
        ? patch.lastIncrementalGeneratedCommitId
        : (existing?.last_incremental_generated_commit_id ?? null),
    last_exported_at:
      patch.lastExportedAt !== undefined
        ? patch.lastExportedAt
        : (existing?.last_exported_at ?? null),
    last_generation_status:
      patch.lastGenerationStatus ?? existing?.last_generation_status ?? 'idle',
    last_generation_error:
      patch.lastGenerationError !== undefined
        ? patch.lastGenerationError
        : (existing?.last_generation_error ?? null),
    updated_at: now
  }
  getDb()
    .prepare(
      `INSERT INTO wiki_project_state (project_id, wiki_enabled, wiki_search_enabled, last_full_generated_commit_id, last_incremental_generated_commit_id, last_exported_at, last_generation_status, last_generation_error, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET
         wiki_enabled = excluded.wiki_enabled,
         wiki_search_enabled = excluded.wiki_search_enabled,
         last_full_generated_commit_id = excluded.last_full_generated_commit_id,
         last_incremental_generated_commit_id = excluded.last_incremental_generated_commit_id,
         last_exported_at = excluded.last_exported_at,
         last_generation_status = excluded.last_generation_status,
         last_generation_error = excluded.last_generation_error,
         updated_at = excluded.updated_at`
    )
    .run(
      row.project_id,
      row.wiki_enabled,
      row.wiki_search_enabled,
      row.last_full_generated_commit_id,
      row.last_incremental_generated_commit_id,
      row.last_exported_at,
      row.last_generation_status,
      row.last_generation_error,
      row.updated_at
    )
  return getWikiProjectState(projectId) as WikiProjectStateRow
}

export function listWikiGenerationRuns(projectId: string): WikiGenerationRunRow[] {
  return getDb()
    .prepare('SELECT * FROM wiki_generation_runs WHERE project_id = ? ORDER BY created_at DESC')
    .all(projectId) as WikiGenerationRunRow[]
}

export function createWikiGenerationRun(input: {
  id?: string
  projectId: string
  mode: string
  status?: string
  baseCommitId?: string | null
  headCommitId?: string | null
  changedFiles?: string[]
  affectedDocuments?: string[]
  outputSummary?: string | null
  error?: string | null
}): WikiGenerationRunRow {
  const now = Date.now()
  const row: WikiGenerationRunRow = {
    id: input.id ?? nanoid(),
    project_id: input.projectId,
    mode: input.mode,
    status: input.status ?? 'running',
    base_commit_id: input.baseCommitId ?? null,
    head_commit_id: input.headCommitId ?? null,
    changed_files_json: JSON.stringify(input.changedFiles ?? []),
    affected_documents_json: JSON.stringify(input.affectedDocuments ?? []),
    output_summary: input.outputSummary ?? null,
    error: input.error ?? null,
    created_at: now,
    updated_at: now
  }
  getDb()
    .prepare(
      `INSERT INTO wiki_generation_runs (id, project_id, mode, status, base_commit_id, head_commit_id, changed_files_json, affected_documents_json, output_summary, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.id,
      row.project_id,
      row.mode,
      row.status,
      row.base_commit_id,
      row.head_commit_id,
      row.changed_files_json,
      row.affected_documents_json,
      row.output_summary,
      row.error,
      row.created_at,
      row.updated_at
    )
  return row
}

export function updateWikiGenerationRun(
  id: string,
  patch: Partial<{
    status: string
    headCommitId: string | null
    changedFiles: string[]
    affectedDocuments: string[]
    outputSummary: string | null
    error: string | null
  }>
): void {
  const sets: string[] = []
  const values: unknown[] = []
  if (patch.status !== undefined) {
    sets.push('status = ?')
    values.push(patch.status)
  }
  if (patch.headCommitId !== undefined) {
    sets.push('head_commit_id = ?')
    values.push(patch.headCommitId)
  }
  if (patch.changedFiles !== undefined) {
    sets.push('changed_files_json = ?')
    values.push(JSON.stringify(patch.changedFiles))
  }
  if (patch.affectedDocuments !== undefined) {
    sets.push('affected_documents_json = ?')
    values.push(JSON.stringify(patch.affectedDocuments))
  }
  if (patch.outputSummary !== undefined) {
    sets.push('output_summary = ?')
    values.push(patch.outputSummary)
  }
  if (patch.error !== undefined) {
    sets.push('error = ?')
    values.push(patch.error)
  }
  sets.push('updated_at = ?')
  values.push(Date.now())
  values.push(id)
  getDb()
    .prepare(`UPDATE wiki_generation_runs SET ${sets.join(', ')} WHERE id = ?`)
    .run(...values)
}

export function clearWikiProject(projectId: string): void {
  const db = getDb()
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM wiki_generation_runs WHERE project_id = ?').run(projectId)
    db.prepare('DELETE FROM wiki_project_state WHERE project_id = ?').run(projectId)
    db.prepare('DELETE FROM wiki_documents WHERE project_id = ?').run(projectId)
  })
  tx()
}

export function findWikiDocumentIdsBySourceFiles(projectId: string, filePaths: string[]): string[] {
  if (filePaths.length === 0) return []
  const placeholders = filePaths.map(() => '?').join(', ')
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT d.id
         FROM wiki_documents d
         JOIN wiki_sections s ON s.document_id = d.id
         JOIN wiki_section_sources ss ON ss.section_id = s.id
        WHERE d.project_id = ? AND ss.file_path IN (${placeholders})`
    )
    .all(projectId, ...filePaths) as Array<{ id: string }>
  return rows.map((row) => row.id)
}
