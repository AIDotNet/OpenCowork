import { create } from 'zustand'
import { toast } from 'sonner'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { useChatStore } from './chat-store'
import { useUIStore } from './ui-store'

export interface GitRepositoryItem {
  name: string
  fullPath: string
  relativePath: string
  branch: string
  isRootRepo: boolean
  sshConnectionId?: string
}

export interface GitStatusFile {
  path: string
  stagedStatus: string
  unstagedStatus: string
  originalPath?: string
}

export interface GitStatusDetailed {
  branch: string
  upstream?: string
  ahead: number
  behind: number
  staged: GitStatusFile[]
  unstaged: GitStatusFile[]
  untracked: GitStatusFile[]
  conflicted: GitStatusFile[]
}

export interface GitCommitHistoryItem {
  hash: string
  shortHash: string
  author: string
  email: string
  date: string
  subject: string
}

export interface GitBranchItem {
  name: string
  fullName: string
  type: 'local' | 'remote'
  isCurrent: boolean
}

interface GitRepositoryDetails {
  status: GitStatusDetailed | null
  history: GitCommitHistoryItem[]
  fileHistoryByPath: Record<string, GitCommitHistoryItem[]>
  branches: GitBranchItem[]
  currentBranch: string | null
  diffByKey: Record<string, string>
  /** 缓存 `commitHash:filePath` → 该提交中此文件的 patch */
  historyFileDiffByKey: Record<string, string>
  loading: boolean
  error: string | null
}

interface GitResultBase {
  success?: boolean
  error?: string
}

interface GitStore {
  repositories: GitRepositoryItem[]
  selectedRepoPath: string | null
  isScanning: boolean
  scanError: string | null
  repoDetailsByPath: Record<string, GitRepositoryDetails>
  activePollingTimer: number | null
  scanRepositories: () => Promise<void>
  selectRepository: (repoPath: string | null) => void
  refreshRepository: (repoPath: string) => Promise<void>
  loadMoreHistory: (repoPath: string) => Promise<void>
  loadFileHistory: (repoPath: string, filePath: string, append?: boolean) => Promise<void>
  loadFileDiff: (repoPath: string, filePath: string, staged?: boolean) => Promise<void>
  loadHistoryFileDiff: (
    repoPath: string,
    filePath: string,
    commitHash: string
  ) => Promise<{ success: boolean }>
  fetchRepository: (repoPath: string) => Promise<{ success: boolean; error?: string }>
  pullRebase: (repoPath: string) => Promise<{ success: boolean; error?: string }>
  pushRepository: (repoPath: string) => Promise<{ success: boolean; error?: string }>
  syncRepository: (repoPath: string) => Promise<{ success: boolean; error?: string }>
  createBranch: (
    repoPath: string,
    name: string,
    startPoint?: string
  ) => Promise<{ success: boolean; error?: string }>
  checkoutBranch: (repoPath: string, name: string) => Promise<{ success: boolean; error?: string }>
  mergeBranch: (repoPath: string, ref: string) => Promise<{ success: boolean; error?: string }>
  rebaseBranch: (repoPath: string, ref: string) => Promise<{ success: boolean; error?: string }>
  deleteLocalBranch: (
    repoPath: string,
    name: string,
    force?: boolean
  ) => Promise<{ success: boolean; error?: string }>
  deleteRemoteBranch: (
    repoPath: string,
    remote: string,
    branchName: string
  ) => Promise<{ success: boolean; error?: string }>
  renameBranch: (
    repoPath: string,
    newName: string,
    oldName?: string
  ) => Promise<{ success: boolean; error?: string }>
  stageFiles: (repoPath: string, paths: string[]) => Promise<{ success: boolean; error?: string }>
  unstageFiles: (repoPath: string, paths: string[]) => Promise<{ success: boolean; error?: string }>
  stageAll: (repoPath: string) => Promise<{ success: boolean; error?: string }>
  unstageAll: (repoPath: string) => Promise<{ success: boolean; error?: string }>
  discardFiles: (
    repoPath: string,
    paths: string[],
    scope: 'worktree' | 'full' | 'untracked'
  ) => Promise<{ success: boolean; error?: string }>
  commit: (repoPath: string, message: string) => Promise<{ success: boolean; error?: string }>
  getStagedDiffBundle: (
    repoPath: string
  ) => Promise<
    | { success: true; stat: string; patch: string; empty: boolean }
    | { success: false; error: string }
  >
  getFileContentAtRef: (
    repoPath: string,
    filePath: string,
    ref: string
  ) => Promise<{ content: string; exists: boolean; isBinary: boolean }>
  invalidateFileDiff: (repoPath: string, filePath: string) => void
  startPolling: () => void
  stopPolling: () => void
  reset: () => void
}

