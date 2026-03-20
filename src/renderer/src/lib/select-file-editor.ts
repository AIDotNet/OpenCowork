import { nanoid } from 'nanoid'
import { createSelectFileTag, parseSelectFileText } from './select-file-tags'

export interface SelectedFileItem {
  id: string
  name: string
  originalPath: string
  sendPath: string
  previewPath: string
  isWorkspaceFile: boolean
}

export interface EditorTextNode {
  type: 'text'
  id: string
  text: string
}

export interface EditorFileNode {
  type: 'file'
  id: string
  fileId: string
  fallbackText: string
}

export type EditorDocumentNode = EditorTextNode | EditorFileNode

interface SerializeOptions {
  appendUnreferencedFiles?: boolean
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').trim()
}

function normalizePathKey(value: string): string {
  return normalizePath(value).toLowerCase()
}

function isAbsolutePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('/')
}

function getBaseName(value: string): string {
  const normalized = normalizePath(value)
  const segments = normalized.split('/')
  return segments[segments.length - 1] || normalized
}

function toPreviewPath(sendPath: string, workingFolder?: string): string {
  if (isAbsolutePath(sendPath) || !workingFolder) return sendPath
  const normalizedWorkingFolder = workingFolder.replace(/[\\/]+$/, '')
  return `${normalizedWorkingFolder}/${sendPath}`
}

function buildFileKey(file: Pick<SelectedFileItem, 'previewPath' | 'sendPath'>): string {
  return `${normalizePathKey(file.previewPath)}::${normalizePathKey(file.sendPath)}`
}

function compareFiles(left: SelectedFileItem, right: SelectedFileItem): number {
  const nameCompare = left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
  if (nameCompare !== 0) return nameCompare
  return left.sendPath.localeCompare(right.sendPath, undefined, { sensitivity: 'base' })
}

function createTextNode(text: string): EditorTextNode {
  return {
    type: 'text',
    id: nanoid(),
    text
  }
}

function createFileNode(fileId: string, fallbackText: string): EditorFileNode {
  return {
    type: 'file',
    id: nanoid(),
    fileId,
    fallbackText
  }
}

function mergeTextNodes(nodes: EditorDocumentNode[]): EditorDocumentNode[] {
  const merged: EditorDocumentNode[] = []

  for (const node of nodes) {
    if (node.type === 'text') {
      if (!node.text) continue
      const last = merged[merged.length - 1]
      if (last?.type === 'text') {
        last.text += node.text
      } else {
        merged.push({ ...node })
      }
      continue
    }

    merged.push({ ...node })
  }

  return merged
}

export function createSelectedFileItem(
  filePath: string,
  workingFolder?: string
): SelectedFileItem | null {
  const normalizedOriginalPath = normalizePath(filePath)
  if (!normalizedOriginalPath) return null

  const normalizedWorkingFolder = workingFolder
    ? normalizePath(workingFolder).replace(/\/+$/, '')
    : ''
  const workingFolderKey = normalizedWorkingFolder
    ? `${normalizePathKey(normalizedWorkingFolder)}/`
    : ''
  const originalPathKey = normalizePathKey(normalizedOriginalPath)
  const isWorkspaceFile = Boolean(workingFolderKey) && originalPathKey.startsWith(workingFolderKey)
  const sendPath = isWorkspaceFile
    ? normalizedOriginalPath.slice(normalizedWorkingFolder.length).replace(/^\/+/, '')
    : normalizedOriginalPath

  return {
    id: nanoid(),
    name: getBaseName(normalizedOriginalPath),
    originalPath: normalizedOriginalPath,
    sendPath,
    previewPath: normalizedOriginalPath,
    isWorkspaceFile
  }
}

export function createSelectedFileItemFromTagPath(
  tagPath: string,
  workingFolder?: string
): SelectedFileItem | null {
  const normalizedSendPath = normalizePath(tagPath)
  if (!normalizedSendPath) return null

  return {
    id: nanoid(),
    name: getBaseName(normalizedSendPath),
    originalPath: normalizedSendPath,
    sendPath: normalizedSendPath,
    previewPath: toPreviewPath(normalizedSendPath, workingFolder),
    isWorkspaceFile: !isAbsolutePath(normalizedSendPath) && Boolean(workingFolder)
  }
}

