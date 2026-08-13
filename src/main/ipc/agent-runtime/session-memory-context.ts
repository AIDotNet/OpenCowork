import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  buildHostedMemoryContext,
  type HostedMemoryFile
} from '../../../shared/agent-system-prompt'
import { resolveDefaultGlobalMemoryHomePath } from './session-system-prompt'

const MEMORY_TOKEN_CHAR_RATIO = 4

async function readOptionalTextFile(filePath: string): Promise<HostedMemoryFile | null> {
  try {
    const content = await readFile(filePath, 'utf8')
    if (!content.trim()) return null
    return { path: filePath, content }
  } catch {
    return null
  }
}

async function readPreferredProjectFile(
  workingFolder: string,
  fileName: string
): Promise<HostedMemoryFile | null> {
  const preferred = await readOptionalTextFile(join(workingFolder, '.agents', fileName))
  if (preferred) return preferred
  return readOptionalTextFile(join(workingFolder, fileName))
}

function buildDailyMemoryDates(now = new Date()): string[] {
  const dates: string[] = []
  for (let offset = 0; offset < 2; offset += 1) {
    const date = new Date(now)
    date.setDate(now.getDate() - offset)
    dates.push(date.toISOString().slice(0, 10))
  }
  return dates
}

async function readDailyMemoryEntries(
  basePath: string
): Promise<Array<{ date: string; path: string; content: string }>> {
  const entries = await Promise.all(
    buildDailyMemoryDates().map(async (date) => {
      const filePath = join(basePath, 'memory', `${date}.md`)
      const file = await readOptionalTextFile(filePath)
      return file ? { date, path: file.path, content: file.content } : null
    })
  )
  return entries.filter((entry): entry is { date: string; path: string; content: string } =>
    Boolean(entry)
  )
}

function estimateTokens(content: string): number {
  return Math.ceil(content.length / MEMORY_TOKEN_CHAR_RATIO)
}

async function readBudgetedMemoryFile(
  filePath: string,
  summaryPath: string,
  budgetTokens: number
): Promise<HostedMemoryFile | null> {
  const summary = await readOptionalTextFile(summaryPath)
  if (summary) return summary
  const memory = await readOptionalTextFile(filePath)
  if (!memory) return null
  if (estimateTokens(memory.content) <= Math.max(1000, budgetTokens)) return memory
  return null
}

export async function loadHostedMemoryContext(args: {
  workingFolder: string | null
  sshConnectionId?: string | null
  memoryUseMemories?: boolean
  memorySummaryBudgetTokens?: number
  globalHomePath?: string
}): Promise<string | null> {
  const globalHomePath = args.globalHomePath ?? resolveDefaultGlobalMemoryHomePath()
  const budget = args.memorySummaryBudgetTokens ?? 12_000
  const workingFolder = args.workingFolder?.trim() || null
  const includeProject = Boolean(workingFolder) && !args.sshConnectionId

  const [
    agents,
    globalSoul,
    projectSoul,
    globalUser,
    projectUser,
    globalMemory,
    projectMemory,
    globalDailyMemory,
    projectDailyMemory
  ] = await Promise.all([
    includeProject && workingFolder ? readPreferredProjectFile(workingFolder, 'AGENTS.md') : null,
    readOptionalTextFile(join(globalHomePath, 'SOUL.md')),
    includeProject && workingFolder ? readPreferredProjectFile(workingFolder, 'SOUL.md') : null,
    readOptionalTextFile(join(globalHomePath, 'USER.md')),
    includeProject && workingFolder ? readPreferredProjectFile(workingFolder, 'USER.md') : null,
    readBudgetedMemoryFile(
      join(globalHomePath, 'MEMORY.md'),
      join(globalHomePath, 'memory_summary.md'),
      budget
    ),
    includeProject && workingFolder
      ? (async () =>
          (await readBudgetedMemoryFile(
            join(workingFolder, '.agents', 'MEMORY.md'),
            join(workingFolder, '.agents', 'memory_summary.md'),
            budget
          )) ??
          (await readBudgetedMemoryFile(
            join(workingFolder, 'MEMORY.md'),
            join(workingFolder, 'memory_summary.md'),
            budget
          )))()
      : null,
    readDailyMemoryEntries(globalHomePath),
    includeProject && workingFolder
      ? readDailyMemoryEntries(join(workingFolder, '.agents')).then(async (agentsDaily) =>
          agentsDaily.length > 0 ? agentsDaily : readDailyMemoryEntries(workingFolder)
        )
      : Promise.resolve([])
  ])

  return buildHostedMemoryContext({
    memoryUseMemories: args.memoryUseMemories,
    layers: {
      agents,
      globalSoul,
      projectSoul,
      globalUser,
      projectUser,
      globalMemory,
      projectMemory,
      globalDailyMemory,
      projectDailyMemory
    }
  })
}
