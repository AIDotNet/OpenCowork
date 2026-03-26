import { nanoid } from 'nanoid'
import { runAgentLoop } from '@renderer/lib/agent/agent-loop'
import { createProvider } from '@renderer/lib/api/provider'
import { buildSystemPrompt } from '@renderer/lib/agent/system-prompt'
import { toolRegistry } from '@renderer/lib/agent/tool-registry'
import { runSubAgent } from '@renderer/lib/agent/sub-agents/runner'
import { ConcurrencyLimiter } from '@renderer/lib/agent/concurrency-limiter'
import { ensureProviderAuthReady } from '@renderer/lib/auth/provider-auth'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { encodeStructuredToolResult } from '@renderer/lib/tools/tool-result-format'
import type { ProviderConfig, ToolDefinition, UnifiedMessage } from '@renderer/lib/api/types'
import type { ToolContext, ToolHandler } from '@renderer/lib/tools/tool-types'
import type { SubAgentDefinition } from '@renderer/lib/agent/sub-agents/types'
import { useProviderStore } from '@renderer/stores/provider-store'
import { useSettingsStore } from '@renderer/stores/settings-store'

export type WikiGenerationMode = 'full' | 'regenerate' | 'incremental'

type WikiGenerationStage =
  | 'preparing'
  | 'planning'
  | 'saving-structure'
  | 'generating'
  | 'exporting'
  | 'completed'
  | 'error'
  | 'cancelled'

export interface WikiDocumentRow {
  id: string
  project_id: string
  name: string
  slug: string
  description: string
  status: string
  content_markdown: string
  generation_mode: string
  last_generated_commit_id: string | null
  parent_id: string | null
  sort_order: number
  level: number
  is_leaf: number
  source_files_json: string
  created_at: number
  updated_at: number
}

export interface WikiTreeNodeDraft {
  title: string
  description: string
  sourceFiles: string[]
  children: WikiTreeNodeDraft[]
}

export interface WikiGeneratorProgress {
  stage: WikiGenerationStage
  message: string
  totalLeafCount: number
  completedLeafCount: number
  currentNodeTitle?: string | null
  runId?: string
}

export type WikiGenerationProgress = WikiGeneratorProgress

export interface WikiGeneratorCallbacks {
  onProgress?: (progress: WikiGeneratorProgress) => void
  onDocumentsUpdated?: (documents: WikiDocumentRow[]) => void
}

interface WikiGeneratorOptions {
  projectId: string
  projectName: string
  workingFolder: string
  mode: WikiGenerationMode
}

interface PersistedNode {
  id: string
  name: string
  description: string
  parentId: string | null
  sortOrder: number
  level: number
  isLeaf: boolean
  sourceFiles: string[]
}

interface SaveWikiDocumentArgs {
  id?: string
  projectId: string
  name: string
  slug: string
  description?: string
  status?: string
  contentMarkdown?: string
  generationMode?: string
  lastGeneratedCommitId?: string | null
  parentId?: string | null
  sortOrder?: number
  level?: number
  isLeaf?: boolean
  sourceFiles?: string[]
  preserveCreatedAt?: boolean
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'wiki'
  )
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
}

function parseSourceFilesJson(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return uniqueStrings(parsed.filter((item): item is string => typeof item === 'string'))
  } catch {
    return []
  }
}

function countLeafNodes(nodes: WikiTreeNodeDraft[]): number {
  return nodes.reduce((total, node) => {
    if (node.children.length === 0) return total + 1
    return total + countLeafNodes(node.children)
  }, 0)
}

function hasStructuredWiki(documents: WikiDocumentRow[]): boolean {
  if (documents.length === 0) return false
  return documents.some((document) => document.is_leaf === 0 || document.parent_id !== null)
}

function flattenTree(nodes: WikiTreeNodeDraft[]): PersistedNode[] {
  const flattened: PersistedNode[] = []

  const walk = (items: WikiTreeNodeDraft[], parentId: string | null, level: number): void => {
    items.forEach((item, index) => {
      const id = nanoid()
      const isLeaf = item.children.length === 0
      flattened.push({
        id,
        name: item.title,
        description: item.description,
        parentId,
        sortOrder: index,
        level,
        isLeaf,
        sourceFiles: isLeaf ? item.sourceFiles : []
      })
      if (!isLeaf) {
        walk(item.children, id, level + 1)
      }
    })
  }

  walk(nodes, null, 0)
  return flattened
}

