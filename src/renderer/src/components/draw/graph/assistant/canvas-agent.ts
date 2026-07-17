import { nanoid } from 'nanoid'
import { runSidecarTextRequest, streamSidecarProviderTurn } from '@renderer/lib/ipc/agent-bridge'
import { isNativeSidecarProviderConfig } from '@renderer/lib/ipc/sidecar-protocol'
import type {
  ContentBlock,
  ProviderConfig,
  ToolDefinition,
  ToolUseBlock,
  UnifiedMessage
} from '@renderer/lib/api/types'
import { screenToWorld } from '../graph-geometry'
import { downstreamNodeIds, upstreamNodeIds, useGraphStore } from '../graph-store'
import { createCanvasNode } from '../node-factory'
import type { GraphActions } from '../graph-actions'
import type { AssistantAction, AssistantActionKind } from './assistant-store'

export const CANVAS_ASSISTANT_SYSTEM_PROMPT = `You are the canvas assistant inside an AI drawing app. The user works on an infinite node-graph canvas. Node kinds: text (prompt notes), image, config ("generate" nodes that read upstream text/images and produce images), video. Edges flow left-to-right: upstream outputs feed downstream inputs.

You can chat and also operate the canvas with tools:
- read_canvas: inspect all nodes, their connections and the current selection. Call it first whenever you need node ids you don't already know.
- create_text_node: add a text/prompt note, optionally connected from existing nodes.
- connect_nodes: wire one node's output into another node's input.
- generate_image: create a prompt text node plus a generate node (optionally fed by reference image nodes) and start an image generation.

Guidelines:
- The user message may include attached context nodes (text and images), labeled with their node ids.
- When writing image prompts, write vivid, concrete English prompts.
- Use tools when the user asks to create nodes, organize the canvas, or generate images; for pure questions just answer.
- Generation runs asynchronously: after generate_image, tell the user it started — never claim it finished.
- Keep answers concise. Reply in the user's language.`

const CANVAS_TOOLS: ToolDefinition[] = [
  {
    name: 'read_canvas',
    description:
      'Read the current canvas graph: all nodes (id, kind, position, text/prompt summary), their input/output connections, and the current selection.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'create_text_node',
    description:
      'Create a new text node on the canvas (used for notes or image-generation prompts). Returns the new node id.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text content of the node' },
        connect_from: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional node ids whose output should connect into this node'
        }
      },
      required: ['text']
    }
  },
  {
    name: 'connect_nodes',
    description: "Connect one node's output into another node's input.",
    inputSchema: {
      type: 'object',
      properties: {
        source_id: { type: 'string', description: 'Upstream node id (output side)' },
        target_id: { type: 'string', description: 'Downstream node id (input side)' }
      },
      required: ['source_id', 'target_id']
    }
  },
  {
    name: 'generate_image',
    description:
      'Start an image generation: creates a text node with the prompt, a connected generate (config) node, optionally wires reference image nodes into it, and runs it. Generation is asynchronous.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The image-generation prompt (English preferred)' },
        reference_node_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional image node ids to use as reference images'
        }
      },
      required: ['prompt']
    }
  }
]

export type CanvasAgentEvent =
  | { type: 'text'; text: string }
  | { type: 'action'; action: AssistantAction }

interface RunCanvasAssistantArgs {
  provider: ProviderConfig
  /** Full request history including the current user message. */
  messages: UnifiedMessage[]
  actions: GraphActions
  signal?: AbortSignal
}

const MAX_TOOL_ROUNDS = 6
const NODE_GAP = 60

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** World point at the center of the current viewport, staggered per placement. */
function viewportAnchor(offsetIndex: number): { x: number; y: number } {
  const { camera, stageSize } = useGraphStore.getState()
  const center = screenToWorld({ x: stageSize.width / 2, y: stageSize.height / 2 }, camera)
  return { x: center.x + offsetIndex * 40, y: center.y + offsetIndex * 40 }
}

