import { toolRegistry } from '../agent/tool-registry'
import type { ToolHandler, ToolContext } from '../tools/tool-types'
import { IPC } from '../ipc/channels'
import { usePluginStore } from '@renderer/stores/plugin-store'

// ── 5 Unified Plugin Tools ──
// All provider-agnostic — route via plugin_id to the correct backend service

function isPluginToolEnabled(pluginId: string, toolName: string): boolean {
  const plugin = usePluginStore.getState().plugins.find((p) => p.id === pluginId)
  if (!plugin?.tools) return true
  const enabled = plugin.tools[toolName]
  return enabled !== false
}

function toolDisabledError(toolName: string): string {
  return JSON.stringify({ error: `Tool "${toolName}" is disabled for this plugin.` })
}

async function execPlugin(
  ctx: ToolContext,
  pluginId: unknown,
  action: string,
  params: Record<string, unknown>,
  toolName: string
): Promise<string> {
  if (!pluginId || typeof pluginId !== 'string') {
    return JSON.stringify({ error: 'Missing or invalid plugin_id. Check the active plugins list.' })
  }
  if (!isPluginToolEnabled(pluginId, toolName)) {
    return toolDisabledError(toolName)
  }
  try {
    const result = await ctx.ipc.invoke(IPC.PLUGIN_EXEC, { pluginId, action, params })
    return JSON.stringify(result)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return JSON.stringify({ error: `Plugin action "${action}" failed: ${msg}` })
  }
}

const pluginSendMessage: ToolHandler = {
  definition: {
    name: 'PluginSendMessage',
    description:
      'Send a message to a chat/group via a messaging plugin (Feishu, DingTalk, etc.). Requires approval.',
    inputSchema: {
      type: 'object',
      properties: {
        plugin_id: { type: 'string', description: 'The plugin instance ID to use' },
        chat_id: { type: 'string', description: 'The chat/group ID to send the message to' },
        content: { type: 'string', description: 'The message content to send' },
      },
      required: ['plugin_id', 'chat_id', 'content'],
    },
  },
  execute: async (input, ctx) => {
    // Delivery-once guard: block duplicate delivery calls within a single cron run
    console.log(`[PluginSendMessage] callerAgent=${ctx.callerAgent}, sharedState=`, JSON.stringify(ctx.sharedState), `pluginId=${input.plugin_id}, chatId=${input.chat_id}`)
    if (ctx.callerAgent === 'CronAgent' && ctx.sharedState?.deliveryUsed) {
      console.warn('[PluginSendMessage] CronAgent already delivered results this run — BLOCKING duplicate call')
      return JSON.stringify({ success: true, skipped: true, reason: 'Already delivered results this run. Only one delivery call is allowed.' })
    }
    // Mark delivery BEFORE sending — prevents race conditions with parallel tool calls
    if (ctx.callerAgent === 'CronAgent' && ctx.sharedState) {
      ctx.sharedState.deliveryUsed = true
      console.log('[PluginSendMessage] Marked deliveryUsed=true BEFORE sending')
    }
    const result = await execPlugin(
      ctx,
      input.plugin_id,
      'sendMessage',
      { chatId: input.chat_id, content: input.content },
      'PluginSendMessage'
    )
    console.log('[PluginSendMessage] Send result:', typeof result === 'string' ? result.slice(0, 200) : result)
    return result
  },
  requiresApproval: () => true,
}

const pluginReplyMessage: ToolHandler = {
  definition: {
    name: 'PluginReplyMessage',
    description:
      'Reply to a specific message via a messaging plugin. Requires approval.',
    inputSchema: {
      type: 'object',
      properties: {
        plugin_id: { type: 'string', description: 'The plugin instance ID to use' },
        message_id: { type: 'string', description: 'The message ID to reply to' },
        content: { type: 'string', description: 'The reply content' },
      },
      required: ['plugin_id', 'message_id', 'content'],
    },
  },
  execute: async (input, ctx) => {
    return execPlugin(
      ctx,
      input.plugin_id,
      'replyMessage',
      { messageId: input.message_id, content: input.content },
      'PluginReplyMessage'
    )
  },
  requiresApproval: () => true,
}