function validateTreeStructure(nodes: WikiTreeNodeDraft[]): WikiTreeNodeDraft[] {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error('Wiki 目录结构不能为空')
  }

  const names = new Set<string>()

  const visit = (node: WikiTreeNodeDraft): WikiTreeNodeDraft => {
    const title = String(node.title ?? '').trim()
    const description = String(node.description ?? '').trim()
    const children = Array.isArray(node.children) ? node.children.map(visit) : []
    const sourceFiles = uniqueStrings(Array.isArray(node.sourceFiles) ? node.sourceFiles : [])

    if (!title) throw new Error('节点 title 不能为空')
    if (names.has(title)) throw new Error(`节点标题重复：${title}`)
    names.add(title)

    if (children.length === 0 && sourceFiles.length === 0) {
      throw new Error(`叶子节点必须提供 sourceFiles：${title}`)
    }

    return {
      title,
      description,
      sourceFiles: children.length > 0 ? [] : sourceFiles,
      children
    }
  }

  return nodes.map(visit)
}

function pickToolDefs(names: string[], extra: ToolDefinition[] = []): ToolDefinition[] {
  const defs = toolRegistry.getDefinitions().filter((tool) => names.includes(tool.name))
  return [...defs, ...extra]
}

function buildPlanningSystemPrompt(workingFolder: string, toolDefs: ToolDefinition[]): string {
  return buildSystemPrompt({
    mode: 'code',
    workingFolder,
    toolDefs,
    language: useSettingsStore.getState().language,
    userRules: [
      '当前任务是生成项目 Wiki 的树形结构，而不是直接回答用户。',
      '必须先使用 Read / Glob / Grep 主动探索项目代码，再一次性调用 `SetWikiStructure` 提交完整结构。',
      '如果最终没有调用 `SetWikiStructure`，任务视为失败。不要只返回自然语言说明。',
      '分组必须基于逻辑职责，不要机械照搬目录。',
      '父节点仅用于分类，不生成 Wiki 内容。',
      '叶子节点必须严格列出全部 sourceFiles，且标题全局唯一。',
      '请优先覆盖关键架构模块、核心业务链路、重要基础设施与配置入口。'
    ].join('\n')
  })
}

function buildPlanningPrompt(projectName: string, workingFolder: string): UnifiedMessage {
  return {
    id: nanoid(),
    role: 'user',
    content: [
      `请为项目「${projectName}」生成 Wiki 树形目录结构。`,
      `工作目录：\`${workingFolder}\``,
      '要求：',
      '1. 先扫描分析代码，再给结构。',
      '2. 只允许一次性调用 SetWikiStructure。',
      '3. 父节点只负责分类；叶子节点后续要生成 Wiki。',
      '4. 叶子节点必须严格列出全部相关 sourceFiles。',
      '5. 目录按逻辑职责划分，而不是简单目录映射。'
    ].join('\n'),
    createdAt: Date.now()
  }
}

function buildLeafDefinition(): SubAgentDefinition {
  return {
    name: 'WikiLeafWriter',
    description: '为单个 Wiki 叶子节点生成 Markdown 文档。',
    systemPrompt: [
      '你正在为项目 Wiki 的单个叶子节点撰写内容。',
      '必须使用 Read / Glob / Grep 阅读给定来源文件。',
      '输出必须为中文 Markdown，适合 AI 查阅，结构清晰，避免空话。',
      '必须覆盖：模块职责、关键入口、核心流程、重要类型/接口、数据流、依赖关系、边界条件、异常/风险、维护提示。',
      '不要编造不存在的实现；不确定的内容要明确说明。',
      '完成后必须调用 SubAgentWriteReport，并把完整 Markdown 填入 report。'
    ].join('\n'),
    allowedTools: ['Read', 'Glob', 'Grep'],
    maxIterations: 12,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        sourceFiles: { type: 'array' },
        projectName: { type: 'string' },
        workingFolder: { type: 'string' },
        commitId: { type: 'string' }
      },
      required: ['title', 'description', 'sourceFiles', 'projectName', 'workingFolder']
    },
    formatOutput: (result) => result.finalReportMarkdown || result.output
  }
}

