import assert from 'node:assert/strict'
import test from 'node:test'
import { assembleSessionContext } from '../../src/main/ipc/agent-runtime/run-context-assembler.ts'
import {
  AgentSessionService,
  splitAssembledTurnMessages
} from '../../src/main/ipc/agent-runtime/agent-session-service.ts'
import {
  deriveCompactWatermarkFromTranscript,
  type CompactWatermark,
  type WatermarkMessage
} from '../../src/shared/compact-watermark.ts'

const session = {
  id: 'session-1',
  mode: 'chat',
  workingFolder: '/tmp/project',
  sshConnectionId: null,
  projectId: 'project-1',
  providerId: 'prov-1',
  modelId: 'model-1'
}

const messages = [
  { id: 'user-1', role: 'user', content: 'first', createdAt: 1, sortOrder: 0 },
  { id: 'asst-1', role: 'assistant', content: 'ok', createdAt: 2, sortOrder: 1 },
  { id: 'user-2', role: 'user', content: 'second', createdAt: 3, sortOrder: 2 }
]

function watermark(overrides: Partial<CompactWatermark> = {}): CompactWatermark {
  return {
    generation: 1,
    summaryMessageId: 'summary-1',
    throughMessageId: 'asst-1',
    throughSortOrder: 1,
    keepMessageIds: [],
    compactedMessageCount: 2,
    trigger: 'auto',
    preTokens: 80_000,
    createdAt: 5,
    ...overrides
  }
}

function assemblerDeps() {
  return {
    getSession: async () => session,
    getMessages: async () => messages,
    getCompaction: async () => null,
    resolveProvider: (providerId: string, modelId: string) => ({
      type: 'openai-chat',
      apiKey: 'k',
      model: modelId,
      providerId
    }),
    readPermissionPolicy: () => ({ allow: ['Read'] }),
    listTools: () => [
      {
        name: 'Read',
        description: 'Read a file',
        inputSchema: { type: 'object', properties: { file_path: { type: 'string' } } }
      }
    ],
    readRunSettings: () => ({
      autoApprove: false,
      maxParallelTools: 8,
      maxConcurrentSubAgents: 2,
      maxIterations: 0,
      webSearchEnabled: false,
      webSearch: null,
      teamToolsEnabled: false,
      codegraphEnabled: false,
      codegraphFullToolSurface: false,
      memoryUseMemories: true,
      memorySummaryBudgetTokens: 12_000,
      contextCompressionEnabled: false,
      contextCompressionThreshold: 0.8,
      contextCompressionModel: null,
      devMode: false,
      settingsRevision: 'test'
    }),
    resolveSystemPrompt: () => 'hosted prompt'
  }
}

test('assembler keeps history before the trigger and sends only the new user turn', async () => {
  const assembled = await assembleSessionContext(
    {
      sessionId: 'session-1',
      triggerMessageId: 'user-2',
      mode: 'chat',
      providerId: 'prov-1',
      modelId: 'model-1',
      attachmentIds: [],
      commandMetadata: null
    },
    assemblerDeps()
  )
  assert.deepEqual(
    assembled.historyMessages.map((message) => message.id),
    ['user-1', 'asst-1']
  )
  assert.deepEqual(
    assembled.turnMessages.map((message) => message.id),
    ['user-2']
  )
  assert.equal((assembled.openTemplate.provider as { apiKey?: string }).apiKey, 'k')
  assert.equal(assembled.openTemplate.workingFolder, '/tmp/project')
  assert.equal(assembled.openTemplate.runtimeProtocolVersion, 2)
  assert.equal(assembled.openTemplate.rolloutMode, 'v2')
  assert.equal(assembled.openTemplate.permissionMode, 'whitelist')
  assert.deepEqual(
    (assembled.openTemplate.tools as Array<{ name: string }>).map((tool) => tool.name),
    ['Read']
  )
  const snapshot = assembled.openTemplate.capabilitySnapshot as {
    sessionId?: string
    authorizedTools?: Array<{ wireName: string }>
  }
  assert.equal(snapshot.sessionId, 'session-1')
  assert.deepEqual(
    snapshot.authorizedTools?.map((tool) => tool.wireName),
    ['Read']
  )
  assert.equal(
    (assembled.openTemplate.provider as { systemPrompt?: string }).systemPrompt,
    'hosted prompt'
  )
})

test('assembler lifts systemCommand and slashCommand from commandMetadata onto the send template', async () => {
  const assembled = await assembleSessionContext(
    {
      sessionId: 'session-1',
      triggerMessageId: 'user-2',
      mode: 'chat',
      providerId: 'prov-1',
      modelId: 'model-1',
      attachmentIds: [],
      commandMetadata: {
        goalRunSource: 'user_turn',
        systemCommand: {
          name: 'init',
          content: 'Generate a file named AGENTS.md'
        },
        slashCommand: {
          commandName: 'init',
          rawArguments: 'docs',
          parsedArguments: ['docs']
        }
      }
    },
    assemblerDeps()
  )

  assert.deepEqual(assembled.openTemplate.systemCommand, {
    name: 'init',
    content: 'Generate a file named AGENTS.md'
  })
  assert.deepEqual(assembled.openTemplate.slashCommand, {
    commandName: 'init',
    rawArguments: 'docs',
    parsedArguments: ['docs']
  })
})

