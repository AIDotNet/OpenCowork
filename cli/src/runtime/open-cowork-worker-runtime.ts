import { randomUUID } from 'node:crypto'
import type {
  AgentOption,
  AgentRuntime,
  AskUserAnswerPayload,
  AskUserRequest,
  CodeGraphStatus,
  ModelCatalog,
  ModelSelection,
  PermissionDecision,
  PermissionMode,
  PlanApprovalMode,
  PlanSnapshot,
  PlanStatus,
  RuntimeSessionConfig,
  TaskItem,
  UiEvent
} from '../types.js'
import { NativeWorkerClient, type NativeWorkerProbe } from './native-worker-client.js'
import {
  loadAgentCatalog,
  loadModelCatalog,
  loadOpenCoworkConfiguration,
  persistModelSelection
} from './provider-catalog.js'
import {
  buildWorkerRunRequest,
  type WorkerMessage,
  type WorkerToolDefinition,
  type WorkerSessionOptions
} from './worker-session.js'

type JsonRecord = Record<string, unknown>

type StreamEnvelope = {
  v: number
  runId: string
  sessionId: string
  seq: number
  events: JsonRecord[]
}

type PendingReverseRequest = {
  id: string
  method: string
  toolName?: string
}

type PendingPlanContext = {
  planExecution?: { filePath?: string }
  planRevision?: { title: string; filePath?: string; feedback: string }
}

export interface OpenCoworkWorkerRuntimeOptions {
  appVersion: string
  cwd: string
  effort?: string
  model?: string
  permissionMode: PermissionMode
  providerId?: string
  workerPath?: string
}

export interface WorkerRuntimeDoctorResult extends NativeWorkerProbe {
  configuredModel: string
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function normalizeEnvelope(value: unknown): StreamEnvelope | null {
  if (!isRecord(value)) return null
  const source = value.event === 'agent/stream' && isRecord(value.params) ? value.params : value
  const seq = numberValue(source.seq)
  if (
    numberValue(source.v) === null ||
    typeof source.runId !== 'string' ||
    typeof source.sessionId !== 'string' ||
    seq === null ||
    !Array.isArray(source.events)
  ) {
    return null
  }
  return {
    v: Number(source.v),
    runId: source.runId,
    sessionId: source.sessionId,
    seq,
    events: source.events.filter(isRecord)
  }
}

function formatJson(value: unknown): string {
  if (value === undefined) return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function flattenContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (!isRecord(item)) return String(item)
        if (item.type === 'text') return stringValue(item.text)
        if (item.type === 'image') return '[image]'
        return formatJson(item)
      })
      .filter(Boolean)
      .join('\n')
  }
  return formatJson(value)
}

function compact(text: string, limit = 220): string {
  const normalized = text.replace(/\s+/gu, ' ').trim()
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized
}

function normalizePlanStatus(value: unknown): PlanStatus {
  return value === 'awaiting_review' ||
    value === 'approved' ||
    value === 'implementing' ||
    value === 'completed' ||
    value === 'rejected' ||
    value === 'drafting'
    ? value
    : 'drafting'
}

function normalizePlanSnapshot(value: unknown): PlanSnapshot | null {
  if (!isRecord(value)) return null
  const id = stringValue(value.id)
  const sessionId = stringValue(value.sessionId)
  if (!id || !sessionId) return null
  const createdAt = numberValue(value.createdAt) ?? Date.now()
  return {
    id,
    sessionId,
    title: stringValue(value.title) || 'Plan',
    status: normalizePlanStatus(value.status),
    ...(stringValue(value.filePath) ? { filePath: stringValue(value.filePath) } : {}),
    ...(typeof value.content === 'string' ? { content: value.content } : {}),
    ...(typeof value.specJson === 'string' ? { specJson: value.specJson } : {}),
    createdAt,
    updatedAt: numberValue(value.updatedAt) ?? createdAt
  }
}

