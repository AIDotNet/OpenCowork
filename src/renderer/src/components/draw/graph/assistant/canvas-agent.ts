import { nanoid } from 'nanoid'
import { runSidecarTextRequest } from '@renderer/lib/ipc/agent-bridge'
import {
  buildSidecarAgentRunRequest,
  isNativeSidecarProviderConfig
} from '@renderer/lib/ipc/sidecar-protocol'
import type {
  ProviderConfig,
  ToolDefinition,
  ToolUseBlock,
  UnifiedMessage
} from '@renderer/lib/api/types'
import { runAgentViaSidecar } from '@renderer/lib/agent/run-agent-via-sidecar'
import { buildSystemPrompt } from '@renderer/lib/agent/system-prompt'
import { toolRegistry } from '@renderer/lib/agent/tool-registry'
import { ensureRequestToolCatalogFresh } from '@renderer/lib/tools/dynamic-tool-catalog'
import { useMcpStore } from '@renderer/stores/mcp-store'
import {
  isProviderAvailableForModelSelection,
  useProviderStore
} from '@renderer/stores/provider-store'
import { buildMcpResourceDefinitions, buildMcpToolDefinitions } from '@renderer/lib/mcp/mcp-tools'
import { registerSidecarApprovalHandler } from '@renderer/lib/ipc/sidecar-approval-registry'
import { registerNativeCanvasToolHandler } from '@renderer/lib/ipc/canvas-native-tool-registry'
import type { ImageAttachment } from '@renderer/lib/image-attachments'
import { IPC } from '@renderer/lib/ipc/channels'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { clampScale, fitCamera, screenToWorld, zoomAtPoint } from '../graph-geometry'
import { downstreamNodeIds, upstreamNodeIds, useGraphStore } from '../graph-store'
import { createCanvasNode } from '../node-factory'
import { addImageNodeFromDataUrl } from '../add-image-node'
import type { GraphActions } from '../graph-actions'
import type { CanvasRunResult } from '../graph-actions'
import type {
  BackgroundMode,
  CanvasNode,
  CanvasNodeEventType,
  CanvasNodeKind
} from '../graph-types'
import {
  emitNodeUpdated,
  getCanvasNodeSubscriptionSnapshot,
  getNodeExecution,
  subscribeCanvasNodeEvents,
  unsubscribeCanvasNodeEvents,
  waitForCanvasNodeEvent
} from '../canvas-events'
import { createsTriggerCycle } from '../canvas-triggers'
import {
  deleteProjectGraph,
  exportGraphJson,
  importGraphJson,
  loadProjectGraph,
  saveProjectGraph
} from '../graph-persistence'
import { useProjectsStore } from '../draw-projects-store'
import {
  ensureDrawAgentWorkspace,
  renameDrawAgentWorkspace,
  trashDrawAgentWorkspace
} from '../draw-agent-workspace'
import { cropImage, transformImage, upscaleImageLocal } from '../node-image-ops'
import { useAssetStore } from '../assets/asset-store'
import {
  useAssistantStore,
  type AssistantAction,
  type AssistantActionKind
} from './assistant-store'

export const CANVAS_ASSISTANT_SYSTEM_PROMPT = `You are the senior creative-production controller inside an AI drawing app. The user works on an infinite node graph with text, image, generate-config, and video nodes. Edges flow left-to-right. Your job is to turn real business requirements into production-ready visual work, not merely to expand a short request with decorative adjectives.

## Operating discipline

You can inspect and fully operate nodes, run image/text/video generation, subscribe to node execution events, wait for a run to finish, and manage the canvas. Before starting a new generation workflow, call read_canvas once in the current turn to inspect relevant assets, execution state, and the available provider/model catalog. Always call read_canvas before relying on node ids not supplied in the current user context. Use get_node_status for an immediate state check. For a multi-step run, inspect or subscribe to the returned config node, wait_for_node_event when it is still queued or running, and continue only after success. Never use a failed, cancelled, interrupted, or incomplete result as the input to a later stage. Never claim generation finished unless its status or event says succeeded; if it is only queued or running, say so accurately.

Uploaded images are labeled with attachment ids and selected canvas nodes are labeled with node ids. When the user asks to change, restyle, replace part of, or otherwise modify an existing image, you MUST use edit_image with that image as source_node_id or source_attachment_id. Use generate_media only to create media from scratch; never substitute it for an image edit.

## Business brief and prompt quality

Before generating commercial or business content, extract the factual brief from the user's request, attachments, canvas, workspace files, and relevant connected tools. Identify, when applicable: the product or service, business objective, campaign/use case, target audience, channel and deliverable, value proposition, verified proof points, brand tone, call to action, required elements, forbidden elements, and technical delivery constraints. Pass these details through business_context instead of burying them in vague prose.

Never invent or silently alter prices, discounts, availability, product capabilities, statistics, testimonials, certifications, awards, guarantees, legal claims, logos, brand rules, or other business facts. Ask one concise clarification before generation only when missing information would materially affect commercial correctness or the chosen direction. Otherwise proceed with clearly labeled, conservative creative assumptions; assumptions may cover visual treatment but must not create new business claims.

Write a professional generation prompt that is specific enough for production. Use creative_direction to define the applicable subject/product fidelity, visual style, environment, composition, framing, camera/lens behavior, lighting, palette, materials, typography and copy handling, motion, pacing, continuity, ending, and negative constraints. Preserve exact supplied copy and brand identifiers. Match aspect ratio, resolution, duration, FPS, quality, and safe areas to the actual delivery channel. Avoid mutually contradictory instructions and avoid requesting details the selected model cannot use.

## Reference-first video workflow

Video generation should normally be image-to-video. First look for a suitable uploaded image or successful image node that accurately represents the required subject, product, brand, composition, and aspect ratio. Reuse it through reference_node_ids or reference_attachment_ids. If no suitable reference exists and visual identity or subject consistency matters, generate a high-quality keyframe/reference image first using generate_media with media_type=image. Design that keyframe for the intended video's opening frame, composition, safe areas, and aspect ratio. Wait until the image run succeeds, obtain the successful output image node id, and then pass that id in reference_node_ids to generate_video.

Do not start the video if the keyframe failed or is still running. Use pure text-to-video only when the user explicitly asks for it, when the selected model cannot accept a reference image, or when a reference image would be inappropriate for the requested concept. When using a reference, treat it as the authority for appearance and composition; make the video prompt focus on temporal behavior: subject action, camera motion, shot timing, physical continuity, stable identity, transition behavior, and end frame. Explicitly suppress flicker, warping, unintended morphing, object duplication, disappearing details, unstable text/logo rendering, and abrupt camera jumps when relevant.

You also have Shell, full file tools, Skills, and enabled MCP tools. Relative file and shell paths resolve from this canvas's dedicated workspace. Use Skill when an available skill clearly matches the request. Use MCP when it is the best connected capability. For image, text, and video generation, independently choose the best available compatible provider, model, and parameters when the user has not specified them. Prefer a model that supports reference-image input for video. Explicit user choices always win; never replace them silently.

Destructive operations request user confirmation automatically. If a tool returns denied_by_user, accept the decision and do not retry the operation. Keep answers concise and reply in the user's language.`

const nodeIdArray = {
  type: 'array',
  items: { type: 'string' }
} as const

const stringList = {
  type: 'array',
  items: { type: 'string' }
} as const

const businessContextSchema = {
  type: 'object',
  description:
    'Factual business and delivery requirements. Include only user-supplied or otherwise verified facts; label non-factual creative assumptions separately.',
  properties: {
    product_or_service: { type: 'string' },
    objective: { type: 'string' },
    campaign_or_use_case: { type: 'string' },
    audience: { type: 'string' },
    channel: { type: 'string' },
    deliverable: { type: 'string' },
    value_proposition: { type: 'string' },
    verified_facts: stringList,
    proof_points: stringList,
    brand_tone: { type: 'string' },
    call_to_action: { type: 'string' },
    required_elements: stringList,
    forbidden_elements: stringList,
    assumptions: {
      ...stringList,
      description:
        'Conservative creative assumptions only; never use this field to invent prices, claims, capabilities, certifications, or other business facts.'
    }
  }
} as const

