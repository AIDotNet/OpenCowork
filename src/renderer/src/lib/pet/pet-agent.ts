import { nanoid } from 'nanoid'
import { runAgentViaSidecar } from '@renderer/lib/agent/run-agent-via-sidecar'
import { buildSidecarAgentRunRequest } from '@renderer/lib/ipc/sidecar-protocol'
import { buildSystemPrompt } from '@renderer/lib/agent/system-prompt'
import { recordUsageEvent } from '@renderer/lib/usage-analytics'
import { useProviderStore } from '@renderer/stores/provider-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { ensureProviderAuthReady } from '@renderer/lib/auth/provider-auth'
import type {
  ContentBlock,
  TextBlock,
  ToolDefinition,
  UnifiedMessage
} from '@renderer/lib/api/types'

/** Drop <think> reasoning blocks (complete or still streaming) from a reply. */
function stripThinkTags(content: string): string {
  return content.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<think>[\s\S]*$/g, '')
}

export const BUILTIN_PET_PROMPT = `你是 {{name}}，一只住在用户电脑桌面上的卡皮巴拉桌宠。你的性格：淡定、温暖、有点贪吃，喜欢泡温泉和发呆。

规则：
- 用用户的语言回复（用户说中文就用中文，说英文就用英文）。
- 回复要非常简短（一两句话，不超过 60 字），像宠物气泡对话，可以用一点可爱的语气词，但不要过度卖萌。
- 你不是全能助手：可以陪聊、安慰、提醒休息、聊聊今天的状态；专业问题可以简单回答，太复杂的就建议主人去主界面找 AI 同事。
- 永远不要输出 Markdown、代码块或列表，只输出纯文本。

你的当前状态：{{status}}
{{project}}`

export interface PetAgentContext {
  petName: string
  hunger: number
  cleanliness: number
  mood: number
  level: number
  projectName?: string | null
  projectFolder?: string | null
  /** Rendered long-term memory block (see pet-memory buildMemorySection). */
  memorySection?: string | null
}

export function buildPetSystemPrompt(template: string, context: PetAgentContext): string {
  const status = `饱食 ${Math.round(context.hunger)}/100，清洁 ${Math.round(context.cleanliness)}/100，心情 ${Math.round(context.mood)}/100，等级 Lv.${context.level}`
  const project = context.projectName
    ? `你被绑定到主人的项目「${context.projectName}」${context.projectFolder ? `（目录：${context.projectFolder}）` : ''}。你可以使用只读工具（Read、LS、Glob、Grep）查看这个项目里的文件来回答主人的问题；需要查看时直接调用工具，不用征求同意。即使查看了很多文件，最终回复也必须保持简短。`
    : ''
  const rendered = (template.trim() || BUILTIN_PET_PROMPT)
    .replaceAll('{{name}}', context.petName)
    .replaceAll('{{status}}', status)
    .replaceAll('{{project}}', project)
  // Memory travels outside the user-editable template so custom personas
  // keep the remember-directive contract intact.
  return context.memorySection ? `${rendered}\n\n${context.memorySection}` : rendered
}

// Read-only subset of the native tool executor's tools: the pet is a full
// main agent, but it never mutates the project.
const PET_AGENT_TOOLS: ToolDefinition[] = [
  {
    name: 'Read',
    description: 'Read a text file. Returns the file content with line numbers.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to read' },
        offset: { type: 'number', description: '1-based line number to start reading from' },
        limit: { type: 'number', description: 'Maximum number of lines to read' }
      },
      required: ['file_path']
    }
  },
  {
    name: 'LS',
    description: 'List files and directories at the given absolute path.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute directory path to list' }
      },
      required: ['path']
    }
  },
  {
    name: 'Glob',
    description: 'Find files matching a glob pattern.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern, e.g. src/**/*.ts' },
        path: { type: 'string', description: 'Directory to search in (defaults to project root)' }
      },
      required: ['pattern']
    }
  },
  {
    name: 'Grep',
    description: 'Search file contents with a regular expression.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression to search for' },
        path: {
          type: 'string',
          description: 'Directory or file to search (defaults to project root)'
        }
      },
      required: ['pattern']
    }
  }
]

