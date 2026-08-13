import assert from 'node:assert/strict'
import test from 'node:test'
import { assembleSessionContext } from '../../src/main/ipc/agent-runtime/run-context-assembler.ts'
import { AgentSessionService } from '../../src/main/ipc/agent-runtime/agent-session-service.ts'

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
  { id: 'user-1', role: 'user', content: 'first', createdAt: 1 },
  { id: 'asst-1', role: 'assistant', content: 'ok', createdAt: 2 },
  { id: 'user-2', role: 'user', content: 'second', createdAt: 3 }
]

function assemblerDeps() {
  return {
    getSession: async () => session,
    getMessages: async () => messages,
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
  assert.deepEqual(calls, ['agent/session-send', 'agent/session-open', 'agent/session-send'])
  assert.equal(sendAttempts, 2)
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
