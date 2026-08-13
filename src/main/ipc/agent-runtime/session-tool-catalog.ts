import {
  createToolManifestV2,
  type RuntimeToolDefinitionLike
} from '../../../shared/agent-runtime-v2'
import { SKILL_TOOL_DESCRIPTION } from '../../../shared/agent-system-prompt'
import type { RuntimeToolCatalogEntry } from '../../../shared/runtime-contracts/generated/contracts'
import {
  BROWSER_SESSION_TOOLS,
  CODEGRAPH_EXPLORE_TOOL,
  CRON_SESSION_TOOLS,
  DESKTOP_SESSION_TOOLS,
  GOAL_SESSION_TOOLS,
  IMAGE_GENERATE_TOOL,
  MEMORY_SESSION_TOOLS,
  MONITOR_SESSION_TOOL,
  PLUGIN_CHANNEL_SESSION_TOOLS,
  PLUGIN_COMMON_SESSION_TOOLS,
  POWERSHELL_SESSION_TOOL,
  TEAM_SESSION_TOOLS,
  WIDGET_SESSION_TOOL
} from './session-tool-families'

export type SessionToolDefinition = RuntimeToolDefinitionLike

export type SessionToolCatalogOptions = {
  webSearchEnabled?: boolean
  teamToolsEnabled?: boolean
  codegraphEnabled?: boolean
  includePowerShell?: boolean
  browserEnabled?: boolean
  desktopControlEnabled?: boolean
  imageGenerateEnabled?: boolean
  pluginToolsEnabled?: boolean
  extraTools?: SessionToolDefinition[]
}

const CORE_SESSION_TOOLS: SessionToolDefinition[] = [
  {
    name: 'Read',
    description: 'Read a file from the filesystem',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute path or relative to the working folder'
        },
        offset: { type: 'number', description: 'Start line (1-indexed)' },
        limit: { type: 'number', description: 'Number of lines to read' }
      },
      required: ['file_path']
    }
  },
  {
    name: 'Write',
    description: 'Writes a file to the filesystem.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute path or relative to the working folder'
        },
        content: { type: 'string', description: 'Complete file contents' }
      },
      required: ['file_path', 'content']
    }
  },
  {
    name: 'Edit',
    description: 'Performs exact string replacements in files.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute path or relative to the working folder'
        },
        old_string: { type: 'string', description: 'The text to replace' },
        new_string: { type: 'string', description: 'Replacement text' },
        replace_all: { type: 'boolean', description: 'Replace all occurrences' }
      },
      required: ['file_path', 'old_string', 'new_string']
    }
  },
  {
    name: 'NotebookEdit',
    description: 'Edit, insert, or delete a Jupyter notebook cell.',
    inputSchema: {
      type: 'object',
      properties: {
        notebook_path: { type: 'string' },
        file_path: { type: 'string' },
        cell_id: { type: 'string' },
        cell_index: { type: 'number' },
        mode: { type: 'string', enum: ['replace', 'insert', 'delete'] },
        new_source: { type: 'string' },
        source: { type: 'string' },
        cell_type: { type: 'string', enum: ['code', 'markdown', 'raw'] }
      }
    }
  },
  {
    name: 'LS',
    description: 'List files and directories in a given path',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path or relative to the working folder' },
        ignore: { type: 'array', items: { type: 'string' }, description: 'Glob patterns to ignore' }
      }
    }
  },
  {
    name: 'Glob',
    description: 'Fast file pattern matching tool',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern to match files' },
        path: { type: 'string', description: 'Optional search directory' },
        limit: { type: 'number', description: 'Maximum result count' }
      },
      required: ['pattern']
    }
  },
  {
    name: 'Grep',
    description: 'Search file contents using regular expressions',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        path: { type: 'string', description: 'Directory to search in' },
        glob: { type: 'string', description: 'File glob to include' },
        output_mode: {
          type: 'string',
          description: 'matches, files_with_matches, files_without_matches, or count'
        },
        maxResults: { type: 'number', description: 'Maximum result rows to return' },
        ignoreCase: { type: 'boolean', description: 'Use case-insensitive matching' }
      },
      required: ['pattern']
    }
  },
  {
    name: 'Bash',
    description: 'Execute a shell command in the working folder.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command to execute' },
        timeout: { type: 'number', description: 'Timeout in milliseconds' }
      },
      required: ['command']
    }
  },
  {
    name: 'Task',
    description:
      'Launch a focused OpenCowork sub-agent. The child inherits parent tools except Task and returns a self-contained report.',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Short description of the delegated task' },
        prompt: { type: 'string', description: 'Self-contained task brief for the sub-agent' },
        subagent_type: { type: 'string', description: 'Configured agent name; defaults to custom' }
      },
      required: ['description', 'prompt']
    }
  },
  {
    name: 'TaskCreate',
    description: 'Create a task for multi-step work in the current session.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        subject: { type: 'string' },
        description: { type: 'string' },
        activeForm: { type: 'string' }
      }
    }
  },
  {
    name: 'TaskGet',
    description: 'Get one task by ID.',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string' }, task_id: { type: 'string' } }
    }
  },
  {
    name: 'TaskUpdate',
    description: 'Update task status, title, owner, or dependency links.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        task_id: { type: 'string' },
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'blocked', 'in_review', 'completed', 'deleted']
        },
        title: { type: 'string' },
        description: { type: 'string' }
      }
    }
  },
  {
    name: 'TaskList',
    description: 'List all tasks for the current session.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'AskUserQuestion',
    description:
      'Ask the user one to four focused questions when a material choice or requirement is unclear.',
    inputSchema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              question: { type: 'string' },
              header: { type: 'string' },
              options: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string' },
                    description: { type: 'string' }
                  },
                  required: ['label']
                }
              },
              multiSelect: { type: 'boolean' }
            },
            required: ['question']
          }
        }
      },
      required: ['questions']
    }
  },
  {
    name: 'EnterPlanMode',
    description: 'Enter Plan Mode to inspect the workspace and create an implementation plan.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Brief reason for entering plan mode.' }
      }
    }
  },
  {
    name: 'ExitPlanMode',
    description: 'Finalize the current plan file and stop for user review.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'Notify',
    description: 'Send a desktop notification to the user.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Notification title' },
        body: { type: 'string', description: 'Notification body' },
        type: { type: 'string', description: 'Notification style' }
      },
      required: ['title', 'body']
    }
  },
  {
    name: 'Skill',
    description:
      'Load a skill by name to get detailed instructions or domain knowledge for a specialized task.',
    inputSchema: {
      type: 'object',
      properties: {
        SkillName: {
          type: 'string',
          description: 'The name of the skill to load.'
        }
      },
      required: ['SkillName']
    }
  }
]