function normalizeAskUserRequest(id: string, value: JsonRecord): AskUserRequest | null {
  const rawQuestions = Array.isArray(value.questions) ? value.questions : []
  const questions = rawQuestions.filter(isRecord).map((question) => ({
    question: stringValue(question.question),
    header: stringValue(question.header) || 'Question',
    multiSelect: question.multiSelect === true,
    options: (Array.isArray(question.options) ? question.options : [])
      .filter(isRecord)
      .map((option) => ({
        label: stringValue(option.label),
        ...(stringValue(option.description)
          ? { description: stringValue(option.description) }
          : {}),
        ...(stringValue(option.preview) ? { preview: stringValue(option.preview) } : {})
      }))
      .filter((option) => option.label)
  }))
  if (
    questions.length === 0 ||
    questions.some((question) => !question.question || question.options.length < 2)
  ) {
    return null
  }
  return {
    id,
    toolUseId: stringValue(value.toolUseId) || id,
    ...(stringValue(value.runId) ? { runId: stringValue(value.runId) } : {}),
    ...(stringValue(value.sessionId) ? { sessionId: stringValue(value.sessionId) } : {}),
    questions
  }
}

function formatToolTitle(name: string, input: JsonRecord): string {
  const primary =
    stringValue(input.description) ||
    stringValue(input.command) ||
    stringValue(input.file_path) ||
    stringValue(input.notebook_path) ||
    stringValue(input.pattern) ||
    stringValue(input.path) ||
    stringValue(input.title) ||
    stringValue(input.subject) ||
    stringValue(input.query) ||
    stringValue(input.symbol) ||
    stringValue(input.taskId) ||
    stringValue(input.task_id)
  return primary ? `${name}(${compact(primary, 90)})` : name
}

function normalizeTaskStatus(status: unknown): TaskItem['status'] {
  if (status === 'completed') return 'completed'
  if (status === 'in_progress' || status === 'in_review') return 'in_progress'
  return 'pending'
}

function findTasks(value: unknown): TaskItem[] | null {
  let parsed = value
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed) as unknown
    } catch {
      return null
    }
  }
  if (!isRecord(parsed)) return null
  const candidates = [parsed.tasks, isRecord(parsed.result) ? parsed.result.tasks : undefined]
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue
    const tasks = candidate.filter(isRecord).map((task) => ({
      id: stringValue(task.id) || stringValue(task.taskId) || randomUUID(),
      label:
        stringValue(task.subject) ||
        stringValue(task.title) ||
        stringValue(task.description) ||
        'Untitled task',
      status: normalizeTaskStatus(task.status)
    }))
    return tasks
  }
  return null
}

function normalizeMessages(value: unknown): WorkerMessage[] | null {
  if (!Array.isArray(value)) return null
  const messages: WorkerMessage[] = []
  for (const item of value) {
    if (!isRecord(item)) return null
    const role = item.role
    if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') {
      return null
    }
    messages.push({
      id: stringValue(item.id) || randomUUID(),
      role,
      content: item.content ?? '',
      createdAt: numberValue(item.createdAt) ?? Date.now(),
      ...(isRecord(item.usage) ? { usage: item.usage } : {}),
      ...(typeof item.providerResponseId === 'string'
        ? { providerResponseId: item.providerResponseId }
        : {}),
      ...(typeof item.source === 'string' || item.source === null ? { source: item.source } : {}),
      ...(isRecord(item.meta) ? { meta: item.meta } : {})
    })
  }
  return messages
}

export class OpenCoworkWorkerRuntime implements AgentRuntime {
  private readonly client: NativeWorkerClient
  private readonly sessionId = `cli-session-${randomUUID()}`
  private readonly subscriptions: Array<() => void> = []
  private readonly pendingReverse = new Map<string, PendingReverseRequest>()
  private readonly sessionAllowedTools = new Set<string>()
  private readonly queue: UiEvent[] = []
  private messages: WorkerMessage[] = []
  private notify: (() => void) | null = null
  private activeRunId: string | null = null
  private lastSequence = 0
  private finished = false
  private assistantId: string | null = null
  private assistantIndex = 0
  private activeModelLabel: string
  private startedTools = new Set<string>()
  private subAgentReports = new Map<string, string>()
  private subAgentThinking = new Map<string, string>()
  private config: RuntimeSessionConfig
  private sessionCreation: Promise<void> | null = null
  private pendingPlanContext: PendingPlanContext = {}
  private activeCodeGraphToolNames = new Set<string>()
  private activeSignal: AbortSignal | null = null