export interface PetChatImage {
  /** base64 without the data-url prefix */
  data: string
  mediaType: string
}

export interface PetChatArgs {
  providerId: string
  modelId: string
  /** Pet persona text, injected per turn as a <system-remind> block. */
  persona: string
  userText: string
  image?: PetChatImage | null
  /** Prior turns, oldest first. The current user message is appended internally. */
  history?: UnifiedMessage[]
  /** Bound project folder; enables the read-only tool set. */
  workingFolder?: string | null
  signal?: AbortSignal
  onDelta?: (text: string) => void
  onToolUse?: (name: string) => void
}

/**
 * One full main-agent turn for the pet: the regular main-agent system prompt
 * and native agent loop, with the pet persona injected via a <system-remind>
 * block in the user message (same pattern as the translation agent), rolling
 * multi-turn history, and — when a project is bound — read-only tools executed
 * by the native worker inside the project's working folder.
 */
export async function runPetChat(args: PetChatArgs): Promise<string> {
  await ensureProviderAuthReady(args.providerId)
  const config = useProviderStore.getState().getProviderConfigById(args.providerId, args.modelId)
  if (!config) throw new Error('pet agent model is not configured')

  const workingFolder = args.workingFolder?.trim() || undefined
  const tools = workingFolder ? PET_AGENT_TOOLS : []

  // The pet IS the main agent: same system prompt as a normal cowork session.
  const systemPrompt = buildSystemPrompt({
    mode: 'cowork',
    workingFolder,
    toolDefs: tools,
    language: useSettingsStore.getState().language
  })

  const personaRemind: TextBlock = {
    type: 'text',
    text: `<system-remind>\n${args.persona}\n</system-remind>`
  }
  const userBlocks: ContentBlock[] = [personaRemind]
  if (args.image) {
    userBlocks.push({
      type: 'image',
      source: { type: 'base64', mediaType: args.image.mediaType, data: args.image.data }
    })
  }
  userBlocks.push({ type: 'text', text: args.userText })

  const messages: UnifiedMessage[] = [
    ...(args.history ?? []),
    { id: nanoid(), role: 'user', content: userBlocks, createdAt: Date.now() }
  ]

  const request = buildSidecarAgentRunRequest({
    messages,
    tools,
    provider: { ...config, systemPrompt, thinkingEnabled: false },
    maxIterations: 8,
    forceApproval: false,
    workingFolder,
    sessionMode: 'chat'
  })
  if (!request) throw new Error('failed to build pet agent request')

  // The final reply is the text of the last iteration (text produced before a
  // tool call belongs to intermediate turns).
  let iterationRaw = ''
  let reply = ''
  for await (const event of runAgentViaSidecar(request, {
    signal: args.signal,
    routeSubAgentEventsToBus: false
  })) {
    if (args.signal?.aborted) break
    switch (event.type) {
      case 'iteration_start':
        iterationRaw = ''
        break
      case 'text_delta':
        if (event.text) {
          iterationRaw += event.text
          reply = stripThinkTags(iterationRaw)
          if (reply.trim()) args.onDelta?.(reply)
        }
        break
      case 'tool_use_generated':
        args.onToolUse?.(event.toolUseBlock.name)
        break
      case 'message_end':
        void recordUsageEvent({
          sourceKind: 'pet-chat',
          providerId: args.providerId,
          modelId: args.modelId,
          usage: event.usage,
          timing: event.timing,
          providerResponseId: event.providerResponseId
        })
        break
      case 'error':
        throw new Error(event.error.message)
      case 'loop_end':
        return reply.trim()
    }
  }
  return reply.trim()
}