test('start-run opens a hosted session then sends only the trigger turn', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const service = new AgentSessionService({
    isRunning: () => true,
    nextRunId: () => 'run-1',
    assemble: (intent) => assembleSessionContext(intent, assemblerDeps()),
    request: async (method, params) => {
      const record = (params ?? {}) as Record<string, unknown>
      calls.push({ method, params: record })
      if (method === 'agent/session-open') {
        return { ok: true, sessionId: 'session-1', messageCount: 2 }
      }
      if (method === 'agent/session-send') {
        const runId = typeof record.runId === 'string' ? record.runId : 'run-worker'
        return {
          started: true,
          runId,
          assistantMessageId: `asst:${runId}`,
          accepted: true
        }
      }
      throw new Error(`unexpected ${method}`)
    }
  })

  const result = await service.startRun({
    sessionId: 'session-1',
    triggerMessageId: 'user-2',
    mode: 'chat',
    providerId: 'prov-1',
    modelId: 'model-1',
    attachmentIds: [],
    commandMetadata: null
  })

  assert.equal(result.accepted, true)
  assert.equal(result.runId, 'run-1')
  assert.equal(result.assistantMessageId, 'asst:run-1')
  assert.equal(result.errorCode, null)
  assert.equal(calls[0]?.method, 'agent/session-open')
  assert.equal(calls[0]?.params.runtimeProtocolVersion, 2)
  assert.ok(calls[0]?.params.capabilitySnapshot)
  assert.deepEqual(
    (calls[0]?.params.messages as Array<{ id: string }>).map((message) => message.id),
    ['user-1', 'asst-1']
  )
  assert.equal(calls[1]?.method, 'agent/session-send')
  assert.equal(calls[1]?.params.runId, 'run-1')
  assert.deepEqual(
    (calls[1]?.params.messages as Array<{ id: string }>).map((message) => message.id),
    ['user-2']
  )
})

test('start-run forwards systemCommand on session-send without pinning it on session-open', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const service = new AgentSessionService({
    isRunning: () => true,
    nextRunId: () => 'run-1',
    assemble: (intent) => assembleSessionContext(intent, assemblerDeps()),
    request: async (method, params) => {
      const record = (params ?? {}) as Record<string, unknown>
      calls.push({ method, params: record })
      if (method === 'agent/session-open') {
        return { ok: true, sessionId: 'session-1', messageCount: 2 }
      }
      if (method === 'agent/session-send') {
        return {
          started: true,
          runId: 'run-1',
          assistantMessageId: 'asst:run-1',
          accepted: true
        }
      }
      throw new Error(`unexpected ${method}`)
    }
  })

  await service.startRun({
    sessionId: 'session-1',
    triggerMessageId: 'user-2',
    mode: 'chat',
    providerId: 'prov-1',
    modelId: 'model-1',
    attachmentIds: [],
    commandMetadata: {
      systemCommand: {
        name: 'init',
        content: 'Generate a file named AGENTS.md'
      }
    }
  })

  assert.equal(calls[0]?.method, 'agent/session-open')
  assert.equal(calls[0]?.params.systemCommand, undefined)
  assert.equal(calls[1]?.method, 'agent/session-send')
  assert.deepEqual(calls[1]?.params.systemCommand, {
    name: 'init',
    content: 'Generate a file named AGENTS.md'
  })
})

test('assembler sets includeFullDebugBody from persisted Dev Mode', async () => {
  const off = await assembleSessionContext(
    {
      sessionId: 'session-1',
      triggerMessageId: 'user-2',
      mode: 'chat',
      providerId: 'prov-1',
      modelId: 'model-1',
      attachmentIds: [],
      commandMetadata: null
    },
    assemblerDeps()
  )
  const on = await assembleSessionContext(
    {
      sessionId: 'session-1',
      triggerMessageId: 'user-2',
      mode: 'chat',
      providerId: 'prov-1',
      modelId: 'model-1',
      attachmentIds: [],
      commandMetadata: null
    },
    {
      ...assemblerDeps(),
      readRunSettings: () => ({
        ...assemblerDeps().readRunSettings(),
        devMode: true
      })
    }
  )
  assert.equal(off.openTemplate.includeFullDebugBody, false)
  assert.equal(on.openTemplate.includeFullDebugBody, true)
})

test('start-run forwards includeFullDebugBody on session-send', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const service = new AgentSessionService({
    isRunning: () => true,
    nextRunId: () => 'run-1',
    assemble: (intent) =>
      assembleSessionContext(intent, {
        ...assemblerDeps(),
        readRunSettings: () => ({
          ...assemblerDeps().readRunSettings(),
          devMode: true
        })
      }),
    request: async (method, params) => {
      const record = (params ?? {}) as Record<string, unknown>
      calls.push({ method, params: record })
      if (method === 'agent/session-open') {
        return { ok: true, sessionId: 'session-1', messageCount: 2 }
      }
      if (method === 'agent/session-send') {
        return {
          started: true,
          runId: 'run-1',
          assistantMessageId: 'asst:run-1',
          accepted: true
        }
      }
      throw new Error(`unexpected ${method}`)
    }
  })

  await service.startRun({
    sessionId: 'session-1',
    triggerMessageId: 'user-2',
    mode: 'chat',
    providerId: 'prov-1',
    modelId: 'model-1',
    attachmentIds: [],
    commandMetadata: null
  })

  assert.equal(calls[0]?.method, 'agent/session-open')
  assert.equal(calls[0]?.params.includeFullDebugBody, true)
  assert.equal(calls[1]?.method, 'agent/session-send')
  assert.equal(calls[1]?.params.includeFullDebugBody, true)
})

test('startAssembledRun forwards includeFullDebugBody on a reused hosted session', async () => {
  const sendFlags: unknown[] = []
  const service = new AgentSessionService({
    isRunning: () => true,
    assemble: (intent) => assembleSessionContext(intent, assemblerDeps()),
    request: async (method, params) => {
      const record = (params ?? {}) as Record<string, unknown>
      if (method === 'agent/session-open') {
        return { ok: true, sessionId: 'session-1', messageCount: 2 }
      }
      if (method === 'agent/session-send') {
        sendFlags.push(record.includeFullDebugBody)
        return {
          started: true,
          runId: record.runId,
          assistantMessageId: `asst:${record.runId}`,
          accepted: true
        }
      }
      throw new Error(`unexpected ${method}`)
    }
  })

  await service.startAssembledRun(
    { ...assembledRunParams, includeFullDebugBody: false },
    { runId: 'run-1' }
  )
  await service.startAssembledRun(
    { ...assembledRunParams, includeFullDebugBody: true },
    { runId: 'run-2' }
  )
  assert.deepEqual(sendFlags, [false, true])
})