  constructor(private readonly options: OpenCoworkWorkerRuntimeOptions) {
    const catalog = loadModelCatalog({
      providerId: options.providerId,
      modelId: options.model
    })
    this.config = {
      effort: options.effort ?? 'high',
      model: catalog.active?.modelId ?? options.model ?? '',
      providerId: catalog.active?.providerId ?? options.providerId ?? '',
      permissionMode: options.permissionMode
    }
    this.activeModelLabel = catalog.active?.modelName ?? options.model ?? 'No model configured'
    this.client = new NativeWorkerClient({
      appVersion: options.appVersion,
      workerPath: options.workerPath
    })
    this.subscriptions.push(
      this.client.on('agent/stream', (params, raw) => this.handleStream(params ?? raw)),
      this.client.on('agent/reverse-request', (params) => this.handleReverseRequest(params)),
      this.client.on('agent/reverse-cancel', (params) => this.handleReverseCancel(params)),
      this.client.on('worker/disconnected', (params) => {
        if (!this.activeRunId) return
        const message = params instanceof Error ? params.message : 'Native worker disconnected'
        this.pushSystem(message, 'error')
        this.finished = true
        this.wake()
      })
    )
  }

  configure(config: Partial<RuntimeSessionConfig>): void {
    this.config = { ...this.config, ...config }
  }

  selectModel(selection: ModelSelection): void {
    const persistedSelection = persistModelSelection(selection)
    this.config = {
      ...this.config,
      model: persistedSelection.modelId,
      providerId: persistedSelection.providerId
    }
    this.activeModelLabel = persistedSelection.modelName

    // A session row is created lazily on the first turn. Once it exists, keep the
    // durable session metadata aligned with the shared provider-store selection so
    // the desktop session list and the CLI describe the same model.
    if (this.sessionCreation) {
      void this.sessionCreation
        .then(async () => {
          const result = await this.client.request<JsonRecord>(
            'db/sessions-update',
            {
              id: this.sessionId,
              patch: {
                providerId: persistedSelection.providerId,
                modelId: persistedSelection.modelId,
                updatedAt: Date.now()
              }
            },
            30_000
          )
          if (isRecord(result) && result.success === false) {
            throw new Error(
              stringValue(result.error) || 'Failed to synchronize the CLI session model'
            )
          }
        })
        .catch((error) => {
          if (this.activeRunId) {
            this.pushSystem(
              `Session model metadata could not be synchronized: ${
                error instanceof Error ? error.message : String(error)
              }`,
              'warning'
            )
          }
        })
    }
  }

  getModelCatalog(): ModelCatalog {
    return loadModelCatalog({
      providerId: this.config.providerId,
      modelId: this.config.model
    })
  }

  getAgentCatalog(): AgentOption[] {
    return loadAgentCatalog()
  }

  async *send(prompt: string, signal: AbortSignal): AsyncIterable<UiEvent> {
    if (this.activeRunId) throw new Error('An OpenCowork worker turn is already active')

    const runId = `cli-run-${randomUUID()}`
    this.activeRunId = runId
    this.lastSequence = 0
    this.finished = false
    this.assistantId = null
    this.assistantIndex = 0
    this.startedTools = new Set()
    this.subAgentReports = new Map()
    this.subAgentThinking = new Map()
    this.queue.length = 0
    this.messages.push({
      id: `user-${randomUUID()}`,
      role: 'user',
      content: prompt,
      createdAt: Date.now()
    })

    const handleAbort = (): void => {
      void this.client.request('agent/cancel', { runId }, 10_000).catch((error) => {
        this.pushSystem(error instanceof Error ? error.message : String(error), 'error')
        this.finished = true
        this.wake()
      })
    }
    this.activeSignal = signal
    signal.addEventListener('abort', handleAbort, { once: true })

    try {
      const extraTools = await this.loadCodeGraphToolDefinitions(signal)
      const sessionOptions = this.createSessionOptions(runId)
      const { request, modelLabel } = buildWorkerRunRequest(
        sessionOptions,
        this.messages,
        extraTools
      )
      this.activeModelLabel = modelLabel
      await this.ensureSession()
      const result = await this.client.request<{ started?: boolean; runId?: string }>(
        'agent/run',
        request,
        30_000,
        signal
      )
      if (!result.started || result.runId !== runId) {
        throw new Error('OpenCowork Native Worker did not accept the agent run')
      }
      this.pendingPlanContext = {}

      while (!this.finished || this.queue.length > 0) {
        const event = this.queue.shift()
        if (event) {
          yield event
          continue
        }
        await new Promise<void>((resolveWait) => {
          this.notify = resolveWait
        })
      }
    } finally {
      signal.removeEventListener('abort', handleAbort)
      for (const [id, request] of this.pendingReverse) {
        if (request.method === 'approval/request') {
          void this.completeReverse(id, { approved: false, reason: 'CLI turn ended' })
        } else if (request.method === 'ask-user/request') {
          void this.completeReverse(id, undefined, 'CLI turn ended before the user answered')
        } else if (request.method === 'codegraph:tool') {
          void this.completeReverse(id, {
            success: true,
            text: 'CodeGraph request cancelled because the CLI turn ended.',
            isError: false,
            errorKind: 'cancelled'
          })
        }
      }
      this.activeRunId = null
      this.assistantId = null
      this.activeSignal = null
      this.notify = null
    }
  }

