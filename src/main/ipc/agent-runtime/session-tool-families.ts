import type { RuntimeToolDefinitionLike } from '../../../shared/agent-runtime-v2'

type SessionToolDefinition = RuntimeToolDefinitionLike

function objectTool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required?: string[]
): SessionToolDefinition {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties,
      ...(required && required.length > 0 ? { required } : {})
    }
  }
}

export const CODEGRAPH_SYSTEM_GUIDANCE = [
  'CodeGraph is enabled for this workspace. For code retrieval and navigation questions —',
  '"how does X work", "where is Y defined/used", "who calls Z", "what breaks if I change W" —',
  'prefer the codegraph_explore tool FIRST: one call returns ranked, connected source across',
  'files (call paths, callers, impact) and replaces many Read/Grep/Glob rounds.',
  'Use Read/Grep only for exact file contents or when explore reports it is still indexing',
  '(then retry it shortly) or unavailable.'
].join(' ')

export const MEMORY_SESSION_TOOLS: SessionToolDefinition[] = [
  objectTool(
    'MemoryList',
    'List available OpenCowork memory roots. Use before reading memory so citations can distinguish global and project memory.',
    {
      scope: {
        type: 'string',
        enum: ['global', 'project', 'both'],
        description: 'Which memory scope to list. Defaults to both.'
      }
    }
  ),
  objectTool(
    'MemoryRead',
    'Read a scoped OpenCowork memory file. The result includes scope, memoryRootId, path, and numbered lines for citation.',
    {
      scope: { type: 'string', enum: ['global', 'project', 'both'] },
      memoryRootId: { type: 'string', description: 'Specific memory root id from MemoryList' },
      file: {
        type: 'string',
        enum: ['memory_summary.md', 'MEMORY.md', 'USER.md', 'raw_memories.md'],
        description: 'Memory file to read. Defaults to memory_summary.md.'
      }
    }
  ),
  objectTool(
    'MemorySearch',
    'Search scoped OpenCowork memory files. Results include scope, memoryRootId, path, line, and text for citation.',
    {
      query: { type: 'string', description: 'Case-insensitive text to search for' },
      scope: { type: 'string', enum: ['global', 'project', 'both'] },
      limit: { type: 'number', description: 'Maximum matches to return, default 20' }
    },
    ['query']
  )
]

export const GOAL_SESSION_TOOLS: SessionToolDefinition[] = [
  objectTool(
    'get_goal',
    'Get the current goal for this session, including status, budgets, token and elapsed-time usage, and remaining token budget.',
    {}
  ),
  objectTool(
    'create_goal',
    'Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks. Set token_budget only when an explicit token budget is requested. Fails if a goal exists; use update_goal only for status.',
    {
      objective: {
        type: 'string',
        description: 'Required. The concrete objective to start pursuing.'
      },
      token_budget: {
        type: 'number',
        description: 'Optional positive token budget for the new active goal.'
      }
    },
    ['objective']
  ),
  objectTool(
    'update_goal',
    'Update the existing goal. Use this tool only to mark the goal achieved or genuinely blocked.',
    {
      status: {
        type: 'string',
        enum: ['complete', 'blocked'],
        description:
          'Required. complete when the objective is achieved; blocked only after the same blocking condition has recurred.'
      }
    },
    ['status']
  )
]

export const CRON_SESSION_TOOLS: SessionToolDefinition[] = [
  objectTool(
    'CronAdd',
    'Schedule a background Agent task. kind="at" uses relative offsets like "+10m"; kind="every" uses interval ms; kind="cron" uses a 5-field expression. Do not use ISO timestamps for one-shot jobs.',
    {
      name: { type: 'string', description: 'Human-readable name for this job' },
      schedule: {
        type: 'object',
        properties: {
          kind: { type: 'string', description: '"at" | "every" | "cron"' },
          at: {
            type: 'string',
            description: 'Required for kind=at. Relative offset such as "+10m".'
          },
          every: { type: 'number', description: 'Required for kind=every. Interval in ms.' },
          expr: { type: 'string', description: 'Required for kind=cron. 5-field cron expression.' },
          tz: { type: 'string', description: 'IANA timezone. Default UTC.' }
        },
        required: ['kind']
      },
      prompt: { type: 'string', description: 'Task instruction for CronAgent when the job fires.' },
      agentId: { type: 'string' },
      model: { type: 'string' },
      workingFolder: { type: 'string' },
      deliveryMode: { type: 'string' },
      deliveryTarget: { type: 'string' },
      deleteAfterRun: { type: 'boolean' },
      maxIterations: { type: 'number' },
      pluginId: { type: 'string' },
      pluginChatId: { type: 'string' }
    },
    ['name', 'schedule', 'prompt']
  ),
  objectTool(
    'CronCreate',
    'Code-agent-compatible alias for CronAdd. Schedule a background agent task.',
    {
      name: { type: 'string' },
      schedule: { type: 'object' },
      prompt: { type: 'string' }
    },
    ['name', 'schedule', 'prompt']
  ),
  objectTool(
    'CronUpdate',
    'Update an existing cron job. Provide the jobId and a patch object with fields to change.',
    {
      jobId: { type: 'string' },
      patch: { type: 'object' }
    },
    ['jobId', 'patch']
  ),
  objectTool(
    'CronRemove',
    'Remove and delete a scheduled cron job by its ID.',
    { jobId: { type: 'string', description: 'The job ID (e.g. "cron-abc12345")' } },
    ['jobId']
  ),
  objectTool(
    'CronDelete',
    'Code-agent-compatible alias for CronRemove. Delete a scheduled cron job by ID.',
    {
      id: { type: 'string' },
      jobId: { type: 'string' }
    }
  ),
  objectTool(
    'CronList',
    'List all cron jobs with their schedule, status, and execution history.',
    {}
  )
]