test('start-run reuses an open hosted session when prefix identity is unchanged', async () => {
  const calls: string[] = []
  let sendCount = 0
  const service = new AgentSessionService({
    isRunning: () => true,
    nextRunId: () => `run-${sendCount + 1}`,
    assemble: (intent) => assembleSessionContext(intent, assemblerDeps()),
    request: async (method, params) => {
      calls.push(method)
      if (method === 'agent/session-open') {
        return { ok: true, sessionId: 'session-1', messageCount: 2 }
      }
      if (method === 'agent/session-send') {
        sendCount += 1
        const runId = (params as { runId?: string }).runId ?? `run-${sendCount}`
        return {
          started: true,
          runId,
          assistantMessageId: `asst:${runId}`,
          accepted: true
        }
      }
      throw new Error(`unexpected ${method}`)
    }
  })

  const params = {
    sessionId: 'session-1',
    triggerMessageId: 'user-2',
    mode: 'chat',
    providerId: 'prov-1',
    modelId: 'model-1',
    attachmentIds: [],
    commandMetadata: null
  }
  await service.startRun(params)
  await service.startRun(params)

  assert.deepEqual(calls, ['agent/session-open', 'agent/session-send', 'agent/session-send'])
})

test('start-run reopens when prefix identity changes', async () => {
  const calls: string[] = []
  const service = new AgentSessionService({
    isRunning: () => true,
    nextRunId: () => 'run-1',
    assemble: (intent) => assembleSessionContext(intent, assemblerDeps()),
    request: async (method) => {
      calls.push(method)
      if (method === 'agent/session-open') {
        return { ok: true, sessionId: 'session-1', messageCount: 2 }
      }
      if (method === 'agent/session-send') {
        return {
          started: true,
          runId: 'run-1',
          assistantMessageId: 'asst:run-1',
          accepted: true
        }
      }
      throw new Error(`unexpected ${method}`)
    }
  })

  await service.startRun({
    sessionId: 'session-1',
    triggerMessageId: 'user-2',
    mode: 'chat',
    providerId: 'prov-1',
    modelId: 'model-1',
    attachmentIds: [],
    commandMetadata: null
  })
  await service.startRun({
    sessionId: 'session-1',
    triggerMessageId: 'user-2',
    mode: 'code',
    providerId: 'prov-1',
    modelId: 'model-1',
    attachmentIds: [],
    commandMetadata: null
  })

  assert.deepEqual(calls, [
    'agent/session-open',
    'agent/session-send',
    'agent/session-open',
    'agent/session-send'
  ])
})

test('start-run uses Worker-allocated run and assistant message ids', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const service = new AgentSessionService({
    isRunning: () => true,
    assemble: (intent) => assembleSessionContext(intent, assemblerDeps()),
    request: async (method, params) => {
      const record = (params ?? {}) as Record<string, unknown>
      calls.push({ method, params: record })
      if (method === 'agent/session-open') {
        return { ok: true, sessionId: 'session-1', messageCount: 2 }
      }
      if (method === 'agent/session-send') {
        assert.equal(record.runId, undefined)
        return {
          started: true,
          runId: 'run-worker',
          assistantMessageId: 'asst:run-worker',
          accepted: true
        }
      }
      throw new Error(`unexpected ${method}`)
    }
  })

  const result = await service.startRun({
    sessionId: 'session-1',
    triggerMessageId: 'user-2',
    mode: 'chat',
    providerId: 'prov-1',
    modelId: 'model-1',
    attachmentIds: [],
    commandMetadata: null
  })

  assert.equal(result.accepted, true)
  assert.equal(result.runId, 'run-worker')
  assert.equal(result.assistantMessageId, 'asst:run-worker')
  assert.equal(calls[1]?.method, 'agent/session-send')
  assert.equal(calls[1]?.params.runId, undefined)
})

test('ssh sessions carry resolved credentials on open and on every turn', async () => {
  const sshSession = { ...session, sshConnectionId: 'conn-1' }
  const connection = { id: 'conn-1', host: 'example.com', username: 'root', password: 'secret' }
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const service = new AgentSessionService({
    isRunning: () => true,
    nextRunId: () => 'run-1',
    assemble: (intent) =>
      assembleSessionContext(intent, {
        ...assemblerDeps(),
        getSession: async () => sshSession,
        resolveSshConnection: (connectionId) => (connectionId === 'conn-1' ? connection : null)
      }),
    request: async (method, params) => {
      calls.push({ method, params: params as Record<string, unknown> })
      if (method === 'agent/session-open') {
        return { ok: true, sessionId: 'session-1', messageCount: 2 }
      }
      if (method === 'agent/session-send') {
        return { started: true, runId: 'run-1', assistantMessageId: 'asst:run-1', accepted: true }
      }
      throw new Error(`unexpected ${method}`)
    }
  })

  await service.startRun({
    sessionId: 'session-1',
    triggerMessageId: 'user-2',
    mode: 'chat',
    providerId: 'prov-1',
    modelId: 'model-1',
    attachmentIds: [],
    commandMetadata: null
  })

  // Without `connection` the Worker cannot route Read/Write/Bash over SSH and reports
  // "Native tool not registered". It rides along on session-send too, so a session
  // restored from the Worker's on-disk snapshot still gets live credentials.
  assert.equal(calls[0]?.method, 'agent/session-open')
  assert.equal(calls[0]?.params.sshConnectionId, 'conn-1')
  assert.deepEqual(calls[0]?.params.connection, connection)
  assert.equal(calls[1]?.method, 'agent/session-send')
  assert.deepEqual(calls[1]?.params.connection, connection)
})