export function mergeSelectedFiles(
  currentFiles: SelectedFileItem[],
  nextFiles: SelectedFileItem[]
): SelectedFileItem[] {
  const merged = new Map<string, SelectedFileItem>()

  for (const file of currentFiles) {
    merged.set(buildFileKey(file), file)
  }

  for (const file of nextFiles) {
    const key = buildFileKey(file)
    const existing = merged.get(key)
    if (existing) {
      merged.set(key, {
        ...existing,
        ...file,
        id: existing.id
      })
      continue
    }
    merged.set(key, file)
  }

  return Array.from(merged.values()).sort(compareFiles)
}

export function getFilePlainText(node: EditorFileNode, files: SelectedFileItem[]): string {
  const file = files.find((item) => item.id === node.fileId)
  return file?.sendPath || node.fallbackText
}

export function getNodePlainText(node: EditorDocumentNode, files: SelectedFileItem[]): string {
  return node.type === 'text' ? node.text : getFilePlainText(node, files)
}

export function getNodePlainTextLength(
  node: EditorDocumentNode,
  files: SelectedFileItem[]
): number {
  return getNodePlainText(node, files).length
}

export function editorDocumentToPlainText(
  document: EditorDocumentNode[],
  files: SelectedFileItem[]
): string {
  return document.map((node) => getNodePlainText(node, files)).join('')
}

export function serializeEditorDocument(
  document: EditorDocumentNode[],
  files: SelectedFileItem[],
  options?: SerializeOptions
): string {
  const referencedFileIds = new Set<string>()
  const base = document
    .map((node) => {
      if (node.type === 'text') return node.text
      const file = files.find((item) => item.id === node.fileId)
      if (!file) return node.fallbackText
      referencedFileIds.add(file.id)
      return createSelectFileTag(file.sendPath)
    })
    .join('')

  if (!options?.appendUnreferencedFiles) return base

  const danglingTags = files
    .filter((file) => !referencedFileIds.has(file.id))
    .map((file) => createSelectFileTag(file.sendPath))
    .filter(Boolean)

  if (danglingTags.length === 0) return base
  if (!base.trim()) return danglingTags.join('\n')
  return `${base}${base.endsWith('\n') ? '' : '\n'}${danglingTags.join('\n')}`
}

export function deserializeEditorState(
  text: string,
  workingFolder?: string,
  baseFiles: SelectedFileItem[] = []
): {
  document: EditorDocumentNode[]
  selectedFiles: SelectedFileItem[]
} {
  const selectedFiles = mergeSelectedFiles([], baseFiles)
  const bySendPath = new Map(selectedFiles.map((file) => [normalizePathKey(file.sendPath), file]))
  const document: EditorDocumentNode[] = []

  for (const segment of parseSelectFileText(text)) {
    if (segment.type === 'text') {
      if (segment.text) document.push(createTextNode(segment.text))
      continue
    }

    const normalizedPath = normalizePath(segment.text)
    if (!normalizedPath) continue

    const existingFile = bySendPath.get(normalizePathKey(normalizedPath))
    const file = existingFile ?? createSelectedFileItemFromTagPath(normalizedPath, workingFolder)
    if (!file) continue

    if (!existingFile) {
      selectedFiles.push(file)
      bySendPath.set(normalizePathKey(file.sendPath), file)
    }

    document.push(createFileNode(file.id, file.sendPath))
  }

  return {
    document: mergeTextNodes(document),
    selectedFiles: selectedFiles.sort(compareFiles)
  }
}

export function addFilesToSelection(
  currentFiles: SelectedFileItem[],
  filePaths: string[],
  workingFolder?: string
): SelectedFileItem[] {
  const nextFiles = filePaths
    .map((filePath) => createSelectedFileItem(filePath, workingFolder))
    .filter((file): file is SelectedFileItem => Boolean(file))

  return mergeSelectedFiles(currentFiles, nextFiles)
}

export function ensureSelectedFile(
  currentFiles: SelectedFileItem[],
  filePath: string,
  workingFolder?: string
): { files: SelectedFileItem[]; file: SelectedFileItem | null } {
  const created = createSelectedFileItem(filePath, workingFolder)
  if (!created) return { files: currentFiles, file: null }

  const merged = mergeSelectedFiles(currentFiles, [created])
  const file =
    merged.find((item) => buildFileKey(item) === buildFileKey(created)) ||
    merged.find((item) => normalizePathKey(item.sendPath) === normalizePathKey(created.sendPath)) ||
    null

  return { files: merged, file }
}

