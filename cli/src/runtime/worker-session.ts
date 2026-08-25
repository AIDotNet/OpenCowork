import { existsSync, readFileSync } from 'node:fs'
import { arch, platform, release } from 'node:os'
import { join } from 'node:path'
import {
  applyOauthClientIdentityHeaders,
  resolveOauthForwardUserAgent
} from '../vendor/oauth-client-identity.js'
import type { ModelSelection, PermissionMode } from '../types.js'
import {
  isRecord,
  loadOpenCoworkConfiguration,
  resolveProviderModel,
  resolveProviderOAuth,
  stringValue,
  type JsonRecord,
  type OpenCoworkConfiguration
} from './provider-catalog.js'
import { createCliCapabilitySnapshot } from './capability-snapshot.js'
import { resolveEffectiveModelContextLength } from '../lib/gpt-context.js'

export interface WorkerToolDefinition {
  name: string
  description: string
  inputSchema: JsonRecord
}

export interface WorkerMessage {
  id: string
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: unknown
  createdAt: number
  usage?: JsonRecord
  providerResponseId?: string
  source?: string | null
  meta?: JsonRecord
}

export interface WorkerSessionOptions {
  appVersion: string
  cwd: string
  effort: string
  model: string
  providerId: string
  permissionMode: PermissionMode
  runId: string
  sessionId: string
  /** Caps agent loop turns for non-interactive runs; 0/undefined means unlimited. */
  maxTurns?: number
  planRevision?: {
    title: string
    filePath?: string
    feedback: string
  }
  planExecution?: {
    filePath?: string
  }
}

export interface WorkerRunRequest extends JsonRecord {
  runtimeProtocolVersion: 2
  rolloutMode: 'v2'
  runId: string
  sessionId: string
  messages: WorkerMessage[]
  requestContextTexts?: string[]
  provider: JsonRecord
  compressionProvider?: JsonRecord
  tools: WorkerToolDefinition[]
  subAgentToolCatalog?: WorkerToolDefinition[]
  webSearch?: JsonRecord
  workingFolder: string
  maxIterations: number
  forceApproval: boolean
  permissionMode: 'default' | 'whitelist' | 'fullAccess'
  maxParallelTools: number
  maxConcurrentSubAgents: number
  captureFinalMessages: true
  sessionMode: 'agent'
  sessionPromptMode: 'code'
  capabilitySnapshot: JsonRecord
}

export interface WorkerCompressionRequest extends JsonRecord {
  focusPrompt?: string
  messages: WorkerMessage[]
  preTokens: number
  preserveCount: 0
  provider: JsonRecord
  trigger: 'manual'
  sessionId?: string
  runId?: string
}

export interface WorkerTitleRequest extends JsonRecord {
  runtimeProtocolVersion: 2
  rolloutMode: 'v2'
  runId: string
  sessionId: string
  messages: WorkerMessage[]
  provider: JsonRecord
  tools: []
  capabilitySnapshot: JsonRecord
  workingFolder: string
  maxIterations: 1
  forceApproval: false
  permissionMode: 'default'
  maxParallelTools: 1
  maxConcurrentSubAgents: 1
  providerTurnOnly: true
  captureFinalMessages: true
  sessionMode: 'agent'
  sessionPromptMode: 'code'
}

export interface WorkerCompressionSettings {
  contextLength: number
  enabled: boolean
  reservedOutputBudget: number
  threshold: number
  triggerTokens: number
}

const DEFAULT_CONTEXT_COMPRESSION_LIMIT = 200_000
const DEFAULT_CONTEXT_COMPRESSION_THRESHOLD = 0.8
const DEFAULT_CONTEXT_COMPRESSION_RESERVED_OUTPUT_TOKENS = 20_000
const CONTEXT_COMPRESSION_AUTO_BUFFER_TOKENS = 13_000

