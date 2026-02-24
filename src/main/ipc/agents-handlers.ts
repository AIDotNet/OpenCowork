import { ipcMain } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

const AGENTS_DIR = path.join(os.homedir(), '.open-cowork', 'agents')

function ensureAgentsDir(): void {
  if (!fs.existsSync(AGENTS_DIR)) {
    fs.mkdirSync(AGENTS_DIR, { recursive: true })
  }
}

// --- Frontmatter parsing ---

export interface AgentInfo {
  /** Unique name (used as subType in Task tool) */
  name: string
  /** Human-readable description (shown in Task tool description) */
  description: string
  /** Lucide icon name */
  icon?: string
  /** Comma-separated list of allowed tool names */
  allowedTools: string[]
  /** Max LLM iterations */
  maxIterations: number
  /** Optional model override */
  model?: string
  /** Optional temperature override */
  temperature?: number
  /** The system prompt (body after frontmatter) */
  systemPrompt: string
}

/**
 * Parse a single agent .md file into AgentInfo.
 * Returns null if parsing fails or required fields are missing.
 */
function parseAgentFile(content: string, filename: string): AgentInfo | null {
  const fmMatch = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/)
  if (!fmMatch) return null

  const fmBlock = fmMatch[1]
  const body = content.slice(fmMatch[0].length).trimStart()

  // Extract frontmatter fields
  const getString = (key: string): string | undefined => {
    const m = fmBlock.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))
    if (!m) return undefined
    return m[1].trim().replace(/^["']|["']$/g, '')
  }

  const getNumber = (key: string): number | undefined => {
    const s = getString(key)
    if (s === undefined) return undefined
    const n = Number(s)
    return isNaN(n) ? undefined : n
  }

  const name = getString('name')
  const description = getString('description')
  if (!name || !description) {
    console.warn(`[Agents] Skipping ${filename}: missing name or description`)
    return null
  }

  const allowedToolsStr = getString('allowedTools') ?? 'Read, Glob, Grep, LS'
  const allowedTools = allowedToolsStr.split(',').map((t) => t.trim()).filter(Boolean)

  return {
    name,
    description,
    icon: getString('icon'),
    allowedTools,
    // 0 => unlimited iterations; explicit value in frontmatter still takes precedence
    maxIterations: getNumber('maxIterations') ?? 0,
    model: getString('model'),
    temperature: getNumber('temperature'),
    systemPrompt: body || `You are ${name}, a specialized agent.`,
  }
}

export function registerAgentsHandlers(): void {
  /**
   * agents:list — scan ~/.open-cowork/agents/ and return all available agents.
   * Each .md file with valid frontmatter is treated as an agent.
   */
  ipcMain.handle('agents:list', async (): Promise<AgentInfo[]> => {
    try {
      ensureAgentsDir()
      const entries = fs.readdirSync(AGENTS_DIR, { withFileTypes: true })
      const agents: AgentInfo[] = []
      for (const entry of entries) {
        if (entry.isDirectory()) continue
        if (!entry.name.endsWith('.md')) continue
        try {
          const content = fs.readFileSync(path.join(AGENTS_DIR, entry.name), 'utf-8')
          const agent = parseAgentFile(content, entry.name)
          if (agent) agents.push(agent)
        } catch {
          // Skip unreadable files
        }
      }
      return agents
    } catch {
      return []
    }
  })

  /**
   * agents:load — read and parse a specific agent .md file by name.
   */
  ipcMain.handle('agents:load', async (_event, args: { name: string }): Promise<AgentInfo | { error: string }> => {
    try {
      if (!fs.existsSync(AGENTS_DIR)) {
        return { error: `Agents directory not found` }
      }
      // Search for the agent file by name field (not filename)
      const entries = fs.readdirSync(AGENTS_DIR, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) continue
        if (!entry.name.endsWith('.md')) continue
        try {
          const content = fs.readFileSync(path.join(AGENTS_DIR, entry.name), 'utf-8')
          const agent = parseAgentFile(content, entry.name)
          if (agent && agent.name === args.name) return agent
        } catch {
          // Skip unreadable files
        }
      }
      return { error: `Agent "${args.name}" not found` }
    } catch (err) {
      return { error: String(err) }
    }
  })
}