test('send-turn reopens from transcript after session_evicted and retries once', async () => {
  const calls: string[] = []
  let sendAttempts = 0
  const service = new AgentSessionService({
    isRunning: () => true,
    nextRunId: () => `run-${sendAttempts + 1}`,
    assemble: (intent) => assembleSessionContext(intent, assemblerDeps()),
    request: async (method, params) => {
      calls.push(method)
      if (method === 'agent/session-open') {
        return { ok: true, sessionId: 'session-1', messageCount: 2 }
      }
      if (method === 'agent/session-send') {
        sendAttempts += 1
        if (sendAttempts === 1) {
          const error = new Error('session_evicted: agent session is not open: session-1')
          ;(error as Error & { errorCode: string }).errorCode = 'session_evicted'
          throw error
        }
        return {
          started: true,
          runId: (params as { runId?: string }).runId ?? 'run-2',
          assistantMessageId: 'asst:run-2'
        }
      }
      throw new Error(`unexpected ${method}`)
    }
  })

  const result = await service.sendTurn({
    sessionId: 'session-1',
    triggerMessageId: 'user-2',
    attachmentIds: [],
    commandMetadata: null
  })

  assert.equal(result.accepted, true)
  assert.equal(result.errorCode, null)
  assert.deepEqual(calls, [
    'agent/session-open',
    'agent/session-send',
    'agent/session-open',
    'agent/session-send'
  ])
  assert.equal(sendAttempts, 2)
})

test('send-turn reopens when the compaction cut changes', async () => {
  const calls: string[] = []
  let messageSet: typeof messages = messages
  let compaction: CompactWatermark | null = null
  const service = new AgentSessionService({
    isRunning: () => true,
    nextRunId: () => 'run-1',
    assemble: (intent) =>
      assembleSessionContext(intent, {
        ...assemblerDeps(),
        getMessages: async () => messageSet,
        getCompaction: async () => compaction
      }),
    request: async (method) => {
      calls.push(method)
      if (method === 'agent/session-open') {
        return { ok: true, sessionId: 'session-1', messageCount: 2 }
      }
      if (method === 'agent/session-send') {
        return {
          started: true,
          runId: 'run-1',
          assistantMessageId: 'asst:run-1',
          accepted: true
        }
      }
      throw new Error(`unexpected ${method}`)
    }
  })

  await service.startRun({
    sessionId: 'session-1',
    triggerMessageId: 'user-2',
    mode: 'chat',
    providerId: 'prov-1',
    modelId: 'model-1',
    attachmentIds: [],
    commandMetadata: null
  })

  messageSet = [
    ...messages.slice(0, 2),
    {
      id: 'summary-1',
      role: 'user',
      content: 'Here is a summary of our conversation so far.',
      createdAt: 5,
      sortOrder: 3
    },
    messages[2]
  ]
  compaction = watermark()

  await service.sendTurn({
    sessionId: 'session-1',
    triggerMessageId: 'user-2',
    attachmentIds: [],
    commandMetadata: null
  })

  assert.deepEqual(calls, [
    'agent/session-open',
    'agent/session-send',
    'agent/session-open',
    'agent/session-send'
  ])
})

test('assembler marks cron callerType and keeps cron extras off the chat session id', async () => {
  const assembled = await assembleSessionContext(
    {
      sessionId: 'cron:run-1',
      triggerMessageId: 'user-2',
      mode: 'cron',
      providerId: 'prov-1',
      modelId: 'model-1',
      attachmentIds: [],
      commandMetadata: null,
      callerType: 'cron',
      requestContextTexts: ['hook-context'],
      extraTemplate: { callerAgent: 'CronAgent', pluginId: 'feishu-1' }
    },
    assemblerDeps()
  )
  const snapshot = assembled.openTemplate.capabilitySnapshot as {
    callerType?: string
    sessionId?: string
  }
  assert.equal(snapshot.callerType, 'cron')
  assert.equal(snapshot.sessionId, 'cron:run-1')
  assert.equal(assembled.openTemplate.callerAgent, 'CronAgent')
  assert.equal(assembled.openTemplate.pluginId, 'feishu-1')
  assert.deepEqual(assembled.openTemplate.requestContextTexts, ['hook-context'])
  assert.equal(assembled.openTemplate.webSearch, undefined)
})

test('assembler passes ssh and tool names into the system prompt resolver', async () => {
  let received: {
    sessionId?: string
    mode?: string
    workingFolder?: string | null
    sshConnectionId?: string | null
    toolNames?: string[]
    projectId?: string | null
  } | null = null
  await assembleSessionContext(
    {
      sessionId: 'session-1',
      triggerMessageId: 'user-2',
      mode: 'code',
      providerId: 'prov-1',
      modelId: 'model-1',
      attachmentIds: [],
      commandMetadata: null
    },
    {
      ...assemblerDeps(),
      getSession: async () => ({ ...session, mode: 'code', sshConnectionId: 'ssh-1' }),
      resolveSystemPrompt: (args) => {
        received = args
        return 'hosted prompt'
      }
    }
  )
  assert.equal(received?.sessionId, 'session-1')
  assert.equal(received?.mode, 'code')
  assert.equal(received?.workingFolder, '/tmp/project')
  assert.equal(received?.sshConnectionId, 'ssh-1')
  assert.equal(received?.projectId, 'project-1')
  assert.deepEqual(received?.toolNames, ['Read'])
})

