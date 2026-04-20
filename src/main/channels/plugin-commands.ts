/**
 * Plugin Command System
 *
 * Handles slash commands sent by users through messaging plugins.
 * Commands are intercepted before the agent loop and handled directly
 * in the main process, replying via the plugin service.
 *
 * Supported commands:
 *   /help     — Show available commands and basic usage
 *   /new      — Clear current session history (fresh conversation)
 *   /init     — Analyze codebase and generate AGENTS.md via agent loop
 *   /status   — Show current plugin status, model, and session info
 *   /compress — Compress context by clearing stale tool results and thinking blocks
 *   /stats   — Show token usage statistics for the current session
 */

import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { app } from 'electron'
import { getDb } from '../db/database'
import type { ChannelManager } from './channel-manager'
import type { ChannelIncomingMessageData, ChannelInstance } from './channel-types'

const PLUGINS_FILE = path.join(os.homedir(), '.open-cowork', 'plugins.json')
const WORKSPACE_MEMORY_TEMPLATE_FILES = ['AGENTS.md', 'SOUL.md', 'USER.md', 'MEMORY.md'] as const

type WorkspaceMemoryTemplateFile = (typeof WORKSPACE_MEMORY_TEMPLATE_FILES)[number]

export interface CommandContext {
  pluginId: string
  pluginType: string
  chatId: string
  data: ChannelIncomingMessageData
  sessionId: string | undefined
  pluginWorkDir: string
  pluginManager: ChannelManager
}

interface CommandResult {
  handled: boolean
  reply?: string
  /**
   * When set, the command is NOT fully handled — instead the message content
   * is rewritten to this value and passed through to the agent loop.
   * This allows commands like /init to delegate work to the full agent.
   */
  rewriteContent?: string
}

type CommandHandler = (ctx: CommandContext, args: string) => CommandResult

function tokenizeSlashCommandArguments(text: string): string[] {
  const normalized = text.trim()
  if (!normalized) return []

  const args: string[] = []
  let current = ''
  let quoteChar: '"' | "'" | null = null
  let escaping = false
  let tokenStarted = false

  for (const char of normalized) {
    if (escaping) {
      current += char
      escaping = false
      tokenStarted = true
      continue
    }

    if (char === '\\') {
      escaping = true
      tokenStarted = true
      continue
    }

    if (quoteChar) {
      if (char === quoteChar) {
        quoteChar = null
      } else {
        current += char
      }
      tokenStarted = true
      continue
    }

    if (char === '"' || char === "'") {
      quoteChar = char
      tokenStarted = true
      continue
    }

    if (/\s/.test(char)) {
      if (tokenStarted) {
        args.push(current)
        current = ''
        tokenStarted = false
      }
      continue
    }

    current += char
    tokenStarted = true
  }

  if (escaping) {
    current += '\\'
  }

  if (tokenStarted) {
    args.push(current)
  }

  return args
}

// ── Command Registry ──

const commands = new Map<string, CommandHandler>()

commands.set('help', handleHelp)
commands.set('new', handleNew)
commands.set('init', handleInit)
commands.set('status', handleStatus)
commands.set('compress', handleCompress)
commands.set('stats', handleStats)

// ── Public API ──

/**
 * Strip leading @mention prefixes from message content.
 * In group chats, messages often arrive as "@BotName /command args".
 * Different platforms use different formats:
 *   - Feishu: "@_user_1 /help" (placeholder keys, usually already stripped)
 *   - DingTalk: "@Bot /help"
 *   - Discord: "<@123456> /help"
 *   - Telegram: "@botname /help"
 *   - Generic: "@Name /help" or "@Name\n/help"
 * This normalizes the content so command parsing works uniformly.
 */
function stripAtMention(content: string): string {
  // Remove leading @mentions in various formats:
  // - @word, @_user_1, @中文名
  // - <@123456> (Discord style)
  // - Multiple consecutive mentions
  let stripped = content.replace(/^(?:<@[^>]+>\s*|@\S+\s*)+/, '').trim()

  // If stripping didn't help and content contains "/" somewhere, try to extract the command
  if (!stripped.startsWith('/') && content.includes('/')) {
    const slashIdx = content.indexOf('/')
    stripped = content.slice(slashIdx).trim()
  }

  return stripped
}

