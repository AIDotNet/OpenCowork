import { ipcMain, app, shell } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

export interface MarketSkillInfo {
  id: string
  name: string
  owner: string
  repo: string
  rank: number
  installs: number
  url: string
  github: string
  description?: string
}

interface MarketSkillsData {
  total: number
  source: string
  skills: MarketSkillInfo[]
}

let _marketSkillsCache: MarketSkillsData | null = null

/**
 * Resolve the path to the market skills JSON.
 * In dev: docs/public/skills/skills.json
 * In prod: resources/skills-market/skills.json (if bundled)
 */
function getMarketSkillsPath(): string {
  const isDev = !app.isPackaged
  if (isDev) {
    return path.join(app.getAppPath(), 'docs', 'public', 'skills', 'skills.json')
  }
  const unpackedDir = path.join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'skills-market', 'skills.json')
  if (fs.existsSync(unpackedDir)) return unpackedDir
  return path.join(process.resourcesPath, 'resources', 'skills-market', 'skills.json')
}

function loadMarketSkills(): MarketSkillsData | null {
  if (_marketSkillsCache) return _marketSkillsCache
  try {
    const filePath = getMarketSkillsPath()
    if (!fs.existsSync(filePath)) return null
    const raw = fs.readFileSync(filePath, 'utf-8')
    _marketSkillsCache = JSON.parse(raw) as MarketSkillsData
    return _marketSkillsCache
  } catch {
    return null
  }
}

const SKILLS_DIR = path.join(os.homedir(), '.open-cowork', 'skills')
const SKILLS_FILENAME = 'SKILL.md'

/**
 * Resolve the path to the bundled resources/skills/ directory.
 * - Dev: <project>/resources/skills/
 * - Production: <app>/resources/skills/ (asarUnpacked)
 */
function getBundledSkillsDir(): string {
  const isDev = !app.isPackaged
  if (isDev) {
    return path.join(app.getAppPath(), 'resources', 'skills')
  }

  const unpackedDir = path.join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'skills')
  if (fs.existsSync(unpackedDir)) {
    return unpackedDir
  }

  return path.join(process.resourcesPath, 'resources', 'skills')
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

export interface ScanFileInfo {
  name: string
  size: number
  type: string
}

export interface RiskItem {
  severity: 'safe' | 'warning' | 'danger'
  category: string
  detail: string
  file: string
  line?: number
}

