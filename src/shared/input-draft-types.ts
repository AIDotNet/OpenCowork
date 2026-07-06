export const INPUT_DRAFT_SCHEMA_VERSION = 2

export type InputDraftScope = 'session' | 'home' | 'project' | 'subagent' | 'custom'

export interface InputDraftImageAttachment {
  id: string
  dataUrl: string
  mediaType: string
}

export interface InputDraftSelectedFileItem {
  id: string
  name: string
  originalPath: string
  sendPath: string
  previewPath: string
  isWorkspaceFile: boolean
}

export interface InputDraftValue {
  text: string
  images: InputDraftImageAttachment[]
  skill: string | null
  selectedFiles: InputDraftSelectedFileItem[]
}

export interface InputDraftContext {
  scope: InputDraftScope
  sessionId?: string | null
  projectId?: string | null
  mode?: string | null
  workingFolder?: string | null
}

export interface InputDraftRecord extends InputDraftValue {
  version: typeof INPUT_DRAFT_SCHEMA_VERSION
  draftKey: string
  context: InputDraftContext
  createdAt: number
  updatedAt: number
  contentHash: string
  sizeBytes: number
}

export interface InputDraftIndexEntry {
  draftKey: string
  fileName: string
  scope: InputDraftScope
  sessionId?: string | null
  projectId?: string | null
  mode?: string | null
  workingFolder?: string | null
  createdAt: number
  updatedAt: number
  sizeBytes: number
}

export interface InputDraftGetArgs {
  draftKey: string
}

export interface InputDraftSetArgs {
  draftKey: string
  draft: InputDraftValue
  context: InputDraftContext
}

export interface InputDraftRemoveArgs {
  draftKey: string
}

export interface InputDraftCleanupArgs {
  maxDrafts?: number
  ttlMs?: number
}

export interface InputDraftMutationResult {
  success: boolean
  error?: string
}

export interface InputDraftCleanupResult extends InputDraftMutationResult {
  removed: number
}
