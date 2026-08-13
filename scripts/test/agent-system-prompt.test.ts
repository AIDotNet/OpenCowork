import assert from 'node:assert/strict'
import test from 'node:test'
import { buildHostedSessionSystemPrompt } from '../../src/main/ipc/agent-runtime/session-system-prompt.ts'
import {
  buildAgentModeSystemPrompt,
  buildChatModeSystemPrompt,
  buildHostedMemoryContext,
  buildActiveMcpPromptSection,
  buildLeadCoordinatorPrompt,
  buildProjectChannelsPromptSection,
  mapNodePlatformToPromptPlatform,
  resolvePromptEnvironmentFromPlatform,
  resolvePromptLanguageName,
  selectTeamCoordinatorForSession
} from '../../src/shared/agent-system-prompt.ts'

const localMac = resolvePromptEnvironmentFromPlatform({ platform: 'Mac' })

test('maps Node platforms onto the renderer prompt platform strings', () => {
  assert.equal(mapNodePlatformToPromptPlatform('darwin'), 'Mac')
  assert.equal(mapNodePlatformToPromptPlatform('win32'), 'Win')
  assert.equal(mapNodePlatformToPromptPlatform('linux'), 'Linux')
  assert.equal(resolvePromptLanguageName('zh-CN'), 'Chinese')
})