const CORE_TOOL_DEFINITIONS: WorkerToolDefinition[] = [
  {
    name: 'Read',
    description: 'Read a file from the filesystem.',
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
    description:
      'Write a file. Read existing files first and prefer editing existing code over creating files.',
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
    description: 'Perform an exact string replacement in a file that has already been read.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute path or relative to the working folder'
        },
        old_string: { type: 'string', description: 'Exact text to replace' },
        new_string: { type: 'string', description: 'Replacement text' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence' }
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
    description:
      'List files and directories at `path`. Pass a directory path, not a shell `command`.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path or relative to the working folder' },
        ignore: { type: 'array', items: { type: 'string' } },
        hidden: { type: 'boolean' },
        respectGitignore: { type: 'boolean' }
      }
    }
  },
  {
    name: 'Glob',
    description: 'Find files by glob pattern with bounded output.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern to match files' },
        path: { type: 'string', description: 'Optional search directory' },
        hidden: { type: 'boolean' },
        respectGitignore: { type: 'boolean' },
        followSymlinks: { type: 'boolean' },
        maxDepth: { type: 'number' },
        limit: { type: 'number' }
      },
      required: ['pattern']
    }
  },
  {
    name: 'Grep',
    description: 'Search file contents using ripgrep-style regular expressions.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        path: { type: 'string' },
        glob: { type: 'string' },
        output_mode: {
          type: 'string',
          enum: ['content', 'matches', 'files_with_matches', 'files_without_matches', 'count']
        },
        head_limit: { type: 'number' },
        maxResults: { type: 'number' },
        maxDepth: { type: 'number' },
        ignoreCase: { type: 'boolean' },
        literal: { type: 'boolean' },
        context: { type: 'number' },
        beforeContext: { type: 'number' },
        afterContext: { type: 'number' }
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
        timeout: { type: 'number', description: 'Timeout in milliseconds' },
        run_in_background: { type: 'boolean' },
        force_foreground: { type: 'boolean' },
        description: { type: 'string' }
      },
      required: ['command']
    }
  },
  {
    name: 'Task',
    description:
      'Launch a focused OpenCowork sub-agent in the Native Worker. The child receives implementation tools except Task, including Write/Edit/Bash when the parent is restricted, and returns a self-contained report. Use subagent_type="custom" or the name of an agent configured in ~/.open-cowork/agents.',
    inputSchema: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'A short three-to-five-word description of the delegated task'
        },
        prompt: {
          type: 'string',
          description: 'A self-contained task brief for the sub-agent'
        },
        subagent_type: {
          type: 'string',
          description: 'Configured agent name; defaults to custom'
        },
        model: {
          type: 'string',
          description: 'Optional model override on the current provider'
        }
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
        activeForm: { type: 'string' },
        metadata: { type: 'object' }
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
        subject: { type: 'string' },
        description: { type: 'string' },
        activeForm: { type: ['string', 'null'] },
        owner: { type: ['string', 'null'] },
        addBlocks: { type: 'array', items: { type: 'string' } },
        addBlockedBy: { type: 'array', items: { type: 'string' } }
      }
    }
  },
  {
    name: 'TaskList',
    description: 'List all tasks for the current session.',
    inputSchema: { type: 'object', properties: {} }
  }
]

const ASK_USER_TOOL_DEFINITION: WorkerToolDefinition = {
  name: 'AskUserQuestion',
  description:
    'Ask the user one to four focused questions when a material choice or requirement is unclear. ' +
    'The terminal presents the choices and returns structured answers. Do not use this for plan approval; use ExitPlanMode.',
  inputSchema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: 4,
        description: 'Questions to ask the user (1-4).',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'The complete question.' },
            header: { type: 'string', description: 'Short label, at most 12 Unicode characters.' },
            options: {
              type: 'array',
              minItems: 2,
              maxItems: 4,
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string' },
                  description: { type: 'string' },
                  preview: { type: 'string' }
                },
                required: ['label', 'description'],
                additionalProperties: false
              }
            },
            multiSelect: { type: 'boolean', default: false }
          },
          required: ['question', 'header', 'options', 'multiSelect'],
          additionalProperties: false
        }
      },
      answers: {
        type: 'object',
        description: 'Worker-populated structured answers keyed by question index.',
        additionalProperties: true
      },
      annotations: {
        type: 'object',
        description: 'Optional preview and free-text notes keyed by question index.',
        additionalProperties: true
      }
    },
    required: ['questions'],
    additionalProperties: false
  }
}

const ENTER_PLAN_TOOL_DEFINITION: WorkerToolDefinition = {
  name: 'EnterPlanMode',
  description:
    'Enter Plan Mode to inspect the workspace and create a detailed implementation plan in the plan file returned by this tool.',
  inputSchema: {
    type: 'object',
    properties: {
      reason: { type: 'string', description: 'Brief reason for entering plan mode.' }
    },
    additionalProperties: false
  }
}

const EXIT_PLAN_TOOL_DEFINITION: WorkerToolDefinition = {
  name: 'ExitPlanMode',
  description:
    'Finalize the current plan file and stop for user review. Pass the complete plan markdown as `plan` if the plan file has not been written yet. ' +
    'Do not implement changes after calling this tool.',
  inputSchema: {
    type: 'object',
    properties: {
      plan: {
        type: 'string',
        description:
          'Optional. The complete plan in Markdown; written to the plan file when provided.'
      }
    },
    additionalProperties: false
  }
}

export const PLAN_MODE_ALLOWED_TOOLS = [
  'Read',
  'LS',
  'Glob',
  'Grep',
  'Write',
  'Edit',
  'EnterPlanMode',
  'ExitPlanMode',
  'AskUserQuestion',
  'TaskCreate',
  'TaskGet',
  'TaskUpdate',
  'TaskList',
  'Task',
  // Read-only research tools remain available while planning.
  'Skill',
  'WebSearch',
  'WebFetch'
] as const

/**
 * Web tools execute natively in the Worker (AgentRuntimeWebSearchExecutor /
 * AgentRuntimeWebFetchExecutor); the CLI only advertises them and forwards the shared
 * web-search settings in the run request. Schemas mirror the desktop definitions.
 */
