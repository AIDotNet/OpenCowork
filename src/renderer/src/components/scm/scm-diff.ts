import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { guessLanguage } from '@renderer/lib/monaco/languages'
import { useGitStore, type GitStatusFile } from '@renderer/stores/git-store'
import { useUIStore, type GitChangeSection } from '@renderer/stores/ui-store'
import {
  isLoadedChangeContent,
  loadAggregatedChangeContent
} from '@renderer/components/chat/change-summary-utils'
import type { AggregatedFileChange } from '@renderer/components/chat/file-change-utils'

async function readWorkingFile(filePath: string, sshConnectionId?: string | null): Promise<string> {
  try {
    const channel = sshConnectionId ? IPC.SSH_FS_READ_FILE : IPC.FS_READ_FILE
    const args = sshConnectionId
      ? { connectionId: sshConnectionId, path: filePath }
      : { path: filePath }
    const result = await ipcClient.invoke(channel, args)
    if (result && typeof result === 'object' && 'error' in result) return ''
    return String(result ?? '')
  } catch {
    return ''
  }
}

export interface OpenGitDiffParams {
  repoPath: string
  file: GitStatusFile
  section: GitChangeSection
  sshConnectionId?: string | null
  sessionId?: string | null
}

/**
 * Resolve the original/modified content for a git change and open it in the
 * central Monaco diff editor. Original/modified sourcing follows VSCode
 * semantics (see the plan's matrix):
 *  - unstaged: index → working file (editable)
 *  - staged:   HEAD  → index (read-only)
 *  - untracked: empty → working file (editable)
 *  - conflicted: HEAD → working file (editable)
 */
export async function openGitDiff(params: OpenGitDiffParams): Promise<void> {
  const { repoPath, file, section, sshConnectionId, sessionId } = params
  const git = useGitStore.getState()
  const statusChar = section === 'staged' ? file.stagedStatus : file.unstagedStatus
  const isDelete = statusChar === 'D'
  const originalPath = file.originalPath ?? file.path

  let original = ''
  let modified = ''
  let modifiedEditable = false
  let originalRef = ''
  let isBinary = false

  if (section === 'staged') {
    originalRef = 'HEAD'
    const orig = await git.getFileContentAtRef(repoPath, originalPath, 'HEAD')
    original = orig.content
    if (!isDelete) {
      const mod = await git.getFileContentAtRef(repoPath, file.path, '')
      modified = mod.content
      isBinary = orig.isBinary || mod.isBinary
    } else {
      isBinary = orig.isBinary
    }
  } else if (section === 'untracked') {
    modifiedEditable = true
    modified = await readWorkingFile(file.path, sshConnectionId)
  } else {
    // unstaged or conflicted
    originalRef = section === 'conflicted' ? 'HEAD' : ''
    const orig = await git.getFileContentAtRef(repoPath, originalPath, originalRef)
    original = orig.content
    isBinary = orig.isBinary
    if (!isDelete) {
      modifiedEditable = true
      modified = await readWorkingFile(file.path, sshConnectionId)
    }
  }

  useUIStore.getState().openDiff({
    filePath: file.path,
    diffSource: 'git',
    original,
    modified,
    modifiedEditable,
    isBinary,
    language: guessLanguage(file.path),
    sshConnectionId: sshConnectionId ?? undefined,
    sessionId,
    diffOriginalRef: originalRef,
    gitRepoPath: repoPath,
    gitSection: section
  })
}

/** Open an agent-run file change as a read-only diff in the central editor. */
export async function openAgentDiff(
  change: AggregatedFileChange,
  sessionId?: string | null
): Promise<void> {
  const content = await loadAggregatedChangeContent(change)
  if (!isLoadedChangeContent(content)) return
  useUIStore.getState().openDiff({
    filePath: change.filePath,
    diffSource: 'agent',
    original: content.beforeText,
    modified: content.afterText,
    modifiedEditable: false,
    language: guessLanguage(change.filePath),
    sshConnectionId: change.connectionId,
    sessionId,
    agentRunId: change.runId,
    agentChangeId: change.id
  })
}