test('chat prompt includes the chat heading and working folder', () => {
  const prompt = buildChatModeSystemPrompt({
    languageName: 'Chinese',
    workingFolder: '/tmp/project',
    environmentContext: localMac
  })
  assert.match(prompt, /## Chat Mode/)
  assert.match(prompt, /You are \*\*OpenCowork\*\*/)
  assert.match(prompt, /## Working Folder/)
  assert.match(prompt, /`\/tmp\/project`/)
  assert.doesNotMatch(prompt, /## Mode: Code/)
})

test('code prompt includes mode body, working folder, and skills reminder', () => {
  const prompt = buildAgentModeSystemPrompt({
    mode: 'code',
    workingFolder: '/tmp/project',
    languageName: 'English',
    toolDefs: [{ name: 'Read' }, { name: 'Skill' }],
    skills: [{ name: 'csv-pipeline', description: 'Process CSV files' }],
    environmentContext: localMac,
    globalHomePath: '/Users/me/.open-cowork'
  })
  assert.match(prompt, /## Mode: Code/)
  assert.match(prompt, /## Working Folder/)
  assert.match(prompt, /`\/tmp\/project`/)
  assert.match(prompt, /Available Skills: 1/)
  assert.match(prompt, /csv-pipeline: Process CSV files/)
  assert.match(prompt, /Operating System: macOS/)
})

test('hosted chat prompt uses the shared chat builder', () => {
  const prompt = buildHostedSessionSystemPrompt({
    mode: 'chat',
    workingFolder: '/tmp/project',
    platform: 'darwin',
    language: 'zh',
    toolNames: ['Read'],
    globalHomePath: '/tmp/home/.open-cowork'
  })
  assert.match(prompt, /## Chat Mode/)
  assert.match(prompt, /Chinese/)
  assert.match(prompt, /`\/tmp\/project`/)
  assert.match(prompt, /Operating System: macOS/)
  assert.doesNotMatch(prompt, /## Mode: Code/)
})

test('hosted code prompt includes skills and SSH environment', () => {
  const prompt = buildHostedSessionSystemPrompt({
    mode: 'code',
    workingFolder: '/home/ubuntu/app',
    platform: 'linux',
    language: 'en',
    toolNames: ['Read', 'Write', 'Skill'],
    skills: [
      { name: 'zeta-skill', description: 'Second' },
      { name: 'alpha-skill', description: 'First' }
    ],
    sshConnectionId: 'ssh-1',
    sshConnection: {
      name: 'prod',
      host: '10.0.0.8',
      defaultDirectory: '/home/ubuntu/app'
    },
    userRules: 'Always write tests.',
    globalHomePath: '/home/user/.open-cowork'
  })
  assert.match(prompt, /## Mode: Code/)
  assert.match(prompt, /SSH Remote Host \(10\.0\.0\.8\)/)
  assert.match(prompt, /SSH Connection: prod/)
  assert.match(prompt, /alpha-skill: First/)
  assert.match(prompt, /zeta-skill: Second/)
  assert.ok(prompt.indexOf('alpha-skill') < prompt.indexOf('zeta-skill'))
  assert.match(prompt, /Always write tests\./)
  assert.match(prompt, /`\/home\/user\/\.open-cowork`/)
})

test('hosted memory context injects soul and withholds user files when memories are disabled', () => {
  const enabled = buildHostedMemoryContext({
    memoryUseMemories: true,
    layers: {
      globalSoul: { path: '/tmp/SOUL.md', content: 'Be a calm engineer.' },
      globalUser: { path: '/tmp/USER.md', content: 'Prefers terse answers.' }
    }
  })
  assert.match(enabled ?? '', /<global_soul/)
  assert.match(enabled ?? '', /Be a calm engineer\./)
  assert.match(enabled ?? '', /<global_user>/)
  assert.match(enabled ?? '', /Prefers terse answers\./)

  const disabled = buildHostedMemoryContext({
    memoryUseMemories: false,
    layers: {
      globalSoul: { path: '/tmp/SOUL.md', content: 'Be a calm engineer.' },
      globalUser: { path: '/tmp/USER.md', content: 'Prefers terse answers.' }
    }
  })
  assert.match(disabled ?? '', /<global_soul/)
  assert.doesNotMatch(disabled ?? '', /<global_user>/)
  assert.doesNotMatch(disabled ?? '', /Prefers terse answers\./)
})

test('hosted chat prompt includes injected memory context', () => {
  const prompt = buildHostedSessionSystemPrompt({
    mode: 'chat',
    workingFolder: '/tmp/project',
    platform: 'darwin',
    language: 'en',
    memoryContext: '<global_soul priority="high">\nBe kind.\n</global_soul>',
    globalHomePath: '/tmp/home/.open-cowork'
  })
  assert.match(prompt, /## Chat Mode/)
  assert.match(prompt, /<global_soul/)
  assert.match(prompt, /Be kind\./)
})

test('hosted memory context includes daily notes when memories are enabled', () => {
  const prompt = buildHostedMemoryContext({
    memoryUseMemories: true,
    layers: {
      globalDailyMemory: [
        { date: '2026-08-13', path: '/tmp/memory/2026-08-13.md', content: 'Shipped catalog.' }
      ]
    }
  })
  assert.match(prompt ?? '', /<global_daily_memory>/)
  assert.match(prompt ?? '', /Shipped catalog\./)
})

test('MCP and channel prompt sections match the renderer live-context shape', () => {
  const mcp = buildActiveMcpPromptSection([
    {
      id: 'srv-1',
      name: 'Docs',
      transport: 'stdio',
      description: 'Internal docs',
      toolNames: ['mcp__srv-1__search']
    }
  ])
  assert.match(mcp ?? '', /## Active MCP Servers/)
  assert.match(mcp ?? '', /mcp__srv-1__search/)
  const channels = buildProjectChannelsPromptSection([
    { id: 'feishu-1', name: 'Work', type: 'feishu-bot' }
  ])
  assert.match(channels ?? '', /## Project Channels/)
  assert.match(channels ?? '', /feishu-1/)
})

test('team coordinator prompt matches the renderer lead coordinator shape', () => {
  const prompt = buildLeadCoordinatorPrompt({
    name: 'Ship Crew',
    permissionMode: 'plan',
    defaultBackend: 'in-process',
    members: [{ name: 'Scout' }, { name: 'Builder' }]
  })
  assert.match(prompt, /## Agent Team Coordinator/)
  assert.match(prompt, /active team "Ship Crew"/)
  assert.match(prompt, /Team permission mode is currently PLAN/)
  assert.match(prompt, /Default team backend: \.NET Native Worker/)
  assert.match(prompt, /Current teammates: Scout, Builder/)
})

test('hosted active team is selected only for the matching interactive session', () => {
  const persisted = {
    activeTeam: {
      name: 'Ship Crew',
      sessionId: 'session-1',
      permissionMode: 'plan',
      defaultBackend: 'in-process',
      members: [{ name: 'Scout' }]
    }
  }
  const selected = selectTeamCoordinatorForSession(persisted, 'session-1')
  assert.equal(selected?.name, 'Ship Crew')
  assert.equal(selectTeamCoordinatorForSession(persisted, 'session-2'), null)
  assert.equal(selectTeamCoordinatorForSession(persisted, 'cron:run-1'), null)
})

test('hosted code prompt injects the active team coordinator block', () => {
  const prompt = buildHostedSessionSystemPrompt({
    mode: 'code',
    workingFolder: '/tmp/project',
    platform: 'darwin',
    language: 'en',
    toolNames: ['Read', 'TeamCreate', 'SendMessage', 'TeamStatus', 'TeamDelete'],
    globalHomePath: '/tmp/home/.open-cowork',
    activeTeam: {
      name: 'Ship Crew',
      permissionMode: 'plan',
      defaultBackend: 'in-process',
      members: [{ name: 'Scout' }]
    }
  })
  assert.match(prompt, /## Agent Teams \(ACTIVE\)/)
  assert.match(prompt, /## Agent Team Coordinator/)
  assert.match(prompt, /active team "Ship Crew"/)
  assert.match(prompt, /Current teammates: Scout/)
})