export const WEB_SEARCH_TOOL_DEFINITION: WorkerToolDefinition = {
  name: 'WebSearch',
  description:
    "Search the web using the user's configured provider. The model cannot choose or override the provider.",
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query to execute' },
      maxResults: {
        type: 'number',
        description: 'Maximum number of results to return',
        default: 5
      },
      searchMode: {
        type: 'string',
        description: 'Search mode (web, news, etc.)',
        enum: ['web', 'news'],
        default: 'web'
      }
    },
    required: ['query']
  }
}

export const WEB_FETCH_TOOL_DEFINITION: WorkerToolDefinition = {
  name: 'WebFetch',
  description:
    'Fetch one or more URLs and return page content. Accepts url or urls (string or string array) and defaults to markdown.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'A single URL to fetch' },
      urls: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        description: 'A list of URLs to fetch'
      },
      format: {
        type: 'string',
        enum: ['markdown', 'text', 'html'],
        default: 'markdown',
        description: 'Output format, defaults to markdown'
      }
    },
    additionalProperties: false
  }
}

export interface SkillCatalogEntry {
  name: string
  description: string
}

const SKILL_TOOL_DESCRIPTION = `Load a skill by name to get detailed instructions or domain knowledge for a specialized task. Returns the full content of the skill's SKILL.md file as context.

You have access to Skills — curated guides for specific workflows. Available skill names are listed in session turn context, not in this schema.
Only use the Skill tool when the user's request clearly matches a listed skill, or when the user explicitly asks for a skill.
Do not call Skill for ordinary coding, file editing, searching, debugging, or repository navigation requests unless a listed skill is obviously the best fit.

### How to use Skills
1. **Match carefully**: Use a skill only when the request clearly aligns with one of the available skills in the session context.
2. **Load first when relevant**: If a listed skill is clearly applicable, call the Skill tool before other tools.
3. **Read carefully**: After loading, read the Skill's content thoroughly before taking any action.
4. **Follow strictly**: Execute the Skill's instructions step-by-step. Do NOT skip steps, reorder them, or substitute your own approach.
5. **Retry on failure**: If a Skill's script fails, fix the issue and re-run the same script command when appropriate.
6. If the user's message begins with "[Skill: <name>]", immediately call that Skill as your first action.`

/**
 * Skill execution lives in the Worker (AgentRuntimeSkillExecutor, ~/.agents/skills).
 * The schema stays stable across turns so the tools prefix can be pinned; the live
 * catalog is injected as last-user turn context instead.
 */
export function buildSkillToolDefinition(_skills: SkillCatalogEntry[] = []): WorkerToolDefinition {
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

export function buildSkillsTurnContext(skills: readonly SkillCatalogEntry[]): string | null {
  const listed = [...skills]
    .map((skill) => ({
      name: skill.name.trim(),
      description: skill.description.trim()
    }))
    .filter((skill) => skill.name)
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))
  if (listed.length === 0) return null
  return [
    '<system-reminder>',
    'Available Skills:',
    `- Available Skills: ${listed.length}`,
    ...listed.map((skill) => `  - ${skill.name}: ${skill.description}`),
    '  Reminder: If the request matches a listed skill, call the Skill tool first.',
    '</system-reminder>'
  ].join('\n')
}

export function listUnpinnedToolNames(
  pinnedNames: readonly string[],
  currentNames: readonly string[]
): string[] {
  const pinned = new Set(pinnedNames)
  return currentNames.filter((name) => name.trim() && !pinned.has(name))
}

export function buildUnavailableToolsReminder(names: readonly string[]): string | null {
  const unavailable = names.map((name) => name.trim()).filter(Boolean)
  if (unavailable.length === 0) return null
  return [
    '<system-reminder>',
    'The following tools became available after this session started and cannot be called until a new session is opened:',
    unavailable.map((name) => `- \`${name}\``).join('\n'),
    '</system-reminder>'
  ].join('\n')
}

export type CliPromptPrefixPin = {
  identity: string
  systemPrompt: string
  tools: WorkerToolDefinition[]
}

export function cliPromptPrefixIdentity(
  options: Pick<WorkerSessionOptions, 'sessionId' | 'cwd' | 'providerId' | 'model'>
): string {
  return [options.sessionId, options.cwd, options.providerId, options.model].join('\u001f')
}

export function applyCliPromptPrefixPin(
  pin: CliPromptPrefixPin | null,
  identity: string,
  request: WorkerRunRequest
): { pin: CliPromptPrefixPin; unpinnedToolNames: string[] } {
  const currentToolNames = request.tools.map((tool) => tool.name)
  if (pin && pin.identity === identity) {
    request.provider.systemPrompt = pin.systemPrompt
    request.tools = pin.tools
    return {
      pin,
      unpinnedToolNames: listUnpinnedToolNames(
        pin.tools.map((tool) => tool.name),
        currentToolNames
      )
    }
  }
  return {
    pin: {
      identity,
      systemPrompt:
        typeof request.provider.systemPrompt === 'string' ? request.provider.systemPrompt : '',
      tools: request.tools.slice()
    },
    unpinnedToolNames: []
  }
}