const creativeDirectionSchema = {
  type: 'object',
  description: 'Concrete production direction appropriate to the selected media type and channel.',
  properties: {
    subject_and_product_fidelity: { type: 'string' },
    visual_style: { type: 'string' },
    environment: { type: 'string' },
    composition: { type: 'string' },
    camera: { type: 'string' },
    motion: { type: 'string' },
    lighting: { type: 'string' },
    color_palette: { type: 'string' },
    materials_and_texture: { type: 'string' },
    typography_and_copy: { type: 'string' },
    pacing: { type: 'string' },
    continuity: { type: 'string' },
    ending: { type: 'string' },
    audio: { type: 'string' },
    negative_prompt: { type: 'string' }
  }
} as const

const CANVAS_TOOLS: ToolDefinition[] = [
  {
    name: 'read_canvas',
    description:
      'Read nodes, edges, triggers, selection, execution states, view, active project, and available generation provider/model catalog.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_node_status',
    description: 'Return the current execution snapshot for one node.',
    inputSchema: {
      type: 'object',
      properties: { node_id: { type: 'string' } },
      required: ['node_id']
    }
  },
  {
    name: 'subscribe_node',
    description: 'Subscribe to execution events for one node. Returns a subscription id.',
    inputSchema: {
      type: 'object',
      properties: {
        node_id: { type: 'string' },
        events: { type: 'array', items: { type: 'string' } }
      },
      required: ['node_id', 'events']
    }
  },
  {
    name: 'wait_for_node_event',
    description: 'Wait for the next event from a subscription, then continue the workflow.',
    inputSchema: {
      type: 'object',
      properties: {
        subscription_id: { type: 'string' },
        timeout_ms: { type: 'number', description: '0-600000; defaults to 600000' }
      },
      required: ['subscription_id']
    }
  },
  {
    name: 'create_node',
    description: 'Create a text, image, config, or video node and optionally connect sources.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['text', 'image', 'config', 'video'] },
        text: { type: 'string' },
        prompt: { type: 'string' },
        mode: { type: 'string', enum: ['image', 'text', 'video'] },
        provider_id: { type: 'string' },
        model_id: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        connect_from: nodeIdArray
      },
      required: ['kind']
    }
  },
  {
    name: 'update_node',
    description: 'Update node content, generation options, model, position, or size.',
    inputSchema: {
      type: 'object',
      properties: {
        node_id: { type: 'string' },
        patch: { type: 'object', description: 'Safe node fields to update' }
      },
      required: ['node_id', 'patch']
    }
  },
  {
    name: 'delete_nodes',
    description: 'Delete nodes and their connected edges. Requires confirmation.',
    inputSchema: {
      type: 'object',
      properties: { node_ids: nodeIdArray },
      required: ['node_ids']
    }
  },
  {
    name: 'duplicate_nodes',
    description: 'Duplicate nodes and internal edges.',
    inputSchema: {
      type: 'object',
      properties: { node_ids: nodeIdArray },
      required: ['node_ids']
    }
  },
  {
    name: 'connect_nodes',
    description: 'Connect an upstream node to a downstream node.',
    inputSchema: {
      type: 'object',
      properties: { source_id: { type: 'string' }, target_id: { type: 'string' } },
      required: ['source_id', 'target_id']
    }
  },
  {
    name: 'disconnect_nodes',
    description: 'Remove an edge by edge id or by source and target ids.',
    inputSchema: {
      type: 'object',
      properties: {
        edge_id: { type: 'string' },
        source_id: { type: 'string' },
        target_id: { type: 'string' }
      }
    }
  },
  {
    name: 'move_nodes',
    description: 'Move nodes by a delta or place one node at an absolute position.',
    inputSchema: {
      type: 'object',
      properties: {
        node_ids: nodeIdArray,
        dx: { type: 'number' },
        dy: { type: 'number' },
        x: { type: 'number' },
        y: { type: 'number' }
      },
      required: ['node_ids']
    }
  },
  {
    name: 'resize_node',
    description: 'Resize a node.',
    inputSchema: {
      type: 'object',
      properties: {
        node_id: { type: 'string' },
        width: { type: 'number' },
        height: { type: 'number' }
      },
      required: ['node_id', 'width', 'height']
    }
  },
  {
    name: 'select_nodes',
    description: 'Select nodes and optionally focus them in the viewport.',
    inputSchema: {
      type: 'object',
      properties: { node_ids: nodeIdArray, focus: { type: 'boolean' } },
      required: ['node_ids']
    }
  },
  {
    name: 'run_node',
    description: 'Run or retry a text, image, config, or video node.',
    inputSchema: {
      type: 'object',
      properties: { node_id: { type: 'string' } },
      required: ['node_id']
    }
  },
  {
    name: 'retry_node',
    description: 'Retry an executable node using its current configuration and context.',
    inputSchema: {
      type: 'object',
      properties: { node_id: { type: 'string' } },
      required: ['node_id']
    }
  },
  {
    name: 'cancel_node',
    description: 'Cancel an active generation. Requires confirmation.',
    inputSchema: {
      type: 'object',
      properties: { node_id: { type: 'string' } },
      required: ['node_id']
    }
  },
  {
    name: 'generate_media',
    description:
      'Create prompt/config nodes and run image, text, or video generation. For business work, provide verified business_context and concrete creative_direction so the stored prompt contains the real delivery requirements.',
    inputSchema: {
      type: 'object',
      properties: {
        media_type: { type: 'string', enum: ['image', 'text', 'video'] },
        prompt: { type: 'string' },
        business_context: businessContextSchema,
        creative_direction: creativeDirectionSchema,
        reference_node_ids: nodeIdArray,
        reference_attachment_ids: nodeIdArray,
        provider_id: { type: 'string' },
        model_id: { type: 'string' },
        aspect: { type: 'string' },
        count: { type: 'number' },
        quality: { type: 'string' },
        size: { type: 'string' },
        resolution: { type: 'string' },
        duration: { type: 'number' },
        fps: { type: 'number' },
        watermark: { type: 'boolean' }
      },
      required: ['media_type', 'prompt']
    }
  },
  {
    name: 'generate_video',
    description:
      'Create and start a video workflow. Prefer image-to-video: reuse a suitable successful image reference, or generate and wait for a keyframe image first, then pass its output node id in reference_node_ids. Use text-to-video only when explicitly requested or reference input is unsupported/inappropriate.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        business_context: businessContextSchema,
        creative_direction: creativeDirectionSchema,
        reference_node_ids: nodeIdArray,
        reference_attachment_ids: nodeIdArray,
        provider_id: { type: 'string' },
        model_id: { type: 'string' },
        aspect: { type: 'string' },
        resolution: { type: 'string' },
        duration: { type: 'number' },
        fps: { type: 'number' },
        watermark: { type: 'boolean' }
      },
      required: ['prompt']
    }
  },
  {
    name: 'edit_image',
    description:
      'Edit an existing source image. For prompt-based visual changes use operation=variation; this calls the image edit endpoint, not ordinary image generation. A source_node_id or source_attachment_id is required.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        operation: {
          type: 'string',
          enum: ['variation', 'crop', 'transform', 'upscale', 'inpaint', 'outpaint', 'split']
        },
        source_node_id: { type: 'string' },
        source_attachment_id: { type: 'string' },
        provider_id: { type: 'string' },
        model_id: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        rotate: { type: 'number' },
        flip_h: { type: 'boolean' },
        flip_v: { type: 'boolean' },
        factor: { type: 'number' },
        mask_data_url: { type: 'string' }
      },
      required: ['prompt']
    }
  },
  {
    name: 'media_action',
    description: 'Save, copy, or download the media contained in an image/video node.',
    inputSchema: {
      type: 'object',
      properties: {
        node_id: { type: 'string' },
        action: { type: 'string', enum: ['save_asset', 'copy', 'download'] }
      },
      required: ['node_id', 'action']
    }
  },
  {
    name: 'create_trigger',
    description: 'Persist a rule that runs a target node when a source event occurs.',
    inputSchema: {
      type: 'object',
      properties: {
        source_node_id: { type: 'string' },
        event: { type: 'string' },
        target_node_id: { type: 'string' }
      },
      required: ['source_node_id', 'event', 'target_node_id']
    }
  },
  {
    name: 'delete_trigger',
    description: 'Delete a persisted node trigger.',
    inputSchema: {
      type: 'object',
      properties: { trigger_id: { type: 'string' } },
      required: ['trigger_id']
    }
  },
  {
    name: 'manage_canvas',
    description: 'Manage view, history, background, graph import/export, and canvas projects.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'undo',
            'redo',
            'fit_view',
            'reset_view',
            'auto_layout',
            'pan_view',
            'zoom_view',
            'set_background',
            'clear_canvas',
            'export_canvas',
            'import_canvas',
            'replace_canvas',
            'create_project',
            'switch_project',
            'rename_project',
            'delete_project'
          ]
        },
        background: { type: 'string', enum: ['dots', 'grid', 'blank'] },
        dx: { type: 'number' },
        dy: { type: 'number' },
        scale: { type: 'number' },
        json: { type: 'string' },
        project_id: { type: 'string' },
        name: { type: 'string' }
      },
      required: ['action']
    }
  }
]

