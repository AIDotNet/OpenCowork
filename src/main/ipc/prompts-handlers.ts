import { app, ipcMain } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

const PROMPTS_DIR = path.join(os.homedir(), '.open-cowork', 'prompts')

/**
 * Resolve the path to the bundled resources/prompts/ directory.
 * - Dev: <project>/resources/prompts/
 * - Production: <app>/resources/prompts/ (asarUnpacked)
 */
function getBundledPromptsDir(): string {
  const isDev = !app.isPackaged
  if (isDev) {
    return path.join(app.getAppPath(), 'resources', 'prompts')
  }

  const unpackedDir = path.join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'prompts')
  if (fs.existsSync(unpackedDir)) {
    return unpackedDir
  }

  return path.join(process.resourcesPath, 'resources', 'prompts')
}

/**
 * Copy built-in prompts from resources/prompts/ to ~/.open-cowork/prompts/.
 * Only copies a prompt if it does not already exist in the target,
 * so user modifications are preserved.
 */
function ensureBuiltinPrompts(): void {
  try {
    const bundledDir = getBundledPromptsDir()
    if (!fs.existsSync(bundledDir)) {
      console.warn('[Prompts] Bundled prompts directory not found:', bundledDir)
      return
    }

    if (!fs.existsSync(PROMPTS_DIR)) {
      fs.mkdirSync(PROMPTS_DIR, { recursive: true })
    }

    const entries = fs.readdirSync(bundledDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (!entry.name.endsWith('.md')) continue

      const targetPath = path.join(PROMPTS_DIR, entry.name)
      if (fs.existsSync(targetPath)) continue

      fs.copyFileSync(path.join(bundledDir, entry.name), targetPath)
    }
  } catch (err) {
    console.error('[Prompts] Failed to initialize builtin prompts:', err)
  }
}

function resolvePromptFilename(name: string): string | null {
  const trimmed = path.basename(name.trim())
  if (!trimmed || trimmed === '.' || trimmed === '..') return null
  if (trimmed.toLowerCase().endsWith('.md')) return trimmed
  return `${trimmed}.md`
}

function resolvePromptPath(name: string): string | null {
  const filename = resolvePromptFilename(name)
  if (!filename) return null

  const userPath = path.join(PROMPTS_DIR, filename)
  if (fs.existsSync(userPath)) return userPath

  const bundledDir = getBundledPromptsDir()
  const bundledPath = path.join(bundledDir, filename)
  if (fs.existsSync(bundledPath)) return bundledPath

  return null
}

export function registerPromptsHandlers(): void {
  ensureBuiltinPrompts()

  ipcMain.handle('prompts:list', async (): Promise<string[]> => {
    try {
      if (!fs.existsSync(PROMPTS_DIR)) return []
      const entries = fs.readdirSync(PROMPTS_DIR, { withFileTypes: true })
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
        .map((entry) => entry.name.replace(/\.md$/i, ''))
    } catch {
      return []
    }
  })

  ipcMain.handle('prompts:load', async (_event, args: { name: string }): Promise<{ content: string } | { error: string }> => {
    try {
      const name = args?.name?.trim()
      if (!name) return { error: 'Prompt name is required' }

      const promptPath = resolvePromptPath(name)
      if (!promptPath) return { error: `Prompt "${name}" not found` }

      const content = fs.readFileSync(promptPath, 'utf-8')
      return { content }
    } catch (err) {
      return { error: String(err) }
    }
  })
}