/** Shared web-search settings mapped to the Worker's run-request webSearch config. */
export function buildWebSearchRunConfig(settings: JsonRecord): JsonRecord | undefined {
  if (settings.webSearchEnabled !== true) return undefined
  const provider = stringValue(settings.webSearchProvider) || 'tavily'
  const apiKey = stringValue(settings.webSearchApiKey)
  const searchEngine = stringValue(settings.webSearchEngine)
  const maxResults = Number(settings.webSearchMaxResults)
  const timeout = Number(settings.webSearchTimeout)
  return {
    enabled: true,
    provider,
    ...(apiKey ? { apiKey } : {}),
    ...(searchEngine ? { searchEngine } : {}),
    maxResults: Number.isFinite(maxResults) && maxResults > 0 ? Math.floor(maxResults) : 5,
    timeout: Number.isFinite(timeout) && timeout > 0 ? Math.floor(timeout) : 30_000
  }
}

export const CORE_WORKER_TOOL_DEFINITIONS = CORE_TOOL_DEFINITIONS

function mergeToolDefinitions(extraTools: WorkerToolDefinition[]): WorkerToolDefinition[] {
  const merged = new Map<string, WorkerToolDefinition>(
    CORE_TOOL_DEFINITIONS.map((tool) => [tool.name, tool])
  )
  for (const tool of [
    ASK_USER_TOOL_DEFINITION,
    ENTER_PLAN_TOOL_DEFINITION,
    EXIT_PLAN_TOOL_DEFINITION,
    ...extraTools
  ]) {
    if (!tool.name.trim()) continue
    merged.set(tool.name, tool)
  }
  return Array.from(merged.values()).sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
  )
}