/**
 * Try to handle a slash command from the incoming message.
 * Returns:
 *   - `true`    — command was fully handled (skip agent loop)
 *   - `false`   — not a command, proceed normally
 *   - `string`  — command rewrote the message content; pass this string
 *                  to the agent loop instead of the original message
 */
export function tryHandleCommand(ctx: CommandContext): boolean | string {
  const raw = ctx.data.content?.trim()
  if (!raw) return false

  // Strip @mention prefix for group chat compatibility
  const content = stripAtMention(raw)
  if (!content.startsWith('/')) return false

  console.log(
    `[PluginCommand] Detected command in raw="${raw.slice(0, 80)}" → parsed="${content.slice(0, 80)}"`
  )

  // Parse: "/command args..."
  const spaceIdx = content.indexOf(' ')
  const cmd = (spaceIdx === -1 ? content.slice(1) : content.slice(1, spaceIdx)).toLowerCase()
  const args = spaceIdx === -1 ? '' : content.slice(spaceIdx + 1).trim()

  const handler = commands.get(cmd)
  if (!handler) return false

  const result = handler(ctx, args)

  // Command wants to delegate to the agent loop with rewritten content
  if (result.rewriteContent) {
    // Send an optional acknowledgment reply before handing off to the agent
    if (result.reply) {
      const service = ctx.pluginManager.getService(ctx.pluginId)
      if (service) {
        const send =
          ctx.pluginType === 'qq-bot' && ctx.data.messageId
            ? service.replyMessage(ctx.data.messageId, result.reply)
            : service.sendMessage(ctx.chatId, result.reply)
        send.catch((err) => {
          console.error(`[PluginCommand] Failed to send ack for /${cmd}:`, err)
        })
      }
    }
    console.log(
      `[PluginCommand] /${cmd} delegating to agent loop for plugin ${ctx.pluginId} chat ${ctx.chatId}`
    )
    return result.rewriteContent
  }

  if (!result.handled) return false

  // Send reply via plugin service
  if (result.reply) {
    const service = ctx.pluginManager.getService(ctx.pluginId)
    if (service) {
      const send =
        ctx.pluginType === 'qq-bot' && ctx.data.messageId
          ? service.replyMessage(ctx.data.messageId, result.reply)
          : service.sendMessage(ctx.chatId, result.reply)
      send.catch((err) => {
        console.error(`[PluginCommand] Failed to send reply for /${cmd}:`, err)
      })
    } else {
      console.warn(`[PluginCommand] No service found for plugin ${ctx.pluginId}, cannot reply`)
    }
  }

  console.log(`[PluginCommand] Handled /${cmd} for plugin ${ctx.pluginId} chat ${ctx.chatId}`)
  return true
}

// ── Command Handlers ──

function handleHelp(ctx: CommandContext, args: string): CommandResult {
  void ctx
  void args
  const helpText = [
    '📋 可用指令 / Available Commands',
    '',
    '/help      — 显示此帮助信息',
    '/new       — 清空当前会话，开始新对话',
    '/init [args...] — 初始化 AGENTS/SOUL/USER/MEMORY 并分析项目更新 AGENTS.md',
    '/status    — 查看当前状态信息',
    '/stats     — 查看 Token 用量统计',
    '/compress  — 压缩上下文（清理旧工具结果和思考过程）',
    '',
    '💡 群聊中可使用 @机器人 + 指令，如 "@Bot /help"',
    '直接发送消息即可与 AI 助手对话。'
  ].join('\n')

  return { handled: true, reply: helpText }
}

function handleNew(ctx: CommandContext, args: string): CommandResult {
  void args
  if (!ctx.sessionId) {
    return { handled: true, reply: '当前没有活跃会话。\nNo active session found.' }
  }

  try {
    const db = getDb()
    // Delete all messages for this session
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(ctx.sessionId)
    // Update session title and timestamp
    const now = Date.now()
    db.prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?').run(
      'New Conversation',
      now,
      ctx.sessionId
    )

    console.log(`[PluginCommand] Cleared session ${ctx.sessionId}`)
    return {
      handled: true,
      reply: '✅ 会话已清空，开始新对话。\nSession cleared. Starting fresh.'
    }
  } catch (err) {
    console.error('[PluginCommand] Failed to clear session:', err)
    return {
      handled: true,
      reply: '❌ 清空会话失败，请稍后重试。\nFailed to clear session. Please try again.'
    }
  }
}