function getProviderConfig(sessionId: string): ProviderConfig | null {
  const providerConfig = useProviderStore.getState().getActiveProviderConfig()
  const modelConfig = useProviderStore.getState().getActiveModelConfig()
  const settings = useSettingsStore.getState()

  if (!providerConfig) {
    return settings.apiKey
      ? {
          type: settings.provider,
          apiKey: settings.apiKey,
          baseUrl: settings.baseUrl || undefined,
          model: settings.model,
          maxTokens: settings.maxTokens,
          temperature: settings.temperature,
          systemPrompt: settings.systemPrompt || undefined,
          thinkingEnabled: false,
          reasoningEffort: settings.reasoningEffort,
          sessionId
        }
      : null
  }

  const effectiveMaxTokens = modelConfig?.maxOutputTokens
    ? Math.min(settings.maxTokens, modelConfig.maxOutputTokens)
    : settings.maxTokens
  const thinkingEnabled = settings.thinkingEnabled && !!modelConfig?.thinkingConfig

  return {
    ...providerConfig,
    maxTokens: effectiveMaxTokens,
    temperature: settings.temperature,
    systemPrompt: settings.systemPrompt || undefined,
    thinkingEnabled,
    thinkingConfig: modelConfig?.thinkingConfig,
    reasoningEffort: settings.reasoningEffort,
    responseSummary: modelConfig?.responseSummary ?? providerConfig.responseSummary,
    enablePromptCache: modelConfig?.enablePromptCache ?? providerConfig.enablePromptCache,
    enableSystemPromptCache:
      modelConfig?.enableSystemPromptCache ?? providerConfig.enableSystemPromptCache,
    sessionId
  }
}

async function loadDocuments(projectId: string): Promise<WikiDocumentRow[]> {
  const rows = (await ipcClient.invoke(IPC.DB_WIKI_LIST_DOCUMENTS, projectId)) as WikiDocumentRow[]
  return rows ?? []
}

async function loadProjectState(projectId: string): Promise<{
  last_full_generated_commit_id?: string | null
  last_incremental_generated_commit_id?: string | null
} | null> {
  return (await ipcClient.invoke(IPC.DB_WIKI_GET_PROJECT_STATE, projectId)) as {
    last_full_generated_commit_id?: string | null
    last_incremental_generated_commit_id?: string | null
  } | null
}

async function saveDocument(args: SaveWikiDocumentArgs): Promise<WikiDocumentRow> {
  return (await ipcClient.invoke(IPC.DB_WIKI_SAVE_DOCUMENT, args)) as WikiDocumentRow
}

async function replaceSources(documentId: string, sourceFiles: string[]): Promise<void> {
  const sections = (await ipcClient.invoke(IPC.DB_WIKI_SAVE_SECTIONS, {
    documentId,
    sections: [
      {
        title: '来源文件',
        anchor: 'source-files',
        sortOrder: 0,
        summary: '该 Wiki 节点绑定的来源代码文件。',
        contentMarkdown: sourceFiles.map((file) => `- \`${file}\``).join('\n')
      }
    ]
  })) as Array<{ id: string }>

  const sectionId = sections[0]?.id
  if (!sectionId) return

  await ipcClient.invoke(IPC.DB_WIKI_SAVE_SECTION_SOURCES, {
    sectionId,
    sources: sourceFiles.map((filePath) => ({
      filePath,
      reason: 'AI 规划目录结构时严格指定的来源文件'
    }))
  })
}

async function saveProjectState(projectId: string, patch: Record<string, unknown>): Promise<void> {
  await ipcClient.invoke(IPC.DB_WIKI_SAVE_PROJECT_STATE, { projectId, patch })
}

async function createRun(args: Record<string, unknown>): Promise<{ id: string }> {
  return (await ipcClient.invoke(IPC.DB_WIKI_CREATE_RUN, args)) as { id: string }
}