test('session tool catalog includes worker-native families and gates team/codegraph', async () => {
  const { listSessionTools } =
    await import('../../src/main/ipc/agent-runtime/session-tool-catalog.ts')
  const coreNames = listSessionTools().map((tool) => tool.name)
  assert.equal(coreNames.includes('Read'), true)
  assert.equal(coreNames.includes('AskUserQuestion'), true)
  assert.equal(coreNames.includes('MemoryList'), true)
  assert.equal(coreNames.includes('CronList'), true)
  assert.equal(coreNames.includes('get_goal'), true)
  assert.equal(coreNames.includes('visualize_show_widget'), true)
  assert.equal(coreNames.includes('Monitor'), true)
  assert.equal(coreNames.includes('TeamCreate'), false)
  assert.equal(coreNames.includes('codegraph_explore'), false)
  assert.equal(coreNames.includes('PowerShell'), false)
  assert.equal(coreNames.includes('WebSearch'), false)
  const withSearch = listSessionTools({ webSearchEnabled: true }).map((tool) => tool.name)
  assert.equal(withSearch.includes('WebSearch'), true)
  assert.equal(withSearch.includes('WebFetch'), true)
  const withTeam = listSessionTools({ teamToolsEnabled: true }).map((tool) => tool.name)
  assert.equal(withTeam.includes('TeamCreate'), true)
  assert.equal(withTeam.includes('SendMessage'), true)
  const withGraph = listSessionTools({ codegraphEnabled: true }).map((tool) => tool.name)
  assert.equal(withGraph.includes('codegraph_explore'), true)
  const withPwsh = listSessionTools({ includePowerShell: true }).map((tool) => tool.name)
  assert.equal(withPwsh.includes('PowerShell'), true)
  assert.equal(coreNames.includes('BrowserNavigate'), false)
  assert.equal(coreNames.includes('PluginSendMessage'), false)
  assert.equal(coreNames.includes('ImageGenerate'), false)
  assert.equal(coreNames.includes('DesktopScreenshot'), false)
  const withHostTools = listSessionTools({
    browserEnabled: true,
    pluginToolsEnabled: true,
    imageGenerateEnabled: true,
    desktopControlEnabled: true
  }).map((tool) => tool.name)
  assert.equal(withHostTools.includes('BrowserNavigate'), true)
  assert.equal(withHostTools.includes('BrowserEvaluate'), true)
  assert.equal(withHostTools.includes('PluginSendMessage'), true)
  assert.equal(withHostTools.includes('FeishuSendImage'), true)
  assert.equal(withHostTools.includes('ImageGenerate'), true)
  assert.equal(withHostTools.includes('DesktopScreenshot'), true)
})

test('assembler appends ultra multi-agent authorization to the hosted prompt', async () => {
  const assembled = await assembleSessionContext(
    {
      sessionId: 'session-1',
      triggerMessageId: 'user-2',
      mode: 'code',
      providerId: 'prov-1',
      modelId: 'model-1',
      attachmentIds: [],
      commandMetadata: null
    },
    {
      ...assemblerDeps(),
      resolveProvider: (providerId, modelId) => ({
        type: 'openai-chat',
        apiKey: 'k',
        model: modelId,
        providerId,
        thinkingEnabled: true,
        reasoningEffort: 'ultra'
      })
    }
  )
  const prompt = (assembled.openTemplate.provider as { systemPrompt?: string }).systemPrompt ?? ''
  assert.doesNotMatch(prompt, /<multi_agent_mode>/)
  const texts = assembled.openTemplate.requestContextTexts as string[]
  assert.equal(
    texts.some((text) => text.includes('<multi_agent_mode>')),
    true
  )
  assert.match(prompt, /hosted prompt/)
})

test('assembler keeps Write in the ACP sub-agent catalog but not the lead tool list', async () => {
  const assembled = await assembleSessionContext(
    {
      sessionId: 'session-1',
      triggerMessageId: 'user-2',
      mode: 'acp',
      providerId: 'prov-1',
      modelId: 'model-1',
      attachmentIds: [],
      commandMetadata: null
    },
    {
      ...assemblerDeps(),
      getSession: async () => ({ ...session, mode: 'acp' }),
      listTools: () => [
        {
          name: 'Read',
          description: 'Read a file',
          inputSchema: { type: 'object', properties: { file_path: { type: 'string' } } }
        },
        {
          name: 'Write',
          description: 'Write a file',
          inputSchema: {
            type: 'object',
            properties: {
              file_path: { type: 'string' },
              content: { type: 'string' }
            }
          }
        },
        {
          name: 'Task',
          description: 'Launch a sub-agent',
          inputSchema: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              prompt: { type: 'string' }
            }
          }
        }
      ]
    }
  )
  assert.deepEqual(
    (assembled.openTemplate.tools as Array<{ name: string }>).map((tool) => tool.name),
    ['Read', 'Task']
  )
  assert.deepEqual(
    (assembled.openTemplate.subAgentToolCatalog as Array<{ name: string }>).map(
      (tool) => tool.name
    ),
    ['Read', 'Task', 'Write']
  )
  const snapshot = assembled.openTemplate.capabilitySnapshot as {
    authorizedTools?: Array<{ wireName: string }>
  }
  assert.deepEqual(
    snapshot.authorizedTools?.map((tool) => tool.wireName),
    ['Read', 'Task']
  )
})

test('assembler injects CodeGraph guidance when explore is in the catalog', async () => {
  const assembled = await assembleSessionContext(
    {
      sessionId: 'session-1',
      triggerMessageId: 'user-2',
      mode: 'code',
      providerId: 'prov-1',
      modelId: 'model-1',
      attachmentIds: [],
      commandMetadata: null
    },
    {
      ...assemblerDeps(),
      listTools: () => [
        {
          name: 'codegraph_explore',
          description: 'Explore the graph',
          inputSchema: { type: 'object', properties: { query: { type: 'string' } } }
        }
      ]
    }
  )
  const texts = assembled.openTemplate.requestContextTexts as string[]
  assert.equal(texts.length, 1)
  assert.match(texts[0], /codegraph_explore/)
})