function numberValue(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function clampCompressionThreshold(value: unknown): number {
  return Math.min(0.9, Math.max(0.3, numberValue(value, DEFAULT_CONTEXT_COMPRESSION_THRESHOLD)))
}

function resolveCompressionContextLength(model: JsonRecord): number {
  const effective = resolveEffectiveModelContextLength({
    id: stringValue(model.id),
    category: stringValue(model.category),
    contextLength: numberValue(model.contextLength, 0) || undefined,
    enableLongContext: model.enableLongContext === true,
    longContextLength: numberValue(model.longContextLength, 0) || undefined,
    supportsLongContext: model.supportsLongContext === true ? true : undefined
  })
  const configured = Math.max(0, Math.floor(effective ?? numberValue(model.contextLength, 0)))
  if (configured <= DEFAULT_CONTEXT_COMPRESSION_LIMIT) return configured
  return model.enableExtendedContextCompression === false
    ? DEFAULT_CONTEXT_COMPRESSION_LIMIT
    : configured
}

function resolveCompressionReservedOutputBudget(model: JsonRecord): number {
  const maxOutputTokens = Math.max(
    1,
    Math.floor(
      numberValue(model.maxOutputTokens, DEFAULT_CONTEXT_COMPRESSION_RESERVED_OUTPUT_TOKENS)
    )
  )
  return Math.min(DEFAULT_CONTEXT_COMPRESSION_RESERVED_OUTPUT_TOKENS, maxOutputTokens)
}

export function resolveWorkerCompressionSettings(
  configuration: OpenCoworkConfiguration,
  model: JsonRecord
): WorkerCompressionSettings {
  const contextLength = resolveCompressionContextLength(model)
  const threshold = clampCompressionThreshold(configuration.settings.contextCompressionThreshold)
  const reservedOutputBudget = resolveCompressionReservedOutputBudget(model)
  const effectiveWindow = Math.max(1, contextLength - reservedOutputBudget)
  const ratioThreshold = Math.max(1, Math.floor(effectiveWindow * threshold))
  const bufferedThreshold = effectiveWindow - CONTEXT_COMPRESSION_AUTO_BUFFER_TOKENS
  const triggerTokens = Math.max(
    1,
    Math.min(ratioThreshold, bufferedThreshold > 0 ? bufferedThreshold : ratioThreshold)
  )
  return {
    enabled: configuration.settings.contextCompressionEnabled !== false && contextLength > 0,
    contextLength,
    threshold,
    reservedOutputBudget,
    triggerTokens
  }
}

function normalizeProviderType(value: string): string {
  return value
}

function normalizeBaseUrl(value: string, providerType: string): string | undefined {
  const trimmed = value.trim().replace(/\/+$/u, '')
  if (!trimmed) return undefined
  if (providerType === 'anthropic') return trimmed.replace(/\/v1(?:\/messages)?$/iu, '')
  if (providerType === 'gemini-interactions' || providerType === 'vertex-ai') {
    return trimmed.replace(/\/openai$/iu, '')
  }
  return trimmed
}

function currentOauthClientPlatform(): { platform: string; arch: string; release: string } {
  return { platform: platform(), arch: arch(), release: release() }
}

function buildRequestOverrides(
  provider: JsonRecord,
  model: JsonRecord,
  modelId: string
): JsonRecord | undefined {
  const providerOverrides = isRecord(provider.requestOverrides) ? provider.requestOverrides : {}
  const modelOverrides = isRecord(model.requestOverrides) ? model.requestOverrides : {}
  const providerHeaders = isRecord(providerOverrides.headers) ? providerOverrides.headers : {}
  const modelHeaders = isRecord(modelOverrides.headers) ? modelOverrides.headers : {}
  const providerBody = isRecord(providerOverrides.body) ? providerOverrides.body : {}
  const modelBody = isRecord(modelOverrides.body) ? modelOverrides.body : {}
  const omitBodyKeys = new Set<string>()
  for (const overrides of [providerOverrides, modelOverrides]) {
    if (!Array.isArray(overrides.omitBodyKeys)) continue
    for (const value of overrides.omitBodyKeys) {
      if (typeof value === 'string' && value) omitBodyKeys.add(value)
    }
  }
  if (provider.sendTemperature === false || /^gpt-5/iu.test(modelId.split('/').pop() ?? modelId)) {
    omitBodyKeys.add('temperature')
  }
  if (provider.sendMaxOutputTokens === false) {
    for (const key of [
      'max_tokens',
      'max_completion_tokens',
      'max_output_tokens',
      'maxOutputTokens'
    ]) {
      omitBodyKeys.add(key)
    }
  }
  const headers =
    applyOauthClientIdentityHeaders(
      stringValue(provider.builtinId),
      { ...providerHeaders, ...modelHeaders } as Record<string, string>,
      currentOauthClientPlatform()
    ) ?? {}
  const body = { ...providerBody, ...modelBody }
  if (
    Object.keys(headers).length === 0 &&
    Object.keys(body).length === 0 &&
    omitBodyKeys.size === 0
  ) {
    return undefined
  }
  return {
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(Object.keys(body).length > 0 ? { body } : {}),
    ...(omitBodyKeys.size > 0 ? { omitBodyKeys: Array.from(omitBodyKeys) } : {})
  }
}

export function resolveReasoningEffort(
  settings: JsonRecord,
  providerId: string,
  modelId: string,
  requested: string,
  model: JsonRecord
): string {
  const thinking = isRecord(model.thinkingConfig) ? model.thinkingConfig : null
  const levels =
    thinking && Array.isArray(thinking.reasoningEffortLevels)
      ? thinking.reasoningEffortLevels.filter((item): item is string => typeof item === 'string')
      : []
  const byModel = isRecord(settings.reasoningEffortByModel)
    ? stringValue(settings.reasoningEffortByModel[`${providerId}:${modelId}`])
    : ''
  for (const candidate of [
    requested,
    byModel,
    stringValue(thinking?.defaultReasoningEffort),
    stringValue(settings.reasoningEffort),
    'medium'
  ]) {
    if (candidate && (levels.length === 0 || levels.includes(candidate))) return candidate
  }
  return 'medium'
}

export function modelDefaultsToThinking(model: JsonRecord): boolean {
  if (model.supportsThinking !== true) return false
  const thinking = isRecord(model.thinkingConfig) ? model.thinkingConfig : null
  if (!thinking) return false
  const bodyParams = isRecord(thinking.bodyParams) ? thinking.bodyParams : null
  const defaultEffort = stringValue(thinking.defaultReasoningEffort)
  return Boolean(
    (bodyParams && Object.keys(bodyParams).length > 0) ||
    (defaultEffort && defaultEffort !== 'none')
  )
}

export function resolveThinkingEnabled(
  settings: JsonRecord,
  providerId: string,
  modelId: string,
  model: JsonRecord
): boolean {
  if (model.supportsThinking !== true || !isRecord(model.thinkingConfig)) return false
  const overrides = isRecord(settings.thinkingEnabledByModel)
    ? settings.thinkingEnabledByModel
    : null
  const override = overrides?.[`${providerId}:${modelId}`]
  if (typeof override === 'boolean') return override
  if (settings.thinkingEnabled === true) return true
  return modelDefaultsToThinking(model)
}

function buildProvider(
  configuration: OpenCoworkConfiguration,
  options: WorkerSessionOptions
): { provider: JsonRecord; model: JsonRecord; selection: ModelSelection | null } {
  const { settings } = configuration
  const resolution = resolveProviderModel(configuration, {
    providerId: options.providerId,
    modelId: options.model
  })

  if (!resolution) {
    const legacyKey = stringValue(settings.apiKey)
    const legacyType = normalizeProviderType(stringValue(settings.provider) || 'anthropic')
    if (!legacyKey && legacyType !== 'openai-chat') {
      throw new Error(
        'No OpenCowork AI provider is configured. Run /provider or cowork config; the CLI writes ' +
          'credentials to the same ~/.open-cowork provider store used by the desktop app.'
      )
    }
    const legacyModel = options.model || stringValue(settings.model)
    return {
      model: { id: legacyModel },
      selection: null,
      provider: {
        type: legacyType,
        apiKey: legacyKey,
        baseUrl: normalizeBaseUrl(stringValue(settings.baseUrl), legacyType),
        model: legacyModel,
        maxTokens: numberValue(settings.maxTokens, 32_000),
        temperature: numberValue(settings.temperature, 0.7),
        requestTimeoutSeconds: numberValue(settings.apiRequestTimeoutSeconds, 100),
        reasoningEffort: options.effort,
        userAgent: `OpenCowork-CLI/${options.appVersion}`
      }
    }
  }

  const { provider, model, selection } = resolution
  const providerId = stringValue(provider.id)
  const configuredModelId = stringValue(model.id)
  const modelId =
    stringValue(provider.builtinId) === 'copilot-oauth'
      ? resolveCopilotModelId(configuredModelId)
      : configuredModelId
  const providerType = normalizeProviderType(stringValue(model.type) || stringValue(provider.type))
  const requiresApiKey = provider.requiresApiKey !== false
  const oauth = resolveProviderOAuth(provider)
  const channel = isRecord(provider.channel) ? provider.channel : {}
  const apiKey =
    (stringValue(provider.builtinId) === 'copilot-oauth'
      ? stringValue(oauth.copilotAccessToken) || stringValue(oauth.accessToken)
      : '') ||
    stringValue(provider.apiKey) ||
    stringValue(oauth.accessToken) ||
    stringValue(channel.accessToken)
  if (requiresApiKey && !apiKey) {
    throw new Error(
      `The configured OpenCowork provider “${stringValue(provider.name) || providerId}” has no usable credential.`
    )
  }

  const maxTokens = Math.min(
    numberValue(settings.maxTokens, 32_000),
    numberValue(model.maxOutputTokens, Number.POSITIVE_INFINITY)
  )
  const thinkingConfig = isRecord(model.thinkingConfig) ? model.thinkingConfig : undefined
  const providerConfig: JsonRecord = {
    type: providerType,
    apiKey,
    baseUrl: normalizeBaseUrl(
      stringValue(provider.builtinId) === 'copilot-oauth'
        ? stringValue(oauth.copilotApiUrl) ||
            stringValue(provider.baseUrl) ||
            'https://api.githubcopilot.com'
        : stringValue(provider.baseUrl),
      providerType
    ),
    model: modelId,
    category: model.category,
    providerId,
    providerBuiltinId: provider.builtinId,
    requiresApiKey,
    useSystemProxy: provider.useSystemProxy,
    allowInsecureTls: provider.allowInsecureTls,
    requestTimeoutSeconds: numberValue(settings.apiRequestTimeoutSeconds, 100),
    maxTokens: Number.isFinite(maxTokens) ? maxTokens : numberValue(settings.maxTokens, 32_000),
    temperature: numberValue(settings.temperature, 0.7),
    thinkingEnabled: resolveThinkingEnabled(settings, providerId, configuredModelId, model),
    thinkingConfig,
    reasoningEffort: resolveReasoningEffort(settings, providerId, modelId, options.effort, model),
    responseSummary: model.responseSummary,
    enablePromptCache: model.enablePromptCache,
    enableSystemPromptCache: model.enableSystemPromptCache,
    cacheTtl: model.cacheTtl ?? provider.cacheTtl,
    requestOverrides: buildRequestOverrides(provider, model, modelId),
    instructionsPrompt: provider.instructionsPrompt,
    serviceTier:
      stringValue(provider.builtinId) === 'codex-oauth' || settings.fastModeEnabled === true
        ? model.serviceTier
        : undefined,
    builtinSearchEnabled:
      model.supportsBuiltinSearch === true && model.enableBuiltinSearch === true,
    accountId: stringValue(oauth.accountId) || undefined,
    websocketUrl:
      model.supportsWebsocket === true
        ? stringValue(model.websocketUrl) || stringValue(provider.websocketUrl) || undefined
        : undefined,
    websocketMode:
      providerType === 'openai-responses'
        ? model.supportsWebsocket === true
          ? stringValue(model.websocketMode) || stringValue(provider.websocketMode) || 'disabled'
          : 'disabled'
        : undefined,
    userAgent:
      resolveOauthForwardUserAgent(
        stringValue(provider.builtinId),
        stringValue(provider.userAgent),
        currentOauthClientPlatform()
      ) || `OpenCowork-CLI/${options.appVersion}`
  }

  if (providerType === 'openai-responses') {
    providerConfig.responsesImageGeneration = {
      ...(isRecord(model.responsesImageGeneration) ? model.responsesImageGeneration : {}),
      enabled:
        model.supportsImageGeneration === true &&
        isRecord(model.responsesImageGeneration) &&
        model.responsesImageGeneration.enabled === true
    }
  }

  return { provider: stripUndefined(providerConfig), model, selection }
}

function buildConfiguredCompressionProvider(
  configuration: OpenCoworkConfiguration,
  options: WorkerSessionOptions
): JsonRecord | undefined {
  const binding = configuration.settings.contextCompressionModel
  if (!isRecord(binding)) return undefined
  const providerId = stringValue(binding.providerId)
  const modelId = stringValue(binding.modelId)
  if (!providerId || !modelId) return undefined

  try {
    return buildProvider(configuration, { ...options, providerId, model: modelId }).provider
  } catch {
    // Match the desktop behavior: a stale/disabled dedicated binding falls back to the
    // current session provider instead of disabling context compression entirely.
    return undefined
  }
}

function resolveCopilotModelId(modelId: string): string {
  const bare = modelId.split('/').pop()?.trim() || modelId
  const normalized = bare.toLowerCase()
  if (normalized === 'gpt-5-codex' || normalized === 'gpt-5.1-codex') {
    return 'gpt-5.3-codex'
  }
  if (normalized === 'gpt-5' || normalized === 'gpt-5.2') {
    return 'gpt-5.6-sol'
  }
  if (normalized === 'gpt-5.1-codex-mini' || normalized === 'gpt-4.1' || normalized === 'gpt-4o') {
    return 'gpt-5-mini'
  }
  if (normalized === 'gemini-2.5-pro' || normalized === 'gemini-3-flash-preview') {
    return 'gemini-3.7-flash'
  }
  return bare || 'gpt-5.6-sol'
}

function stripUndefined(record: JsonRecord): JsonRecord {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined))
}