export interface CanvasConfirmationRequest {
  id: string
  toolName: string
  kind:
    | 'delete_nodes'
    | 'cancel_node'
    | 'clear_canvas'
    | 'replace_canvas'
    | 'delete_project'
    | 'tool'
  count?: number
  nodeId?: string
  inputPreview?: string
}

export type CanvasAgentEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'action'; action: AssistantAction }
  | {
      type: 'tool_start'
      kind: AssistantActionKind
      nodeId?: string
      subscriptionId?: string
    }

interface RunCanvasAssistantArgs {
  provider: ProviderConfig
  messages: UnifiedMessage[]
  actions: GraphActions
  attachments?: ImageAttachment[]
  attachmentNodeIds?: Record<string, string>
  projectId?: string
  projectBaseName?: string
  confirm?: (request: CanvasConfirmationRequest) => Promise<boolean>
  signal?: AbortSignal
}

const MAX_TURN_MS = 15 * 60 * 1000
const CANVAS_AGENT_TOOL_NAMES = new Set([
  'Read',
  'Write',
  'Edit',
  'NotebookEdit',
  'LS',
  'Glob',
  'Grep',
  'Bash',
  'Skill'
])
const NODE_GAP = 60
const NODE_EVENT_TYPES = new Set<CanvasNodeEventType>([
  'run.queued',
  'run.started',
  'run.progress',
  'run.succeeded',
  'run.failed',
  'run.cancelled',
  'run.interrupted',
  'node.updated'
])

interface ToolOutcome {
  output: string
  isError?: boolean
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

const BUSINESS_PROMPT_FIELDS = [
  ['product_or_service', 'Product or service'],
  ['objective', 'Business objective'],
  ['campaign_or_use_case', 'Campaign or use case'],
  ['audience', 'Target audience'],
  ['channel', 'Channel'],
  ['deliverable', 'Deliverable'],
  ['value_proposition', 'Value proposition'],
  ['verified_facts', 'Verified facts'],
  ['proof_points', 'Verified proof points'],
  ['brand_tone', 'Brand tone'],
  ['call_to_action', 'Call to action'],
  ['required_elements', 'Required elements'],
  ['forbidden_elements', 'Forbidden elements'],
  ['assumptions', 'Creative assumptions (not business facts)']
] as const

const CREATIVE_PROMPT_FIELDS = [
  ['subject_and_product_fidelity', 'Subject and product fidelity'],
  ['visual_style', 'Visual style'],
  ['environment', 'Environment'],
  ['composition', 'Composition and framing'],
  ['camera', 'Camera and lens'],
  ['motion', 'Subject and camera motion'],
  ['lighting', 'Lighting'],
  ['color_palette', 'Color palette'],
  ['materials_and_texture', 'Materials and texture'],
  ['typography_and_copy', 'Typography and exact copy'],
  ['pacing', 'Pacing and shot timing'],
  ['continuity', 'Continuity'],
  ['ending', 'Ending frame'],
  ['audio', 'Audio direction'],
  ['negative_prompt', 'Negative constraints']
] as const

function promptValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined
  if (!Array.isArray(value)) return undefined
  const items = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
  return items.length > 0 ? items.join('; ') : undefined
}

function formatPromptFields(
  input: unknown,
  fields: ReadonlyArray<readonly [string, string]>
): string[] {
  const record = asRecord(input)
  if (!record) return []
  return fields.flatMap(([key, label]) => {
    const value = promptValue(record[key])
    return value ? [`- ${label}: ${value}`] : []
  })
}

function buildProfessionalMediaPrompt(
  input: Record<string, unknown>,
  prompt: string,
  mode: 'image' | 'text' | 'video'
): string {
  const businessLines = formatPromptFields(input.business_context, BUSINESS_PROMPT_FIELDS)
  const creativeLines = formatPromptFields(input.creative_direction, CREATIVE_PROMPT_FIELDS)
  const deliveryLines = [
    mode !== 'text'
      ? `- Aspect ratio: ${asString(input.aspect) || (mode === 'video' ? '16:9' : '1:1')}`
      : '',
    asString(input.size) ? `- Size: ${asString(input.size)}` : '',
    asString(input.resolution) ? `- Resolution: ${asString(input.resolution)}` : '',
    asString(input.quality) ? `- Quality: ${asString(input.quality)}` : '',
    mode === 'video' && asNumber(input.duration) !== undefined
      ? `- Duration: ${asNumber(input.duration)} seconds`
      : '',
    mode === 'video' && asNumber(input.fps) !== undefined
      ? `- Frame rate: ${asNumber(input.fps)} FPS`
      : ''
  ].filter(Boolean)
  const sections = [`## Core creative request\n${prompt.trim()}`]
  if (businessLines.length > 0) {
    sections.push(`## Business and delivery brief\n${businessLines.join('\n')}`)
  }
  if (creativeLines.length > 0) {
    sections.push(`## Production direction\n${creativeLines.join('\n')}`)
  }
  if (deliveryLines.length > 0) {
    sections.push(`## Technical delivery\n${deliveryLines.join('\n')}`)
  }
  sections.push(
    mode === 'video'
      ? `## Execution guardrails\n- When a reference image is supplied, preserve its subject identity, product geometry, materials, colors, logos, composition, and visual hierarchy; animate it instead of redesigning it.\n- Maintain temporal and physical continuity. Avoid flicker, warping, unintended morphing, duplicated or disappearing objects, unstable anatomy, unstable text or logos, and abrupt camera jumps.\n- Do not introduce prices, claims, copy, logos, or other business facts that are not explicitly stated above.`
      : mode === 'image'
        ? `## Execution guardrails\n- Preserve recognizable subject and product geometry, material accuracy, brand colors, and exact supplied copy.\n- Produce a coherent, production-clean composition without accidental text, logos, watermarks, distorted anatomy, duplicated objects, or broken perspective unless explicitly requested.\n- Do not introduce prices, claims, copy, logos, or other business facts that are not explicitly stated above.`
        : `## Execution guardrails\n- Keep all business statements faithful to the supplied brief and preserve exact required names, figures, and calls to action.\n- Do not invent prices, claims, capabilities, testimonials, certifications, guarantees, or other business facts.`
  )
  return sections.join('\n\n')
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function summarizeToolResult(output: string): unknown {
  if (output.length > 2000) return { truncated: true, preview: truncate(output, 2000) }
  try {
    return JSON.parse(output) as unknown
  } catch {
    return { message: output }
  }
}

function stringifyToolOutput(output: unknown): string {
  if (typeof output === 'string') return output
  if (output === undefined) return ''
  try {
    return JSON.stringify(output)
  } catch {
    return String(output)
  }
}

async function buildCanvasAgentTools(projectId: string): Promise<ToolDefinition[]> {
  await ensureRequestToolCatalogFresh()
  const mcpProjectId = `graph:${projectId}`
  await useMcpStore.getState().ensureConversationReady(mcpProjectId)
  const mcpState = useMcpStore.getState()
  const activeServers = mcpState.getActiveMcps(mcpProjectId)
  const tools = [
    ...CANVAS_TOOLS,
    ...toolRegistry
      .getStableDefinitions()
      .filter((definition) => CANVAS_AGENT_TOOL_NAMES.has(definition.name)),
    ...buildMcpToolDefinitions(activeServers, mcpState.getActiveMcpTools(mcpProjectId)),
    ...buildMcpResourceDefinitions(activeServers, mcpState.getActiveMcpResources(mcpProjectId))
  ]
  return [...new Map(tools.map((tool) => [tool.name, tool])).values()]
}

function approvalPreview(input: Record<string, unknown>): string | undefined {
  const text = stringifyToolOutput(input)
  return text ? truncate(text, 500) : undefined
}

async function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T | null> {
  if (!signal) return await promise
  if (signal.aborted) {
    void promise.catch(() => undefined)
    return null
  }
  return await new Promise<T | null>((resolve, reject) => {
    let settled = false
    const finish = (value: T | null): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const onAbort = (): void => finish(null)
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(finish, (error) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      reject(error)
    })
  })
}