  async respondToPermission(requestId: string, decision: PermissionDecision): Promise<void> {
    const pending = this.pendingReverse.get(requestId)
    if (!pending || pending.method !== 'approval/request') return
    if (decision === 'allow_session' && pending.toolName) {
      this.sessionAllowedTools.add(pending.toolName)
    }
    const approved = decision !== 'deny'
    await this.completeReverse(requestId, {
      approved,
      reason: approved ? undefined : 'Denied by the user in OpenCowork CLI'
    })
  }

  async respondToAskUser(requestId: string, payload: AskUserAnswerPayload): Promise<void> {
    const pending = this.pendingReverse.get(requestId)
    if (!pending || pending.method !== 'ask-user/request') return
    await this.completeReverse(requestId, payload)
  }

  async approvePlan(plan: PlanSnapshot, mode: PlanApprovalMode): Promise<void> {
    const permissionMode: PermissionMode = mode === 'auto' ? 'auto' : mode
    await this.updatePlan(plan.id, { status: 'implementing', updatedAt: Date.now() })
    this.config = { ...this.config, permissionMode }
    this.pendingPlanContext = { planExecution: { filePath: plan.filePath } }
  }

  async revisePlan(plan: PlanSnapshot, feedback: string): Promise<void> {
    const normalized = feedback.trim()
    if (!normalized) throw new Error('Plan feedback is required')
    await this.updatePlan(plan.id, {
      status: 'rejected',
      updatedAt: Date.now()
    })
    this.config = { ...this.config, permissionMode: 'plan' }
    this.pendingPlanContext = {
      planRevision: {
        title: plan.title,
        ...(plan.filePath ? { filePath: plan.filePath } : {}),
        feedback: normalized
      }
    }
  }