export function removeSelectedFile(
  currentFiles: SelectedFileItem[],
  document: EditorDocumentNode[],
  fileId: string
): { files: SelectedFileItem[]; document: EditorDocumentNode[] } {
  const removedFile = currentFiles.find((file) => file.id === fileId)
  const files = currentFiles.filter((file) => file.id !== fileId)
  if (!removedFile) return { files, document }

  const nextDocument = mergeTextNodes(
    document.map((node) => {
      if (node.type === 'file' && node.fileId === fileId) {
        return createTextNode(removedFile.sendPath)
      }
      return node
    })
  )

  return { files, document: nextDocument }
}

export function removeReferenceNode(
  currentDocument: EditorDocumentNode[],
  nodeId: string,
  files: SelectedFileItem[]
): EditorDocumentNode[] {
  const nextNodes: EditorDocumentNode[] = []

  for (const node of currentDocument) {
    if (node.type === 'file' && node.id === nodeId) {
      continue
    }

    if (node.type === 'text') {
      nextNodes.push({ ...node })
      continue
    }

    nextNodes.push({ ...node, fallbackText: getFilePlainText(node, files) })
  }

  return mergeTextNodes(nextNodes)
}

export function normalizeSelectionToFileBoundaries(
  document: EditorDocumentNode[],
  files: SelectedFileItem[],
  start: number,
  end: number
): { start: number; end: number } {
  let cursor = 0
  let nextStart = start
  let nextEnd = end

  for (const node of document) {
    const length = getNodePlainTextLength(node, files)
    const nodeStart = cursor
    const nodeEnd = cursor + length
    cursor = nodeEnd

    if (node.type !== 'file' || length === 0) continue

    if (nextStart > nodeStart && nextStart < nodeEnd) {
      nextStart = nextStart - nodeStart <= nodeEnd - nextStart ? nodeStart : nodeEnd
    }

    if (nextEnd > nodeStart && nextEnd < nodeEnd) {
      nextEnd = nextEnd - nodeStart <= nodeEnd - nextEnd ? nodeStart : nodeEnd
    }

    if (nextStart < nodeEnd && nextEnd > nodeStart) {
      nextStart = Math.min(nextStart, nodeStart)
      nextEnd = Math.max(nextEnd, nodeEnd)
    }
  }

  return { start: nextStart, end: nextEnd }
}

export function replaceEditorRange(
  document: EditorDocumentNode[],
  files: SelectedFileItem[],
  start: number,
  end: number,
  replacement: EditorDocumentNode[]
): EditorDocumentNode[] {
  const normalized = normalizeSelectionToFileBoundaries(document, files, start, end)
  const nextDocument: EditorDocumentNode[] = []
  let cursor = 0
  let inserted = false

  for (const node of document) {
    const text = getNodePlainText(node, files)
    const length = text.length
    const nodeStart = cursor
    const nodeEnd = cursor + length
    cursor = nodeEnd

    if (nodeEnd <= normalized.start || nodeStart >= normalized.end) {
      if (!inserted && nodeStart >= normalized.end) {
        nextDocument.push(...replacement.map((item) => ({ ...item })))
        inserted = true
      }
      nextDocument.push({ ...node })
      continue
    }

    if (node.type === 'text') {
      const keepLeft = Math.max(0, normalized.start - nodeStart)
      const keepRight = Math.max(0, nodeEnd - normalized.end)
      const leftText = keepLeft > 0 ? node.text.slice(0, keepLeft) : ''
      const rightText = keepRight > 0 ? node.text.slice(node.text.length - keepRight) : ''
      if (leftText) nextDocument.push(createTextNode(leftText))
      if (!inserted) {
        nextDocument.push(...replacement.map((item) => ({ ...item })))
        inserted = true
      }
      if (rightText) nextDocument.push(createTextNode(rightText))
      continue
    }

    if (!inserted) {
      nextDocument.push(...replacement.map((item) => ({ ...item })))
      inserted = true
    }
  }

  if (!inserted) {
    nextDocument.push(...replacement.map((item) => ({ ...item })))
  }

  return mergeTextNodes(nextDocument)
}

export function createTextReplacementNode(text: string): EditorTextNode {
  return createTextNode(text)
}

export function createFileReferenceNode(fileId: string, fallbackText: string): EditorFileNode {
  return createFileNode(fileId, fallbackText)
}

export function documentHasFileReferences(
  document: EditorDocumentNode[],
  fileId?: string
): boolean {
  return document.some(
    (node) => node.type === 'file' && (typeof fileId === 'undefined' || node.fileId === fileId)
  )
}