function viewportAnchor(offsetIndex: number): { x: number; y: number } {
  const { camera, stageSize } = useGraphStore.getState()
  const center = screenToWorld({ x: stageSize.width / 2, y: stageSize.height / 2 }, camera)
  return { x: center.x + offsetIndex * 40, y: center.y + offsetIndex * 40 }
}

function readCanvas(): string {
  const graph = useGraphStore.getState()
  const projectStore = useProjectsStore.getState()
  const providerStore = useProviderStore.getState()
  return JSON.stringify({
    project: projectStore.projects.find((project) => project.id === projectStore.activeProjectId),
    projects: projectStore.projects,
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      x: Math.round(node.x),
      y: Math.round(node.y),
      width: Math.round(node.w),
      height: Math.round(node.h),
      execution: node.execution ?? { status: 'idle' },
      ...(node.kind === 'text' ? { text: truncate(node.data.text, 500) } : {}),
      ...(node.kind === 'image'
        ? { hasImage: !!(node.data.src || node.data.filePath), prompt: node.data.prompt }
        : {}),
      ...(node.kind === 'video'
        ? { hasVideo: !!(node.data.src || node.data.filePath), prompt: node.data.prompt }
        : {}),
      ...(node.kind === 'config' ? { config: node.data } : {}),
      inputs: upstreamNodeIds(graph.edges, node.id),
      outputs: downstreamNodeIds(graph.edges, node.id)
    })),
    edges: graph.edges,
    triggers: graph.triggers,
    selection: graph.selection,
    background: graph.background,
    camera: graph.camera,
    generationModels: providerStore.providers
      .filter(isProviderAvailableForModelSelection)
      .flatMap((provider) =>
        provider.models
          .filter(
            (model) =>
              model.enabled && ['chat', 'image', 'video'].includes(model.category ?? 'chat')
          )
          .map((model) => ({
            provider_id: provider.id,
            provider_name: provider.name,
            model_id: model.id,
            model_name: model.name,
            category: model.category ?? 'chat',
            type: model.type ?? provider.type
          }))
      ),
    generationDefaults: {
      text: {
        provider_id: providerStore.activeProviderId,
        model_id: providerStore.activeModelId
      },
      image: {
        provider_id: providerStore.activeImageProviderId,
        model_id: providerStore.activeImageModelId
      }
    }
  })
}

function createNodeTool(input: Record<string, unknown>, offsetIndex: number): ToolOutcome {
  const kind = asString(input.kind) as CanvasNodeKind
  if (!['text', 'image', 'config', 'video'].includes(kind)) {
    return { output: 'Error: invalid node kind', isError: true }
  }
  const graph = useGraphStore.getState()
  const base = createCanvasNode(kind, viewportAnchor(offsetIndex))
  const x = asNumber(input.x)
  const y = asNumber(input.y)
  let node: CanvasNode = {
    ...base,
    ...(x !== undefined ? { x } : {}),
    ...(y !== undefined ? { y } : {})
  } as CanvasNode
  if (node.kind === 'text') node = { ...node, data: { text: asString(input.text) } }
  if (node.kind === 'image' || node.kind === 'video') {
    node = {
      ...node,
      data: {
        ...node.data,
        prompt: asString(input.prompt) || undefined,
        providerId: asString(input.provider_id) || undefined,
        modelId: asString(input.model_id) || undefined
      }
    } as CanvasNode
  }
  if (node.kind === 'config') {
    node = {
      ...node,
      data: {
        ...node.data,
        mode: (asString(input.mode) || 'image') as 'image' | 'text' | 'video',
        providerId: asString(input.provider_id) || undefined,
        modelId: asString(input.model_id) || undefined
      }
    }
  }
  graph.addNode(node, { history: true, select: true })
  const connected: string[] = []
  for (const sourceId of stringArray(input.connect_from)) {
    if (!graph.nodes.some((candidate) => candidate.id === sourceId)) continue
    graph.addEdge(sourceId, node.id, { history: false })
    connected.push(sourceId)
  }
  return { output: JSON.stringify({ node_id: node.id, connected_from: connected }) }
}

function updateNodeTool(input: Record<string, unknown>): ToolOutcome {
  const nodeId = asString(input.node_id)
  const patch =
    input.patch && typeof input.patch === 'object' ? (input.patch as Record<string, unknown>) : {}
  const graph = useGraphStore.getState()
  const node = graph.nodes.find((candidate) => candidate.id === nodeId)
  if (!node) return { output: 'Error: node not found', isError: true }
  graph.pushHistory()
  graph.updateNode(nodeId, (current) => {
    const x = asNumber(patch.x)
    const y = asNumber(patch.y)
    const w = asNumber(patch.width)
    const h = asNumber(patch.height)
    const box = {
      ...current,
      ...(x !== undefined ? { x } : {}),
      ...(y !== undefined ? { y } : {}),
      ...(w !== undefined ? { w: Math.max(140, w) } : {}),
      ...(h !== undefined ? { h: Math.max(100, h) } : {})
    }
    if (box.kind === 'text') {
      return {
        ...box,
        data: {
          ...box.data,
          ...(typeof patch.text === 'string' ? { text: patch.text } : {}),
          ...(typeof patch.font_scale === 'number' ? { fontScale: patch.font_scale } : {})
        }
      }
    }
    if (box.kind === 'config') {
      const mode = asString(patch.mode)
      return {
        ...box,
        data: {
          ...box.data,
          ...(mode && ['image', 'text', 'video'].includes(mode)
            ? { mode: mode as 'image' | 'text' | 'video' }
            : {}),
          ...(typeof patch.provider_id === 'string' ? { providerId: patch.provider_id } : {}),
          ...(typeof patch.model_id === 'string' ? { modelId: patch.model_id } : {}),
          ...(typeof patch.aspect === 'string' ? { aspect: patch.aspect } : {}),
          ...(typeof patch.count === 'number' ? { count: patch.count } : {}),
          ...(typeof patch.quality === 'string' ? { quality: patch.quality } : {}),
          ...(typeof patch.size === 'string' ? { size: patch.size } : {}),
          ...(typeof patch.resolution === 'string' ? { resolution: patch.resolution } : {}),
          ...(typeof patch.duration === 'number' ? { duration: patch.duration } : {}),
          ...(typeof patch.fps === 'number' ? { fps: patch.fps } : {}),
          ...(typeof patch.watermark === 'boolean' ? { watermark: patch.watermark } : {})
        }
      }
    }
    return {
      ...box,
      data: {
        ...box.data,
        ...(typeof patch.prompt === 'string' ? { prompt: patch.prompt } : {}),
        ...(typeof patch.provider_id === 'string' ? { providerId: patch.provider_id } : {}),
        ...(typeof patch.model_id === 'string' ? { modelId: patch.model_id } : {})
      }
    } as CanvasNode
  })
  emitNodeUpdated(nodeId, { source: 'canvas_assistant' })
  return { output: JSON.stringify({ updated: nodeId }) }
}

async function resolveAttachmentNode(
  attachmentId: string,
  offsetIndex: number,
  args: RunCanvasAssistantArgs
): Promise<string | null> {
  const existingId = args.attachmentNodeIds?.[attachmentId]
  if (
    existingId &&
    useGraphStore.getState().nodes.some((node) => node.id === existingId && node.kind === 'image')
  ) {
    return existingId
  }
  const attachment = (args.attachments ?? []).find((candidate) => candidate.id === attachmentId)
  return attachment
    ? await addImageNodeFromDataUrl(attachment.dataUrl, viewportAnchor(offsetIndex), args.projectId)
    : null
}

function loadCanvasImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Unable to load source image'))
    image.src = src
  })
}

async function editImageTool(
  input: Record<string, unknown>,
  offsetIndex: number,
  args: RunCanvasAssistantArgs
): Promise<ToolOutcome> {
  const operation = asString(input.operation) || 'variation'
  let sourceNodeId = asString(input.source_node_id)
  if (!sourceNodeId && asString(input.source_attachment_id)) {
    sourceNodeId =
      (await resolveAttachmentNode(asString(input.source_attachment_id), offsetIndex, args)) ?? ''
  }
  const graph = useGraphStore.getState()
  const node = graph.nodes.find(
    (candidate) => candidate.id === sourceNodeId && candidate.kind === 'image'
  )
  if (!node || node.kind !== 'image' || (!node.data.src && !node.data.filePath)) {
    return {
      output:
        'Error: edit_image requires an available source image via source_node_id or source_attachment_id',
      isError: true
    }
  }
  if (operation === 'variation') {
    const result = await args.actions.applyEdit(node.id, {
      prompt: asString(input.prompt) || 'Edit this image while preserving its core composition.',
      sourceSize: { width: node.w, height: node.h },
      providerId: asString(input.provider_id) || undefined,
      modelId: asString(input.model_id) || undefined
    })
    return { output: JSON.stringify(result), isError: !result.ok }
  }
  if (operation === 'split') {
    const group = node.data.groupSrcs ?? []
    if (group.length < 2) return { output: 'Error: image node has no result group', isError: true }
    const ids: string[] = []
    group.forEach((result, index) => {
      const child: CanvasNode = {
        ...createCanvasNode('image', {
          x: node.x + node.w + NODE_GAP,
          y: node.y + index * (node.h + 32)
        }),
        kind: 'image',
        data: {
          ...result,
          prompt: node.data.prompt,
          providerId: node.data.providerId,
          modelId: node.data.modelId
        }
      }
      graph.addNode(child, { history: index === 0 })
      graph.addEdge(node.id, child.id, { history: false })
      ids.push(child.id)
    })
    return { output: JSON.stringify({ output_node_ids: ids }) }
  }
  if (!node.data.src) {
    return { output: 'Error: local image operations require a loaded image source', isError: true }
  }
  const image = await loadCanvasImage(node.data.src)
  if (operation === 'inpaint' || operation === 'outpaint') {
    const maskDataUrl = asString(input.mask_data_url)
    if (!maskDataUrl) {
      return { output: 'Error: mask_data_url is required for inpaint/outpaint', isError: true }
    }
    const result = await args.actions.applyEdit(node.id, {
      maskDataUrl,
      prompt: asString(input.prompt) || 'Edit the masked area to match the surrounding image.',
      sourceSize: { width: image.naturalWidth, height: image.naturalHeight },
      providerId: asString(input.provider_id) || undefined,
      modelId: asString(input.model_id) || undefined
    })
    return { output: JSON.stringify(result), isError: !result.ok }
  }
  let dataUrl: string | null = null
  if (operation === 'crop') {
    dataUrl = cropImage(image, {
      x: asNumber(input.x) ?? 0,
      y: asNumber(input.y) ?? 0,
      width: asNumber(input.width) ?? image.naturalWidth,
      height: asNumber(input.height) ?? image.naturalHeight
    })
  } else if (operation === 'transform') {
    dataUrl = transformImage(image, {
      rotate: asNumber(input.rotate) ?? 0,
      flipH: input.flip_h === true,
      flipV: input.flip_v === true
    })
  } else if (operation === 'upscale') {
    dataUrl = upscaleImageLocal(image, asNumber(input.factor) ?? 2)
  }
  if (!dataUrl) return { output: `Error: unsupported edit operation ${operation}`, isError: true }
  const outputNodeId = await args.actions.addDerivedImage(node.id, dataUrl, {
    prompt: asString(input.prompt) || node.data.prompt,
    select: true
  })
  return { output: JSON.stringify({ output_node_id: outputNodeId }), isError: !outputNodeId }
}

async function mediaActionTool(
  input: Record<string, unknown>,
  actions: GraphActions
): Promise<ToolOutcome> {
  const node = useGraphStore
    .getState()
    .nodes.find((candidate) => candidate.id === asString(input.node_id))
  if (!node || (node.kind !== 'image' && node.kind !== 'video')) {
    return { output: 'Error: media node not found', isError: true }
  }
  const action = asString(input.action)
  if (action === 'save_asset') {
    if (!node.data.filePath) return { output: 'Error: media is not persisted', isError: true }
    useAssetStore.getState().addAsset({
      filePath: node.data.filePath,
      mediaType: node.data.mediaType,
      prompt: node.data.prompt,
      createdAt: Date.now(),
      ...(node.kind === 'video' ? { kind: 'video' as const } : {})
    })
    return { output: JSON.stringify({ saved_to_assets: node.id }) }
  }
  if (action === 'download') {
    if (node.kind === 'image') {
      await actions.downloadImage(node.id)
    } else if (node.data.filePath) {
      const result = await ipcClient.invoke(IPC.FS_DOWNLOAD_FILE_COPY, {
        sourcePath: node.data.filePath,
        defaultName: 'video.mp4',
        filters: [{ name: 'Video', extensions: ['mp4', 'webm'] }]
      })
      if (!(result as { success?: boolean; canceled?: boolean }).success) {
        return { output: JSON.stringify(result), isError: true }
      }
    }
    return { output: JSON.stringify({ downloaded: node.id }) }
  }
  if (action === 'copy') {
    if (node.kind !== 'image') return { output: 'Error: only images can be copied', isError: true }
    let data = node.data.src?.startsWith('data:')
      ? node.data.src.slice(node.data.src.indexOf(',') + 1)
      : undefined
    if (!data && node.data.filePath) {
      const read = await ipcClient.invoke(IPC.FS_READ_FILE_BINARY, { path: node.data.filePath })
      data = (read as { data?: string }).data
    }
    if (!data) return { output: 'Error: image bytes unavailable', isError: true }
    const result = await ipcClient.invoke(IPC.CLIPBOARD_WRITE_IMAGE, { data })
    return (result as { error?: string }).error
      ? { output: JSON.stringify(result), isError: true }
      : { output: JSON.stringify({ copied: node.id }) }
  }
  return { output: `Error: unknown media action ${action}`, isError: true }
}

async function generateMediaTool(
  input: Record<string, unknown>,
  offsetIndex: number,
  actions: GraphActions,
  args: RunCanvasAssistantArgs
): Promise<ToolOutcome> {
  const rawPrompt = asString(input.prompt).trim()
  const mode = asString(input.media_type) || 'image'
  if (!rawPrompt || !['image', 'text', 'video'].includes(mode)) {
    return { output: 'Error: valid media_type and prompt are required', isError: true }
  }
  const mediaMode = mode as 'image' | 'text' | 'video'
  const prompt = buildProfessionalMediaPrompt(input, rawPrompt, mediaMode)
  const attachmentIds = stringArray(input.reference_attachment_ids)
  const attachmentNodes = (
    await Promise.all(
      attachmentIds.map((id, index) => resolveAttachmentNode(id, offsetIndex + index, args))
    )
  ).filter((id): id is string => !!id)
  const graph = useGraphStore.getState()
  const referenceIds = [...stringArray(input.reference_node_ids), ...attachmentNodes]
    .filter((id, index, all) => all.indexOf(id) === index)
    .filter((id) =>
      graph.nodes.some(
        (node) => node.id === id && node.kind === 'image' && !!(node.data.src || node.data.filePath)
      )
    )
  if (
    mode === 'video' &&
    (stringArray(input.reference_node_ids).length > 0 || attachmentIds.length > 0) &&
    referenceIds.length === 0
  ) {
    return {
      output:
        'Error: video reference inputs were requested, but no completed image reference is available. Wait for the image to succeed or choose another reference.',
      isError: true
    }
  }
  const promptBase = createCanvasNode('text', viewportAnchor(offsetIndex + attachmentNodes.length))
  const promptNode: CanvasNode = { ...promptBase, kind: 'text', data: { text: prompt } }
  const configBase = createCanvasNode('config', { x: 0, y: 0 })
  const configNode: CanvasNode = {
    ...configBase,
    x: promptNode.x + promptNode.w + NODE_GAP,
    y: promptNode.y,
    kind: 'config',
    data: {
      mode: mode as 'image' | 'text' | 'video',
      aspect: asString(input.aspect) || (mode === 'video' ? '16:9' : '1:1'),
      count: Math.min(4, Math.max(1, Math.round(asNumber(input.count) ?? 1))),
      quality: asString(input.quality) || undefined,
      size: asString(input.size) || undefined,
      resolution: asString(input.resolution) || undefined,
      duration: asNumber(input.duration),
      fps: asNumber(input.fps),
      watermark: typeof input.watermark === 'boolean' ? input.watermark : undefined,
      providerId: asString(input.provider_id) || undefined,
      modelId: asString(input.model_id) || undefined
    }
  }
  graph.addNode(promptNode, { history: true })
  graph.addNode(configNode, { history: false })
  graph.addEdge(promptNode.id, configNode.id, { history: false })
  referenceIds.forEach((id) => graph.addEdge(id, configNode.id, { history: false }))
  const result = await beginCanvasRun(
    configNode.id,
    () => actions.runConfigNode(configNode.id),
    args.signal
  )
  return {
    output: JSON.stringify({
      prompt_node_id: promptNode.id,
      config_node_id: configNode.id,
      reference_node_ids: referenceIds,
      result
    }),
    isError: !result.ok
  }
}