  async getCodeGraphStatus(): Promise<CodeGraphStatus> {
    const configuration = loadOpenCoworkConfiguration()
    const enabled = configuration.settings.codegraphEnabled === true
    const fullToolSurface = configuration.settings.codegraphFullToolSurface === true
    if (!enabled) {
      return {
        enabled: false,
        fullToolSurface,
        indexed: false,
        toolNames: [],
        message: 'CodeGraph is disabled in OpenCowork Settings.'
      }
    }

    const tools = await this.loadCodeGraphToolDefinitions()
    let indexed = false
    let message = 'CodeGraph is enabled.'
    try {
      const result = await this.client.request<unknown>(
        'codegraph/instructions',
        { workingFolder: this.options.cwd },
        30_000
      )
      if (isRecord(result)) {
        indexed = result.indexed === true
        message = stringValue(result.instructions) || (indexed ? 'CodeGraph index ready.' : message)
      }
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    return {
      enabled,
      fullToolSurface,
      indexed,
      toolNames: tools.map((tool) => tool.name),
      message
    }
  }

  async doctor(): Promise<WorkerRuntimeDoctorResult> {
    const probe = await this.client.probe()
    const runId = `cli-doctor-${randomUUID()}`
    const { modelLabel } = buildWorkerRunRequest(this.createSessionOptions(runId), [])
    return { ...probe, configuredModel: modelLabel }
  }

  async dispose(): Promise<void> {
    if (this.activeRunId) {
      await this.client.request('agent/cancel', { runId: this.activeRunId }, 10_000).catch(() => {})
    }
    for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe()
    await this.client.stop()
  }

  private createSessionOptions(runId: string): WorkerSessionOptions {
    return {
      appVersion: this.options.appVersion,
      cwd: this.options.cwd,
      effort: this.config.effort,
      model: this.config.model,
      providerId: this.config.providerId,
      permissionMode: this.config.permissionMode,
      runId,
      sessionId: this.sessionId,
      ...(this.pendingPlanContext.planExecution
        ? { planExecution: this.pendingPlanContext.planExecution }
        : {}),
      ...(this.pendingPlanContext.planRevision
        ? { planRevision: this.pendingPlanContext.planRevision }
        : {})
    }
  }

  private async ensureSession(): Promise<void> {
    if (this.sessionCreation) return this.sessionCreation
    const sessionInput: JsonRecord = {
      id: this.sessionId,
      title: 'OpenCowork CLI',
      mode: 'code',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      workingFolder: this.options.cwd,
      modelSelectionMode: 'manual'
    }
    if (this.config.providerId) sessionInput.providerId = this.config.providerId
    if (this.config.model) sessionInput.modelId = this.config.model
    this.sessionCreation = this.client
      .request<JsonRecord>('db/sessions-create', sessionInput)
      .then((result) => {
        if (isRecord(result) && result.success === false) {
          throw new Error(
            stringValue(result.error) || 'Failed to create the OpenCowork CLI session'
          )
        }
      })
      .catch((error) => {
        this.sessionCreation = null
        throw error
      })
    return this.sessionCreation
  }

  private async loadCodeGraphToolDefinitions(
    signal?: AbortSignal
  ): Promise<WorkerToolDefinition[]> {
    const configuration = loadOpenCoworkConfiguration()
    const enabled = configuration.settings.codegraphEnabled === true
    this.activeCodeGraphToolNames.clear()
    if (!enabled) return []

    try {
      const result = await this.client.request<unknown>(
        'codegraph/tools-list',
        { workingFolder: this.options.cwd },
        30_000,
        signal
      )
      const listed = isRecord(result) && Array.isArray(result.tools) ? result.tools : []
      const fullSurface = configuration.settings.codegraphFullToolSurface === true
      const candidates = listed.filter(isRecord).filter((tool) => {
        const name = stringValue(tool.name)
        return name.startsWith('codegraph_') && (fullSurface || name === 'codegraph_explore')
      })
      const tools = candidates.map((tool) => {
        const name = stringValue(tool.name)
        const inputSchema = isRecord(tool.inputSchema)
          ? tool.inputSchema
          : { type: 'object', properties: {} }
        return {
          name,
          description:
            stringValue(tool.description) || `CodeGraph ${name.slice('codegraph_'.length)} query.`,
          inputSchema
        }
      })
      for (const tool of tools) this.activeCodeGraphToolNames.add(tool.name)
      return tools
    } catch (error) {
      if (signal?.aborted) throw error
      this.pushSystem(
        `CodeGraph tool catalog unavailable: ${error instanceof Error ? error.message : String(error)}`,
        'warning'
      )
      return []
    }
  }

  private handleStream(value: unknown): void {
    const envelope = normalizeEnvelope(value)
    if (!envelope || envelope.runId !== this.activeRunId || envelope.sessionId !== this.sessionId) {
      return
    }
    if (envelope.seq <= this.lastSequence) return
    if (this.lastSequence > 0 && envelope.seq !== this.lastSequence + 1) {
      this.pushSystem(
        `Worker stream sequence gap: expected ${this.lastSequence + 1}, received ${envelope.seq}`,
        'warning'
      )
    }
    this.lastSequence = envelope.seq
    for (const event of envelope.events) this.projectEvent(event)
    this.wake()
  }

  private projectEvent(event: JsonRecord): void {
    const type = stringValue(event.type)
    if (type === 'iteration_start') {
      this.assistantId = null
      return
    }
    if (type === 'text_delta') {
      const id = this.ensureAssistant()
      this.push({ type: 'assistant.delta', id, text: stringValue(event.text) })
      return
    }
    if (type === 'thinking_delta') {
      const id = this.ensureAssistant()
      this.push({ type: 'assistant.thinking', id, thinking: stringValue(event.thinking) })
      return
    }
    if (type === 'message_end') {
      if (this.assistantId) this.push({ type: 'assistant.done', id: this.assistantId })
      return
    }
    if (type === 'tool_use_generated' && isRecord(event.toolUseBlock)) {
      this.startTool(event.toolUseBlock)
      return
    }
    if ((type === 'tool_call_start' || type === 'tool_call_update') && isRecord(event.toolCall)) {
      this.startTool(event.toolCall)
      return
    }
    if (type === 'tool_call_result' && isRecord(event.toolCall)) {
      const tool = event.toolCall
      this.startTool(tool)
      const output = tool.output ?? tool.error ?? ''
      const error = stringValue(tool.status) === 'error' || Boolean(tool.error)
      this.push({
        type: 'tool.done',
        id: stringValue(tool.id),
        status: error ? 'error' : 'success',
        summary: compact(flattenContent(output)) || (error ? 'Failed' : 'Done')
      })
      const tasks = findTasks(output)
      if (tasks) this.push({ type: 'tasks.update', tasks })
      return
    }
    if (type === 'request_retry') {
      const attempt = numberValue(event.attempt) ?? 0
      const maxAttempts = numberValue(event.maxAttempts) ?? 0
      this.pushSystem(
        `Provider request retry ${attempt}/${maxAttempts} in ${numberValue(event.delayMs) ?? 0} ms${event.reason ? ` · ${stringValue(event.reason)}` : ''}`,
        'warning'
      )
      return
    }
    if (type === 'context_compression_start') {
      this.pushSystem('Compressing conversation context…')
      return
    }
    if (type === 'context_compressed') {
      this.pushSystem(
        `Context compressed · ${numberValue(event.originalCount) ?? 0} → ${numberValue(event.newCount) ?? 0} messages`,
        'success'
      )
      return
    }
    if (type === 'web_search') {
      const id = stringValue(event.webSearchId) || `web-search-${this.activeRunId}`
      if (!this.startedTools.has(id)) {
        this.startedTools.add(id)
        this.push({
          type: 'tool.start',
          id,
          title: `WebSearch(${compact(stringValue(event.content), 90)})`
        })
      }
      if (event.status === 'completed') {
        const sources = Array.isArray(event.webSearchSources) ? event.webSearchSources.length : 0
        this.push({
          type: 'tool.done',
          id,
          status: 'success',
          summary: sources > 0 ? `${sources} sources` : 'Search completed'
        })
      }
      return
    }
    if (type === 'image_generation_started') {
      const id = `image-${this.activeRunId}`
      if (!this.startedTools.has(id)) {
        this.startedTools.add(id)
        this.push({ type: 'tool.start', id, title: 'ImageGenerate' })
      }
      return
    }
    if (type === 'image_generated' || type === 'image_error') {
      const id = `image-${this.activeRunId}`
      if (!this.startedTools.has(id)) {
        this.startedTools.add(id)
        this.push({ type: 'tool.start', id, title: 'ImageGenerate' })
      }
      this.push({
        type: 'tool.done',
        id,
        status: type === 'image_error' ? 'error' : 'success',
        summary:
          type === 'image_error' && isRecord(event.imageError)
            ? stringValue(event.imageError.message)
            : 'Image generated'
      })
      return
    }
    if (
      type === 'sub_agent_queued' ||
      type === 'sub_agent_dequeued' ||
      type === 'sub_agent_start'
    ) {
      const id = stringValue(event.toolUseId) || `sub-agent-${randomUUID()}`
      if (!this.startedTools.has(id)) {
        this.startedTools.add(id)
        this.push({
          type: 'tool.start',
          id,
          title: `Task(${stringValue(event.subAgentName) || 'sub-agent'})`,
          detail: formatJson(event.input)
        })
      } else {
        const state =
          type === 'sub_agent_queued'
            ? 'Queued'
            : type === 'sub_agent_dequeued'
              ? 'Starting'
              : 'Running'
        this.push({
          type: 'tool.update',
          id,
          title: `Task(${stringValue(event.subAgentName) || 'sub-agent'})`,
          summary: state
        })
      }
      return
    }
    if (type === 'sub_agent_text_delta') {
      const id = stringValue(event.toolUseId)
      const report = `${this.subAgentReports.get(id) ?? ''}${stringValue(event.text)}`
      this.subAgentReports.set(id, report)
      this.push({ type: 'tool.update', id, summary: compact(report) || 'Working…' })
      return
    }
    if (type === 'sub_agent_thinking_delta') {
      const id = stringValue(event.toolUseId)
      const thinking = `${this.subAgentThinking.get(id) ?? ''}${stringValue(event.thinking)}`
      this.subAgentThinking.set(id, thinking)
      this.push({ type: 'tool.update', id, detail: compact(thinking, 1_000) })
      return
    }
    if (type === 'sub_agent_tool_use_generated' && isRecord(event.toolUseBlock)) {
      const id = stringValue(event.toolUseId)
      this.push({
        type: 'tool.update',
        id,
        summary: `Using ${stringValue(event.toolUseBlock.name) || 'tool'}`
      })
      return
    }
    if (type === 'sub_agent_tool_call' && isRecord(event.toolCall)) {
      const id = stringValue(event.toolUseId)
      const tool = event.toolCall
      const status = stringValue(tool.status)
      this.push({
        type: 'tool.update',
        id,
        summary: `${status === 'success' ? 'Completed' : status === 'error' ? 'Failed' : 'Using'} ${stringValue(tool.name) || 'tool'}`
      })
      return
    }
    if (type === 'sub_agent_report_update') {
      const id = stringValue(event.toolUseId)
      const report = stringValue(event.report)
      if (report) this.subAgentReports.set(id, report)
      this.push({
        type: 'tool.update',
        id,
        summary: compact(report) || 'Report unavailable'
      })
      return
    }
    if (type === 'sub_agent_end') {
      const id = stringValue(event.toolUseId)
      const result = isRecord(event.result) ? event.result : {}
      const report =
        stringValue(result.output) ||
        this.subAgentReports.get(id) ||
        stringValue(result.error) ||
        'Completed'
      this.push({
        type: 'tool.done',
        id,
        status: result.success === false ? 'error' : 'success',
        summary: compact(report)
      })
      return
    }
    if (type === 'error') {
      this.pushSystem(
        stringValue(event.message) || stringValue(event.details) || 'Native agent runtime error',
        'error'
      )
      return
    }
    if (type === 'loop_end') {
      if (this.assistantId) this.push({ type: 'assistant.done', id: this.assistantId })
      const finalMessages = normalizeMessages(event.messages)
      if (finalMessages) this.messages = finalMessages
      const reason = stringValue(event.reason)
      if (reason === 'max_iterations')
        this.pushSystem('Maximum agent iterations reached', 'warning')
      if (reason === 'aborted') this.pushSystem('Interrupted')
      this.push({ type: 'turn.done' })
      this.finished = true
    }
  }

  private startTool(tool: JsonRecord): void {
    const id = stringValue(tool.id)
    const name = stringValue(tool.name) || 'Tool'
    if (!id || this.startedTools.has(id)) return
    this.startedTools.add(id)
    const input = isRecord(tool.input) ? tool.input : {}
    this.push({
      type: 'tool.start',
      id,
      title: formatToolTitle(name, input),
      detail: Object.keys(input).length > 0 ? formatJson(input) : undefined
    })
  }

  private ensureAssistant(): string {
    if (this.assistantId) return this.assistantId
    this.assistantIndex += 1
    this.assistantId = `${this.activeRunId}-assistant-${this.assistantIndex}`
    this.push({
      type: 'assistant.start',
      id: this.assistantId,
      model: this.activeModelLabel
    })
    return this.assistantId
  }

  private handleReverseRequest(value: unknown): void {
    if (!isRecord(value)) return
    const id = stringValue(value.id)
    const method = stringValue(value.method)
    const params = isRecord(value.params) ? value.params : {}
    if (!id || !method) return
    if (method === 'ask-user/request') {
      const request = normalizeAskUserRequest(id, params)
      if (!request) {
        this.pendingReverse.set(id, { id, method })
        void this.completeReverse(id, undefined, 'Invalid AskUserQuestion payload')
        return
      }
      this.pendingReverse.set(id, { id, method })
      this.push({ type: 'askUser.request', request })
      return
    }

    if (method === 'plan/ui-update') {
      const plan = normalizePlanSnapshot(params.plan)
      if (!plan) {
        this.pendingReverse.set(id, { id, method })
        void this.completeReverse(id, undefined, 'Invalid plan/ui-update payload')
        return
      }
      this.pendingReverse.set(id, { id, method })
      const action = params.action === 'exit' || params.action === 'sync' ? params.action : 'enter'
      this.push({ type: 'plan.update', action, plan })
      void this.completeReverse(id, { ok: true })
      return
    }

    if (method === 'codegraph:tool') {
      this.pendingReverse.set(id, { id, method })
      void this.forwardCodeGraphRequest(id, params)
      return
    }

    if (method !== 'approval/request') {
      this.pendingReverse.set(id, { id, method })
      void this.completeReverse(id, undefined, `Unsupported CLI host request: ${method}`)
      return
    }

    const tool = isRecord(params.toolCall) ? params.toolCall : {}
    const toolName = stringValue(tool.name) || 'Tool'
    const editTool = toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit'
    if (
      this.sessionAllowedTools.has(toolName) ||
      this.config.permissionMode === 'auto' ||
      (this.config.permissionMode === 'acceptEdits' && editTool)
    ) {
      this.pendingReverse.set(id, { id, method, toolName })
      void this.completeReverse(id, { approved: true })
      this.pushSystem(`Allowed by session policy · ${toolName}`, 'success')
      return
    }

    const input = isRecord(tool.input) ? tool.input : {}
    this.pendingReverse.set(id, { id, method, toolName })
    this.push({
      type: 'permission.request',
      request: {
        id,
        tool: toolName,
        title: formatToolTitle(toolName, input),
        detail: formatJson(input) || 'This tool call has side effects.',
        risk:
          toolName === 'Bash' || toolName === 'Shell'
            ? 'Review the command and its working-directory effects before allowing it.'
            : undefined
      }
    })
  }

  private handleReverseCancel(value: unknown): void {
    if (!isRecord(value)) return
    const id = stringValue(value.id)
    const pending = id ? this.pendingReverse.get(id) : undefined
    if (id) this.pendingReverse.delete(id)
    if (!pending) return
    if (pending.method === 'ask-user/request') this.push({ type: 'askUser.cancel', requestId: id })
    if (pending.method === 'approval/request')
      this.push({ type: 'permission.cancel', requestId: id })
  }

  private async forwardCodeGraphRequest(id: string, params: JsonRecord): Promise<void> {
    const toolName = stringValue(params.name)
    if (!toolName.startsWith('codegraph_') || !this.activeCodeGraphToolNames.has(toolName)) {
      await this.completeReverse(id, {
        success: true,
        text: 'This CodeGraph tool is not enabled for the current workspace. Use the tools reported by codegraph/tools-list.',
        isError: false,
        errorKind: 'disabled'
      })
      return
    }

    const configuration = loadOpenCoworkConfiguration()
    if (configuration.settings.codegraphEnabled !== true) {
      await this.completeReverse(id, {
        success: true,
        text: 'CodeGraph is disabled for this workspace. Continue with Read, Grep, and Glob.',
        isError: false,
        errorKind: 'disabled'
      })
      return
    }

    const input = isRecord(params.input) ? { ...params.input } : {}
    const projectPath =
      stringValue(input.projectPath) || stringValue(params.workingFolder) || this.options.cwd
    if (projectPath) input.projectPath = projectPath
    try {
      const result = await this.client.request<unknown>(
        `codegraph/${toolName.slice('codegraph_'.length)}`,
        input,
        120_000,
        this.activeSignal ?? undefined
      )
      await this.completeReverse(id, result)
    } catch (error) {
      await this.completeReverse(id, {
        success: true,
        text: `CodeGraph is currently unavailable (${error instanceof Error ? error.message : String(error)}). Continue with Read, Grep, and Glob, then retry when the index is ready.`,
        isError: false,
        errorKind: 'unavailable'
      })
    }
  }

  private async updatePlan(id: string, patch: JsonRecord): Promise<void> {
    const result = await this.client.request<JsonRecord>('db/plans-update', { id, patch }, 30_000)
    if (isRecord(result) && result.success === false) {
      throw new Error(stringValue(result.error) || 'Failed to update the plan in the Native Worker')
    }
  }

  private async completeReverse(id: string, result?: unknown, error?: string): Promise<void> {
    if (!this.pendingReverse.has(id)) return
    this.pendingReverse.delete(id)
    await this.client.request(
      'agent/reverse-response',
      error ? { id, error } : { id, result },
      30_000
    )
  }

  private push(event: UiEvent): void {
    this.queue.push(event)
    this.wake()
  }

  private pushSystem(
    text: string,
    tone: 'muted' | 'warning' | 'error' | 'success' = 'muted'
  ): void {
    this.push({
      type: 'system',
      message: { id: `system-${randomUUID()}`, kind: 'system', text, tone }
    })
  }

  private wake(): void {
    if (!this.notify) return
    const resume = this.notify
    this.notify = null
    resume()
  }
}