function handleInit(ctx: CommandContext, args: string): CommandResult {
  const agentsPath = path.join(ctx.pluginWorkDir, 'AGENTS.md')
  const parsedArgs = tokenizeSlashCommandArguments(args)

  if (!fs.existsSync(ctx.pluginWorkDir)) {
    fs.mkdirSync(ctx.pluginWorkDir, { recursive: true })
  }

  const initialization = initializeWorkspaceMemoryFiles(ctx.pluginWorkDir)
  const hasExistingAgents = initialization.existing.includes('AGENTS.md')

  const initPrompt = buildInitAgentPrompt({
    workDir: ctx.pluginWorkDir,
    agentsPath,
    hasExistingAgents,
    createdFiles: initialization.created,
    existingFiles: initialization.existing,
    rawArgs: args,
    parsedArgs
  })

  const statusLine = [
    initialization.created.length > 0
      ? `🧩 已初始化模板文件: ${initialization.created.join(', ')}`
      : '🧩 模板文件已存在，跳过初始化。',
    hasExistingAgents
      ? '🔄 正在分析项目并更新 AGENTS.md...'
      : '🔍 正在分析项目结构，生成 AGENTS.md...'
  ].join('\n')

  return {
    handled: false,
    reply: `${statusLine}\n${hasExistingAgents ? 'Analyzing project and updating AGENTS.md...' : 'Analyzing project structure to generate AGENTS.md...'}`,
    rewriteContent: initPrompt
  }
}

function handleStatus(ctx: CommandContext, args: string): CommandResult {
  void args
  const lines: string[] = ['📊 当前状态 / Status']

  // Plugin info
  let pluginInstance: ChannelInstance | undefined
  try {
    if (fs.existsSync(PLUGINS_FILE)) {
      const plugins = JSON.parse(fs.readFileSync(PLUGINS_FILE, 'utf-8')) as ChannelInstance[]
      pluginInstance = plugins.find((p) => p.id === ctx.pluginId)
    }
  } catch {
    /* ignore */
  }

  // ── Plugin Basic Info ──
  lines.push('')
  lines.push(`🔌 插件: ${pluginInstance?.name ?? ctx.pluginId}`)
  lines.push(`📡 类型: ${ctx.pluginType}`)
  lines.push(`🆔 ID: ${ctx.pluginId}`)

  // Service status
  const service = ctx.pluginManager.getService(ctx.pluginId)
  const status = ctx.pluginManager.getStatus(ctx.pluginId)
  lines.push(
    `⚡ 运行状态: ${status === 'running' ? '运行中 ✅' : status === 'error' ? '异常 ❌' : '已停止 ⏹'}`
  )

  // ── Model & Provider ──
  lines.push('')
  if (pluginInstance?.providerId) {
    lines.push(`🏢 服务商: ${pluginInstance.providerId}`)
  }
  if (pluginInstance?.model) {
    lines.push(`🤖 模型: ${pluginInstance.model}`)
  } else {
    lines.push(`🤖 模型: 使用全局默认`)
  }

  // ── Features ──
  const features = pluginInstance?.features ?? {
    autoReply: true,
    streamingReply: true,
    autoStart: true
  }
  lines.push('')
  lines.push(`📋 功能开关:`)
  lines.push(`  自动回复: ${features.autoReply ? '✅ 开启' : '❌ 关闭'}`)
  lines.push(
    `  流式回复: ${features.streamingReply && service?.supportsStreaming ? '✅ 开启' : '❌ 关闭'}`
  )
  lines.push(`  自动启动: ${features.autoStart ? '✅ 开启' : '❌ 关闭'}`)

  // ── Permissions ──
  const perms = pluginInstance?.permissions
  if (perms) {
    lines.push('')
    lines.push(`🔒 权限:`)
    lines.push(`  Shell 执行: ${perms.allowShell ? '✅ 允许' : '❌ 禁止'}`)
    lines.push(`  读取主目录: ${perms.allowReadHome ? '✅ 允许' : '❌ 禁止'}`)
    lines.push(`  外部写入: ${perms.allowWriteOutside ? '✅ 允许' : '❌ 禁止'}`)
    lines.push(`  子代理: ${perms.allowSubAgents ? '✅ 允许' : '❌ 禁止'}`)
  }

  // ── Session Info ──
  lines.push('')
  if (ctx.sessionId) {
    try {
      const db = getDb()
      const sessionRow = db
        .prepare('SELECT title, created_at, updated_at FROM sessions WHERE id = ?')
        .get(ctx.sessionId) as { title: string; created_at: number; updated_at: number } | undefined
      const msgCount = db
        .prepare('SELECT COUNT(*) as count FROM messages WHERE session_id = ?')
        .get(ctx.sessionId) as { count: number } | undefined

      lines.push(`💬 会话: ${sessionRow?.title ?? '未命名'}`)
      lines.push(`  消息数: ${msgCount?.count ?? 0}`)
      if (sessionRow?.created_at) {
        lines.push(`  创建时间: ${new Date(sessionRow.created_at).toLocaleString('zh-CN')}`)
      }
      if (sessionRow?.updated_at) {
        lines.push(`  最后活跃: ${new Date(sessionRow.updated_at).toLocaleString('zh-CN')}`)
      }
    } catch {
      /* ignore */
    }
  } else {
    lines.push(`💬 会话: 无活跃会话`)
  }

  // ── Workspace Memory & Working Directory ──
  lines.push('')
  for (const filename of WORKSPACE_MEMORY_TEMPLATE_FILES) {
    const filePath = path.join(ctx.pluginWorkDir, filename)
    lines.push(
      `📝 ${filename}: ${fs.existsSync(filePath) ? '已配置 ✅' : '未初始化（使用 /init 创建）'}`
    )
  }
  lines.push(`📁 工作目录: ${ctx.pluginWorkDir}`)

  // ── System Info ──
  lines.push('')
  lines.push(`🖥️ 系统: ${os.platform()} ${os.release()}`)
  lines.push(`⏰ 当前时间: ${new Date().toLocaleString('zh-CN')}`)

  return { handled: true, reply: lines.join('\n') }
}