async function beginCanvasRun(
  nodeId: string,
  run: () => Promise<CanvasRunResult>,
  signal?: AbortSignal
): Promise<CanvasRunResult> {
  const promise = run()
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (signal?.aborted) {
      void promise.catch(() => undefined)
      return {
        ok: false,
        nodeId,
        outputNodeIds: [],
        status: 'interrupted',
        error: 'Assistant stopped before the run started'
      }
    }
    await new Promise((resolve) => window.setTimeout(resolve, 25))
    const execution = getNodeExecution(nodeId)
    if (execution && ['queued', 'running'].includes(execution.status)) {
      void promise.catch(() => undefined)
      return {
        ok: true,
        runId: execution.runId,
        nodeId,
        outputNodeIds: execution.outputNodeIds ?? [],
        status: execution.status
      }
    }
    if (
      execution &&
      ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(execution.status)
    ) {
      return await promise
    }
  }
  if (!signal) return await promise
  return await new Promise<CanvasRunResult>((resolve, reject) => {
    let settled = false
    const finish = (result: CanvasRunResult): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const onAbort = (): void =>
      finish({
        ok: false,
        nodeId,
        outputNodeIds: [],
        status: 'interrupted',
        error: 'Assistant stopped before the run started'
      })
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    void promise.then(finish, reject)
  })
}

function requiresConfirmation(call: ToolUseBlock): CanvasConfirmationRequest | null {
  const action = asString(call.input.action)
  if (
    call.name !== 'delete_nodes' &&
    call.name !== 'cancel_node' &&
    !(
      call.name === 'manage_canvas' &&
      ['clear_canvas', 'import_canvas', 'replace_canvas', 'delete_project'].includes(action)
    )
  ) {
    return null
  }
  const kind =
    call.name === 'delete_nodes'
      ? 'delete_nodes'
      : call.name === 'cancel_node'
        ? 'cancel_node'
        : action === 'delete_project'
          ? 'delete_project'
          : action === 'clear_canvas'
            ? 'clear_canvas'
            : 'replace_canvas'
  return {
    id: nanoid(),
    toolName: call.name,
    kind,
    ...(kind === 'delete_nodes'
      ? { count: stringArray(call.input.node_ids).length }
      : kind === 'cancel_node'
        ? { nodeId: asString(call.input.node_id) }
        : {})
  }
}

