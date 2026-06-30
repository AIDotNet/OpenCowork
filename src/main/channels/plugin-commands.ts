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
import { getNativeWorker } from '../lib/native-worker'
import { readChannelPlugins } from './channel-config-store'
import type { ChannelManager } from './channel-manager'
import type { ChannelIncomingMessageData, ChannelInstance } from './channel-types'

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

type CommandHandler = (ctx: CommandContext, args: string) => CommandResult | Promise<CommandResult>

interface NativeMessageCompactResult {
  success: boolean
  totalMessages: number
  compacted: number
  error?: string | null
}

interface NativeSessionResetResult {
  success: boolean
  deletedMessages: number
  updatedAt: number
  error?: string | null
}

interface NativeSessionStatusResult {
  success: boolean
  found: boolean
  title?: string | null
  createdAt?: number | null
  updatedAt?: number | null
  messageCount: number
  error?: string | null
}

interface NativeMessageUsageStatsResult {
  success: boolean
  hasUsage: boolean
  totalInput: number
  totalOutput: number
  totalCacheCreation: number
  totalCacheRead: number
  totalReasoning: number
  totalDurationMs: number
  requestCount: number
  assistantReplies: number
  firstCreatedAt?: number | null
  lastCreatedAt?: number | null
  error?: string | null
}

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
export async function tryHandleCommand(ctx: CommandContext): Promise<boolean | string> {
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

  const result = await handler(ctx, args)

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
    '📋 Available Commands',
    '',
    '/help      — Show this help message',
    '/new       — Clear current session, start new conversation',
    '/init [args...] — Initialize AGENTS/SOUL/USER/MEMORY and analyze project to update AGENTS.md',
    '/status    — Show current status information',
    '/stats     — Show token usage statistics',
    '/compress  — Compress context (clear stale tool results and thinking blocks)',
    '',
    '💡 Use @bot + command in group chats, e.g. "@Bot /help"',
    'Send a message directly to chat with the AI assistant.'
  ].join('\n')

  return { handled: true, reply: helpText }
}

