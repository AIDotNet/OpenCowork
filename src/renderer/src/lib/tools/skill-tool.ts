import type { ToolHandler } from './tool-types'
import { toolRegistry } from '../agent/tool-registry'
import { ipcClient } from '../ipc/ipc-client'

/**
 * Build the description for the Skill tool by embedding
 * all available skill names, descriptions, and usage guidelines.
 * Similar pattern to buildTaskDescription in sub-agents/create-tool.ts.
 */
function buildSkillDescription(skills: { name: string; description: string }[]): string {
  const base = `Load a skill by name to get detailed instructions or knowledge for a specific task. Returns the full content of the skill's SKILL.md file as context.`

  if (skills.length === 0) return base

  const skillLines = skills.map((s) => `- **${s.name}**: ${s.description}`).join('\n')

  return `${base}

You have access to **Skills** — pre-defined expert scripts for specialized tasks. Skills are your MOST RELIABLE way to handle these tasks.
**BEFORE using Shell, Read, Write, or ANY other tool, check if the user's request matches a Skill below.**

**Available skills:**
${skillLines}

### How to use Skills
1. **Match**: Before starting any task, check if it matches an available Skill's description above.
2. **Load first**: Call the Skill tool as your FIRST tool call for matching tasks. Do NOT attempt ad-hoc solutions — Skills contain curated scripts with proper error handling that ad-hoc approaches will miss.
3. **Read carefully**: After loading, read the Skill's content thoroughly before taking any action.
4. **Follow strictly**: Execute the Skill's instructions step-by-step. Do NOT skip steps, reorder them, or substitute your own approach.
5. **Retry on failure**: If a Skill's script fails, fix the issue and **re-run the exact same script command**. NEVER replace a Skill's script with your own inline code or ad-hoc scripts.
6. If the user's message begins with "[Skill: <name>]", immediately call that Skill as your first action.`
}

/**
 * Create the Skill tool handler with the given skills list
 * embedded in the tool description.
 */
function createSkillHandler(skills: { name: string; description: string }[]): ToolHandler {
  return {
    definition: {
      name: 'Skill',
      description: buildSkillDescription(skills),
      inputSchema: {
        type: 'object',
        properties: {
          SkillName: {
            type: 'string',
            description: 'The name of the skill to load. Must match one of the available skills.',
          },
        },
        required: ['SkillName'],
      },
    },
    execute: async (input, ctx) => {
      const skillName = input.SkillName as string
      if (!skillName) {
        return JSON.stringify({ error: 'SkillName is required' })
      }
      try {
        const result = await ctx.ipc.invoke('skills:load', { name: skillName }) as
          | { content: string; workingDirectory: string }
          | { error: string }
        if ('error' in result) {
          return JSON.stringify({ error: result.error })
        }
        return `<skill_context>\n<working_directory>${result.workingDirectory}</working_directory>\n<instruction>CRITICAL: When executing any script mentioned in this skill, you MUST prepend the working_directory to form an absolute path. For example, if the skill says "python scripts/foo.py", you must run "python ${result.workingDirectory}/scripts/foo.py". NEVER run scripts using bare relative paths like "python scripts/foo.py" — they will fail because your cwd is not the skill directory.</instruction>\n</skill_context>\n\n${result.content}`
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
      }
    },
    requiresApproval: () => false,
  }
}

/**
 * Load available skills from ~/agents/skills/ via IPC,
 * then register the Skill tool with embedded skill descriptions.
 *
 * This is async because it reads skill metadata via IPC from the main process.
 * Similar pattern to registerBuiltinSubAgents().
 */
export async function registerSkillTools(): Promise<void> {
  let skills: { name: string; description: string }[] = []
  try {
    const result = await ipcClient.invoke('skills:list')
    if (Array.isArray(result)) {
      skills = result as { name: string; description: string }[]
    }
  } catch (err) {
    console.error('[Skills] Failed to load skills from IPC:', err)
  }

  toolRegistry.register(createSkillHandler(skills))
}