async function updateRun(id: string, patch: Record<string, unknown>): Promise<void> {
  await ipcClient.invoke(IPC.DB_WIKI_UPDATE_RUN, { id, patch })
}

async function getHeadCommit(projectId: string): Promise<string | null> {
  const result = (await ipcClient.invoke(IPC.WIKI_GET_HEAD_COMMIT, { projectId })) as {
    commitId?: string | null
  }
  return result?.commitId ?? null
}

async function getChangedFiles(projectId: string, baseCommitId: string): Promise<string[] | null> {
  const result = (await ipcClient.invoke(IPC.WIKI_GET_CHANGED_FILES, {
    projectId,
    baseCommitId
  })) as {
    changedFiles?: string[] | null
  }
  return result?.changedFiles ?? null
}

async function exportProject(projectId: string): Promise<string[]> {
  const result = (await ipcClient.invoke(IPC.WIKI_EXPORT_PROJECT, { projectId })) as {
    exportedPaths?: string[]
  }
  return result?.exportedPaths ?? []
}

function tryParseTreePayload(text: string): WikiTreeNodeDraft[] | null {
  const candidates: string[] = []
  const trimmed = text.trim()
  if (trimmed) candidates.push(trimmed)

  const fenceMatches = Array.from(trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/g))
  for (const match of fenceMatches) {
    if (match[1]?.trim()) candidates.push(match[1].trim())
  }

  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1))
  }

  const firstBracket = trimmed.indexOf('[')
  const lastBracket = trimmed.lastIndexOf(']')
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    candidates.push(trimmed.slice(firstBracket, lastBracket + 1))
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown
      if (Array.isArray(parsed)) {
        return validateTreeStructure(parsed as WikiTreeNodeDraft[])
      }
      if (
        parsed &&
        typeof parsed === 'object' &&
        Array.isArray((parsed as { nodes?: unknown[] }).nodes)
      ) {
        return validateTreeStructure((parsed as { nodes: WikiTreeNodeDraft[] }).nodes)
      }
    } catch {
      continue
    }
  }

  return null
}

async function generateStructureJsonFallback(options: {
  providerConfig: ProviderConfig
  projectName: string
  workingFolder: string
  signal: AbortSignal
}): Promise<WikiTreeNodeDraft[] | null> {
  const provider = createProvider({
    ...options.providerConfig,
    systemPrompt: [
      '你是项目 Wiki 目录规划器。',
      '你的唯一任务是输出严格合法的 JSON。',
      '禁止输出 Markdown、解释、注释、前后缀文字。',
      'JSON 顶层必须是对象，格式为 {"nodes": [...]}。',
      '每个节点必须包含 title、description、sourceFiles、children。',
      '父节点的 sourceFiles 必须为空数组。',
      '叶子节点必须严格列出全部相关 sourceFiles。',
      '分组按逻辑职责，而不是按目录机械拆分。'
    ].join('\n')
  })

  const prompt: UnifiedMessage = {
    id: nanoid(),
    role: 'user',
    content: [
      `请为项目「${options.projectName}」生成 Wiki 树形结构 JSON。`,
      `工作目录：\`${options.workingFolder}\``,
      '请先在脑中完成分析，然后只返回 JSON，不要返回任何解释。',
      '格式：{"nodes":[{"title":"...","description":"...","sourceFiles":[],"children":[]}]}',
      '父节点不生成 Wiki；叶子节点必须列出严格完整的来源文件。'
    ].join('\n'),
    createdAt: Date.now()
  }

  let text = ''
  try {
    const stream = provider.sendMessage([prompt], [], { ...options.providerConfig }, options.signal)
    for await (const event of stream) {
      if (event.type === 'text_delta' && event.text) {
        text += event.text
      }
    }
  } catch {
    return null
  }

  return tryParseTreePayload(text)
}

