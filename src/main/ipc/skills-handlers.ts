import { ipcMain, app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { is } from '@electron-toolkit/utils'

const SKILLS_DIR = path.join(os.homedir(), '.open-cowork', 'skills')
const SKILLS_FILENAME = 'SKILL.md'

/**
 * Resolve the path to the bundled resources/skills/ directory.
 * - Dev: <project>/resources/skills/
 * - Production: <app>/resources/skills/ (asarUnpacked)
 */
function getBundledSkillsDir(): string {
  if (is.dev) {
    return path.join(app.getAppPath(), 'resources', 'skills')
  }
  return path.join(process.resourcesPath, 'skills')
}

/**
 * Copy built-in skills from resources/skills/ to ~/.open-cowork/skills/.
 * Only copies a skill if its directory does not already exist in the target,
 * so user modifications are preserved.
 */
/**
 * Recursively copy a directory from src to dest.
 */
function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true })
  const entries = fs.readdirSync(src, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath)
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

function ensureBuiltinSkills(): void {
  try {
    const bundledDir = getBundledSkillsDir()
    if (!fs.existsSync(bundledDir)) {
      console.warn('[Skills] Bundled skills directory not found:', bundledDir)
      return
    }

    if (!fs.existsSync(SKILLS_DIR)) {
      fs.mkdirSync(SKILLS_DIR, { recursive: true })
    }

    const entries = fs.readdirSync(bundledDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const targetDir = path.join(SKILLS_DIR, entry.name)
      if (fs.existsSync(targetDir)) continue // already installed, skip

      copyDirRecursive(path.join(bundledDir, entry.name), targetDir)
    }
  } catch (err) {
    console.error('[Skills] Failed to initialize builtin skills:', err)
  }
}

export interface SkillInfo {
  name: string
  description: string
}

/**
 * Extract a short description from SKILL.md content.
 * Parses YAML frontmatter for 'description' field first,
 * then falls back to the first non-empty, non-heading line.
 */
function extractDescription(content: string, fallback: string): string {
  // Try to parse YAML frontmatter first
  const fmMatch = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/)
  if (fmMatch) {
    const fmBlock = fmMatch[1]
    const descMatch = fmBlock.match(/^description:\s*(.+)$/m)
    if (descMatch) {
      const desc = descMatch[1].trim().replace(/^["']|["']$/g, '')
      if (desc) return desc.length > 200 ? desc.slice(0, 200) + '...' : desc
    }
  }

  // Fallback: first non-empty, non-heading, non-frontmatter line
  const lines = content.split('\n')
  let inFrontmatter = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '---') {
      inFrontmatter = !inFrontmatter
      continue
    }
    if (inFrontmatter) continue
    if (!trimmed) continue
    if (trimmed.startsWith('#')) continue
    return trimmed.length > 120 ? trimmed.slice(0, 120) + '...' : trimmed
  }
  return fallback
}

export function registerSkillsHandlers(): void {
  // Initialize builtin skills on startup
  ensureBuiltinSkills()

  /**
   * skills:list — scan ~/.open-cowork/skills/ and return all available skills.
   * Each subdirectory containing a SKILL.md is treated as a skill.
   */
  ipcMain.handle('skills:list', async (): Promise<SkillInfo[]> => {
    try {
      if (!fs.existsSync(SKILLS_DIR)) return []
      const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
      const skills: SkillInfo[] = []
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const mdPath = path.join(SKILLS_DIR, entry.name, SKILLS_FILENAME)
        if (!fs.existsSync(mdPath)) continue
        try {
          const content = fs.readFileSync(mdPath, 'utf-8')
          skills.push({
            name: entry.name,
            description: extractDescription(content, entry.name),
          })
        } catch {
          // Skip unreadable files
        }
      }
      return skills
    } catch {
      return []
    }
  })

  /**
   * skills:load — read the SKILL.md content for a given skill name.
   */
  ipcMain.handle('skills:load', async (_event, args: { name: string }): Promise<{ content: string } | { error: string }> => {
    try {
      const mdPath = path.join(SKILLS_DIR, args.name, SKILLS_FILENAME)
      if (!fs.existsSync(mdPath)) {
        return { error: `Skill "${args.name}" not found at ${mdPath}` }
      }
      const raw = fs.readFileSync(mdPath, 'utf-8')
      console.log('[Skills:load] raw length:', raw.length, 'first 80 chars:', JSON.stringify(raw.slice(0, 80)))
      console.log('[Skills:load] has frontmatter:', /^---/.test(raw), 'line ending hex:', Buffer.from(raw.slice(0, 10)).toString('hex'))
      // Strip YAML frontmatter so AI only sees actionable instructions
      // Use \r?\n to handle both LF and CRLF line endings
      const content = raw.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n)?/, '')
      console.log('[Skills:load] stripped length:', content.trimStart().length, 'first 80 chars:', JSON.stringify(content.trimStart().slice(0, 80)))
      return { content: content.trimStart() }
    } catch (err) {
      return { error: String(err) }
    }
  })
}