export const TEAM_SESSION_TOOLS: SessionToolDefinition[] = [
  objectTool(
    'TeamCreate',
    'Create a new agent team for parallel collaboration. Use this when a task benefits from multiple agents working simultaneously on different aspects.',
    {
      team_name: {
        type: 'string',
        description: 'Short, descriptive name for the team (e.g. "pr-review", "bug-fix-squad")'
      },
      description: { type: 'string', description: 'What this team is working on' },
      default_backend: {
        type: 'string',
        enum: ['in-process'],
        description: 'Optional default backend for teammate execution.'
      }
    },
    ['team_name', 'description']
  ),
  objectTool(
    'SendMessage',
    'Send a message to a teammate, broadcast to all teammates, or send a shutdown request. Use this for inter-agent communication within the team.',
    {
      type: {
        type: 'string',
        enum: [
          'message',
          'broadcast',
          'shutdown_request',
          'shutdown_response',
          'idle_notification',
          'permission_request',
          'permission_response',
          'plan_approval_request',
          'plan_approval_response',
          'team_permission_update',
          'mode_set_request'
        ]
      },
      recipient: { type: 'string' },
      content: { type: 'string' },
      sender: { type: 'string' },
      summary: { type: 'string' }
    },
    ['type', 'content']
  ),
  objectTool(
    'TeamStatus',
    'Get a snapshot of the current team state: all members with their status, all tasks, and recent messages. Non-blocking — returns immediately.',
    {}
  ),
  objectTool(
    'TeamDelete',
    'Delete the active team and clean up all resources. Use this when all tasks are completed and the team is no longer needed.',
    {}
  )
]

export const MONITOR_SESSION_TOOL: SessionToolDefinition = objectTool(
  'Monitor',
  'Run a background command and monitor its output through OpenCowork background tasks.',
  {
    command: { type: 'string', description: 'Command to run in the background' },
    description: { type: 'string', description: 'Short monitor description' }
  },
  ['command']
)

export const POWERSHELL_SESSION_TOOL: SessionToolDefinition = objectTool(
  'PowerShell',
  'Execute a command through Windows PowerShell.',
  {
    command: { type: 'string', description: 'PowerShell command to execute' },
    timeout: { type: 'number', description: 'Timeout in milliseconds' }
  },
  ['command']
)

export const WIDGET_SESSION_TOOL: SessionToolDefinition = objectTool(
  'visualize_show_widget',
  'Show visual content — SVG graphics, diagrams, charts, or interactive HTML widgets — that renders inline alongside your text response.',
  {
    title: {
      type: 'string',
      description: 'Short snake_case identifier for this visual.'
    },
    loading_messages: {
      type: 'array',
      minItems: 1,
      maxItems: 4,
      items: { type: 'string' }
    },
    widget_code: {
      type: 'string',
      description: 'SVG or HTML code to render.'
    }
  },
  ['loading_messages', 'title', 'widget_code']
)

export const CODEGRAPH_EXPLORE_TOOL: SessionToolDefinition = objectTool(
  'codegraph_explore',
  'Explore the indexed code graph for the current project: resolve a symbol or natural-language query into related definitions, callers/callees, and files. Requires the opt-in CodeGraph feature to be enabled.',
  {
    query: {
      type: 'string',
      description: 'A symbol name or natural-language question about the codebase structure.'
    },
    projectPath: {
      type: 'string',
      description: 'Optional absolute path to the project root. Defaults to the working folder.'
    }
  },
  ['query']
)