const pluginGetGroupMessages: ToolHandler = {
  definition: {
    name: 'PluginGetGroupMessages',
    description: 'Get recent messages from a chat/group via a messaging plugin.',
    inputSchema: {
      type: 'object',
      properties: {
        plugin_id: { type: 'string', description: 'The plugin instance ID to use' },
        chat_id: { type: 'string', description: 'The chat/group ID to get messages from' },
        count: { type: 'number', description: 'Number of messages to retrieve (default 20)' },
      },
      required: ['plugin_id', 'chat_id'],
    },
  },
  execute: async (input, ctx) => {
    return execPlugin(
      ctx,
      input.plugin_id,
      'getGroupMessages',
      { chatId: input.chat_id, count: input.count ?? 20 },
      'PluginGetGroupMessages'
    )
  },
}

const pluginListGroups: ToolHandler = {
  definition: {
    name: 'PluginListGroups',
    description: 'List all available groups/chats for a messaging plugin.',
    inputSchema: {
      type: 'object',
      properties: {
        plugin_id: { type: 'string', description: 'The plugin instance ID to use' },
      },
      required: ['plugin_id'],
    },
  },
  execute: async (input, ctx) => {
    return execPlugin(ctx, input.plugin_id, 'listGroups', {}, 'PluginListGroups')
  },
}

const pluginSummarizeGroup: ToolHandler = {
  definition: {
    name: 'PluginSummarizeGroup',
    description:
      'Get recent messages from a group and provide them for summarization. Returns raw messages — you should summarize them in your response.',
    inputSchema: {
      type: 'object',
      properties: {
        plugin_id: { type: 'string', description: 'The plugin instance ID to use' },
        chat_id: { type: 'string', description: 'The chat/group ID to summarize' },
        count: {
          type: 'number',
          description: 'Number of recent messages to include (default 50)',
        },
      },
      required: ['plugin_id', 'chat_id'],
    },
  },
  execute: async (input, ctx) => {
    return execPlugin(
      ctx,
      input.plugin_id,
      'getGroupMessages',
      { chatId: input.chat_id, count: input.count ?? 50 },
      'PluginSummarizeGroup'
    )
  },
}

const pluginGetCurrentChatMessages: ToolHandler = {
  definition: {
    name: 'PluginGetCurrentChatMessages',
    description: 'Get recent messages from the current plugin chat session.',
    inputSchema: {
      type: 'object',
      properties: {
        plugin_id: { type: 'string', description: 'The plugin instance ID to use (optional, defaults to current)' },
        chat_id: { type: 'string', description: 'The chat/group ID to read (optional, defaults to current)' },
        count: { type: 'number', description: 'Number of messages to retrieve (default 20)' },
      },
      required: [],
    },
  },
  execute: async (input, ctx) => {
    const pluginId = typeof input.plugin_id === 'string' ? input.plugin_id : ctx.pluginId
    const chatId = typeof input.chat_id === 'string' ? input.chat_id : ctx.pluginChatId
    if (!pluginId || !chatId) {
      return JSON.stringify({ error: 'Missing plugin_id or chat_id. Ensure you are in a plugin chat session.' })
    }
    if (!isPluginToolEnabled(pluginId, 'PluginGetCurrentChatMessages')) {
      return toolDisabledError('PluginGetCurrentChatMessages')
    }
    try {
      const composite = `plugin:${pluginId}:chat:${chatId}`
      const session = await ctx.ipc.invoke(IPC.PLUGIN_SESSIONS_FIND_BY_CHAT, composite) as { id?: string } | null
      if (!session?.id) {
        return JSON.stringify({ error: 'Plugin session not found for this chat.' })
      }
      const rows = await ctx.ipc.invoke(IPC.PLUGIN_SESSIONS_MESSAGES, {
        sessionId: session.id,
        limit: typeof input.count === 'number' ? input.count : 20,
      })
      return JSON.stringify({ sessionId: session.id, messages: rows })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return JSON.stringify({ error: `Failed to load plugin chat messages: ${msg}` })
    }
  },
}

// ── Feishu-specific Media Tools ──