export interface ScanResult {
  name: string
  description: string
  files: ScanFileInfo[]
  risks: RiskItem[]
  skillMdContent: string
  scriptContents: { file: string; content: string }[]
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
   * skills:load — read the SKILL.md content for a given skill name (strips frontmatter for AI use).
   */
  ipcMain.handle('skills:load', async (_event, args: { name: string }): Promise<{ content: string; workingDirectory: string } | { error: string }> => {
    try {
      const skillDir = path.join(SKILLS_DIR, args.name)
      const mdPath = path.join(skillDir, SKILLS_FILENAME)
      if (!fs.existsSync(mdPath)) {
        return { error: `Skill "${args.name}" not found at ${mdPath}` }
      }
      const raw = fs.readFileSync(mdPath, 'utf-8')
      // Strip YAML frontmatter so AI only sees actionable instructions
      // Use \r?\n to handle both LF and CRLF line endings
      const content = raw.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n)?/, '')
      return { content: content.trimStart(), workingDirectory: skillDir }
    } catch (err) {
      return { error: String(err) }
    }
  })

  /**
   * skills:read — read the full SKILL.md content (with frontmatter intact) for display.
   */
  ipcMain.handle('skills:read', async (_event, args: { name: string }): Promise<{ content: string } | { error: string }> => {
    try {
      const mdPath = path.join(SKILLS_DIR, args.name, SKILLS_FILENAME)
      if (!fs.existsSync(mdPath)) {
        return { error: `Skill "${args.name}" not found` }
      }
      return { content: fs.readFileSync(mdPath, 'utf-8') }
    } catch (err) {
      return { error: String(err) }
    }
  })

  /**
   * skills:list-files — list all files in a skill directory with sizes and types.
   */
  ipcMain.handle('skills:list-files', async (_event, args: { name: string }): Promise<{ files: ScanFileInfo[] } | { error: string }> => {
    try {
      const skillDir = path.join(SKILLS_DIR, args.name)
      if (!fs.existsSync(skillDir)) {
        return { error: `Skill "${args.name}" not found` }
      }
      const files: ScanFileInfo[] = []
      function walkDir(dir: string, prefix: string): void {
        const entries = fs.readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name)
          const relPath = prefix ? `${prefix}/${entry.name}` : entry.name
          if (entry.isDirectory()) {
            walkDir(fullPath, relPath)
          } else {
            const stat = fs.statSync(fullPath)
            files.push({ name: relPath, size: stat.size, type: path.extname(entry.name).toLowerCase() || 'unknown' })
          }
        }
      }
      walkDir(skillDir, '')
      return { files }
    } catch (err) {
      return { error: String(err) }
    }
  })

  /**
   * skills:delete — remove a skill directory from ~/.open-cowork/skills/.
   */
  ipcMain.handle('skills:delete', async (_event, args: { name: string }): Promise<{ success: boolean; error?: string }> => {
    try {
      const skillDir = path.join(SKILLS_DIR, args.name)
      if (!fs.existsSync(skillDir)) {
        return { success: false, error: `Skill "${args.name}" not found` }
      }
      fs.rmSync(skillDir, { recursive: true, force: true })
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  /**
   * skills:open-folder — open a skill's directory in the system file explorer.
   */
  ipcMain.handle('skills:open-folder', async (_event, args: { name: string }): Promise<{ success: boolean; error?: string }> => {
    try {
      const skillDir = path.join(SKILLS_DIR, args.name)
      if (!fs.existsSync(skillDir)) {
        return { success: false, error: `Skill "${args.name}" not found` }
      }
      await shell.openPath(skillDir)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  /**
   * skills:add-from-folder — copy a skill from a source folder into ~/.open-cowork/skills/.
   * Expects the source folder to contain a SKILL.md file.
   */
  ipcMain.handle('skills:add-from-folder', async (_event, args: { sourcePath: string }): Promise<{ success: boolean; name?: string; error?: string }> => {
    try {
      const srcMd = path.join(args.sourcePath, SKILLS_FILENAME)
      if (!fs.existsSync(srcMd)) {
        return { success: false, error: `No ${SKILLS_FILENAME} found in the selected folder` }
      }
      const skillName = path.basename(args.sourcePath)
      const targetDir = path.join(SKILLS_DIR, skillName)
      if (fs.existsSync(targetDir)) {
        return { success: false, error: `Skill "${skillName}" already exists` }
      }
      if (!fs.existsSync(SKILLS_DIR)) {
        fs.mkdirSync(SKILLS_DIR, { recursive: true })
      }
      copyDirRecursive(args.sourcePath, targetDir)
      return { success: true, name: skillName }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  /**
   * skills:save — write updated SKILL.md content back to disk.
   */
  ipcMain.handle('skills:save', async (_event, args: { name: string; content: string }): Promise<{ success: boolean; error?: string }> => {
    try {
      const mdPath = path.join(SKILLS_DIR, args.name, SKILLS_FILENAME)
      if (!fs.existsSync(path.dirname(mdPath))) {
        return { success: false, error: `Skill "${args.name}" not found` }
      }
      fs.writeFileSync(mdPath, args.content, 'utf-8')
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  /**
   * skills:scan — analyze a skill folder for security risks before installation.
   * Returns file listing, risk analysis, and content previews.
   */
  ipcMain.handle('skills:scan', async (_event, args: { sourcePath: string }): Promise<ScanResult | { error: string }> => {
    try {
      const srcMd = path.join(args.sourcePath, SKILLS_FILENAME)
      if (!fs.existsSync(srcMd)) {
        return { error: `No ${SKILLS_FILENAME} found in the selected folder` }
      }

      const skillName = path.basename(args.sourcePath)
      const skillMdContent = fs.readFileSync(srcMd, 'utf-8')
      const description = extractDescription(skillMdContent, skillName)

      // Collect all files recursively
      const files: ScanFileInfo[] = []
      const scriptContents: { file: string; content: string }[] = []
      function walkDir(dir: string, prefix: string): void {
        const entries = fs.readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name)
          const relPath = prefix ? `${prefix}/${entry.name}` : entry.name
          if (entry.isDirectory()) {
            walkDir(fullPath, relPath)
          } else {
            const stat = fs.statSync(fullPath)
            const ext = path.extname(entry.name).toLowerCase()
            files.push({ name: relPath, size: stat.size, type: ext || 'unknown' })
            // Read script/code files for analysis
            const codeExts = new Set(['.py', '.js', '.ts', '.sh', '.bash', '.ps1', '.bat', '.cmd', '.rb', '.pl'])
            if (codeExts.has(ext)) {
              try {
                scriptContents.push({ file: relPath, content: fs.readFileSync(fullPath, 'utf-8') })
              } catch { /* skip unreadable */ }
            }
          }
        }
      }
      walkDir(args.sourcePath, '')

      // Analyze risks
      const risks: RiskItem[] = []
      const allContents = [
        { file: SKILLS_FILENAME, content: skillMdContent },
        ...scriptContents,
      ]

      const riskPatterns: { pattern: RegExp; severity: 'warning' | 'danger'; category: string; label: string }[] = [
        // Dangerous shell commands
        { pattern: /\brm\s+-rf\b/g, severity: 'danger', category: 'shell', label: 'rm -rf' },
        { pattern: /\bdel\s+\/[fFsS]/g, severity: 'danger', category: 'shell', label: 'del /f' },
        { pattern: /\bformat\s+[A-Z]:/gi, severity: 'danger', category: 'shell', label: 'format drive' },
        { pattern: /\bmkfs\b/g, severity: 'danger', category: 'shell', label: 'mkfs' },
        { pattern: /\bdd\s+if=/g, severity: 'danger', category: 'shell', label: 'dd' },
        // Code execution
        { pattern: /\beval\s*\(/g, severity: 'danger', category: 'execution', label: 'eval()' },
        { pattern: /\bexec\s*\(/g, severity: 'warning', category: 'execution', label: 'exec()' },
        { pattern: /\bsubprocess\b/g, severity: 'warning', category: 'execution', label: 'subprocess' },
        { pattern: /\bos\.system\s*\(/g, severity: 'danger', category: 'execution', label: 'os.system()' },
        { pattern: /\bchild_process\b/g, severity: 'warning', category: 'execution', label: 'child_process' },
        { pattern: /\bos\.popen\s*\(/g, severity: 'danger', category: 'execution', label: 'os.popen()' },
        // Network access
        { pattern: /\brequests\.(get|post|put|delete|patch)\s*\(/g, severity: 'warning', category: 'network', label: 'requests HTTP call' },
        { pattern: /\burllib\b/g, severity: 'warning', category: 'network', label: 'urllib' },
        { pattern: /\bfetch\s*\(/g, severity: 'warning', category: 'network', label: 'fetch()' },
        { pattern: /\bcurl\s+/g, severity: 'warning', category: 'network', label: 'curl' },
        { pattern: /\bwget\s+/g, severity: 'warning', category: 'network', label: 'wget' },
        { pattern: /\bhttpx?\.\w+\s*\(/g, severity: 'warning', category: 'network', label: 'HTTP client' },
        // Credential access
        { pattern: /\b(api_key|apikey|api[-_]?secret)\b/gi, severity: 'warning', category: 'credential', label: 'API key reference' },
        { pattern: /\b(password|passwd)\s*[=:]/gi, severity: 'danger', category: 'credential', label: 'password assignment' },
        { pattern: /\b(access_token|auth_token|bearer)\b/gi, severity: 'warning', category: 'credential', label: 'token reference' },
        // File system destructive
        { pattern: /\bshutil\.rmtree\s*\(/g, severity: 'danger', category: 'filesystem', label: 'shutil.rmtree()' },
        { pattern: /\bos\.remove\s*\(/g, severity: 'warning', category: 'filesystem', label: 'os.remove()' },
        { pattern: /\bfs\.(unlinkSync|rmSync)\s*\(/g, severity: 'danger', category: 'filesystem', label: 'fs delete' },
        // Data exfiltration patterns
        { pattern: /\bbase64\b.*\b(send|post|upload)\b/gi, severity: 'danger', category: 'exfiltration', label: 'base64 + send' },
      ]

      for (const { file, content } of allContents) {
        const lines = content.split('\n')
        for (const rp of riskPatterns) {
          // Reset regex lastIndex for global patterns
          rp.pattern.lastIndex = 0
          for (let i = 0; i < lines.length; i++) {
            rp.pattern.lastIndex = 0
            if (rp.pattern.test(lines[i])) {
              // Avoid duplicate risks for same file+line+category
              const exists = risks.some(
                (r) => r.file === file && r.line === i + 1 && r.category === rp.category
              )
              if (!exists) {
                risks.push({
                  severity: rp.severity,
                  category: rp.category,
                  detail: rp.label,
                  file,
                  line: i + 1,
                })
              }
            }
          }
        }
      }

      return { name: skillName, description, files, risks, skillMdContent, scriptContents }
    } catch (err) {
      return { error: String(err) }
    }
  })

  /**
   * skills:market-list — return paginated market skills with optional search.
   * Enriches skills with descriptions extracted from SKILL.md files.
   */
  ipcMain.handle('skills:market-list', async (_event, args: { offset?: number; limit?: number; query?: string }): Promise<{
    total: number
    skills: MarketSkillInfo[]
  }> => {
    const data = loadMarketSkills()
    if (!data) return { total: 0, skills: [] }

    let results = data.skills
    if (args.query && args.query.trim()) {
      const q = args.query.toLowerCase()
      results = results.filter(
        (s) => s.name.toLowerCase().includes(q) || s.owner.toLowerCase().includes(q) || s.id.toLowerCase().includes(q)
      )
    }

    // Enrich with descriptions from SKILL.md files
    const enrichedResults = results.map((skill) => {
      let description = skill.description
      if (!description) {
        try {
          // Try to read from docs/public/skills/{owner}/{name}/SKILL.md
          const skillPath = path.join(app.getAppPath(), 'docs', 'public', 'skills', skill.owner, skill.name, 'SKILL.md')
          if (fs.existsSync(skillPath)) {
            const content = fs.readFileSync(skillPath, 'utf-8')
            description = extractDescription(content, skill.name)
          }
        } catch {
          // Ignore errors, use default description
        }
      }
      return { ...skill, description }
    })

    const offset = args.offset ?? 0
    const limit = args.limit ?? 50
    return {
      total: enrichedResults.length,
      skills: enrichedResults.slice(offset, offset + limit),
    }
  })

  /**
   * skills:download-remote — download a skill from the remote marketplace to a temp directory.
   * Returns the temp path and file contents for agent review.
   */
  ipcMain.handle('skills:download-remote', async (_event, args: { owner: string; repo: string; name: string }): Promise<{
    tempPath?: string
    files?: { path: string; content: string }[]
    error?: string
  }> => {
    try {
      // Create temp directory with timestamp, but skill subdirectory with actual name
      const tempBase = path.join(os.tmpdir(), 'opencowork-skills', `download-${Date.now()}`)
      const tempDir = path.join(tempBase, args.name)
      fs.mkdirSync(tempDir, { recursive: true })

      // In dev mode, copy from docs/public/skills/{owner}/{name}/
      // In production, this would download from the actual API
      const skillSourcePath = path.join(app.getAppPath(), 'docs', 'public', 'skills', args.owner, args.name)

      if (!fs.existsSync(skillSourcePath)) {
        return { error: `Skill not found: ${args.owner}/${args.name}` }
      }

      // Copy skill files to temp directory
      copyDirRecursive(skillSourcePath, tempDir)

      // Read all files for agent review
      const files: { path: string; content: string }[] = []
      function collectFiles(dir: string, prefix: string): void {
        const entries = fs.readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name)
          const relPath = prefix ? `${prefix}/${entry.name}` : entry.name
          if (entry.isDirectory()) {
            collectFiles(fullPath, relPath)
          } else {
            try {
              const content = fs.readFileSync(fullPath, 'utf-8')
              files.push({ path: relPath, content })
            } catch {
              // Skip binary or unreadable files
            }
          }
        }
      }
      collectFiles(tempDir, '')

      return { tempPath: tempDir, files }
    } catch (err) {
      return { error: String(err) }
    }
  })

  /**
   * skills:cleanup-temp — remove a temporary skill directory after installation or cancellation.
   */
  ipcMain.handle('skills:cleanup-temp', async (_event, args: { tempPath: string }): Promise<{ success: boolean }> => {
    try {
      // Safety check: only delete paths in the temp directory
      if (!args.tempPath.includes('opencowork-skills')) {
        console.warn('[Skills] Refusing to delete non-temp path:', args.tempPath)
        return { success: false }
      }

      // Find the base temp directory (parent of the skill directory)
      // tempPath is like: /tmp/opencowork-skills/download-123456/skill-name
      // We want to delete: /tmp/opencowork-skills/download-123456
      const parts = args.tempPath.split(path.sep)
      const skillsIndex = parts.findIndex(p => p === 'opencowork-skills')
      if (skillsIndex >= 0 && skillsIndex + 1 < parts.length) {
        const baseTempDir = parts.slice(0, skillsIndex + 2).join(path.sep)
        if (fs.existsSync(baseTempDir)) {
          fs.rmSync(baseTempDir, { recursive: true, force: true })
        }
      } else if (fs.existsSync(args.tempPath)) {
        // Fallback: just delete the provided path
        fs.rmSync(args.tempPath, { recursive: true, force: true })
      }
      return { success: true }
    } catch (err) {
      console.error('[Skills] Cleanup failed:', err)
      return { success: false }
    }
  })
}