const compactedTranscript = [
  { id: 'old-1', role: 'user', content: 'huge earlier task', createdAt: 1, sortOrder: 0 },
  { id: 'old-2', role: 'assistant', content: 'huge earlier reply', createdAt: 2, sortOrder: 1 },
  {
    id: 'asst-triggering',
    role: 'assistant',
    content: 'kept streaming through the compaction',
    createdAt: 3,
    sortOrder: 2
  },
  {
    id: 'summary-1',
    role: 'user',
    content: 'Here is a summary of our conversation so far. Earlier work is done.',
    createdAt: 4,
    sortOrder: 3
  },
  {
    id: 'asst-after',
    role: 'assistant',
    content: 'continued from summary',
    createdAt: 5,
    sortOrder: 4
  },
  { id: 'user-2', role: 'user', content: 'next question', createdAt: 6, sortOrder: 5 }
]

test('assembler drops everything through the recorded cut and keeps the spared turn', async () => {
  const assembled = await assembleSessionContext(
    {
      sessionId: 'session-1',
      triggerMessageId: 'user-2',
      mode: 'chat',
      providerId: 'prov-1',
      modelId: 'model-1',
      attachmentIds: [],
      commandMetadata: null
    },
    {
      ...assemblerDeps(),
      getMessages: async () => compactedTranscript,
      getCompaction: async () =>
        watermark({
          throughMessageId: 'asst-triggering',
          throughSortOrder: 2,
          keepMessageIds: ['asst-triggering']
        })
    }
  )
  assert.deepEqual(
    assembled.historyMessages.map((message) => message.id),
    ['summary-1', 'asst-triggering', 'asst-after']
  )
  assert.deepEqual(
    assembled.turnMessages.map((message) => message.id),
    ['user-2']
  )
  assert.ok(assembled.prefixIdentity.endsWith('\u00001:2:summary-1'))
})

test('assembler resolves the cut from the boundary row after a sort-order renumber', async () => {
  const renumbered = compactedTranscript.map((message) => ({
    ...message,
    sortOrder: message.sortOrder + 100
  }))
  const assembled = await assembleSessionContext(
    {
      sessionId: 'session-1',
      triggerMessageId: 'user-2',
      mode: 'chat',
      providerId: 'prov-1',
      modelId: 'model-1',
      attachmentIds: [],
      commandMetadata: null
    },
    {
      ...assemblerDeps(),
      getMessages: async () => renumbered,
      // The stored position is stale; the boundary id still resolves.
      getCompaction: async () => watermark({ throughMessageId: 'old-2', throughSortOrder: 1 })
    }
  )
  assert.deepEqual(
    assembled.historyMessages.map((message) => message.id),
    ['summary-1', 'asst-triggering', 'asst-after']
  )
})

test('assembler prefix identity changes after a new compaction', async () => {
  const before = await assembleSessionContext(
    {
      sessionId: 'session-1',
      triggerMessageId: 'user-2',
      mode: 'chat',
      providerId: 'prov-1',
      modelId: 'model-1',
      attachmentIds: [],
      commandMetadata: null
    },
    assemblerDeps()
  )
  const after = await assembleSessionContext(
    {
      sessionId: 'session-1',
      triggerMessageId: 'user-2',
      mode: 'chat',
      providerId: 'prov-1',
      modelId: 'model-1',
      attachmentIds: [],
      commandMetadata: null
    },
    {
      ...assemblerDeps(),
      getMessages: async () => compactedTranscript,
      getCompaction: async () => watermark()
    }
  )
  assert.notEqual(before.prefixIdentity, after.prefixIdentity)
})

test('assembler derives the cut for a session compacted by an older build', async () => {
  const legacyTranscript = [
    { id: 'old-1', role: 'user', content: 'huge earlier task', createdAt: 1, sortOrder: 0 },
    { id: 'old-2', role: 'assistant', content: 'huge earlier reply', createdAt: 2, sortOrder: 1 },
    {
      id: 'boundary-1',
      role: 'system',
      content: 'Conversation compacted',
      createdAt: 3,
      sortOrder: 2,
      meta: {
        compactBoundary: {
          trigger: 'auto',
          preTokens: 120000,
          messagesSummarized: 2,
          summaryId: 'summary-1'
        }
      }
    },
    {
      id: 'summary-1',
      role: 'user',
      content: '[Context Memory Compressed Summary]\n\nEarlier work is done.',
      createdAt: 4,
      sortOrder: 3,
      meta: { compactSummary: { messagesSummarized: 2, recentMessagesPreserved: false } }
    },
    {
      id: 'asst-after',
      role: 'assistant',
      content: 'continued from summary',
      createdAt: 5,
      sortOrder: 4
    },
    { id: 'user-2', role: 'user', content: 'next question', createdAt: 6, sortOrder: 5 }
  ]
  const assembled = await assembleSessionContext(
    {
      sessionId: 'session-1',
      triggerMessageId: 'user-2',
      mode: 'chat',
      providerId: 'prov-1',
      modelId: 'model-1',
      attachmentIds: [],
      commandMetadata: null
    },
    {
      ...assemblerDeps(),
      getMessages: async () => legacyTranscript,
      getCompaction: async (_sessionId: string, transcript: readonly WatermarkMessage[]) =>
        deriveCompactWatermarkFromTranscript(transcript)
    }
  )
  assert.deepEqual(
    assembled.historyMessages.map((message) => message.id),
    ['summary-1', 'asst-after']
  )
})

const assembledRunParams = {
  sessionId: 'session-1',
  sessionPromptMode: 'chat',
  workingFolder: '/tmp/project',
  provider: { type: 'openai-chat', apiKey: 'k', model: 'model-1', providerId: 'prov-1' },
  tools: [{ name: 'Read' }],
  messages: [
    { id: 'user-1', role: 'user', content: 'first', createdAt: 1 },
    { id: 'asst-1', role: 'assistant', content: 'ok', createdAt: 2 },
    { id: 'user-2', role: 'user', content: 'second', createdAt: 3 },
    { id: 'asst-empty', role: 'assistant', content: '', createdAt: 4 }
  ]
}