const feishuSendImage: ToolHandler = {
  definition: {
    name: 'FeishuSendImage',
    description:
      'Send an image to a Feishu chat. Accepts either an absolute local file path (e.g. /home/user/pic.png or C:\\Users\\...\\pic.png) or an HTTP/HTTPS URL (e.g. https://example.com/image.png). The tool automatically downloads URLs and uploads the image to Feishu.',
    inputSchema: {
      type: 'object',
      properties: {
        plugin_id: { type: 'string', description: 'The Feishu plugin instance ID' },
        chat_id: { type: 'string', description: 'The Feishu chat ID to send the image to' },
        file_path: { type: 'string', description: 'Absolute local file path OR an HTTP/HTTPS URL pointing to the image' },
      },
      required: ['plugin_id', 'chat_id', 'file_path'],
    },
  },
  execute: async (input, ctx) => {
    if (!isPluginToolEnabled(input.plugin_id as string, 'FeishuSendImage')) {
      return toolDisabledError('FeishuSendImage')
    }
    const result = await ctx.ipc.invoke(IPC.PLUGIN_FEISHU_SEND_IMAGE, {
      pluginId: input.plugin_id,
      chatId: input.chat_id,
      filePath: input.file_path,
    }) as { ok?: boolean; error?: string; messageId?: string }
    if (result?.error) throw new Error(`FeishuSendImage failed: ${result.error}`)
    return JSON.stringify({ ok: true, messageId: result?.messageId })
  },
  requiresApproval: () => true,
}

const feishuSendFile: ToolHandler = {
  definition: {
    name: 'FeishuSendFile',
    description:
      'Send a file to a Feishu chat. Accepts either an absolute local file path (e.g. /home/user/doc.pdf) or an HTTP/HTTPS URL (e.g. https://example.com/report.pdf). The tool automatically downloads URLs, detects the file type from the extension (pdf, doc/docx, xls/xlsx, ppt/pptx, mp4, opus → stream for others), and uploads to Feishu.',
    inputSchema: {
      type: 'object',
      properties: {
        plugin_id: { type: 'string', description: 'The Feishu plugin instance ID' },
        chat_id: { type: 'string', description: 'The Feishu chat ID to send the file to' },
        file_path: { type: 'string', description: 'Absolute local file path OR an HTTP/HTTPS URL pointing to the file' },
        file_type: {
          type: 'string',
          description: 'Override file type: opus, mp4, pdf, doc, xls, ppt, or stream. Omit to auto-detect from extension.',
          enum: ['opus', 'mp4', 'pdf', 'doc', 'xls', 'ppt', 'stream'],
        },
      },
      required: ['plugin_id', 'chat_id', 'file_path'],
    },
  },
  execute: async (input, ctx) => {
    if (!isPluginToolEnabled(input.plugin_id as string, 'FeishuSendFile')) {
      return toolDisabledError('FeishuSendFile')
    }
    const result = await ctx.ipc.invoke(IPC.PLUGIN_FEISHU_SEND_FILE, {
      pluginId: input.plugin_id,
      chatId: input.chat_id,
      filePath: input.file_path,
      fileType: input.file_type,
    }) as { ok?: boolean; error?: string; messageId?: string }
    if (result?.error) throw new Error(`FeishuSendFile failed: ${result.error}`)
    return JSON.stringify({ ok: true, messageId: result?.messageId })
  },
  requiresApproval: () => true,
}

const feishuListChatMembers: ToolHandler = {
  definition: {
    name: 'FeishuListChatMembers',
    description: 'List members in a Feishu chat/group. Returns member IDs for @mentions.',
    inputSchema: {
      type: 'object',
      properties: {
        plugin_id: { type: 'string', description: 'The Feishu plugin instance ID' },
        chat_id: { type: 'string', description: 'The Feishu chat ID (optional, defaults to current)' },
        page_size: { type: 'number', description: 'Page size (1-50, default 50)' },
        page_token: { type: 'string', description: 'Pagination token' },
        member_id_type: {
          type: 'string',
          enum: ['open_id', 'user_id', 'union_id'],
          description: 'Member ID type (default open_id)',
        },
      },
      required: ['plugin_id'],
    },
  },
  execute: async (input, ctx) => {
    if (!isPluginToolEnabled(input.plugin_id as string, 'FeishuListChatMembers')) {
      return toolDisabledError('FeishuListChatMembers')
    }
    const chatId = (input.chat_id as string | undefined) ?? ctx.pluginChatId
    if (!chatId) {
      return JSON.stringify({ error: 'Missing chat_id. Ensure you are in a plugin chat session.' })
    }
    const result = await ctx.ipc.invoke(IPC.PLUGIN_FEISHU_LIST_MEMBERS, {
      pluginId: input.plugin_id,
      chatId,
      pageToken: input.page_token,
      pageSize: input.page_size,
      memberIdType: input.member_id_type,
    })
    return JSON.stringify(result)
  },
}

