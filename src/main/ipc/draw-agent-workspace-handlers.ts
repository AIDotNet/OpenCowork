import { shell } from 'electron'
import { access, lstat, mkdir, realpath, rename } from 'fs/promises'
import { homedir } from 'os'
import { basename, join, relative, resolve, sep } from 'path'
import { registerMessagePackHandler } from './messagepack-handler'

const WORKSPACE_ROOT = join(homedir(), '.open-cowork', 'graph-agents')

interface EnsureWorkspaceArgs {
  projectId: string
  name: string
  workspacePath?: string
}

interface RenameWorkspaceArgs extends EnsureWorkspaceArgs {
  workspacePath: string
}

interface TrashWorkspaceArgs {
  workspacePath?: string
}

function sanitizeWorkspaceName(name: string, projectId: string): string {
  const withoutControlCharacters = Array.from(name.normalize('NFC'), (character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint < 32 || codePoint === 127 ? '-' : character
  }).join('')
  const sanitized = withoutControlCharacters
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/[. ]+$/g, '')
    .trim()
  return sanitized || `Canvas-${projectId.slice(0, 8)}`
}

function isWorkspacePath(value: string): boolean {
  return isPathInside(resolve(WORKSPACE_ROOT), resolve(value))
}

function isPathInside(root: string, value: string): boolean {
  const child = relative(root, value)
  return child.length > 0 && child !== '..' && !child.startsWith(`..${sep}`) && !child.includes(sep)
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await access(value)
    return true
  } catch {
    return false
  }
}

async function uniqueWorkspacePath(name: string, excludePath?: string): Promise<string> {
  const excluded = excludePath ? resolve(excludePath) : null
  const physicalExcluded =
    excludePath && (await pathExists(excludePath)) ? await realpath(excludePath) : null
  for (let suffix = 1; ; suffix += 1) {
    const candidate = join(WORKSPACE_ROOT, suffix === 1 ? name : `${name}-${suffix}`)
    if (excluded === resolve(candidate)) return candidate
    if (!(await pathExists(candidate))) return candidate
    if (physicalExcluded && (await realpath(candidate)) === physicalExcluded) return candidate
  }
}

function assertWorkspacePath(value: string): void {
  if (!isWorkspacePath(value)) {
    throw new Error('Canvas Agent workspace must stay inside ~/.open-cowork/graph-agents')
  }
}

async function assertExistingWorkspaceDirectory(value: string): Promise<void> {
  assertWorkspacePath(value)
  const stats = await lstat(value)
  if (stats.isSymbolicLink()) throw new Error('Canvas Agent workspace cannot be a symbolic link')
  const [physicalRoot, physicalWorkspace] = await Promise.all([
    realpath(WORKSPACE_ROOT),
    realpath(value)
  ])
  if (!isPathInside(physicalRoot, physicalWorkspace)) {
    throw new Error('Canvas Agent workspace resolves outside ~/.open-cowork/graph-agents')
  }
}

export function registerDrawAgentWorkspaceHandlers(): void {
  registerMessagePackHandler<EnsureWorkspaceArgs, { workspacePath: string }>(
    'draw-agent-workspace:ensure',
    async ({ projectId, name, workspacePath }) => {
      await mkdir(WORKSPACE_ROOT, { recursive: true })
      if (workspacePath) {
        assertWorkspacePath(workspacePath)
        await mkdir(workspacePath, { recursive: true })
        await assertExistingWorkspaceDirectory(workspacePath)
        return { workspacePath: resolve(workspacePath) }
      }

      const target = await uniqueWorkspacePath(sanitizeWorkspaceName(name, projectId))
      await mkdir(target, { recursive: false })
      return { workspacePath: target }
    }
  )

  registerMessagePackHandler<RenameWorkspaceArgs, { workspacePath: string }>(
    'draw-agent-workspace:rename',
    async ({ projectId, name, workspacePath }) => {
      assertWorkspacePath(workspacePath)
      await mkdir(WORKSPACE_ROOT, { recursive: true })
      if (!(await pathExists(workspacePath))) {
        await mkdir(workspacePath, { recursive: true })
      }
      await assertExistingWorkspaceDirectory(workspacePath)

      const target = await uniqueWorkspacePath(
        sanitizeWorkspaceName(name, projectId),
        workspacePath
      )
      if (resolve(target) !== resolve(workspacePath)) {
        await rename(workspacePath, target)
      }
      return { workspacePath: target }
    }
  )

  registerMessagePackHandler<TrashWorkspaceArgs, { trashed: boolean; name?: string }>(
    'draw-agent-workspace:trash',
    async ({ workspacePath }) => {
      if (!workspacePath) return { trashed: false }
      assertWorkspacePath(workspacePath)
      if (!(await pathExists(workspacePath))) return { trashed: false }
      await assertExistingWorkspaceDirectory(workspacePath)
      await shell.trashItem(workspacePath)
      return { trashed: true, name: basename(workspacePath) }
    }
  )
}