function createStructureTool(state: { nodes: WikiTreeNodeDraft[] | null }): ToolHandler {
  return {
    definition: {
      name: 'SetWikiStructure',
      description: '一次性提交完整的 Wiki 树形结构 JSON。',
      inputSchema: {
        type: 'object',
        properties: {
          nodes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                description: { type: 'string' },
                sourceFiles: { type: 'array', items: { type: 'string' } },
                children: { type: 'array' }
              },
              required: ['title', 'description', 'children']
            }
          }
        },
        required: ['nodes']
      }
    },
    execute: async (input) => {
      const rawNodes = Array.isArray(input.nodes) ? (input.nodes as WikiTreeNodeDraft[]) : []
      state.nodes = validateTreeStructure(rawNodes)
      const flattened = flattenTree(state.nodes)
      return encodeStructuredToolResult({
        success: true,
        nodeCount: flattened.length,
        leafCount: flattened.filter((node) => node.isLeaf).length
      })
    },
    requiresApproval: () => false
  }
}

async function generateStructure(options: {
  providerConfig: ProviderConfig
  projectName: string
  workingFolder: string
  signal: AbortSignal
}): Promise<WikiTreeNodeDraft[]> {
  const state: { nodes: WikiTreeNodeDraft[] | null } = { nodes: null }
  const structureTool = createStructureTool(state)
  const toolDefs = pickToolDefs(['Read', 'Glob', 'Grep'], [structureTool.definition])
  const systemPrompt = buildPlanningSystemPrompt(options.workingFolder, toolDefs)
  const toolCtx: ToolContext = {
    workingFolder: options.workingFolder,
    signal: options.signal,
    ipc: ipcClient,
    inlineToolHandlers: {
      SetWikiStructure: structureTool
    }
  }

  const attemptMessages: UnifiedMessage[] = [
    buildPlanningPrompt(options.projectName, options.workingFolder)
  ]
  let collectedText = ''

  for (let attempt = 0; attempt < 2; attempt += 1) {
    collectedText = ''
    const loop = runAgentLoop(
      attemptMessages,
      {
        maxIterations: 20,
        provider: {
          ...options.providerConfig,
          systemPrompt
        },
        tools: toolDefs,
        systemPrompt,
        workingFolder: options.workingFolder,
        signal: options.signal
      },
      toolCtx,
      async () => true
    )

    for await (const event of loop) {
      if (event.type === 'text_delta') {
        collectedText += event.text
      }
      if (event.type === 'loop_end') break
    }

    if (state.nodes) {
      return state.nodes
    }

    const parsedFromText = tryParseTreePayload(collectedText)
    if (parsedFromText) {
      state.nodes = parsedFromText
      return parsedFromText
    }

    attemptMessages.push({
      id: nanoid(),
      role: 'user',
      content: [
        '你刚才没有调用 SetWikiStructure。',
        '现在必须立即调用一次 SetWikiStructure 提交完整结构。',
        '不要继续解释，不要输出自然语言，直接提交 tool 调用。',
        '如果你已经整理好了结果，也可以先输出合法 JSON，再立刻调用 SetWikiStructure。'
      ].join('\n'),
      createdAt: Date.now()
    })
  }

  const jsonFallback = await generateStructureJsonFallback(options)
  if (jsonFallback) {
    state.nodes = jsonFallback
    return jsonFallback
  }

  throw new Error('AI 未提交 Wiki 树结构')
}

async function persistStructure(
  projectId: string,
  mode: WikiGenerationMode,
  tree: WikiTreeNodeDraft[]
): Promise<WikiDocumentRow[]> {
  const flattened = flattenTree(tree)
  for (const node of flattened) {
    const saved = await saveDocument({
      id: node.id,
      projectId,
      name: node.name,
      slug: slugify(node.name),
      description: node.description,
      status: node.isLeaf ? 'pending' : 'directory',
      contentMarkdown: '',
      generationMode: mode,
      parentId: node.parentId,
      sortOrder: node.sortOrder,
      level: node.level,
      isLeaf: node.isLeaf,
      sourceFiles: node.sourceFiles
    })

    if (node.isLeaf) {
      await replaceSources(saved.id, node.sourceFiles)
    }
  }
  return loadDocuments(projectId)
}