async function executeCanvasTool(
  call: ToolUseBlock,
  args: RunCanvasAssistantArgs,
  offsetIndex: number,
  subscriptionIds: Set<string>,
  deadlineAt: number,
  confirmationHandled = false
): Promise<ToolOutcome> {
  try {
    const confirmation = confirmationHandled ? null : requiresConfirmation(call)
    if (confirmation) {
      const approved = args.confirm
        ? await raceWithAbort(args.confirm(confirmation), args.signal)
        : false
      if (!approved) {
        return { output: JSON.stringify({ status: 'denied_by_user' }), isError: true }
      }
    }
    const input = call.input
    const graph = useGraphStore.getState()
    switch (call.name) {
      case 'read_canvas':
        return { output: readCanvas() }
      case 'get_node_status': {
        const nodeId = asString(input.node_id)
        const node = graph.nodes.find((candidate) => candidate.id === nodeId)
        return node
          ? {
              output: JSON.stringify({
                node_id: nodeId,
                execution: getNodeExecution(nodeId) ?? { status: 'idle' }
              })
            }
          : { output: 'Error: node not found', isError: true }
      }
      case 'subscribe_node': {
        const nodeId = asString(input.node_id)
        if (!graph.nodes.some((node) => node.id === nodeId)) {
          return { output: 'Error: node not found', isError: true }
        }
        const events = stringArray(input.events).filter((event): event is CanvasNodeEventType =>
          NODE_EVENT_TYPES.has(event as CanvasNodeEventType)
        )
        if (events.length === 0) {
          return { output: 'Error: at least one valid event is required', isError: true }
        }
        const id = subscribeCanvasNodeEvents({ nodeId, events })
        subscriptionIds.add(id)
        return {
          output: JSON.stringify({
            subscription_id: id,
            execution: getNodeExecution(nodeId) ?? { status: 'idle' }
          })
        }
      }
      case 'wait_for_node_event': {
        const subscriptionId = asString(input.subscription_id)
        if (!subscriptionIds.has(subscriptionId)) {
          return { output: 'Error: unknown subscription', isError: true }
        }
        const event = await waitForCanvasNodeEvent({
          subscriptionId,
          timeoutMs: Math.min(
            asNumber(input.timeout_ms) ?? 10 * 60 * 1000,
            Math.max(0, deadlineAt - Date.now())
          ),
          signal: args.signal
        })
        const snapshot = getCanvasNodeSubscriptionSnapshot(subscriptionId)
        return {
          output: JSON.stringify(
            event ?? {
              status: args.signal?.aborted ? 'cancelled' : 'timeout',
              ...snapshot,
              execution: snapshot?.execution ?? { status: 'idle' }
            }
          )
        }
      }
      case 'create_node':
        return createNodeTool(input, offsetIndex)
      case 'update_node':
        return updateNodeTool(input)
      case 'delete_nodes': {
        const ids = stringArray(input.node_ids)
        graph.removeNodes(ids)
        return { output: JSON.stringify({ deleted: ids }) }
      }
      case 'duplicate_nodes': {
        const previous = graph.selection
        graph.setSelection(stringArray(input.node_ids))
        graph.duplicateSelection()
        const duplicated = useGraphStore.getState().selection
        if (duplicated.length === 0) graph.setSelection(previous)
        return { output: JSON.stringify({ duplicated_node_ids: duplicated }) }
      }
      case 'connect_nodes': {
        const source = asString(input.source_id)
        const target = asString(input.target_id)
        if (
          !graph.nodes.some((node) => node.id === source) ||
          !graph.nodes.some((node) => node.id === target)
        ) {
          return { output: 'Error: source or target not found', isError: true }
        }
        graph.addEdge(source, target)
        return { output: JSON.stringify({ connected: [source, target] }) }
      }
      case 'disconnect_nodes': {
        const edge = asString(input.edge_id)
          ? graph.edges.find((candidate) => candidate.id === asString(input.edge_id))
          : graph.edges.find(
              (candidate) =>
                candidate.source === asString(input.source_id) &&
                candidate.target === asString(input.target_id)
            )
        if (!edge) return { output: 'Error: edge not found', isError: true }
        graph.removeEdge(edge.id)
        return { output: JSON.stringify({ disconnected: edge.id }) }
      }
      case 'move_nodes': {
        const ids = stringArray(input.node_ids)
        graph.pushHistory()
        const x = asNumber(input.x)
        const y = asNumber(input.y)
        const dx = asNumber(input.dx) ?? 0
        const dy = asNumber(input.dy) ?? 0
        graph.moveNodes(
          Object.fromEntries(
            ids.map((id) => {
              const node = graph.nodes.find((candidate) => candidate.id === id)
              return [
                id,
                {
                  x: x !== undefined && node ? x - node.x : dx,
                  y: y !== undefined && node ? y - node.y : dy
                }
              ]
            })
          )
        )
        return { output: JSON.stringify({ moved: ids }) }
      }
      case 'resize_node': {
        const node = graph.nodes.find((candidate) => candidate.id === asString(input.node_id))
        if (!node) return { output: 'Error: node not found', isError: true }
        graph.pushHistory()
        graph.resizeNode(node.id, {
          id: node.id,
          x: node.x,
          y: node.y,
          w: Math.max(140, asNumber(input.width) ?? node.w),
          h: Math.max(100, asNumber(input.height) ?? node.h)
        })
        return { output: JSON.stringify({ resized: node.id }) }
      }
      case 'select_nodes': {
        const ids = stringArray(input.node_ids).filter((id) =>
          graph.nodes.some((node) => node.id === id)
        )
        graph.setSelection(ids)
        if (input.focus === true && ids.length > 0) {
          graph.setCamera(
            fitCamera(
              graph.nodes.filter((node) => ids.includes(node.id)),
              graph.stageSize
            )
          )
        }
        return { output: JSON.stringify({ selected: ids }) }
      }
      case 'run_node': {
        const nodeId = asString(input.node_id)
        const result = await beginCanvasRun(nodeId, () => args.actions.runNode(nodeId), args.signal)
        return { output: JSON.stringify(result), isError: !result.ok }
      }
      case 'retry_node': {
        const nodeId = asString(input.node_id)
        const result = await beginCanvasRun(
          nodeId,
          () => args.actions.retryNode(nodeId),
          args.signal
        )
        return { output: JSON.stringify(result), isError: !result.ok }
      }
      case 'cancel_node': {
        const nodeId = asString(input.node_id)
        const relatedNodeIds = new Set([
          nodeId,
          ...(getNodeExecution(nodeId)?.outputNodeIds ?? []),
          ...upstreamNodeIds(graph.edges, nodeId).filter(
            (id) => graph.nodes.find((node) => node.id === id)?.kind === 'config'
          )
        ])
        const cancelled = await args.actions.cancelNode(nodeId)
        if (cancelled) {
          for (const subscriptionId of [...subscriptionIds]) {
            const subscribedNodeId = getCanvasNodeSubscriptionSnapshot(subscriptionId)?.nodeId
            if (!subscribedNodeId || !relatedNodeIds.has(subscribedNodeId)) continue
            unsubscribeCanvasNodeEvents(subscriptionId)
            subscriptionIds.delete(subscriptionId)
          }
        }
        return { output: JSON.stringify({ cancelled }), isError: !cancelled }
      }
      case 'generate_media':
        return await generateMediaTool(input, offsetIndex, args.actions, args)
      case 'generate_video':
        return await generateMediaTool(
          { ...input, media_type: 'video' },
          offsetIndex,
          args.actions,
          args
        )
      case 'edit_image':
        return await editImageTool(input, offsetIndex, args)
      case 'media_action':
        return await mediaActionTool(input, args.actions)
      case 'create_trigger': {
        const sourceNodeId = asString(input.source_node_id)
        const targetNodeId = asString(input.target_node_id)
        const event = asString(input.event) as CanvasNodeEventType
        if (
          !NODE_EVENT_TYPES.has(event) ||
          !graph.nodes.some((node) => node.id === sourceNodeId) ||
          !graph.nodes.some((node) => node.id === targetNodeId) ||
          graph.triggers.some(
            (trigger) =>
              trigger.sourceNodeId === sourceNodeId &&
              trigger.targetNodeId === targetNodeId &&
              trigger.event === event
          ) ||
          createsTriggerCycle(graph.triggers, sourceNodeId, targetNodeId)
        ) {
          return { output: 'Error: invalid or cyclic trigger', isError: true }
        }
        const trigger = {
          id: nanoid(),
          sourceNodeId,
          targetNodeId,
          event,
          enabled: true,
          createdAt: Date.now()
        }
        graph.addTrigger(trigger)
        return { output: JSON.stringify(trigger) }
      }
      case 'delete_trigger': {
        const id = asString(input.trigger_id)
        graph.removeTrigger(id)
        return { output: JSON.stringify({ deleted_trigger: id }) }
      }
      case 'manage_canvas': {
        const previousProjectId = useProjectsStore.getState().activeProjectId
        const outcome = await manageCanvasTool(input, args.projectBaseName ?? 'Canvas')
        if (useProjectsStore.getState().activeProjectId !== previousProjectId) {
          for (const subscriptionId of subscriptionIds) {
            unsubscribeCanvasNodeEvents(subscriptionId)
          }
          subscriptionIds.clear()
        }
        return outcome
      }
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

async function manageCanvasTool(
  input: Record<string, unknown>,
  projectBaseName: string
): Promise<ToolOutcome> {
  const action = asString(input.action)
  const graph = useGraphStore.getState()
  const projects = useProjectsStore.getState()
  switch (action) {
    case 'undo':
      graph.undo()
      break
    case 'redo':
      graph.redo()
      break
    case 'fit_view':
      graph.setCamera(fitCamera(graph.nodes, graph.stageSize))
      break
    case 'reset_view':
      graph.resetView()
      break
    case 'auto_layout': {
      if (graph.nodes.length === 0) break
      const nodeIds = new Set(graph.nodes.map((node) => node.id))
      const incoming = new Map(graph.nodes.map((node) => [node.id, 0]))
      const outgoing = new Map(graph.nodes.map((node) => [node.id, [] as string[]]))
      for (const edge of graph.edges) {
        if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue
        incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1)
        outgoing.get(edge.source)?.push(edge.target)
      }
      const layers = new Map<string, number>()
      const queue = graph.nodes
        .filter((node) => incoming.get(node.id) === 0)
        .sort((a, b) => a.y - b.y)
        .map((node) => node.id)
      queue.forEach((id) => layers.set(id, 0))
      for (let index = 0; index < queue.length; index += 1) {
        const source = queue[index]
        for (const target of outgoing.get(source) ?? []) {
          layers.set(target, Math.max(layers.get(target) ?? 0, (layers.get(source) ?? 0) + 1))
          incoming.set(target, (incoming.get(target) ?? 1) - 1)
          if (incoming.get(target) === 0) queue.push(target)
        }
      }
      const fallbackLayer = Math.max(-1, ...layers.values()) + 1
      graph.nodes.forEach((node) => {
        if (!layers.has(node.id)) layers.set(node.id, fallbackLayer)
      })
      const grouped = new Map<number, CanvasNode[]>()
      for (const node of graph.nodes) {
        const layer = layers.get(node.id) ?? 0
        const items = grouped.get(layer) ?? []
        items.push(node)
        grouped.set(layer, items)
      }
      const deltas: Record<string, { x: number; y: number }> = {}
      let x = 80
      for (const layer of [...grouped.keys()].sort((a, b) => a - b)) {
        const items = (grouped.get(layer) ?? []).sort((a, b) => a.y - b.y)
        let y = 80
        const width = Math.max(...items.map((node) => node.w))
        for (const node of items) {
          deltas[node.id] = { x: x - node.x, y: y - node.y }
          y += node.h + 64
        }
        x += width + 120
      }
      graph.pushHistory()
      graph.moveNodes(deltas)
      graph.setCamera(fitCamera(useGraphStore.getState().nodes, graph.stageSize))
      break
    }
    case 'pan_view':
      graph.setCamera((camera) => ({
        ...camera,
        x: camera.x + (asNumber(input.dx) ?? 0),
        y: camera.y + (asNumber(input.dy) ?? 0)
      }))
      break
    case 'zoom_view': {
      const nextScale = clampScale(asNumber(input.scale) ?? graph.camera.scale)
      graph.setCamera(
        zoomAtPoint(
          graph.camera,
          { x: graph.stageSize.width / 2, y: graph.stageSize.height / 2 },
          nextScale
        )
      )
      break
    }
    case 'set_background':
      graph.setBackground((asString(input.background) || 'dots') as BackgroundMode)
      break
    case 'clear_canvas':
      graph.replaceGraph({ nodes: [], edges: [], triggers: [] })
      break
    case 'export_canvas':
      return { output: exportGraphJson() }
    case 'import_canvas':
    case 'replace_canvas':
      return importGraphJson(asString(input.json))
        ? { output: JSON.stringify({ imported: true }) }
        : { output: 'Error: invalid canvas JSON', isError: true }
    case 'create_project': {
      const current = projects.activeProjectId
      if (current) saveProjectGraph(current)
      const id = projects.createProject(asString(input.name) || projectBaseName, Date.now())
      loadProjectGraph(id)
      await ensureDrawAgentWorkspace(id)
      return { output: JSON.stringify({ project_id: id }) }
    }
    case 'switch_project': {
      const id = asString(input.project_id)
      if (!projects.projects.some((project) => project.id === id)) {
        return { output: 'Error: project not found', isError: true }
      }
      if (projects.activeProjectId === id) {
        return { output: JSON.stringify({ project_id: id, unchanged: true }) }
      }
      if (projects.activeProjectId) saveProjectGraph(projects.activeProjectId)
      projects.setActiveProject(id)
      loadProjectGraph(id)
      return { output: JSON.stringify({ project_id: id }) }
    }
    case 'rename_project': {
      const id = asString(input.project_id) || projects.activeProjectId || ''
      if (!projects.projects.some((project) => project.id === id)) {
        return { output: 'Error: project not found', isError: true }
      }
      const name = asString(input.name) || projectBaseName
      const workspacePath = await renameDrawAgentWorkspace(id, name)
      projects.renameProject(id, name)
      return { output: JSON.stringify({ renamed: id, workspace_path: workspacePath }) }
    }
    case 'delete_project': {
      const id = asString(input.project_id) || projects.activeProjectId || ''
      if (!projects.projects.some((project) => project.id === id)) {
        return { output: 'Error: project not found', isError: true }
      }
      const wasActive = projects.activeProjectId === id
      await trashDrawAgentWorkspace(id)
      deleteProjectGraph(id)
      useAssistantStore.getState().clearSession(id)
      projects.deleteProject(id)
      if (!wasActive) {
        return {
          output: JSON.stringify({
            deleted_project: id,
            active_project_id: useProjectsStore.getState().activeProjectId
          })
        }
      }
      let next = useProjectsStore.getState().activeProjectId
      if (!next) {
        next = projects.createProject(`${projectBaseName} 1`, Date.now())
        await ensureDrawAgentWorkspace(next)
      }
      loadProjectGraph(next)
      return { output: JSON.stringify({ deleted_project: id, active_project_id: next }) }
    }
    default:
      return { output: `Error: unknown canvas action ${action}`, isError: true }
  }
  return { output: JSON.stringify({ action, ok: true }) }
}

export async function* runCanvasAssistantTurn(
  args: RunCanvasAssistantArgs
): AsyncGenerator<CanvasAgentEvent> {
  const turnController = new AbortController()
  const forwardAbort = (): void => turnController.abort()
  if (args.signal?.aborted) forwardAbort()
  else args.signal?.addEventListener('abort', forwardAbort, { once: true })
  const timeout = window.setTimeout(() => turnController.abort(), MAX_TURN_MS)
  const runArgs: RunCanvasAssistantArgs = { ...args, signal: turnController.signal }
  const subscriptionIds = new Set<string>()
  const runCleanups: Array<() => void> = []
  try {
    const projectId = runArgs.projectId ?? useProjectsStore.getState().activeProjectId
    if (!projectId) throw new Error('Canvas project is unavailable')
    const workingFolder = await ensureDrawAgentWorkspace(projectId)
    const tools = await buildCanvasAgentTools(projectId)
    const provider: ProviderConfig = {
      ...runArgs.provider,
      systemPrompt: `${buildSystemPrompt({
        mode: 'cowork',
        workingFolder,
        sessionId: `graph-agent:${projectId}`,
        toolDefs: tools
      })}\n\n## Canvas controller\n${CANVAS_ASSISTANT_SYSTEM_PROMPT}`,
      temperature: 0.7
    }
    if (!isNativeSidecarProviderConfig(provider)) {
      const text = await raceWithAbort(
        runSidecarTextRequest({
          provider,
          messages: runArgs.messages,
          signal: runArgs.signal
        }),
        runArgs.signal
      )
      if (text) yield { type: 'text', text }
      return
    }

    const runId = nanoid()
    const request = buildSidecarAgentRunRequest({
      messages: runArgs.messages,
      provider,
      tools,
      runId,
      sessionId: `graph-agent:${projectId}`,
      projectId,
      workingFolder,
      maxIterations: 20,
      maxParallelTools: 1,
      forceApproval: false,
      sessionMode: 'agent',
      canvasContext: { projectId }
    })
    if (!request) throw new Error('Unable to prepare the Canvas Agent request')

    let createdCount = 0
    runCleanups.push(
      registerNativeCanvasToolHandler(runId, async (nativeRequest) => {
        if (nativeRequest.projectId !== projectId) {
          return { content: 'Canvas project changed during the run', isError: true }
        }
        const call: ToolUseBlock = {
          type: 'tool_use',
          id: nativeRequest.toolUseId,
          name: nativeRequest.toolName,
          input: nativeRequest.input
        }
        const outcome = await executeCanvasTool(
          call,
          runArgs,
          createdCount,
          subscriptionIds,
          Date.now() + MAX_TURN_MS,
          true
        )
        if (['create_node', 'generate_media', 'generate_video', 'edit_image'].includes(call.name)) {
          createdCount += 1
        }
        return {
          content: outcome.output,
          ...(outcome.isError ? { isError: true, error: stringifyToolOutput(outcome.output) } : {})
        }
      })
    )
    runCleanups.push(
      registerSidecarApprovalHandler(runId, async ({ toolCall }) => {
        const call: ToolUseBlock = {
          type: 'tool_use',
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.input
        }
        const confirmation = requiresConfirmation(call) ?? {
          id: nanoid(),
          toolName: toolCall.name,
          kind: 'tool' as const,
          inputPreview: approvalPreview(toolCall.input)
        }
        const approved = runArgs.confirm ? await runArgs.confirm(confirmation) : false
        return {
          approved,
          ...(approved ? {} : { reason: 'User denied permission' })
        }
      })
    )
    const startedToolIds = new Set<string>()
    for await (const event of runAgentViaSidecar(request, { signal: runArgs.signal })) {
      if (runArgs.signal?.aborted) return
      if (event.type === 'text_delta' && event.text) {
        yield { type: 'text', text: event.text }
      } else if (event.type === 'thinking_delta' && event.thinking) {
        yield { type: 'thinking', text: event.thinking }
      } else if (event.type === 'tool_call_start') {
        const toolCall = event.toolCall
        if (!startedToolIds.has(toolCall.id)) {
          startedToolIds.add(toolCall.id)
          yield {
            type: 'tool_start',
            kind: toolCall.name as AssistantActionKind,
            nodeId:
              asString(toolCall.input.node_id) ||
              asString(toolCall.input.source_node_id) ||
              undefined,
            subscriptionId: asString(toolCall.input.subscription_id) || undefined
          }
        }
      } else if (event.type === 'tool_call_result') {
        const output = stringifyToolOutput(event.toolCall.output ?? event.toolCall.error ?? '')
        yield {
          type: 'action',
          action: {
            kind: event.toolCall.name as AssistantActionKind,
            ok: event.toolCall.status === 'completed' && !event.toolCall.error,
            result: summarizeToolResult(output)
          }
        }
      } else if (event.type === 'error') {
        throw event.error
      } else if (event.type === 'loop_end') {
        if (event.reason === 'max_iterations') {
          throw new Error('Canvas assistant reached the 20-round tool limit')
        }
        if (event.reason === 'error') throw new Error('Canvas assistant run failed')
        return
      }
    }
  } finally {
    for (const cleanup of runCleanups) cleanup()
    for (const id of subscriptionIds) unsubscribeCanvasNodeEvents(id)
    window.clearTimeout(timeout)
    args.signal?.removeEventListener('abort', forwardAbort)
  }
}