function readWorkspaceRules(cwd: string): string {
  const candidates = [join(cwd, '.agents', 'AGENTS.md'), join(cwd, 'AGENTS.md')]
  for (const path of candidates) {
    try {
      if (!existsSync(path)) continue
      const text = readFileSync(path, 'utf8').trim()
      if (text) return text.slice(0, 64 * 1024)
    } catch {
      // Workspace rules are optional context; a read error must not block startup.
    }
  }
  return ''
}

function buildSystemPrompt(options: WorkerSessionOptions, settings: JsonRecord): string {
  const operatingSystem =
    platform() === 'darwin' ? 'macOS' : platform() === 'win32' ? 'Windows' : 'Linux'
  const shell = process.env.SHELL || (platform() === 'win32' ? 'PowerShell' : '/bin/sh')
  const workspaceRules = readWorkspaceRules(options.cwd)
  const userPrompt = stringValue(settings.systemPrompt).trim()
  const codeGraphEnabled = settings.codegraphEnabled === true
  return [
    'You are OpenCoWork, an agentic coding assistant. The terminal is only the user interface; all tools and agent-loop decisions are executed by OpenCowork.Native.Worker.',
    '',
    '## Mode: Code',
    '- Inspect relevant files before editing them.',
    '- Match the repository conventions and make focused, complete changes.',
    '- Use Read/Glob/Grep instead of guessing project structure.',
    '- Use Edit for precise changes and Write only when creating or fully replacing a file.',
    '- Validate changes with the project’s own checks when practical.',
    '- Keep the user informed about material progress, risks, and blockers.',
    '- Use AskUserQuestion for material clarification instead of asking questions in ordinary assistant prose.',
    codeGraphEnabled
      ? '- CodeGraph is enabled for this workspace. For definitions, callers/callees, impact, or code navigation, prefer codegraph_explore before broad Read/Grep/Glob exploration.'
      : '',
    '',
    '## Environment',
    `- Operating system: ${operatingSystem}`,
    `- Shell: ${shell}`,
    `- Working folder: ${options.cwd}`,
    '',
    '## Tool safety',
    '- Respect every worker approval request. Never claim an action ran before its tool result.',
    '- Never expose credentials or add secrets to the repository.',
    '- Treat unrelated workspace changes as user-owned and preserve them.',
    workspaceRules ? `\n<workspace_rules>\n${workspaceRules}\n</workspace_rules>` : '',
    userPrompt ? `\n<user_rules>\n${userPrompt}\n</user_rules>` : ''
  ]
    .filter(Boolean)
    .join('\n')
}