function handleCompress(ctx: CommandContext, args: string): CommandResult {
  void args
  if (!ctx.sessionId) {
    return { handled: true, reply: '当前没有活跃会话。\nNo active session found.' }
  }

  try {
    const db = getDb()

    // Fetch all messages for this session
    const rows = db
      .prepare(
        'SELECT id, role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC'
      )
      .all(ctx.sessionId) as Array<{ id: string; role: string; content: string }>

    if (rows.length < 6) {
      return { handled: true, reply: '消息数量较少，无需压缩。\nToo few messages to compress.' }
    }

    // Keep the last 6 messages intact, compress older ones
    const cutoff = rows.length - 6
    let compressedCount = 0

    for (let i = 0; i < cutoff; i++) {
      const row = rows[i]
      let content: unknown
      try {
        content = JSON.parse(row.content)
      } catch {
        continue // plain text, skip
      }

      if (!Array.isArray(content)) continue

      let changed = false
      const newBlocks = (content as Array<Record<string, unknown>>).map((block) => {
        // Clear old tool_result content (keep short ones)
        if (block.type === 'tool_result') {
          const text =
            typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
          if (text.length > 200) {
            changed = true
            return { ...block, content: '[Context compressed — stale tool result cleared]' }
          }
        }
        // Clear old thinking blocks
        if (block.type === 'thinking') {
          changed = true
          return { ...block, thinking: '[Thinking cleared during compression]' }
        }
        return block
      })

      if (changed) {
        db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(
          JSON.stringify(newBlocks),
          row.id
        )
        compressedCount++
      }
    }

    if (compressedCount === 0) {
      return { handled: true, reply: '上下文已经很精简，无需压缩。\nContext is already compact.' }
    }

    console.log(
      `[PluginCommand] Compressed ${compressedCount} messages in session ${ctx.sessionId}`
    )
    return {
      handled: true,
      reply: `✅ 上下文已压缩，清理了 ${compressedCount} 条消息中的旧工具结果和思考过程。\nCompressed ${compressedCount} messages (stale tool results and thinking blocks cleared).`
    }
  } catch (err) {
    console.error('[PluginCommand] Failed to compress context:', err)
    return {
      handled: true,
      reply: '❌ 压缩失败，请稍后重试。\nCompression failed. Please try again.'
    }
  }
}

function getBundledAgentTemplatesDir(): string {
  const isDev = !app.isPackaged
  if (isDev) {
    return path.join(app.getAppPath(), 'resources', 'agents', 'templates')
  }

  const unpackedDir = path.join(
    process.resourcesPath,
    'app.asar.unpacked',
    'resources',
    'agents',
    'templates'
  )
  if (fs.existsSync(unpackedDir)) {
    return unpackedDir
  }

  return path.join(process.resourcesPath, 'resources', 'agents', 'templates')
}