async function generateLeafMarkdown(args: {
  providerConfig: ProviderConfig
  projectName: string
  workingFolder: string
  document: WikiDocumentRow
  commitId: string | null
  signal: AbortSignal
}): Promise<string> {
  const sourceFiles = parseSourceFilesJson(args.document.source_files_json)
  const result = await runSubAgent({
    definition: buildLeafDefinition(),
    parentProvider: { ...args.providerConfig, systemPrompt: undefined },
    toolContext: {
      workingFolder: args.workingFolder,
      signal: args.signal,
      ipc: ipcClient
    },
    input: {
      title: args.document.name,
      description: args.document.description,
      sourceFiles,
      projectName: args.projectName,
      workingFolder: args.workingFolder,
      commitId: args.commitId ?? ''
    },
    toolUseId: `wiki-${args.document.id}`,
    onApprovalNeeded: async () => true
  })

  const markdown = result.finalReportMarkdown?.trim() || result.output.trim()
  if (!markdown) {
    throw new Error(`叶子节点生成失败：${args.document.name}`)
  }
  return markdown
}

function intersectsChangedFiles(document: WikiDocumentRow, changedSet: Set<string>): boolean {
  return parseSourceFilesJson(document.source_files_json).some((file) => changedSet.has(file))
}

export class WikiGeneratorController {
  private abortController: AbortController | null = null
  private readonly leafLimiter = new ConcurrencyLimiter(2)

  cancel(): void {
    this.abortController?.abort()
  }