export function toCodeGraphSessionTool(tool: {
  name?: string
  description?: string
  inputSchema?: Record<string, unknown>
}): SessionToolDefinition | null {
  const name = typeof tool.name === 'string' ? tool.name.trim() : ''
  if (!name) return null
  const properties =
    tool.inputSchema?.properties && typeof tool.inputSchema.properties === 'object'
      ? (tool.inputSchema.properties as Record<string, unknown>)
      : {}
  const required = Array.isArray(tool.inputSchema?.required)
    ? tool.inputSchema.required.filter((item): item is string => typeof item === 'string')
    : undefined
  return objectTool(
    name,
    typeof tool.description === 'string' ? tool.description : '',
    properties,
    required
  )
}

export const toHostedDynamicTool = toCodeGraphSessionTool

export const IMAGE_GENERATE_TOOL: SessionToolDefinition = objectTool(
  'ImageGenerate',
  'Generate images when the user needs visual content. count defaults to 1, max 4.',
  {
    prompt: { type: 'string', description: 'Complete visual prompt aligned with user intent.' },
    count: { type: 'number', description: 'How many images to generate. Defaults to 1, max 4.' },
    reference_images: {
      type: 'array',
      items: { type: 'string' },
      description: 'Optional local image paths used as visual references.'
    },
    size: { type: 'string', enum: ['auto', '1024x1024', '1024x1536', '1536x1024'] },
    quality: { type: 'string', enum: ['auto', 'low', 'medium', 'high'] }
  },
  ['prompt']
)

export const BROWSER_SESSION_TOOLS: SessionToolDefinition[] = [
  objectTool('BrowserNavigate', 'Navigate the built-in browser to a URL or control page history.', {
    url: { type: 'string', description: 'URL to open when action is goto.' },
    action: { type: 'string', description: 'goto, back, forward, or refresh.' }
  }),
  objectTool('BrowserGetContent', 'Extract the current page content as Markdown or HTML.', {
    selector: { type: 'string' },
    type: { type: 'string', description: 'markdown or html' }
  }),
  objectTool('BrowserScreenshot', 'Capture a screenshot of the current browser viewport.', {}),
  objectTool(
    'BrowserSnapshot',
    'List interactive elements on the current page with CSS selectors.',
    {}
  ),
  objectTool(
    'BrowserClick',
    'Click an element on the current page.',
    { selector: { type: 'string' } },
    ['selector']
  ),
  objectTool(
    'BrowserType',
    'Type text into an input on the current page.',
    {
      selector: { type: 'string' },
      text: { type: 'string' },
      clear: { type: 'boolean' },
      submit: { type: 'boolean' }
    },
    ['selector', 'text']
  ),
  objectTool('BrowserScroll', 'Scroll the current page up or down.', {
    direction: { type: 'string' },
    amount: { type: 'number' }
  }),
  objectTool(
    'BrowserEvaluate',
    'Execute JavaScript in the current page and return the result.',
    { code: { type: 'string' } },
    ['code']
  )
]

export const DESKTOP_SESSION_TOOLS: SessionToolDefinition[] = [
  objectTool('DesktopScreenshot', 'Capture a full desktop screenshot.', {
    delayMs: { type: 'number' }
  }),
  objectTool(
    'DesktopClick',
    'Click a desktop coordinate.',
    {
      x: { type: 'number' },
      y: { type: 'number' },
      button: { type: 'string' },
      action: { type: 'string' }
    },
    ['x', 'y']
  ),
  objectTool('DesktopType', 'Type text or send a key/hotkey on the desktop.', {
    text: { type: 'string' },
    key: { type: 'string' },
    hotkey: { type: 'array', items: { type: 'string' } }
  }),
  objectTool('DesktopScroll', 'Scroll on the desktop.', {
    x: { type: 'number' },
    y: { type: 'number' },
    scrollX: { type: 'number' },
    scrollY: { type: 'number' }
  }),
  objectTool('DesktopWait', 'Pause desktop automation briefly.', {
    delayMs: { type: 'number' }
  })
]

export const PLUGIN_COMMON_SESSION_TOOLS: SessionToolDefinition[] = [
  objectTool(
    'PluginSendMessage',
    'Send a message to a chat/group via a messaging channel. Requires approval.',
    {
      plugin_id: { type: 'string' },
      chat_id: { type: 'string' },
      content: { type: 'string' }
    },
    ['plugin_id', 'chat_id', 'content']
  ),
  objectTool(
    'PluginReplyMessage',
    'Reply to a specific message via a messaging channel. Requires approval.',
    {
      plugin_id: { type: 'string' },
      message_id: { type: 'string' },
      content: { type: 'string' }
    },
    ['plugin_id', 'message_id', 'content']
  ),
  objectTool(
    'PluginGetGroupMessages',
    'Get recent messages from a chat/group via a messaging channel.',
    {
      plugin_id: { type: 'string' },
      chat_id: { type: 'string' },
      count: { type: 'number' }
    },
    ['plugin_id', 'chat_id']
  ),
  objectTool(
    'PluginListGroups',
    'List all available groups/chats for a messaging channel.',
    { plugin_id: { type: 'string' } },
    ['plugin_id']
  ),
  objectTool(
    'PluginSummarizeGroup',
    'Get recent messages from a group for summarization.',
    {
      plugin_id: { type: 'string' },
      chat_id: { type: 'string' },
      count: { type: 'number' }
    },
    ['plugin_id', 'chat_id']
  ),
  objectTool('PluginGetCurrentChatMessages', 'Get recent messages from the current channel chat.', {
    plugin_id: { type: 'string' },
    chat_id: { type: 'string' },
    count: { type: 'number' }
  })
]