export function buildWorkerTitleRequest(
  options: WorkerSessionOptions,
  prompt: string,
  systemPrompt: string
): WorkerTitleRequest {
  const configuration = loadOpenCoworkConfiguration()
  const { provider } = buildProvider(configuration, options)
  provider.systemPrompt = systemPrompt
  provider.maxTokens = 100
  provider.temperature = 0.3
  provider.sessionId = options.sessionId
  provider.thinkingEnabled = false
  delete provider.thinkingConfig
  delete provider.reasoningEffort
  delete provider.responseSummary
  if (provider.type === 'openai-responses') provider.responsesSessionScope = 'generate-title'

  return {
    runtimeProtocolVersion: 2,
    rolloutMode: 'v2',
    runId: options.runId,
    sessionId: options.sessionId,
    messages: [
      {
        id: `title-user-${options.runId}`,
        role: 'user',
        content: prompt.slice(0, 500),
        createdAt: Date.now()
      }
    ],
    provider,
    tools: [],
    capabilitySnapshot: createCliCapabilitySnapshot({ sessionId: options.sessionId, tools: [] }),
    workingFolder: options.cwd,
    maxIterations: 1,
    forceApproval: false,
    permissionMode: 'default',
    maxParallelTools: 1,
    maxConcurrentSubAgents: 1,
    providerTurnOnly: true,
    captureFinalMessages: true,
    sessionMode: 'agent',
    sessionPromptMode: 'code'
  }
}