function getActiveProject(): ReturnType<typeof useChatStore.getState>['projects'][number] | null {
  const { activeProjectId, projects } = useChatStore.getState()
  return projects.find((project) => project.id === activeProjectId) ?? null
}

function getGitTarget(repoPath?: string): { cwd: string; sshConnectionId: string | null } {
  const project = getActiveProject()
  return {
    cwd: repoPath ?? project?.workingFolder ?? '',
    sshConnectionId: project?.sshConnectionId ?? null
  }
}

function getErrorMessage(result: unknown, fallback: string): string {
  if (!result || typeof result !== 'object') return fallback
  if ('error' in result && typeof (result as { error?: unknown }).error === 'string') {
    return (result as { error: string }).error
  }
  return fallback
}

async function invokeGit<T>(channel: string, payload: Record<string, unknown>): Promise<T> {
  return (await ipcClient.invoke(channel, payload)) as T
}

function createEmptyRepoDetails(): GitRepositoryDetails {
  return {
    status: null,
    history: [],
    fileHistoryByPath: {},
    branches: [],
    currentBranch: null,
    diffByKey: {},
    historyFileDiffByKey: {},
    loading: false,
    error: null
  }
}

function ensureRepoDetails(
  repoDetailsByPath: Record<string, GitRepositoryDetails>,
  repoPath: string
): GitRepositoryDetails {
  return repoDetailsByPath[repoPath] ?? createEmptyRepoDetails()
}

const pendingFileDiffRequests = new Map<string, Promise<void>>()

function fileDiffCacheKey(filePath: string, staged = false): string {
  return `${staged ? 'staged' : 'unstaged'}:${filePath}`
}

function fileDiffRequestKey(repoPath: string, filePath: string, staged = false): string {
  return `${repoPath}:${fileDiffCacheKey(filePath, staged)}`
}