export const PLUGIN_CHANNEL_SESSION_TOOLS: SessionToolDefinition[] = [
  objectTool(
    'FeishuSendImage',
    'Send an image to a Feishu chat from a local path or URL.',
    {
      plugin_id: { type: 'string' },
      chat_id: { type: 'string' },
      file_path: { type: 'string' }
    },
    ['plugin_id', 'chat_id', 'file_path']
  ),
  objectTool(
    'FeishuSendFile',
    'Send a file to a Feishu chat from a local path or URL.',
    {
      plugin_id: { type: 'string' },
      chat_id: { type: 'string' },
      file_path: { type: 'string' }
    },
    ['plugin_id', 'chat_id', 'file_path']
  ),
  objectTool(
    'FeishuListChatMembers',
    'List members of a Feishu chat.',
    { plugin_id: { type: 'string' }, chat_id: { type: 'string' } },
    ['plugin_id']
  ),
  objectTool(
    'FeishuAtMember',
    'Mention members in a Feishu group chat.',
    {
      plugin_id: { type: 'string' },
      chat_id: { type: 'string' },
      user_ids: { type: 'array', items: { type: 'string' } },
      at_all: { type: 'boolean' },
      text: { type: 'string' }
    },
    ['plugin_id', 'text']
  ),
  objectTool(
    'FeishuSendUrgent',
    'Send urgent push to Feishu message recipients.',
    {
      plugin_id: { type: 'string' },
      message_id: { type: 'string' },
      user_ids: { type: 'array', items: { type: 'string' } }
    },
    ['plugin_id', 'message_id']
  ),
  objectTool(
    'FeishuBitableListApps',
    'List Feishu Bitable apps.',
    { plugin_id: { type: 'string' } },
    ['plugin_id']
  ),
  objectTool(
    'FeishuBitableListTables',
    'List tables in a Feishu Bitable app.',
    { plugin_id: { type: 'string' }, app_token: { type: 'string' } },
    ['plugin_id', 'app_token']
  ),
  objectTool(
    'FeishuBitableListFields',
    'List fields for a Feishu Bitable table.',
    {
      plugin_id: { type: 'string' },
      app_token: { type: 'string' },
      table_id: { type: 'string' }
    },
    ['plugin_id', 'app_token', 'table_id']
  ),
  objectTool(
    'FeishuBitableGetRecords',
    'Get records from a Feishu Bitable table.',
    {
      plugin_id: { type: 'string' },
      app_token: { type: 'string' },
      table_id: { type: 'string' }
    },
    ['plugin_id', 'app_token', 'table_id']
  ),
  objectTool(
    'FeishuBitableCreateRecords',
    'Create records in a Feishu Bitable table.',
    {
      plugin_id: { type: 'string' },
      app_token: { type: 'string' },
      table_id: { type: 'string' },
      records: { type: 'array' }
    },
    ['plugin_id', 'app_token', 'table_id']
  ),
  objectTool(
    'FeishuBitableUpdateRecords',
    'Update records in a Feishu Bitable table.',
    {
      plugin_id: { type: 'string' },
      app_token: { type: 'string' },
      table_id: { type: 'string' },
      records: { type: 'array' }
    },
    ['plugin_id', 'app_token', 'table_id']
  ),
  objectTool(
    'FeishuBitableDeleteRecords',
    'Delete records from a Feishu Bitable table.',
    {
      plugin_id: { type: 'string' },
      app_token: { type: 'string' },
      table_id: { type: 'string' },
      record_ids: { type: 'array', items: { type: 'string' } }
    },
    ['plugin_id', 'app_token', 'table_id']
  ),
  objectTool(
    'WeixinSendImage',
    'Send an image through a Weixin official-account channel.',
    {
      plugin_id: { type: 'string' },
      chat_id: { type: 'string' },
      file_path: { type: 'string' }
    },
    ['plugin_id', 'chat_id', 'file_path']
  ),
  objectTool(
    'WeixinSendFile',
    'Send a file through a Weixin official-account channel.',
    {
      plugin_id: { type: 'string' },
      chat_id: { type: 'string' },
      file_path: { type: 'string' }
    },
    ['plugin_id', 'chat_id', 'file_path']
  )
]