  async run(options: WikiGeneratorOptions, callbacks: WikiGeneratorCallbacks = {}): Promise<void> {
    if (this.abortController) {
      throw new Error('已有 Wiki 生成任务正在运行')
    }

    const abortController = new AbortController()
    this.abortController = abortController
    const signal = abortController.signal
    const sessionId = `wiki-${options.projectId}-${Date.now()}`
    let runId: string | null = null
    let changedFiles: string[] = []
    let targetDocuments: WikiDocumentRow[] = []
    let completedLeafCount = 0
    let totalLeafCount = 0
    let headCommitId: string | null = null

    const reportProgress = (progress: WikiGeneratorProgress): void => {
      callbacks.onProgress?.(progress)
    }

    try {
      const providerConfig = getProviderConfig(sessionId)
      if (!providerConfig || (!providerConfig.apiKey && providerConfig.requiresApiKey !== false)) {
        throw new Error('请先在设置中配置可用的 AI Provider')
      }
      if (providerConfig.providerId) {
        const ready = await ensureProviderAuthReady(providerConfig.providerId)
        if (!ready) {
          throw new Error('当前 AI Provider 尚未完成认证')
        }
      }

      reportProgress({
        stage: 'preparing',
        message: '正在准备 Wiki 生成任务',
        totalLeafCount: 0,
        completedLeafCount: 0
      })

      let effectiveMode = options.mode
      let documents = await loadDocuments(options.projectId)
      let leafDocuments = documents.filter((document) => document.is_leaf === 1)
      const projectState = await loadProjectState(options.projectId)
      headCommitId = await getHeadCommit(options.projectId)

      if (
        effectiveMode === 'full' &&
        (leafDocuments.length === 0 || !hasStructuredWiki(documents))
      ) {
        effectiveMode = 'regenerate'
      }

      if (effectiveMode === 'incremental') {
        const baseCommitId =
          projectState?.last_incremental_generated_commit_id ??
          projectState?.last_full_generated_commit_id ??
          null
        if (!baseCommitId) {
          effectiveMode = 'regenerate'
        } else {
          const nextChangedFiles = await getChangedFiles(options.projectId, baseCommitId)
          if (nextChangedFiles === null) {
            effectiveMode = 'regenerate'
          } else {
            changedFiles = nextChangedFiles
          }
        }
      }

      if (effectiveMode === 'regenerate') {
        await ipcClient.invoke(IPC.DB_WIKI_CLEAR_PROJECT, options.projectId)
      }

      await saveProjectState(options.projectId, {
        wikiEnabled: true,
        lastGenerationStatus: 'running',
        lastGenerationError: null
      })

      runId = (
        await createRun({
          projectId: options.projectId,
          mode: effectiveMode,
          status: 'running',
          baseCommitId:
            effectiveMode === 'incremental'
              ? (projectState?.last_incremental_generated_commit_id ??
                projectState?.last_full_generated_commit_id ??
                null)
              : null,
          headCommitId,
          changedFiles,
          affectedDocuments: []
        })
      ).id
      const activeRunId = runId

      if (effectiveMode === 'regenerate') {
        reportProgress({
          stage: 'planning',
          message: 'AI 正在扫描项目并规划 Wiki 树结构',
          totalLeafCount: 0,
          completedLeafCount: 0,
          runId: activeRunId
        })
        const tree = await generateStructure({
          providerConfig,
          projectName: options.projectName,
          workingFolder: options.workingFolder,
          signal
        })

        reportProgress({
          stage: 'saving-structure',
          message: '正在保存 Wiki 树结构',
          totalLeafCount: countLeafNodes(tree),
          completedLeafCount: 0,
          runId: activeRunId
        })
        documents = await persistStructure(options.projectId, effectiveMode, tree)
        callbacks.onDocumentsUpdated?.(documents)
        leafDocuments = documents.filter((document) => document.is_leaf === 1)
        targetDocuments = leafDocuments
      } else if (effectiveMode === 'full') {
        targetDocuments = leafDocuments
      } else {
        if (changedFiles.length === 0) {
          await saveProjectState(options.projectId, {
            wikiEnabled: true,
            lastGenerationStatus: 'completed',
            lastGenerationError: null,
            lastIncrementalGeneratedCommitId: headCommitId
          })
          await updateRun(activeRunId, {
            status: 'completed',
            changedFiles: [],
            affectedDocuments: [],
            outputSummary: 'No changed files detected.'
          })
          reportProgress({
            stage: 'completed',
            message: '没有检测到需要更新的代码变更',
            totalLeafCount: 0,
            completedLeafCount: 0,
            runId: activeRunId
          })
          return
        }

        const changedSet = new Set(changedFiles)
        targetDocuments = leafDocuments.filter((document) =>
          intersectsChangedFiles(document, changedSet)
        )

        if (targetDocuments.length === 0) {
          await saveProjectState(options.projectId, {
            wikiEnabled: true,
            lastGenerationStatus: 'completed',
            lastGenerationError: null,
            lastIncrementalGeneratedCommitId: headCommitId
          })
          await updateRun(activeRunId, {
            status: 'completed',
            changedFiles,
            affectedDocuments: [],
            outputSummary: 'Changed files did not match existing wiki nodes.'
          })
          reportProgress({
            stage: 'completed',
            message: '变更未命中任何现有 Wiki 节点',
            totalLeafCount: 0,
            completedLeafCount: 0,
            runId: activeRunId
          })
          return
        }
      }

      totalLeafCount = targetDocuments.length
      await updateRun(runId, {
        changedFiles,
        affectedDocuments: targetDocuments.map((document) => document.name),
        outputSummary: `Preparing ${totalLeafCount} leaf wiki documents.`
      })

      await Promise.all(
        targetDocuments.map((document) =>
          this.leafLimiter.run(async () => {
            if (signal.aborted) return
            const sourceFiles = parseSourceFilesJson(document.source_files_json)

            await saveDocument({
              id: document.id,
              projectId: options.projectId,
              name: document.name,
              slug: document.slug,
              description: document.description,
              status: 'generating',
              contentMarkdown: document.content_markdown,
              generationMode: effectiveMode,
              lastGeneratedCommitId: headCommitId,
              parentId: document.parent_id,
              sortOrder: document.sort_order,
              level: document.level,
              isLeaf: true,
              sourceFiles,
              preserveCreatedAt: true
            })
            callbacks.onDocumentsUpdated?.(await loadDocuments(options.projectId))
            reportProgress({
              stage: 'generating',
              message: `正在生成 Wiki：${document.name}`,
              totalLeafCount,
              completedLeafCount,
              currentNodeTitle: document.name,
              runId: activeRunId
            })

            try {
              const markdown = await generateLeafMarkdown({
                providerConfig,
                projectName: options.projectName,
                workingFolder: options.workingFolder,
                document,
                commitId: headCommitId,
                signal
              })

              await saveDocument({
                id: document.id,
                projectId: options.projectId,
                name: document.name,
                slug: document.slug,
                description: document.description,
                status: 'generated',
                contentMarkdown: markdown,
                generationMode: effectiveMode,
                lastGeneratedCommitId: headCommitId,
                parentId: document.parent_id,
                sortOrder: document.sort_order,
                level: document.level,
                isLeaf: true,
                sourceFiles,
                preserveCreatedAt: true
              })
              await replaceSources(document.id, sourceFiles)
              completedLeafCount += 1
              callbacks.onDocumentsUpdated?.(await loadDocuments(options.projectId))
              reportProgress({
                stage: 'generating',
                message: `已完成 ${completedLeafCount}/${totalLeafCount}：${document.name}`,
                totalLeafCount,
                completedLeafCount,
                currentNodeTitle: document.name,
                runId: activeRunId
              })
              await updateRun(activeRunId, {
                outputSummary: `Generated ${completedLeafCount}/${totalLeafCount} leaf wiki documents.`
              })
            } catch (error) {
              if (!signal.aborted) {
                await saveDocument({
                  id: document.id,
                  projectId: options.projectId,
                  name: document.name,
                  slug: document.slug,
                  description: document.description,
                  status: 'error',
                  contentMarkdown: document.content_markdown,
                  generationMode: effectiveMode,
                  lastGeneratedCommitId: headCommitId,
                  parentId: document.parent_id,
                  sortOrder: document.sort_order,
                  level: document.level,
                  isLeaf: true,
                  sourceFiles,
                  preserveCreatedAt: true
                })
                callbacks.onDocumentsUpdated?.(await loadDocuments(options.projectId))
              }
              throw error
            }
          }, signal)
        )
      )

      reportProgress({
        stage: 'exporting',
        message: '正在导出 Wiki 文档',
        totalLeafCount,
        completedLeafCount,
        runId: activeRunId
      })
      const exportedPaths = await exportProject(options.projectId)
      await saveProjectState(options.projectId, {
        wikiEnabled: true,
        lastGenerationStatus: 'completed',
        lastGenerationError: null,
        lastExportedAt: Date.now(),
        lastFullGeneratedCommitId: effectiveMode === 'incremental' ? undefined : headCommitId,
        lastIncrementalGeneratedCommitId: effectiveMode === 'incremental' ? headCommitId : undefined
      })
      await updateRun(activeRunId, {
        status: 'completed',
        changedFiles,
        affectedDocuments: targetDocuments.map((document) => document.name),
        outputSummary: `Generated ${completedLeafCount} wiki documents and exported ${exportedPaths.length} files.`
      })
      reportProgress({
        stage: 'completed',
        message: 'Wiki 生成完成',
        totalLeafCount,
        completedLeafCount,
        runId: activeRunId
      })
    } catch (error) {
      const cancelled = signal.aborted
      const message = error instanceof Error ? error.message : String(error)
      await saveProjectState(options.projectId, {
        wikiEnabled: true,
        lastGenerationStatus: cancelled ? 'cancelled' : 'error',
        lastGenerationError: cancelled ? null : message
      })
      if (runId) {
        await updateRun(runId, {
          status: cancelled ? 'cancelled' : 'failed',
          headCommitId,
          changedFiles,
          affectedDocuments: targetDocuments.map((document) => document.name),
          ...(cancelled ? {} : { error: message })
        })
      }
      reportProgress({
        stage: cancelled ? 'cancelled' : 'error',
        message: cancelled ? 'Wiki 生成已取消' : message,
        totalLeafCount,
        completedLeafCount,
        runId: runId ?? undefined
      })
      if (!cancelled) {
        throw error
      }
    } finally {
      this.abortController = null
    }
  }
}

export function createWikiGeneratorController(): WikiGeneratorController {
  return new WikiGeneratorController()
}

const defaultWikiGeneratorController = new WikiGeneratorController()

export async function runWikiGeneration(
  options: WikiGeneratorOptions,
  callbacks?: WikiGeneratorCallbacks
): Promise<void> {
  await defaultWikiGeneratorController.run(options, callbacks)
}

export function cancelWikiGeneration(): void {
  defaultWikiGeneratorController.cancel()
}