const feishuAtMember: ToolHandler = {
  definition: {
    name: 'FeishuAtMember',
    description: 'Mention members in a Feishu group chat (group-only). Use FeishuListChatMembers to get open_id values.',
    inputSchema: {
      type: 'object',
      properties: {
        plugin_id: { type: 'string', description: 'The Feishu plugin instance ID' },
        chat_id: { type: 'string', description: 'The Feishu chat ID (optional, defaults to current)' },
        user_ids: { type: 'array', items: { type: 'string' }, description: 'User IDs to mention' },
        at_all: { type: 'boolean', description: 'Mention all members' },
        text: { type: 'string', description: 'Message text to send (without @ tags)' },
      },
      required: ['plugin_id', 'text'],
    },
  },
  execute: async (input, ctx) => {
    if (!isPluginToolEnabled(input.plugin_id as string, 'FeishuAtMember')) {
      return toolDisabledError('FeishuAtMember')
    }
    const fallbackSender = ctx.pluginSenderId ? [ctx.pluginSenderId] : undefined
    const result = await ctx.ipc.invoke(IPC.PLUGIN_FEISHU_SEND_MENTION, {
      pluginId: input.plugin_id,
      chatId: input.chat_id ?? ctx.pluginChatId,
      userIds: input.user_ids ?? fallbackSender,
      atAll: input.at_all ?? false,
      text: input.text,
    }) as { ok?: boolean; error?: string; messageId?: string }
    if (result?.error) throw new Error(`FeishuAtMember failed: ${result.error}`)
    return JSON.stringify({ ok: true, messageId: result?.messageId })
  },
  requiresApproval: () => true,
}

const feishuSendUrgent: ToolHandler = {
  definition: {
    name: 'FeishuSendUrgent',
    description: 'Send urgent push (app/sms) to Feishu message recipients.',
    inputSchema: {
      type: 'object',
      properties: {
        plugin_id: { type: 'string', description: 'The Feishu plugin instance ID' },
        message_id: { type: 'string', description: 'Target message_id for urgent push' },
        user_ids: { type: 'array', items: { type: 'string' }, description: 'User IDs to notify' },
        urgent_types: {
          type: 'array',
          items: { type: 'string', enum: ['app', 'sms'] },
          description: 'Urgent types to send (app, sms)',
        },
      },
      required: ['plugin_id', 'message_id', 'user_ids', 'urgent_types'],
    },
  },
  execute: async (input, ctx) => {
    if (!isPluginToolEnabled(input.plugin_id as string, 'FeishuSendUrgent')) {
      return toolDisabledError('FeishuSendUrgent')
    }
    const result = await ctx.ipc.invoke(IPC.PLUGIN_FEISHU_SEND_URGENT, {
      pluginId: input.plugin_id,
      messageId: input.message_id,
      userIds: input.user_ids,
      urgentTypes: input.urgent_types,
    }) as { ok?: boolean; error?: string }
    if (result?.error) throw new Error(`FeishuSendUrgent failed: ${result.error}`)
    return JSON.stringify({ ok: true })
  },
  requiresApproval: () => true,
}

const feishuBitableListApps: ToolHandler = {
  definition: {
    name: 'FeishuBitableListApps',
    description: 'List accessible Feishu Bitable apps.',
    inputSchema: {
      type: 'object',
      properties: {
        plugin_id: { type: 'string', description: 'The Feishu plugin instance ID' },
      },
      required: ['plugin_id'],
    },
  },
  execute: async (input, ctx) => {
    if (!isPluginToolEnabled(input.plugin_id as string, 'FeishuBitableListApps')) {
      return toolDisabledError('FeishuBitableListApps')
    }
    const result = await ctx.ipc.invoke(IPC.PLUGIN_FEISHU_BITABLE_LIST_APPS, {
      pluginId: input.plugin_id,
    })
    return JSON.stringify(result)
  },
}