async function handleNew(ctx: CommandContext, args: string): Promise<CommandResult> {
  void args
  if (!ctx.sessionId) {
    return { handled: true, reply: 'No active session found.' }
  }

  try {
    const result = await getNativeWorker().request<NativeSessionResetResult>(
      'db/session-reset-conversation',
      { sessionId: ctx.sessionId },
      120_000
    )
    if (!result.success) {
      throw new Error(result.error || 'Native session reset failed')
    }

    console.log(
      `[PluginCommand] Cleared session ${ctx.sessionId}, removed ${result.deletedMessages} messages`
    )
    return {
      handled: true,
      reply: '✅ Session cleared. Starting fresh.'
    }
  } catch (err) {
    console.error('[PluginCommand] Failed to clear session:', err)
    return {
      handled: true,
      reply: '❌ Failed to clear session. Please try again.'
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
      ? `🧩 Initialized template files: ${initialization.created.join(', ')}`
      : '🧩 Template files already exist, skipping initialization.',
    hasExistingAgents
      ? '🔄 Analyzing project and updating AGENTS.md...'
      : '🔍 Analyzing project structure, generating AGENTS.md...'
  ].join('\n')

  return {
    handled: false,
    reply: `${statusLine}\n${hasExistingAgents ? 'Analyzing project and updating AGENTS.md...' : 'Analyzing project structure to generate AGENTS.md...'}`,
    rewriteContent: initPrompt
  }
}

async function handleStatus(ctx: CommandContext, args: string): Promise<CommandResult> {
  void args
  const lines: string[] = ['📊 Status']

  // Plugin info
  let pluginInstance: ChannelInstance | undefined
  try {
    const plugins = await readChannelPlugins()
    pluginInstance = plugins.find((p) => p.id === ctx.pluginId)
  } catch {
    /* ignore */
  }

  // ── Plugin Basic Info ──
  lines.push('')
  lines.push(`🔌 Plugin: ${pluginInstance?.name ?? ctx.pluginId}`)
  lines.push(`📡 Type: ${ctx.pluginType}`)
  lines.push(`🆔 ID: ${ctx.pluginId}`)

  // Service status
  const service = ctx.pluginManager.getService(ctx.pluginId)
  const status = ctx.pluginManager.getStatus(ctx.pluginId)
  lines.push(
    `⚡ Status: ${status === 'running' ? 'Running ✅' : status === 'error' ? 'Error ❌' : 'Stopped ⏹'}`
  )

  // ── Model & Provider ──
  lines.push('')
  if (pluginInstance?.providerId) {
    lines.push(`🏢 Provider: ${pluginInstance.providerId}`)
  }
  if (pluginInstance?.model) {
    lines.push(`🤖 Model: ${pluginInstance.model}`)
  } else {
    lines.push(`🤖 Model: Using global default`)
  }

  // ── Features ──
  const features = pluginInstance?.features ?? {
    autoReply: true,
    streamingReply: true,
    autoStart: true
  }
  lines.push('')
  lines.push(`📋 Feature Toggles:`)
  lines.push(`  Auto Reply: ${features.autoReply ? '✅ ON' : '❌ OFF'}`)
  lines.push(
    `  Streaming Reply: ${features.streamingReply && service?.supportsStreaming ? '✅ ON' : '❌ OFF'}`
  )
  lines.push(`  Auto Start: ${features.autoStart ? '✅ ON' : '❌ OFF'}`)

  // ── Permissions ──
  const perms = pluginInstance?.permissions
  if (perms) {
    lines.push('')
    lines.push(`🔒 Permissions:`)
    lines.push(`  Shell Execute: ${perms.allowShell ? '✅ Allowed' : '❌ Denied'}`)
    lines.push(`  Read Home: ${perms.allowReadHome ? '✅ Allowed' : '❌ Denied'}`)
    lines.push(`  External Write: ${perms.allowWriteOutside ? '✅ Allowed' : '❌ Denied'}`)
    lines.push(`  Sub-agents: ${perms.allowSubAgents ? '✅ Allowed' : '❌ Denied'}`)
  }

  // ── Session Info ──
  lines.push('')
  if (ctx.sessionId) {
    try {
      const session = await getNativeWorker().request<NativeSessionStatusResult>(
        'db/session-status',
        { sessionId: ctx.sessionId },
        120_000
      )
      if (!session.success) {
        throw new Error(session.error || 'Native session status failed')
      }

      lines.push(`💬 Session: ${session.found ? session.title || 'Untitled' : 'Untitled'}`)
      lines.push(`  Messages: ${session.messageCount}`)
      if (session.createdAt) {
        lines.push(`  Created: ${new Date(session.createdAt).toLocaleString()}`)
      }
      if (session.updatedAt) {
        lines.push(`  Last Active: ${new Date(session.updatedAt).toLocaleString()}`)
      }
    } catch {
      /* ignore */
    }
  } else {
    lines.push(`💬 Session: No active session`)
  }

  // ── Workspace Memory & Working Directory ──
  lines.push('')
  for (const filename of WORKSPACE_MEMORY_TEMPLATE_FILES) {
    const filePath = path.join(ctx.pluginWorkDir, filename)
    lines.push(
      `📝 ${filename}: ${fs.existsSync(filePath) ? 'Configured ✅' : 'Not initialized (use /init to create)'}`
    )
  }
  lines.push(`📁 Working Directory: ${ctx.pluginWorkDir}`)

  // ── System Info ──
  lines.push('')
  lines.push(`🖥️ System: ${os.platform()} ${os.release()}`)
  lines.push(`⏰ Current Time: ${new Date().toLocaleString()}`)

  return { handled: true, reply: lines.join('\n') }
}

async function handleCompress(ctx: CommandContext, args: string): Promise<CommandResult> {
  void args
  if (!ctx.sessionId) {
    return { handled: true, reply: 'No active session found.' }
  }

  try {
    const result = await getNativeWorker().request<NativeMessageCompactResult>(
      'db/messages-compact-session',
      { sessionId: ctx.sessionId },
      120_000
    )
    if (!result.success) {
      throw new Error(result.error || 'Native message compaction failed')
    }

    if (result.totalMessages < 6) {
      return { handled: true, reply: 'Too few messages to compress.' }
    }

    if (result.compacted === 0) {
      return { handled: true, reply: 'Context is already compact.' }
    }

    console.log(
      `[PluginCommand] Compacted ${result.compacted} messages in session ${ctx.sessionId}`
    )
    return {
      handled: true,
      reply: `✅ Context compressed, cleaned ${result.compacted} messages (stale tool results and thinking blocks cleared). Compressed ${result.compacted} messages.`
    }
  } catch (err) {
    console.error('[PluginCommand] Failed to compress context:', err)
    return {
      handled: true,
      reply: '❌ Compression failed. Please try again.'
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

async function handleStats(ctx: CommandContext, args: string): Promise<CommandResult> {
  void args
  if (!ctx.sessionId) {
    return { handled: true, reply: 'No active session found.' }
  }

  try {
    const stats = await getNativeWorker().request<NativeMessageUsageStatsResult>(
      'db/messages-usage-stats',
      { sessionId: ctx.sessionId },
      120_000
    )
    if (!stats.success) {
      throw new Error(stats.error || 'Native message usage stats failed')
    }

    if (!stats.hasUsage) {
      return { handled: true, reply: 'No token usage data available.' }
    }

    const totalTokens = stats.totalInput + stats.totalOutput
    const formatNum = (n: number): string => {
      if (n < 1_000) return String(n)
      if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`
      return `${(n / 1_000_000).toFixed(2)}M`
    }
    const formatPercent = (rate: number): string => {
      const safeRate = Number.isFinite(rate) ? Math.min(1, Math.max(0, rate)) : 0
      const percent = Math.round(safeRate * 1000) / 10
      return `${Number.isInteger(percent) ? percent.toFixed(0) : percent.toFixed(1)}%`
    }

    const lines: string[] = ['📈 Usage Stats']

    lines.push('')
    lines.push(`📊 Total: ${formatNum(totalTokens)} tokens`)
    lines.push(`  Input:  ${formatNum(stats.totalInput)}`)
    lines.push(`  Output: ${formatNum(stats.totalOutput)}`)

    if (stats.totalCacheRead > 0 || stats.totalCacheCreation > 0) {
      lines.push('')
      lines.push(`💾 Cache:`)
      if (stats.totalCacheRead > 0) {
        const cacheTokenShare = stats.totalCacheRead / (stats.totalInput + stats.totalCacheRead)
        lines.push(`  Cache Read: ${formatNum(stats.totalCacheRead)}`)
        lines.push(`  Cached Token Share: ${formatPercent(cacheTokenShare)}`)
      }
      if (stats.totalCacheCreation > 0)
        lines.push(`  Cache Write: ${formatNum(stats.totalCacheCreation)}`)
    }

    if (stats.totalReasoning > 0) {
      lines.push(`🧠 推理 (Reasoning): ${formatNum(stats.totalReasoning)}`)
    }

    lines.push('')
    lines.push(`🔄 API Calls: ${stats.requestCount}`)
    lines.push(`💬 Assistant Replies: ${stats.assistantReplies}`)

    if (stats.totalDurationMs > 0) {
      const totalSec = stats.totalDurationMs / 1000
      const tps = totalSec > 0 ? totalTokens / totalSec : 0
      lines.push(
        `⏱️ Total Time: ${totalSec < 60 ? `${totalSec.toFixed(1)}s` : `${(totalSec / 60).toFixed(1)}min`}`
      )
      lines.push(`⚡ TPS: ${tps.toFixed(1)}`)
    }

    // Session time range
    if (stats.firstCreatedAt && stats.lastCreatedAt) {
      lines.push('')
      lines.push(`📅 Stats Range:`)
      lines.push(`  First: ${new Date(stats.firstCreatedAt).toLocaleString()}`)
      lines.push(`  Latest: ${new Date(stats.lastCreatedAt).toLocaleString()}`)
    }

    return { handled: true, reply: lines.join('\n') }
  } catch (err) {
    console.error('[PluginCommand] Failed to get stats:', err)
    return {
      handled: true,
      reply: '❌ Failed to get usage stats.'
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
[Project-specific conventions: naming, file organization, import patterns, error handling, and code comment expectations. Comments should explain intent, invariants, boundaries, side effects, or non-obvious behavior rather than restating straightforward code. Only include things that are NOT obvious from the code.]

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