export const useGitStore = create<GitStore>((set, get) => ({
  repositories: [],
  selectedRepoPath: null,
  isScanning: false,
  scanError: null,
  repoDetailsByPath: {},
  activePollingTimer: null,

  scanRepositories: async () => {
    const project = getActiveProject()
    if (!project?.workingFolder) {
      set({ repositories: [], selectedRepoPath: null, scanError: null, isScanning: false })
      return
    }

    set({ isScanning: true, scanError: null })
    const result = await invokeGit<GitResultBase & { repositories?: GitRepositoryItem[] }>(
      IPC.GIT_SCAN_REPOSITORIES,
      {
        ...getGitTarget(project.workingFolder),
        rootPath: project.workingFolder,
        maxDepth: 3
      }
    )

    if (!result?.success) {
      set({
        isScanning: false,
        repositories: [],
        scanError: getErrorMessage(result, 'Failed to scan Git repositories')
      })
      return
    }

    const repositories = result.repositories ?? []
    const nextSelected = repositories.find((repo) => repo.fullPath === get().selectedRepoPath)
      ? get().selectedRepoPath
      : (repositories[0]?.fullPath ?? null)

    set({ repositories, selectedRepoPath: nextSelected, isScanning: false, scanError: null })

    if (nextSelected) {
      await get().refreshRepository(nextSelected)
    }
  },

  selectRepository: (repoPath) => {
    set({ selectedRepoPath: repoPath })
    if (repoPath) {
      void get().refreshRepository(repoPath)
    }
  },

  refreshRepository: async (repoPath) => {
    set((state) => ({
      repoDetailsByPath: {
        ...state.repoDetailsByPath,
        [repoPath]: {
          ...ensureRepoDetails(state.repoDetailsByPath, repoPath),
          loading: true,
          error: null
        }
      }
    }))

    const [statusResult, historyResult, branchesResult] = await Promise.all([
      invokeGit<GitResultBase & { status?: GitStatusDetailed }>(
        IPC.GIT_GET_STATUS_DETAILED,
        getGitTarget(repoPath)
      ),
      invokeGit<GitResultBase & { history?: GitCommitHistoryItem[] }>(IPC.GIT_GET_COMMIT_HISTORY, {
        ...getGitTarget(repoPath),
        limit: 50,
        skip: 0
      }),
      invokeGit<GitResultBase & { branches?: GitBranchItem[]; current?: string | null }>(
        IPC.GIT_LIST_BRANCHES,
        getGitTarget(repoPath)
      )
    ])

    set((state) => ({
      repoDetailsByPath: {
        ...state.repoDetailsByPath,
        [repoPath]: {
          ...ensureRepoDetails(state.repoDetailsByPath, repoPath),
          status: statusResult.success ? (statusResult.status ?? null) : null,
          history: historyResult.success ? (historyResult.history ?? []) : [],
          branches: branchesResult.success ? (branchesResult.branches ?? []) : [],
          currentBranch: branchesResult.success ? (branchesResult.current ?? null) : null,
          historyFileDiffByKey: ensureRepoDetails(state.repoDetailsByPath, repoPath)
            .historyFileDiffByKey,
          loading: false,
          error:
            (!statusResult.success && getErrorMessage(statusResult, 'Failed to load status')) ||
            (!historyResult.success && getErrorMessage(historyResult, 'Failed to load history')) ||
            (!branchesResult.success &&
              getErrorMessage(branchesResult, 'Failed to load branches')) ||
            null
        }
      }
    }))
  },

  loadMoreHistory: async (repoPath) => {
    const existing = ensureRepoDetails(get().repoDetailsByPath, repoPath)
    const result = await invokeGit<GitResultBase & { history?: GitCommitHistoryItem[] }>(
      IPC.GIT_GET_COMMIT_HISTORY,
      {
        ...getGitTarget(repoPath),
        limit: 50,
        skip: existing.history.length
      }
    )
    if (!result.success) return
    set((state) => ({
      repoDetailsByPath: {
        ...state.repoDetailsByPath,
        [repoPath]: {
          ...ensureRepoDetails(state.repoDetailsByPath, repoPath),
          history: [...existing.history, ...(result.history ?? [])]
        }
      }
    }))
  },

  loadFileHistory: async (repoPath, filePath, append = false) => {
    const details = ensureRepoDetails(get().repoDetailsByPath, repoPath)
    const existing = details.fileHistoryByPath[filePath] ?? []
    const result = await invokeGit<GitResultBase & { history?: GitCommitHistoryItem[] }>(
      IPC.GIT_GET_FILE_HISTORY,
      {
        ...getGitTarget(repoPath),
        filePath,
        limit: 50,
        skip: append ? existing.length : 0
      }
    )
    if (!result.success) return
    set((state) => ({
      repoDetailsByPath: {
        ...state.repoDetailsByPath,
        [repoPath]: {
          ...ensureRepoDetails(state.repoDetailsByPath, repoPath),
          fileHistoryByPath: {
            ...ensureRepoDetails(state.repoDetailsByPath, repoPath).fileHistoryByPath,
            [filePath]: append ? [...existing, ...(result.history ?? [])] : (result.history ?? [])
          }
        }
      }
    }))
  },

  loadFileDiff: async (repoPath, filePath, staged = false) => {
    const key = fileDiffCacheKey(filePath, staged)
    const cached = ensureRepoDetails(get().repoDetailsByPath, repoPath).diffByKey[key]
    if (cached !== undefined) return

    const requestKey = fileDiffRequestKey(repoPath, filePath, staged)
    const pending = pendingFileDiffRequests.get(requestKey)
    if (pending) return pending

    const request = (async () => {
      const result = await invokeGit<GitResultBase & { diff?: string }>(IPC.GIT_GET_FILE_DIFF, {
        ...getGitTarget(repoPath),
        filePath,
        staged
      })
      if (!result.success) return

      const diff = result.diff ?? ''
      set((state) => {
        const details = ensureRepoDetails(state.repoDetailsByPath, repoPath)
        if (details.diffByKey[key] === diff) return state

        return {
          repoDetailsByPath: {
            ...state.repoDetailsByPath,
            [repoPath]: {
              ...details,
              diffByKey: {
                ...details.diffByKey,
                [key]: diff
              }
            }
          }
        }
      })
    })()

    pendingFileDiffRequests.set(requestKey, request)
    try {
      await request
    } finally {
      if (pendingFileDiffRequests.get(requestKey) === request) {
        pendingFileDiffRequests.delete(requestKey)
      }
    }
  },

  loadHistoryFileDiff: async (repoPath, filePath, commitHash) => {
    const cacheKey = `${commitHash}:${filePath}`
    const existing = ensureRepoDetails(get().repoDetailsByPath, repoPath).historyFileDiffByKey[
      cacheKey
    ]
    if (existing !== undefined) return { success: true }

    const result = await invokeGit<GitResultBase & { diff?: string }>(
      IPC.GIT_GET_FILE_DIFF_AT_COMMIT,
      {
        ...getGitTarget(repoPath),
        filePath,
        commitHash
      }
    )
    if (!result.success) {
      toast.error(getErrorMessage(result, 'Failed to load history changes'))
      return { success: false }
    }
    set((state) => ({
      repoDetailsByPath: {
        ...state.repoDetailsByPath,
        [repoPath]: {
          ...ensureRepoDetails(state.repoDetailsByPath, repoPath),
          historyFileDiffByKey: {
            ...ensureRepoDetails(state.repoDetailsByPath, repoPath).historyFileDiffByKey,
            [cacheKey]: result.diff ?? ''
          }
        }
      }
    }))
    return { success: true }
  },

  getStagedDiffBundle: async (repoPath) => {
    const result = await invokeGit<
      GitResultBase & { stat?: string; patch?: string; empty?: boolean }
    >(IPC.GIT_GET_STAGED_DIFF_BUNDLE, {
      ...getGitTarget(repoPath),
      maxPatchChars: 96_000
    })
    if (!result.success) {
      return {
        success: false as const,
        error: getErrorMessage(result, 'Failed to read staged changes')
      }
    }
    return {
      success: true as const,
      stat: result.stat ?? '',
      patch: result.patch ?? '',
      empty: Boolean(result.empty)
    }
  },

  getFileContentAtRef: async (repoPath, filePath, ref) => {
    const result = await invokeGit<
      GitResultBase & { content?: string; exists?: boolean; isBinary?: boolean }
    >(IPC.GIT_GET_FILE_CONTENT_AT_REF, {
      ...getGitTarget(repoPath),
      filePath,
      ref
    })
    if (!result.success) {
      return { content: '', exists: false, isBinary: false }
    }
    return {
      content: result.content ?? '',
      exists: result.exists ?? true,
      isBinary: Boolean(result.isBinary)
    }
  },

  invalidateFileDiff: (repoPath, filePath) => {
    for (const staged of [true, false]) {
      pendingFileDiffRequests.delete(fileDiffRequestKey(repoPath, filePath, staged))
    }
    set((state) => {
      const details = state.repoDetailsByPath[repoPath]
      if (!details) return state
      const nextDiffByKey = { ...details.diffByKey }
      delete nextDiffByKey[fileDiffCacheKey(filePath, true)]
      delete nextDiffByKey[fileDiffCacheKey(filePath, false)]
      return {
        repoDetailsByPath: {
          ...state.repoDetailsByPath,
          [repoPath]: { ...details, diffByKey: nextDiffByKey }
        }
      }
    })
  },

  fetchRepository: async (repoPath) => {
    const result = await invokeGit<GitResultBase>(IPC.GIT_FETCH, getGitTarget(repoPath))
    if (result.success) await get().refreshRepository(repoPath)
    return result.success
      ? { success: true }
      : { success: false, error: getErrorMessage(result, 'Fetch failed') }
  },

  pullRebase: async (repoPath) => {
    const result = await invokeGit<GitResultBase>(IPC.GIT_PULL_REBASE, getGitTarget(repoPath))
    if (result.success) await get().refreshRepository(repoPath)
    return result.success
      ? { success: true }
      : { success: false, error: getErrorMessage(result, 'Pull --rebase failed') }
  },

  pushRepository: async (repoPath) => {
    const result = await invokeGit<GitResultBase>(IPC.GIT_PUSH, getGitTarget(repoPath))
    if (result.success) await get().refreshRepository(repoPath)
    return result.success
      ? { success: true }
      : { success: false, error: getErrorMessage(result, 'Push failed') }
  },

  syncRepository: async (repoPath) => {
    const pullResult = await get().pullRebase(repoPath)
    if (!pullResult.success) return pullResult
    return get().pushRepository(repoPath)
  },

  createBranch: async (repoPath, name, startPoint) => {
    const result = await invokeGit<GitResultBase>(IPC.GIT_CREATE_BRANCH, {
      ...getGitTarget(repoPath),
      name,
      ...(startPoint ? { startPoint } : {})
    })
    if (result.success) await get().refreshRepository(repoPath)
    return result.success
      ? { success: true }
      : { success: false, error: getErrorMessage(result, 'Failed to create branch') }
  },

  checkoutBranch: async (repoPath, name) => {
    const result = await invokeGit<GitResultBase>(IPC.GIT_CHECKOUT_BRANCH, {
      ...getGitTarget(repoPath),
      name
    })
    if (result.success) await get().refreshRepository(repoPath)
    return result.success
      ? { success: true }
      : { success: false, error: getErrorMessage(result, 'Failed to checkout branch') }
  },

  mergeBranch: async (repoPath, ref) => {
    const result = await invokeGit<GitResultBase>(IPC.GIT_MERGE_BRANCH, {
      ...getGitTarget(repoPath),
      ref
    })
    if (result.success) await get().refreshRepository(repoPath)
    return result.success
      ? { success: true }
      : { success: false, error: getErrorMessage(result, 'Merge failed') }
  },

  rebaseBranch: async (repoPath, ref) => {
    const result = await invokeGit<GitResultBase>(IPC.GIT_REBASE_BRANCH, {
      ...getGitTarget(repoPath),
      ref
    })
    if (result.success) await get().refreshRepository(repoPath)
    return result.success
      ? { success: true }
      : { success: false, error: getErrorMessage(result, 'Rebase failed') }
  },

  deleteLocalBranch: async (repoPath, name, force) => {
    const result = await invokeGit<GitResultBase>(IPC.GIT_DELETE_LOCAL_BRANCH, {
      ...getGitTarget(repoPath),
      name,
      ...(force ? { force: true } : {})
    })
    if (result.success) await get().refreshRepository(repoPath)
    return result.success
      ? { success: true }
      : { success: false, error: getErrorMessage(result, 'Failed to delete local branch') }
  },

  deleteRemoteBranch: async (repoPath, remote, branchName) => {
    const result = await invokeGit<GitResultBase>(IPC.GIT_DELETE_REMOTE_BRANCH, {
      ...getGitTarget(repoPath),
      remote,
      branchName
    })
    if (result.success) await get().refreshRepository(repoPath)
    return result.success
      ? { success: true }
      : { success: false, error: getErrorMessage(result, 'Failed to delete remote branch') }
  },

  renameBranch: async (repoPath, newName, oldName) => {
    const result = await invokeGit<GitResultBase>(IPC.GIT_RENAME_BRANCH, {
      ...getGitTarget(repoPath),
      newName,
      ...(oldName !== undefined ? { oldName } : {})
    })
    if (result.success) await get().refreshRepository(repoPath)
    return result.success
      ? { success: true }
      : { success: false, error: getErrorMessage(result, 'Failed to rename branch') }
  },

  stageFiles: async (repoPath, paths) => {
    const result = await invokeGit<GitResultBase>(IPC.GIT_STAGE_FILES, {
      ...getGitTarget(repoPath),
      paths
    })
    if (result.success) await get().refreshRepository(repoPath)
    return result.success
      ? { success: true }
      : { success: false, error: getErrorMessage(result, 'Failed to stage files') }
  },

  unstageFiles: async (repoPath, paths) => {
    const result = await invokeGit<GitResultBase>(IPC.GIT_UNSTAGE_FILES, {
      ...getGitTarget(repoPath),
      paths
    })
    if (result.success) await get().refreshRepository(repoPath)
    return result.success
      ? { success: true }
      : { success: false, error: getErrorMessage(result, 'Failed to unstage files') }
  },

  stageAll: async (repoPath) => {
    const result = await invokeGit<GitResultBase>(IPC.GIT_STAGE_ALL, getGitTarget(repoPath))
    if (result.success) await get().refreshRepository(repoPath)
    return result.success
      ? { success: true }
      : { success: false, error: getErrorMessage(result, 'Failed to stage all') }
  },

  unstageAll: async (repoPath) => {
    const result = await invokeGit<GitResultBase>(IPC.GIT_UNSTAGE_ALL, getGitTarget(repoPath))
    if (result.success) await get().refreshRepository(repoPath)
    return result.success
      ? { success: true }
      : { success: false, error: getErrorMessage(result, 'Failed to unstage all') }
  },

  discardFiles: async (repoPath, paths, scope) => {
    const result = await invokeGit<GitResultBase>(IPC.GIT_DISCARD_FILES, {
      ...getGitTarget(repoPath),
      paths,
      scope
    })
    if (result.success) await get().refreshRepository(repoPath)
    return result.success
      ? { success: true }
      : { success: false, error: getErrorMessage(result, 'Failed to discard changes') }
  },

  commit: async (repoPath, message) => {
    const result = await invokeGit<GitResultBase>(IPC.GIT_COMMIT, {
      ...getGitTarget(repoPath),
      message
    })
    if (result.success) await get().refreshRepository(repoPath)
    return result.success
      ? { success: true }
      : { success: false, error: getErrorMessage(result, 'Commit failed') }
  },

  startPolling: () => {
    if (get().activePollingTimer) return
    const timer = window.setInterval(() => {
      const ui = useUIStore.getState()
      const repoPath = get().selectedRepoPath
      if (ui.chatView !== 'git' || !repoPath) return
      void get().refreshRepository(repoPath)
    }, 15000)
    set({ activePollingTimer: timer })
  },

  stopPolling: () => {
    const timer = get().activePollingTimer
    if (timer) window.clearInterval(timer)
    set({ activePollingTimer: null })
  },

  reset: () => {
    get().stopPolling()
    set({
      repositories: [],
      selectedRepoPath: null,
      isScanning: false,
      scanError: null,
      repoDetailsByPath: {}
    })
  }
}))