const feishuBitableListTables: ToolHandler = {
  definition: {
    name: 'FeishuBitableListTables',
    description: 'List tables in a Feishu Bitable app.',
    inputSchema: {
      type: 'object',
      properties: {
        plugin_id: { type: 'string', description: 'The Feishu plugin instance ID' },
        app_token: { type: 'string', description: 'Bitable app token' },
      },
      required: ['plugin_id', 'app_token'],
    },
  },
  execute: async (input, ctx) => {
    if (!isPluginToolEnabled(input.plugin_id as string, 'FeishuBitableListTables')) {
      return toolDisabledError('FeishuBitableListTables')
    }
    const result = await ctx.ipc.invoke(IPC.PLUGIN_FEISHU_BITABLE_LIST_TABLES, {
      pluginId: input.plugin_id,
      appToken: input.app_token,
    })
    return JSON.stringify(result)
  },
}

const feishuBitableListFields: ToolHandler = {
  definition: {
    name: 'FeishuBitableListFields',
    description: 'List fields for a Feishu Bitable table.',
    inputSchema: {
      type: 'object',
      properties: {
        plugin_id: { type: 'string', description: 'The Feishu plugin instance ID' },
        app_token: { type: 'string', description: 'Bitable app token' },
        table_id: { type: 'string', description: 'Bitable table ID' },
      },
      required: ['plugin_id', 'app_token', 'table_id'],
    },
  },
  execute: async (input, ctx) => {
    if (!isPluginToolEnabled(input.plugin_id as string, 'FeishuBitableListFields')) {
      return toolDisabledError('FeishuBitableListFields')
    }
    const result = await ctx.ipc.invoke(IPC.PLUGIN_FEISHU_BITABLE_LIST_FIELDS, {
      pluginId: input.plugin_id,
      appToken: input.app_token,
      tableId: input.table_id,
    })
    return JSON.stringify(result)
  },
}

const feishuBitableGetRecords: ToolHandler = {
  definition: {
    name: 'FeishuBitableGetRecords',
    description: 'Get records from a Feishu Bitable table.',
    inputSchema: {
      type: 'object',
      properties: {
        plugin_id: { type: 'string', description: 'The Feishu plugin instance ID' },
        app_token: { type: 'string', description: 'Bitable app token' },
        table_id: { type: 'string', description: 'Bitable table ID' },
        filter: { type: 'string', description: 'Optional filter formula' },
        page_size: { type: 'number', description: 'Page size (default 50)' },
        page_token: { type: 'string', description: 'Page token for pagination' },
      },
      required: ['plugin_id', 'app_token', 'table_id'],
    },
  },
  execute: async (input, ctx) => {
    if (!isPluginToolEnabled(input.plugin_id as string, 'FeishuBitableGetRecords')) {
      return toolDisabledError('FeishuBitableGetRecords')
    }
    const result = await ctx.ipc.invoke(IPC.PLUGIN_FEISHU_BITABLE_GET_RECORDS, {
      pluginId: input.plugin_id,
      appToken: input.app_token,
      tableId: input.table_id,
      filter: input.filter,
      pageSize: input.page_size,
      pageToken: input.page_token,
    })
    return JSON.stringify(result)
  },
}

const feishuBitableCreateRecords: ToolHandler = {
  definition: {
    name: 'FeishuBitableCreateRecords',
    description: 'Create records in a Feishu Bitable table.',
    inputSchema: {
      type: 'object',
      properties: {
        plugin_id: { type: 'string', description: 'The Feishu plugin instance ID' },
        app_token: { type: 'string', description: 'Bitable app token' },
        table_id: { type: 'string', description: 'Bitable table ID' },
        records: {
          type: 'array',
          description: 'Records payload array',
          items: { type: 'object', description: 'Record payload object' },
        },
      },
      required: ['plugin_id', 'app_token', 'table_id', 'records'],
    },
  },
  execute: async (input, ctx) => {
    if (!isPluginToolEnabled(input.plugin_id as string, 'FeishuBitableCreateRecords')) {
      return toolDisabledError('FeishuBitableCreateRecords')
    }
    const result = await ctx.ipc.invoke(IPC.PLUGIN_FEISHU_BITABLE_CREATE_RECORDS, {
      pluginId: input.plugin_id,
      appToken: input.app_token,
      tableId: input.table_id,
      records: input.records,
    })
    return JSON.stringify(result)
  },
}

