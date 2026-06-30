import type { ToolHandler } from './tool-types'
import { toolRegistry } from '../agent/tool-registry'
import { ipcClient } from '../ipc/ipc-client'
import { encodeToolError } from './tool-result-format'

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
  const nextSignature = buildSkillSignature(normalizedSkills)
  if (nextSignature === registeredSkillSignature && toolRegistry.has('Skill')) return

  registeredSkills = normalizedSkills
  registeredSkillSignature = nextSignature
  toolRegistry.register(createSkillHandler())
}

function buildSkillDescription(): string {
  const skillList =
    registeredSkills.length > 0
      ? [
          '',
          'Currently available skills:',
          ...registeredSkills.map((skill) => `- ${skill.name}: ${skill.description}`)
        ].join('\n')
      : '\n\nNo skills are currently installed.'

  return `Load a skill by name to get detailed instructions or domain knowledge for a specialized task. Returns the full content of the skill's SKILL.md file as context.

You have access to **Skills** — curated guides for specific workflows.
Only use the Skill tool when the user's request clearly matches a listed skill, or when the user explicitly asks for a skill.
Do not call Skill for ordinary coding, file editing, searching, debugging, or repository navigation requests unless a listed skill is obviously the best fit.

### How to use Skills
1. **Match carefully**: Use a skill only when the request clearly aligns with one of the available skills in the session context.
2. **Load first when relevant**: If a listed skill is clearly applicable, call the Skill tool before other tools.
3. **Read carefully**: After loading, read the Skill's content thoroughly before taking any action.
4. **Follow strictly**: Execute the Skill's instructions step-by-step. Do NOT skip steps, reorder them, or substitute your own approach.
5. **Retry on failure**: If a Skill's script fails, fix the issue and re-run the same script command when appropriate.
6. If the user's message begins with "[Skill: <name>]", immediately call that Skill as your first action.${skillList}`
}

function createSkillHandler(): ToolHandler {
  const availableSkillNames = registeredSkills.map((skill) => skill.name)

  return {
    definition: {
      name: 'Skill',
      description: buildSkillDescription(),
      inputSchema: {
        type: 'object',
        properties: {
          SkillName: {
            type: 'string',
            description: 'The name of the skill to load. Must match one of the available skills.',
            ...(availableSkillNames.length > 0 ? { enum: availableSkillNames } : {})
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