function readCanvas(): string {
  const { nodes, edges, selection } = useGraphStore.getState()
  const summary = nodes.map((n) => ({
    id: n.id,
    kind: n.kind,
    x: Math.round(n.x),
    y: Math.round(n.y),
    ...(n.kind === 'text' ? { text: truncate(n.data.text, 300) } : {}),
    ...(n.kind === 'image'
      ? {
          hasImage: !!n.data.src,
          ...(n.data.prompt ? { prompt: truncate(n.data.prompt, 200) } : {}),
          ...(n.data.generating ? { generating: true } : {})
        }
      : {}),
    ...(n.kind === 'config' ? { mode: n.data.mode } : {}),
    inputs: upstreamNodeIds(edges, n.id),
    outputs: downstreamNodeIds(edges, n.id)
  }))
  return JSON.stringify({ nodes: summary, selection })
}

interface ToolOutcome {
  output: string
  isError?: boolean
}

function createTextNodeTool(input: Record<string, unknown>, offsetIndex: number): ToolOutcome {
  const text = typeof input.text === 'string' ? input.text : ''
  if (!text.trim()) return { output: 'Error: text is required', isError: true }
  const graph = useGraphStore.getState()
  const connectFrom = Array.isArray(input.connect_from)
    ? input.connect_from.filter((id): id is string => typeof id === 'string')
    : []
  const sources = graph.nodes.filter((n) => connectFrom.includes(n.id))
  const missing = connectFrom.filter((id) => !sources.some((n) => n.id === id))

  const base = createCanvasNode('text', viewportAnchor(offsetIndex))
  const node = { ...base, kind: 'text' as const, data: { text } }
  if (sources.length > 0) {
    const rightmost = sources.reduce((a, b) => (a.x + a.w > b.x + b.w ? a : b))
    node.x = rightmost.x + rightmost.w + NODE_GAP
    node.y = rightmost.y
  }
  graph.addNode(node, { history: true })
  sources.forEach((s) => graph.addEdge(s.id, node.id, { history: false }))
  return {
    output: JSON.stringify({
      node_id: node.id,
      ...(missing.length > 0 ? { missing_connect_from: missing } : {})
    })
  }
}

function connectNodesTool(input: Record<string, unknown>): ToolOutcome {
  const sourceId = typeof input.source_id === 'string' ? input.source_id : ''
  const targetId = typeof input.target_id === 'string' ? input.target_id : ''
  const graph = useGraphStore.getState()
  const source = graph.nodes.find((n) => n.id === sourceId)
  const target = graph.nodes.find((n) => n.id === targetId)
  if (!source || !target) {
    return {
      output: `Error: ${!source ? `source ${sourceId}` : `target ${targetId}`} not found. Call read_canvas for valid ids.`,
      isError: true
    }
  }
  if (sourceId === targetId)
    return { output: 'Error: cannot connect a node to itself', isError: true }
  graph.addEdge(sourceId, targetId)
  return { output: JSON.stringify({ connected: [sourceId, targetId] }) }
}

function generateImageTool(
  input: Record<string, unknown>,
  offsetIndex: number,
  actions: GraphActions
): ToolOutcome {
  const prompt = typeof input.prompt === 'string' ? input.prompt : ''
  if (!prompt.trim()) return { output: 'Error: prompt is required', isError: true }
  const graph = useGraphStore.getState()
  const refIds = Array.isArray(input.reference_node_ids)
    ? input.reference_node_ids.filter((id): id is string => typeof id === 'string')
    : []
  const refs = graph.nodes.filter((n) => n.kind === 'image' && refIds.includes(n.id))
  const missing = refIds.filter((id) => !refs.some((n) => n.id === id))

  const textBase = createCanvasNode('text', viewportAnchor(offsetIndex))
  const textNode = { ...textBase, kind: 'text' as const, data: { text: prompt } }
  if (refs.length > 0) {
    const rightmost = refs.reduce((a, b) => (a.x + a.w > b.x + b.w ? a : b))
    textNode.x = rightmost.x + rightmost.w + NODE_GAP
    textNode.y = rightmost.y
  }
  const configNode = createCanvasNode('config', { x: 0, y: 0 })
  configNode.x = textNode.x + textNode.w + NODE_GAP
  configNode.y = textNode.y

  graph.addNode(textNode, { history: true })
  graph.addNode(configNode, { history: false })
  graph.addEdge(textNode.id, configNode.id, { history: false })
  refs.forEach((ref) => graph.addEdge(ref.id, configNode.id, { history: false }))
  actions.runConfigNode(configNode.id)
  return {
    output: JSON.stringify({
      status: 'generation started (asynchronous)',
      text_node_id: textNode.id,
      config_node_id: configNode.id,
      ...(missing.length > 0 ? { missing_reference_ids: missing } : {})
    })
  }
}