test('splitAssembledTurnMessages keeps history and the last user turn', () => {
  const { history, turn } = splitAssembledTurnMessages(assembledRunParams.messages)
  assert.deepEqual(
    history.map((message) => message.id),
    ['user-1', 'asst-1']
  )
  assert.deepEqual(
    turn.map((message) => message.id),
    ['user-2']
  )
})

test('splitAssembledTurnMessages leaves tool_result-only user messages in history', () => {
  const { history, turn } = splitAssembledTurnMessages([
    { id: 'user-1', role: 'user', content: 'first' },
    { id: 'asst-1', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read' }] },
    { id: 'tool-1', role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] }
  ])
  assert.equal(turn.length, 0)
  assert.deepEqual(
    history.map((message) => message.id),
    ['user-1', 'asst-1', 'tool-1']
  )
})

test('startAssembledRun opens a hosted session then sends only the new user turn', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const service = new AgentSessionService({
    isRunning: () => true,
    assemble: (intent) => assembleSessionContext(intent, assemblerDeps()),
    request: async (method, params) => {
      const record = (params ?? {}) as Record<string, unknown>
      calls.push({ method, params: record })
      if (method === 'agent/session-open') {
        return { ok: true, sessionId: 'session-1', messageCount: 2 }
      }
      if (method === 'agent/session-send') {
        return {
          started: true,
          runId: record.runId,
          assistantMessageId: `asst:${record.runId}`,
          accepted: true
        }
      }
      throw new Error(`unexpected ${method}`)
    }
  })

  const result = await service.startAssembledRun(
    { ...assembledRunParams },
    { runId: 'run-assembled' }
  )
  assert.equal(result?.accepted, true)
  assert.equal(result?.runId, 'run-assembled')
  assert.equal(calls[0]?.method, 'agent/session-open')
  assert.deepEqual(
    (calls[0]?.params.messages as Array<{ id: string }>).map((message) => message.id),
    ['user-1', 'asst-1']
  )
  assert.equal(calls[1]?.method, 'agent/session-send')
  assert.equal(calls[1]?.params.runId, 'run-assembled')
  assert.deepEqual(
    (calls[1]?.params.messages as Array<{ id: string }>).map((message) => message.id),
    ['user-2']
  )
})

test('startAssembledRun reuses an open hosted session when prefix identity is unchanged', async () => {
  const calls: string[] = []
  const service = new AgentSessionService({
    isRunning: () => true,
    assemble: (intent) => assembleSessionContext(intent, assemblerDeps()),
    request: async (method, params) => {
      calls.push(method)
      if (method === 'agent/session-open') {
        return { ok: true, sessionId: 'session-1', messageCount: 2 }
      }
      if (method === 'agent/session-send') {
        return {
          started: true,
          runId: (params as { runId?: string }).runId ?? 'run-1',
          assistantMessageId: 'asst:run-1',
          accepted: true
        }
      }
      throw new Error(`unexpected ${method}`)
    }
  })

  await service.startAssembledRun({ ...assembledRunParams }, { runId: 'run-1' })
  await service.startAssembledRun({ ...assembledRunParams }, { runId: 'run-2' })
  assert.deepEqual(calls, ['agent/session-open', 'agent/session-send', 'agent/session-send'])
})

/**
 * Main owns the cut, so it must enforce it on payloads the renderer assembled
 * from its own view of the transcript. A renderer view that predates the last
 * compaction is exactly how summarized turns get back into the context window.
 */
test('startAssembledRun re-applies the recorded cut to an assembled payload', async () => {
  const openMessages: string[][] = []
  const service = new AgentSessionService({
    isRunning: () => true,
    assemble: (intent) => assembleSessionContext(intent, assemblerDeps()),
    readCompaction: async () => watermark({ throughMessageId: 'asst-1', throughSortOrder: 1 }),
    request: async (method, params) => {
      const record = (params ?? {}) as Record<string, unknown>
      if (method === 'agent/session-open') {
        openMessages.push((record.messages as Array<{ id: string }>).map((message) => message.id))
        return { ok: true, sessionId: 'session-1', messageCount: 1 }
      }
      if (method === 'agent/session-send') {
        return {
          started: true,
          runId: record.runId,
          assistantMessageId: 'asst:run-cut',
          accepted: true
        }
      }
      throw new Error(`unexpected ${method}`)
    }
  })

  const result = await service.startAssembledRun(
    {
      ...assembledRunParams,
      messages: [
        { id: 'user-1', role: 'user', content: 'first', createdAt: 1, sortOrder: 0 },
        { id: 'asst-1', role: 'assistant', content: 'ok', createdAt: 2, sortOrder: 1 },
        { id: 'summary-1', role: 'user', content: 'summary text', createdAt: 3, sortOrder: 2 },
        { id: 'asst-after', role: 'assistant', content: 'continued', createdAt: 4, sortOrder: 3 },
        { id: 'user-2', role: 'user', content: 'second', createdAt: 5, sortOrder: 4 }
      ]
    },
    { runId: 'run-cut' }
  )
  assert.equal(result?.accepted, true)
  assert.deepEqual(openMessages, [['summary-1', 'asst-after']])
})

