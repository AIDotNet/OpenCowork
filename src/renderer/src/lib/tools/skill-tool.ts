import type { ToolHandler } from './tool-types'
import { toolRegistry } from '../agent/tool-registry'
import { ipcClient } from '../ipc/ipc-client'
import { encodeToolError } from './tool-result-format'
import { SKILL_TOOL_DESCRIPTION } from '../../../../shared/agent-system-prompt'

type SkillMeta = { name: string; description: string }

let registeredSkills: SkillMeta[] = []
let registeredSkillSignature = ''

export function getRegisteredSkills(): SkillMeta[] {
  return registeredSkills.slice()
}

function normalizeSkills(skills: SkillMeta[]): SkillMeta[] {
  return skills
    .map((skill) => ({
      name: String(skill.name ?? '').trim(),
      description: String(skill.description ?? '').trim()
    }))
    .filter((skill) => skill.name)
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))
}

function buildSkillSignature(skills: SkillMeta[]): string {
  return JSON.stringify(skills)
}

async function loadRegisteredSkills(): Promise<SkillMeta[] | null> {
  try {
    const result = await ipcClient.invoke('skills:list')
    return Array.isArray(result) ? (result as SkillMeta[]) : []
  } catch (err) {
    console.error('[Skills] Failed to load skills from IPC:', err)
    return null
  }
}

export async function refreshSkillTools(): Promise<void> {
  const nextSkills = await loadRegisteredSkills()
  if (!nextSkills) {
    if (!toolRegistry.has('Skill')) {
      toolRegistry.register(createSkillHandler())
    }
    return
  }

  const normalizedSkills = normalizeSkills(nextSkills)
  registeredSkills = normalizedSkills
  const nextSignature = buildSkillSignature(normalizedSkills)
  if (nextSignature === registeredSkillSignature && toolRegistry.has('Skill')) return

  registeredSkillSignature = nextSignature
  if (!toolRegistry.has('Skill')) {
    toolRegistry.register(createSkillHandler())
  }
}

function createSkillHandler(): ToolHandler {
  return {
    definition: {
      name: 'Skill',
      description: SKILL_TOOL_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          SkillName: {
            type: 'string',
            description:
              'The name of the skill to load. Must match one of the available skills listed in session context.'
          }
        },
        required: ['SkillName']
      }
    },
    execute: async (input) => {
      const skillName = input.SkillName as string
      if (!skillName) {
        return encodeToolError('SkillName is required')
      }
      return encodeToolError('Skill executes in the .NET Native Worker and is unavailable through the renderer boundary.')
    },
    requiresApproval: () => false
  }
}

/**
 * Load available skills from ~/agents/skills/ via IPC,
 * then register the Skill tool with a stable description.
 *
 * This is async because it reads skill metadata via IPC from the main process.
 * Similar pattern to registerBuiltinSubAgents().
 */
export async function registerSkillTools(): Promise<void> {
  await refreshSkillTools()
}