export function buildWorkerRunRequest(
  options: WorkerSessionOptions,
  messages: WorkerMessage[],
  extraTools: WorkerToolDefinition[] = [],
  requestContextTexts: string[] = []
): { request: WorkerRunRequest; modelLabel: string } {
  const configuration = loadOpenCoworkConfiguration()
  const { settings } = configuration
  const { provider, model, selection } = buildProvider(configuration, options)
  const compressionSettings = resolveWorkerCompressionSettings(configuration, model)
  const compressionProvider = compressionSettings.enabled
    ? buildConfiguredCompressionProvider(configuration, options)
    : undefined
  provider.systemPrompt = buildSystemPrompt(options, settings)
  provider.sessionId = options.sessionId
  if (provider.type === 'openai-responses') provider.responsesSessionScope = 'agent-main'

  const webSearch = buildWebSearchRunConfig(settings)
  const tools = mergeToolDefinitions([
    ...(webSearch ? [WEB_SEARCH_TOOL_DEFINITION, WEB_FETCH_TOOL_DEFINITION] : []),
    ...extraTools
  ])

  // The terminal status must describe the effective Worker policy. A desktop-global
  // autoApprove flag must not silently turn a CLI session displaying "manual" into fullAccess.
  const autoApprove = options.permissionMode === 'auto'
  const permissionPolicy = isRecord(settings.permissionPolicy)
    ? settings.permissionPolicy
    : undefined
  const capabilitySnapshot = createCliCapabilitySnapshot({
    permissionPolicy,
    sessionId: options.sessionId,
    tools
  })
  const request: WorkerRunRequest = {
    runtimeProtocolVersion: 2,
    rolloutMode: 'v2',
    runId: options.runId,
    sessionId: options.sessionId,
    messages,
    ...(requestContextTexts.length > 0 ? { requestContextTexts } : {}),
    provider,
    ...(compressionProvider ? { compressionProvider } : {}),
    tools,
    ...(tools.length > 0 ? { subAgentToolCatalog: tools } : {}),
    ...(webSearch ? { webSearch } : {}),
    capabilitySnapshot,
    workingFolder: options.cwd,
    maxIterations: options.maxTurns && options.maxTurns > 0 ? options.maxTurns : 0,
    forceApproval: false,
    permissionMode: autoApprove
      ? 'fullAccess'
      : permissionPolicy?.enabled === true
        ? 'whitelist'
        : 'default',
    maxParallelTools: Math.max(1, Math.min(16, numberValue(settings.maxParallelToolCalls, 4))),
    maxConcurrentSubAgents: Math.max(
      1,
      Math.min(16, numberValue(settings.maxConcurrentSubAgents, 4))
    ),
    captureFinalMessages: true,
    sessionMode: 'agent',
    sessionPromptMode: 'code',
    ...(options.permissionMode === 'plan' || options.planRevision ? { planMode: true } : {}),
    ...(options.permissionMode === 'plan' || options.planRevision
      ? {
          planModeAllowedTools: Array.from(
            new Set([
              ...PLAN_MODE_ALLOWED_TOOLS,
              ...tools.map((tool) => tool.name).filter((name) => name.startsWith('codegraph_'))
            ])
          )
        }
      : {}),
    ...(options.planRevision ? { planRevision: options.planRevision } : {}),
    ...(options.planExecution ? { planExecution: options.planExecution } : {}),
    ...(permissionPolicy ? { permissionPolicy } : {}),
    ...(compressionSettings.enabled
      ? {
          compression: {
            enabled: true,
            contextLength: compressionSettings.contextLength,
            threshold: compressionSettings.threshold,
            reservedOutputBudget: compressionSettings.reservedOutputBudget
          }
        }
      : {})
  }

  return {
    request,
    modelLabel: selection?.modelName || stringValue(provider.model) || options.model
  }
}

function findRecentContextTokens(messages: WorkerMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const usage = messages[index]?.usage
    const contextTokens = isRecord(usage) ? numberValue(usage.contextTokens, 0) : 0
    if (contextTokens > 0) return Math.floor(contextTokens)
  }
  return 0
}

export function buildWorkerCompressionRequest(
  options: WorkerSessionOptions,
  messages: WorkerMessage[],
  focusPrompt?: string
): { request: WorkerCompressionRequest; modelLabel: string } {
  const configuration = loadOpenCoworkConfiguration()
  const sessionProvider = buildProvider(configuration, options)
  const provider =
    buildConfiguredCompressionProvider(configuration, options) ?? sessionProvider.provider
  const binding = configuration.settings.contextCompressionModel
  const dedicatedResolution = isRecord(binding)
    ? (() => {
        try {
          return resolveProviderModel(configuration, {
            providerId: stringValue(binding.providerId),
            modelId: stringValue(binding.modelId)
          })
        } catch {
          return null
        }
      })()
    : null
  const normalizedFocus = focusPrompt?.trim()

  return {
    request: {
      provider,
      messages,
      preserveCount: 0,
      trigger: 'manual',
      preTokens: findRecentContextTokens(messages),
      ...(normalizedFocus ? { focusPrompt: normalizedFocus } : {})
    },
    modelLabel:
      dedicatedResolution?.selection.modelName ??
      sessionProvider.selection?.modelName ??
      stringValue(provider.model)
  }
}