function executeCanvasTool(
  call: ToolUseBlock,
  actions: GraphActions,
  offsetIndex: number
): ToolOutcome {
  try {
    switch (call.name) {
      case 'read_canvas':
        return { output: readCanvas() }
      case 'create_text_node':
        return createTextNodeTool(call.input, offsetIndex)
      case 'connect_nodes':
        return connectNodesTool(call.input)
      case 'generate_image':
        return generateImageTool(call.input, offsetIndex, actions)
      default:
        return { output: `Error: unknown tool ${call.name}`, isError: true }
    }
  } catch (error) {
    return {
      output: `Error: ${error instanceof Error ? error.message : String(error)}`,
      isError: true
    }
  }
}

/**
 * One assistant turn with canvas tools: streams text deltas, executes tool
 * calls locally against the graph store between provider turns, and loops
 * until the model stops calling tools. Non-native providers fall back to a
 * plain text request without tools.
 */
export async function* runCanvasAssistantTurn(
  args: RunCanvasAssistantArgs
): AsyncGenerator<CanvasAgentEvent> {
  const provider: ProviderConfig = {
    ...args.provider,
    systemPrompt: CANVAS_ASSISTANT_SYSTEM_PROMPT,
    temperature: 0.7
  }

  if (!isNativeSidecarProviderConfig(provider)) {
    const text = await runSidecarTextRequest({
      provider,
      messages: args.messages,
      signal: args.signal
    })
    if (text) yield { type: 'text', text }
    return
  }

  const messages: UnifiedMessage[] = [...args.messages]
  let createdCount = 0

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const toolCalls: ToolUseBlock[] = []
    let turnText = ''

    for await (const event of streamSidecarProviderTurn({
      provider,
      messages,
      tools: CANVAS_TOOLS,
      signal: args.signal
    })) {
      if (args.signal?.aborted) return
      if (event.type === 'text_delta' && event.text) {
        turnText += event.text
        yield { type: 'text', text: event.text }
      } else if (event.type === 'tool_call_end' && event.toolCallId && event.toolName) {
        toolCalls.push({
          type: 'tool_use',
          id: event.toolCallId,
          name: event.toolName,
          input: event.toolCallInput ?? {}
        })
      } else if (event.type === 'error') {
        throw new Error(event.error?.message ?? 'Assistant stream error')
      }
    }

    if (toolCalls.length === 0) return
    if (args.signal?.aborted) return

    messages.push({
      id: nanoid(),
      role: 'assistant',
      content: [
        ...(turnText ? [{ type: 'text', text: turnText } as ContentBlock] : []),
        ...toolCalls
      ],
      createdAt: Date.now()
    })

    const results: ContentBlock[] = []
    for (const call of toolCalls) {
      const outcome = executeCanvasTool(call, args.actions, createdCount)
      if (call.name === 'create_text_node' || call.name === 'generate_image') createdCount++
      yield {
        type: 'action',
        action: { kind: call.name as AssistantActionKind, ok: !outcome.isError }
      }
      results.push({
        type: 'tool_result',
        toolUseId: call.id,
        content: outcome.output,
        ...(outcome.isError ? { isError: true } : {})
      })
    }
    messages.push({ id: nanoid(), role: 'user', content: results, createdAt: Date.now() })
    if (turnText) yield { type: 'text', text: '\n\n' }
  }
}