const WEB_SEARCH_TOOL: SessionToolDefinition = {
  name: 'WebSearch',
  description:
    "Search the web using the user's configured provider. The model cannot choose or override the provider.",
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query to execute' },
      maxResults: { type: 'number', description: 'Maximum number of results to return' }
    },
    required: ['query']
  }
}

const WEB_FETCH_TOOL: SessionToolDefinition = {
  name: 'WebFetch',
  description: 'Fetch one or more URLs and return page content.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'A single URL to fetch' },
      urls: {
        type: 'array',
        items: { type: 'string' },
        description: 'A list of URLs to fetch'
      },
      format: {
        type: 'string',
        enum: ['markdown', 'text', 'html']
      }
    }
  }
}

export function listSessionTools(options: SessionToolCatalogOptions = {}): SessionToolDefinition[] {
  const merged = new Map<string, SessionToolDefinition>(
    CORE_SESSION_TOOLS.map((tool) => [tool.name, tool])
  )
  for (const tool of MEMORY_SESSION_TOOLS) merged.set(tool.name, tool)
  for (const tool of GOAL_SESSION_TOOLS) merged.set(tool.name, tool)
  for (const tool of CRON_SESSION_TOOLS) merged.set(tool.name, tool)
  merged.set(MONITOR_SESSION_TOOL.name, MONITOR_SESSION_TOOL)
  merged.set(WIDGET_SESSION_TOOL.name, WIDGET_SESSION_TOOL)
  if (options.includePowerShell) {
    merged.set(POWERSHELL_SESSION_TOOL.name, POWERSHELL_SESSION_TOOL)
  }
  if (options.teamToolsEnabled) {
    for (const tool of TEAM_SESSION_TOOLS) merged.set(tool.name, tool)
  }
  if (options.webSearchEnabled) {
    merged.set(WEB_SEARCH_TOOL.name, WEB_SEARCH_TOOL)
    merged.set(WEB_FETCH_TOOL.name, WEB_FETCH_TOOL)
  }
  if (options.codegraphEnabled) {
    merged.set(CODEGRAPH_EXPLORE_TOOL.name, CODEGRAPH_EXPLORE_TOOL)
  }
  if (options.browserEnabled) {
    for (const tool of BROWSER_SESSION_TOOLS) merged.set(tool.name, tool)
  }
  if (options.desktopControlEnabled) {
    for (const tool of DESKTOP_SESSION_TOOLS) merged.set(tool.name, tool)
  }
  if (options.imageGenerateEnabled) {
    merged.set(IMAGE_GENERATE_TOOL.name, IMAGE_GENERATE_TOOL)
  }
  if (options.pluginToolsEnabled) {
    for (const tool of PLUGIN_COMMON_SESSION_TOOLS) merged.set(tool.name, tool)
    for (const tool of PLUGIN_CHANNEL_SESSION_TOOLS) merged.set(tool.name, tool)
  }
  for (const tool of options.extraTools ?? []) {
    if (!tool.name.trim()) continue
    merged.set(tool.name, tool)
  }
  return Array.from(merged.values()).sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
  )
}

export function toRuntimeToolCatalogEntries(
  tools: SessionToolDefinition[]
): RuntimeToolCatalogEntry[] {
  return tools.map((tool) => {
    const manifest = createToolManifestV2(tool)
    return {
      toolId: manifest.toolId,
      wireName: manifest.wireName,
      executionLocation: manifest.requiresRenderer ? 'renderer' : 'worker',
      capabilityKind: manifest.source
    }
  })
}

export function buildSkillToolDefinition(
  _skills: Array<{ name: string; description: string }>
): SessionToolDefinition {
  return {
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
  }
}