function initializeWorkspaceMemoryFiles(workDir: string): {
  created: WorkspaceMemoryTemplateFile[]
  existing: WorkspaceMemoryTemplateFile[]
} {
  const bundledDir = getBundledAgentTemplatesDir()
  const created: WorkspaceMemoryTemplateFile[] = []
  const existing: WorkspaceMemoryTemplateFile[] = []

  for (const filename of WORKSPACE_MEMORY_TEMPLATE_FILES) {
    const targetPath = path.join(workDir, filename)
    if (fs.existsSync(targetPath)) {
      existing.push(filename)
      continue
    }

    const templatePath = path.join(bundledDir, filename)
    if (!fs.existsSync(templatePath)) {
      console.warn(`[PluginCommand] Missing bundled template: ${templatePath}`)
      continue
    }

    fs.copyFileSync(templatePath, targetPath)
    created.push(filename)
  }

  return { created, existing }
}

function handleStats(ctx: CommandContext, args: string): CommandResult {
  void args
  if (!ctx.sessionId) {
    return { handled: true, reply: '当前没有活跃会话。\nNo active session found.' }
  }

  try {
    const db = getDb()

    // Fetch all assistant messages with usage data for this session
    const rows = db
      .prepare(
        'SELECT usage, created_at FROM messages WHERE session_id = ? AND role = ? AND usage IS NOT NULL ORDER BY created_at ASC'
      )
      .all(ctx.sessionId, 'assistant') as Array<{ usage: string; created_at: number }>

    if (rows.length === 0) {
      return { handled: true, reply: '暂无 Token 用量数据。\nNo token usage data available.' }
    }

    let totalInput = 0
    let totalOutput = 0
    let totalCacheCreation = 0
    let totalCacheRead = 0
    let totalReasoning = 0
    let totalDurationMs = 0
    let requestCount = 0

    for (const row of rows) {
      try {
        const usage = JSON.parse(row.usage) as {
          inputTokens?: number
          outputTokens?: number
          billableInputTokens?: number
          cacheCreationTokens?: number
          cacheReadTokens?: number
          reasoningTokens?: number
          totalDurationMs?: number
          requestTimings?: Array<unknown>
        }
        totalInput += usage.billableInputTokens ?? usage.inputTokens ?? 0
        totalOutput += usage.outputTokens ?? 0
        totalCacheCreation += usage.cacheCreationTokens ?? 0
        totalCacheRead += usage.cacheReadTokens ?? 0
        totalReasoning += usage.reasoningTokens ?? 0
        totalDurationMs += usage.totalDurationMs ?? 0
        requestCount += usage.requestTimings?.length ?? 1
      } catch {
        /* skip malformed usage */
      }
    }

    const totalTokens = totalInput + totalOutput
    const formatNum = (n: number): string => {
      if (n < 1_000) return String(n)
      if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`
      return `${(n / 1_000_000).toFixed(2)}M`
    }

    const lines: string[] = ['📈 Token 用量统计 / Usage Stats']

    lines.push('')
    lines.push(`📊 总计: ${formatNum(totalTokens)} tokens`)
    lines.push(`  输入 (Input):  ${formatNum(totalInput)}`)
    lines.push(`  输出 (Output): ${formatNum(totalOutput)}`)

    if (totalCacheRead > 0 || totalCacheCreation > 0) {
      lines.push('')
      lines.push(`💾 缓存:`)
      if (totalCacheRead > 0) lines.push(`  缓存命中: ${formatNum(totalCacheRead)}`)
      if (totalCacheCreation > 0) lines.push(`  缓存写入: ${formatNum(totalCacheCreation)}`)
    }

    if (totalReasoning > 0) {
      lines.push(`🧠 推理 (Reasoning): ${formatNum(totalReasoning)}`)
    }

    lines.push('')
    lines.push(`🔄 API 调用次数: ${requestCount}`)
    lines.push(`💬 助手回复数: ${rows.length}`)

    if (totalDurationMs > 0) {
      const totalSec = totalDurationMs / 1000
      const tps = totalSec > 0 ? totalTokens / totalSec : 0
      lines.push(
        `⏱️ 总耗时: ${totalSec < 60 ? `${totalSec.toFixed(1)}s` : `${(totalSec / 60).toFixed(1)}min`}`
      )
      lines.push(`⚡ TPS: ${tps.toFixed(1)}`)
    }

    // Session time range
    const firstMsg = rows[0]
    const lastMsg = rows[rows.length - 1]
    if (firstMsg && lastMsg) {
      lines.push('')
      lines.push(`📅 统计范围:`)
      lines.push(`  首次: ${new Date(firstMsg.created_at).toLocaleString('zh-CN')}`)
      lines.push(`  最近: ${new Date(lastMsg.created_at).toLocaleString('zh-CN')}`)
    }

    return { handled: true, reply: lines.join('\n') }
  } catch (err) {
    console.error('[PluginCommand] Failed to get stats:', err)
    return {
      handled: true,
      reply: '❌ 获取统计信息失败。\nFailed to get usage stats.'
    }
  }
}

// ── /init Agent Prompt Builder ──

function buildInitAgentPrompt(options: {
  workDir: string
  agentsPath: string
  hasExistingAgents: boolean
  createdFiles: WorkspaceMemoryTemplateFile[]
  existingFiles: WorkspaceMemoryTemplateFile[]
  rawArgs: string
  parsedArgs: string[]
}): string {
  const {
    workDir,
    agentsPath,
    hasExistingAgents,
    createdFiles,
    existingFiles,
    rawArgs,
    parsedArgs
  } = options
  const existingNote = hasExistingAgents
    ? `There is already an AGENTS.md at \`${agentsPath}\`. Read it first and suggest improvements — preserve any user-customized sections while enhancing the auto-generated parts.`
    : `No AGENTS.md exists yet. Create a new one at \`${agentsPath}\`.`
  const initializedNote =
    createdFiles.length > 0
      ? `The workspace memory templates were just initialized: ${createdFiles.map((file) => `\`${file}\``).join(', ')}. Keep their intent intact. You may lightly tailor AGENTS.md to the repository, but do not overwrite SOUL.md, USER.md, or MEMORY.md unless the user explicitly asked for it.`
      : existingFiles.length > 0
        ? `The workspace already contains memory files: ${existingFiles.map((file) => `\`${file}\``).join(', ')}. Read them before changing anything and preserve user-authored content.`
        : 'No workspace memory files were pre-existing.'
  const argsNote = rawArgs
    ? `The user passed slash-command arguments to /init.
- Raw arguments: ${rawArgs}
- Parsed arguments: ${JSON.stringify(parsedArgs)}
Treat them as explicit scope or preferences for initialization, and honor them when analyzing the workspace.`
    : 'No slash-command arguments were provided.'

  return `[System Command: /init]

Please analyze the codebase in \`${workDir}\` and ${hasExistingAgents ? 'update' : 'create'} an AGENTS.md file.

${existingNote}
${initializedNote}
${argsNote}

**Your task:**
1. Explore the project structure using Glob, Grep, and Read tools. Look at package.json, README.md, config files, source entry points, and key modules.
2. Identify the tech stack, build system, common commands (build, lint, test, dev), and project architecture.
3. ${hasExistingAgents ? 'Update' : 'Write'} the AGENTS.md file at \`${agentsPath}\` with the following structure:

\`\`\`
# AGENTS.md

This file provides guidance to the AI assistant when working with code in this repository.

## Commands
[Common commands: build, lint, test, dev, etc. Include how to run a single test if applicable.]

## Architecture
[High-level code architecture and structure — the "big picture" that requires reading multiple files to understand. Focus on entry points, data flow, key patterns, and module responsibilities.]

## Conventions
[Project-specific conventions: naming, file organization, import patterns, error handling, etc. Only include things that are NOT obvious from the code.]

## Custom Instructions
[Preserve any existing custom instructions from the user, or leave a placeholder for them to fill in.]
\`\`\`

**Rules:**
- Do NOT repeat information that can be easily discovered by reading a single file.
- Do NOT include generic development practices or obvious instructions.
- Do NOT list every component or file — focus on architecture and relationships.
- Do NOT make up information — only include what you can verify from the codebase.
- If there's a README.md, incorporate its important parts (don't duplicate verbatim).
- If there are existing rule files (.cursorrules, .cursor/rules/, .github/copilot-instructions.md, CLAUDE.md), incorporate their important parts.
- Keep it concise and actionable — this file should help an AI assistant be productive quickly.
- Prefix the file with:

\`\`\`
# AGENTS.md

This file provides guidance to the AI assistant when working with code in this repository.
\`\`\`

After writing the file, confirm completion with a brief summary of what was generated.`
}