test('startAssembledRun derives the cut for a session compacted by an older build', async () => {
  const openMessages: string[][] = []
  const service = new AgentSessionService({
    isRunning: () => true,
    assemble: (intent) => assembleSessionContext(intent, assemblerDeps()),
    readCompaction: async () => null,
    request: async (method, params) => {
      const record = (params ?? {}) as Record<string, unknown>
      if (method === 'agent/session-open') {
        openMessages.push((record.messages as Array<{ id: string }>).map((message) => message.id))
        return { ok: true, sessionId: 'session-1', messageCount: 1 }
      }
      if (method === 'agent/session-send') {
        return {
          started: true,
          runId: record.runId,
          assistantMessageId: 'asst:run-legacy',
          accepted: true
        }
      }
      throw new Error(`unexpected ${method}`)
    }
  })

  const result = await service.startAssembledRun(
    {
      ...assembledRunParams,
      messages: [
        { id: 'old-1', role: 'user', content: 'huge earlier task', createdAt: 1, sortOrder: 0 },
        {
          id: 'boundary-1',
          role: 'system',
          content: 'Conversation compacted',
          createdAt: 2,
          sortOrder: 1,
          meta: { compactBoundary: { summaryId: 'summary-1' } }
        },
        {
          id: 'summary-1',
          role: 'user',
          content: '[Context Memory Compressed Summary]\n\nEarlier work is done.',
          createdAt: 3,
          sortOrder: 2,
          meta: { compactSummary: { messagesSummarized: 1 } }
        },
        { id: 'asst-after', role: 'assistant', content: 'continued', createdAt: 4, sortOrder: 3 },
        { id: 'user-2', role: 'user', content: 'next question', createdAt: 5, sortOrder: 4 }
      ]
    },
    { runId: 'run-legacy' }
  )
  assert.equal(result?.accepted, true)
  assert.deepEqual(openMessages, [['summary-1', 'asst-after']])
})

test('startAssembledRun returns null for continue, provider-turn-only, and empty turns', async () => {
  const service = new AgentSessionService({
    isRunning: () => true,
    assemble: (intent) => assembleSessionContext(intent, assemblerDeps()),
    request: async () => {
      throw new Error('should not request worker')
    }
  })

  assert.equal(
    await service.startAssembledRun({ ...assembledRunParams, goalRunSource: 'continue' }),
    null
  )
  assert.equal(
    await service.startAssembledRun({ ...assembledRunParams, providerTurnOnly: true }),
    null
  )
  assert.equal(
    await service.startAssembledRun({
      ...assembledRunParams,
      messages: [
        { id: 'user-1', role: 'user', content: 'first' },
        { id: 'asst-1', role: 'assistant', content: 'ok' }
      ]
    }),
    null
  )
})

test('assembler attaches compression config and copies message usage onto the wire', async () => {
  const assembled = await assembleSessionContext(
    {
      sessionId: 'session-1',
      triggerMessageId: 'user-2',
      mode: 'chat',
      providerId: 'prov-1',
      modelId: 'model-1',
      attachmentIds: [],
      commandMetadata: null
    },
    {
      ...assemblerDeps(),
      getMessages: async () => [
        messages[0],
        {
          ...messages[1],
          usage: { inputTokens: 120_000, outputTokens: 800, contextTokens: 120_000 }
        },
        messages[2]
      ],
      readRunSettings: () => ({
        ...assemblerDeps().readRunSettings(),
        contextCompressionEnabled: true,
        contextCompressionThreshold: 0.8
      }),
      resolveCompressionModel: () => ({
        contextLength: 200_000,
        maxOutputTokens: 16_000
      }),
      resolveCompressionProvider: () => ({
        type: 'openai-chat',
        apiKey: 'k',
        model: 'compress-1',
        providerId: 'prov-compress'
      })
    }
  )

  assert.deepEqual(assembled.openTemplate.compression, {
    enabled: true,
    contextLength: 200_000,
    threshold: 0.8,
    preCompressThreshold: 0.65,
    reservedOutputBudget: 16_000
  })
  assert.equal(
    (assembled.openTemplate.compressionProvider as { model?: string }).model,
    'compress-1'
  )
  assert.deepEqual(assembled.historyMessages[1]?.usage, {
    inputTokens: 120_000,
    outputTokens: 800,
    contextTokens: 120_000
  })
  assert.match(assembled.prefixIdentity, /\0on:200000:0.8:16000:prov-compress:compress-1\0/)
})

test('assembler omits compression when the setting is disabled', async () => {
  const assembled = await assembleSessionContext(
    {
      sessionId: 'session-1',
      triggerMessageId: 'user-2',
      mode: 'chat',
      providerId: 'prov-1',
      modelId: 'model-1',
      attachmentIds: [],
      commandMetadata: null
    },
    {
      ...assemblerDeps(),
      readRunSettings: () => ({
        ...assemblerDeps().readRunSettings(),
        contextCompressionEnabled: false,
        contextCompressionThreshold: 0.8
      }),
      resolveCompressionModel: () => ({ contextLength: 200_000 })
    }
  )
  assert.equal(assembled.openTemplate.compression, undefined)
  assert.equal(assembled.openTemplate.compressionProvider, undefined)
  assert.match(assembled.prefixIdentity, /\0off\0/)
})

test('assembler prefix identity changes when compression settings change', async () => {
  const intent = {
    sessionId: 'session-1',
    triggerMessageId: 'user-2',
    mode: 'chat',
    providerId: 'prov-1',
    modelId: 'model-1',
    attachmentIds: [],
    commandMetadata: null
  }
  const before = await assembleSessionContext(intent, {
    ...assemblerDeps(),
    readRunSettings: () => ({
      ...assemblerDeps().readRunSettings(),
      contextCompressionEnabled: true,
      contextCompressionThreshold: 0.8
    }),
    resolveCompressionModel: () => ({ contextLength: 200_000 })
  })
  const after = await assembleSessionContext(intent, {
    ...assemblerDeps(),
    readRunSettings: () => ({
      ...assemblerDeps().readRunSettings(),
      contextCompressionEnabled: true,
      contextCompressionThreshold: 0.5
    }),
    resolveCompressionModel: () => ({ contextLength: 200_000 })
  })
  assert.notEqual(before.prefixIdentity, after.prefixIdentity)
})
