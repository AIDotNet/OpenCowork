import { ipcMain, shell } from 'electron'
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
  source_path?: string
}

const SKILLS_DIR = path.join(os.homedir(), '.open-cowork', 'skills')
const SKILLS_FILENAME = 'SKILL.md'

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

  /**
   * skills:list 鈥?scan ~/.open-cowork/skills/ and return all available skills.
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
   * skills:load 鈥?read the SKILL.md content for a given skill name (strips frontmatter for AI use).
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
   * skills:read 鈥?read the full SKILL.md content (with frontmatter intact) for display.
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
   * skills:list-files 鈥?list all files in a skill directory with sizes and types.
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
   * skills:delete 鈥?remove a skill directory from ~/.open-cowork/skills/.
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
   * skills:open-folder 鈥?open a skill's directory in the system file explorer.
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
   * skills:add-from-folder 鈥?copy a skill from a source folder into ~/.open-cowork/skills/.
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
   * skills:save 鈥?write updated SKILL.md content back to disk.
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
   * skills:scan 鈥?analyze a skill folder for security risks before installation.
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
   * Normalise a raw skill object from the skillsmp API into MarketSkillInfo.
   */
  function normaliseSkillsmpItem(s: Record<string, unknown>, index: number): MarketSkillInfo {
    return {
      id: String(s['id'] ?? s['name'] ?? index),
      name: String(s['name'] ?? ''),
      owner: String(s['owner'] ?? s['github_owner'] ?? ''),
      repo: String(s['repo'] ?? s['github_repo'] ?? s['name'] ?? ''),
      rank: Number(s['stars'] ?? s['rank'] ?? 0),
      installs: Number(s['installs'] ?? s['downloads'] ?? 0),
      url: String(s['url'] ?? s['marketplace_url'] ?? `https://skillsmp.com/skills/${s['name'] ?? ''}`),
      github: String(s['github'] ?? s['github_url'] ?? ''),
      description: s['description'] != null ? String(s['description']) : undefined,
      source_path: s['source_path'] != null ? String(s['source_path']) : undefined,
    }
  }

  /**
   * Parse the skillsmp API JSON response into { total, skills }.
   * Handles both top-level and nested data shapes.
   */
  function parseSkillsmpResponse(json: Record<string, unknown>): { total: number; skills: MarketSkillInfo[] } {
    if (json['success'] === false) {
      const err = json['error'] as Record<string, unknown> | undefined
      throw new Error(String(err?.['message'] ?? 'skillsmp API returned failure'))
    }

    // Unwrap nested data if present
    const data = (json['data'] ?? json) as Record<string, unknown>

    const rawSkills: unknown[] = (
      (data['skills'] as unknown[]) ??
      (data['items'] as unknown[]) ??
      (data['results'] as unknown[]) ??
      []
    )

    const total: number =
      (data['pagination'] != null ? (data['pagination'] as Record<string, unknown>)['total'] as number : undefined) ??
      (data['total'] as number | undefined) ??
      rawSkills.length

    const skills = (rawSkills as Record<string, unknown>[]).map((s, i) => normaliseSkillsmpItem(s, i))
    return { total: Number(total) || skills.length, skills }
  }

  /**
   * Fetch skills from skillsmp.com using the documented REST API.
   *
   * Endpoints (https://skillsmp.com/docs/api):
   *   GET /api/v1/skills/search?q=QUERY&page=N&limit=N&sortBy=stars|recent
   *   GET /api/v1/skills/ai-search?q=QUERY   (semantic, no pagination)
   *
   * Notes:
   *   - `q` is required for both endpoints; use empty string for full listing.
   *   - /api/v1/skills (bare) does NOT exist.
   *   - Rate limit: 500 req/day per API key.
   */
  async function fetchSkillsmpList(args: {
    query?: string
    offset?: number
    limit?: number
    apiKey: string
    useAiSearch?: boolean
  }): Promise<{ total: number; skills: MarketSkillInfo[] }> {
    const base = 'https://skillsmp.com/api/v1'
    const q = (args.query ?? '').trim()
    const headers = { Authorization: `Bearer ${args.apiKey}` }

    let endpoint: string

    if (args.useAiSearch && q) {
      // AI semantic search 鈥?no pagination parameters
      endpoint = `${base}/skills/ai-search?q=${encodeURIComponent(q)}`
    } else {
      // Keyword search 鈥?supports pagination; q is required, use '*' to list all
      const page = Math.floor((args.offset ?? 0) / (args.limit ?? 20)) + 1
      const limit = Math.min(args.limit ?? 20, 100)
      const params = new URLSearchParams({
        q: q || '*',
        page: String(page),
        limit: String(limit),
        sortBy: 'stars',
      })
      endpoint = `${base}/skills/search?${params}`
    }

    const res = await fetch(endpoint, { headers })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      let detail = body
      try {
        const parsed = JSON.parse(body) as Record<string, unknown>
        const err = parsed['error'] as Record<string, unknown> | undefined
        if (err?.['message']) detail = String(err['message'])
        if (parsed['success'] === false && err?.['code']) detail = `${err['code']}: ${detail}`
      } catch { /* use raw body */ }
      throw new Error(`skillsmp API ${res.status}: ${detail}`)
    }

    const json = await res.json() as Record<string, unknown>
    return parseSkillsmpResponse(json)
  }

  /**
   * skills:market-list 鈥?return paginated market skills with optional search.
   * Requires SkillsMP API key.
   */
  ipcMain.handle('skills:market-list', async (_event, args: {
    offset?: number
    limit?: number
    query?: string
    provider?: 'skillsmp'
    apiKey?: string
  }): Promise<{
    total: number
    skills: MarketSkillInfo[]
  }> => {
    if (!args.apiKey) return { total: 0, skills: [] }
    if (args.provider && args.provider !== 'skillsmp') return { total: 0, skills: [] }

    try {
      return await fetchSkillsmpList({
        query: args.query,
        offset: args.offset,
        limit: args.limit,
        apiKey: args.apiKey,
      })
    } catch (err) {
      console.error('[Skills] skillsmp API error:', err)
      return { total: 0, skills: [] }
    }
  })

  /**
   * Download skill files from GitHub using the raw content API.
   * Fetches the file tree and downloads all text files into tempDir.
   */
  async function downloadFromGitHub(args: {
    owner: string
    repo: string
    sourcePath?: string
    tempDir: string
  }): Promise<{ files: { path: string; content: string }[] }> {
    const { owner, repo, sourcePath, tempDir } = args
    const prefix = sourcePath ? sourcePath.replace(/^\/|\/$/, '') : ''

    // Get the recursive file tree
    const treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`
    const treeRes = await fetch(treeUrl, {
      headers: { 'User-Agent': 'OpenCowork', Accept: 'application/vnd.github+json' },
    })
    if (!treeRes.ok) {
      throw new Error(`GitHub tree API error ${treeRes.status} for ${owner}/${repo}`)
    }
    const treeJson = await treeRes.json() as { tree?: { path: string; type: string; url?: string }[] }
    const tree = treeJson.tree ?? []

    // Filter to blobs under the sourcePath prefix
    const blobs = tree.filter((item) => {
      if (item.type !== 'blob') return false
      if (prefix) return item.path.startsWith(prefix + '/') || item.path === prefix
      return true
    })

    const files: { path: string; content: string }[] = []
    const textExts = new Set(['.md', '.txt', '.py', '.js', '.ts', '.sh', '.bash', '.ps1', '.bat',
      '.cmd', '.rb', '.pl', '.yaml', '.yml', '.json', '.toml', '.cfg', '.ini', '.env'])

    for (const blob of blobs) {
      const relPath = prefix ? blob.path.slice(prefix.length).replace(/^\//, '') : blob.path
      const ext = path.extname(relPath).toLowerCase()
      if (textExts.has(ext) || relPath === 'SKILL.md') {
        const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${blob.path}`
        try {
          const fileRes = await fetch(rawUrl, { headers: { 'User-Agent': 'OpenCowork' } })
          if (!fileRes.ok) continue
          const content = await fileRes.text()
          // Write to temp directory
          const destPath = path.join(tempDir, relPath)
          fs.mkdirSync(path.dirname(destPath), { recursive: true })
          fs.writeFileSync(destPath, content, 'utf-8')
          files.push({ path: relPath, content })
        } catch {
          // Skip files that fail to download
        }
      }
    }

    return { files }
  }

  /**
   * skills:download-remote 鈥?download a skill from the remote marketplace to a temp directory.
   * Returns the temp path and file contents for agent review.
   * When provider=skillsmp (or github URL available), downloads from GitHub.
   */
  ipcMain.handle('skills:download-remote', async (_event, args: {
    owner: string
    repo: string
    name: string
    provider?: 'skillsmp'
    apiKey?: string
    skillId?: string
    sourcePath?: string
    github?: string
  }): Promise<{
    tempPath?: string
    files?: { path: string; content: string }[]
    error?: string
  }> => {
    try {
      const tempBase = path.join(os.tmpdir(), 'opencowork-skills', `download-${Date.now()}`)
      const tempDir = path.join(tempBase, args.name)
      fs.mkdirSync(tempDir, { recursive: true })

      if (args.provider === 'skillsmp' && !args.apiKey) {
        return { error: 'SkillsMP API key is required' }
      }

      if (!args.owner || !args.repo) {
        return { error: 'Missing GitHub owner/repo for skill download' }
      }

      const { files } = await downloadFromGitHub({
        owner: args.owner,
        repo: args.repo,
        sourcePath: args.sourcePath,
        tempDir,
      })

      if (files.length === 0) {
        return { error: `No files found in GitHub repo ${args.owner}/${args.repo}` }
      }

      // Ensure SKILL.md exists
      if (!files.some((f) => f.path === 'SKILL.md')) {
        return { error: `No SKILL.md found in ${args.owner}/${args.repo}` }
      }

      return { tempPath: tempDir, files }
    } catch (err) {
      return { error: String(err) }
    }
  })

  /**
   * skills:cleanup-temp 鈥?remove a temporary skill directory after installation or cancellation.
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