const feishuBitableUpdateRecords: ToolHandler = {
  definition: {
    name: 'FeishuBitableUpdateRecords',
    description: 'Update records in a Feishu Bitable table.',
    inputSchema: {
      type: 'object',
      properties: {
        plugin_id: { type: 'string', description: 'The Feishu plugin instance ID' },
        app_token: { type: 'string', description: 'Bitable app token' },
        table_id: { type: 'string', description: 'Bitable table ID' },
        records: {
          type: 'array',
          description: 'Records payload array',
          items: { type: 'object', description: 'Record payload object' },
        },
      },
      required: ['plugin_id', 'app_token', 'table_id', 'records'],
    },
  },
  execute: async (input, ctx) => {
    if (!isPluginToolEnabled(input.plugin_id as string, 'FeishuBitableUpdateRecords')) {
      return toolDisabledError('FeishuBitableUpdateRecords')
    }
    const result = await ctx.ipc.invoke(IPC.PLUGIN_FEISHU_BITABLE_UPDATE_RECORDS, {
      pluginId: input.plugin_id,
      appToken: input.app_token,
      tableId: input.table_id,
      records: input.records,
    })
    return JSON.stringify(result)
  },
}

const feishuBitableDeleteRecords: ToolHandler = {
  definition: {
    name: 'FeishuBitableDeleteRecords',
    description: 'Delete records from a Feishu Bitable table.',
    inputSchema: {
      type: 'object',
      properties: {
        plugin_id: { type: 'string', description: 'The Feishu plugin instance ID' },
        app_token: { type: 'string', description: 'Bitable app token' },
        table_id: { type: 'string', description: 'Bitable table ID' },
        record_ids: { type: 'array', items: { type: 'string' }, description: 'Record IDs to delete' },
      },
      required: ['plugin_id', 'app_token', 'table_id', 'record_ids'],
    },
  },
  execute: async (input, ctx) => {
    if (!isPluginToolEnabled(input.plugin_id as string, 'FeishuBitableDeleteRecords')) {
      return toolDisabledError('FeishuBitableDeleteRecords')
    }
    const result = await ctx.ipc.invoke(IPC.PLUGIN_FEISHU_BITABLE_DELETE_RECORDS, {
      pluginId: input.plugin_id,
      appToken: input.app_token,
      tableId: input.table_id,
      recordIds: input.record_ids,
    })
    return JSON.stringify(result)
  },
}

const FEISHU_TOOLS: ToolHandler[] = [
  feishuSendImage,
  feishuSendFile,
  feishuListChatMembers,
  feishuAtMember,
  feishuSendUrgent,
  feishuBitableListApps,
  feishuBitableListTables,
  feishuBitableListFields,
  feishuBitableGetRecords,
  feishuBitableCreateRecords,
  feishuBitableUpdateRecords,
  feishuBitableDeleteRecords,
]

const ALL_PLUGIN_TOOLS: ToolHandler[] = [
  pluginSendMessage,
  pluginReplyMessage,
  pluginGetGroupMessages,
  pluginListGroups,
  pluginSummarizeGroup,
  pluginGetCurrentChatMessages,
  ...FEISHU_TOOLS,
]

export const PLUGIN_TOOL_DEFINITIONS = ALL_PLUGIN_TOOLS.map((tool) => ({
  name: tool.definition.name,
  description: tool.definition.description,
}))

let _registered = false

export function registerPluginTools(): void {
  if (_registered) return
  _registered = true
  for (const tool of ALL_PLUGIN_TOOLS) {
    toolRegistry.register(tool)
  }
}

export function unregisterPluginTools(): void {
  if (!_registered) return
  _registered = false
  for (const tool of ALL_PLUGIN_TOOLS) {
    toolRegistry.unregister(tool.definition.name)
  }
}

export function isPluginToolsRegistered(): boolean {
  return _registered
}
