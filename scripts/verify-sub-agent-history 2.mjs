/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { decode, encode } from '@msgpack/msgpack'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..')
const defaultWorkerDll = path.join(
  repoRoot,
  'sidecars',
  'OpenCowork.Native.Worker',
  'bin',
  'Debug',
  'net10.0',
  'OpenCowork.Native.Worker.dll'
)
const workerPath = process.env.OPEN_COWORK_VERIFY_WORKER || defaultWorkerDll

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function createFrame(payload) {
  const frame = Buffer.allocUnsafe(4 + payload.byteLength)
  frame.writeUInt32BE(payload.byteLength, 0)
  Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).copy(frame, 4)
  return frame
}

class WorkerClient {
  constructor(endpoint, child, dbPath) {
    this.endpoint = endpoint
    this.child = child
    this.dbPath = dbPath
    this.socket = null
    this.buffer = Buffer.alloc(0)
    this.nextId = 1
    this.pending = new Map()
  }

  async connect() {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      try {
        this.socket = await new Promise((resolve, reject) => {
          const socket = net.createConnection(this.endpoint)
          socket.once('connect', () => resolve(socket))
          socket.once('error', reject)
        })
        this.socket.on('data', (chunk) => this.onData(chunk))
        return
      } catch {
        if (this.child.exitCode !== null) {
          throw new Error(`Native worker exited with code ${this.child.exitCode}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
    throw new Error('Timed out connecting to Native Worker')
  }

  request(method, params = {}) {
    const id = this.nextId++
    const requestParams = method.startsWith('db/') ? { ...params, dbPath: this.dbPath } : params
    const frame = createFrame(encode({ id, method, params: requestParams }))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Timed out: ${method}`))
      }, 120_000)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.write(frame)
    })
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0)
      if (this.buffer.length < length + 4) return
      const frame = decode(this.buffer.subarray(4, length + 4))
      this.buffer = this.buffer.subarray(length + 4)
      if (typeof frame?.id !== 'number') continue
      const pending = this.pending.get(frame.id)
      if (!pending) continue
      clearTimeout(pending.timer)
      this.pending.delete(frame.id)
      if (frame.error) pending.reject(new Error(String(frame.error)))
      else pending.resolve(frame.result)
    }
  }

  close() {
    this.socket?.destroy()
  }
}

function historyEntry(toolUseId, sessionId, startedAt, report) {
  return {
    toolUseId,
    sessionId,
    name: 'general-purpose',
    displayName: 'general-purpose',
    description: 'test',
    prompt: 'test',
    isRunning: false,
    success: true,
    endReason: 'completed',
    errorMessage: null,
    iteration: 1,
    toolCalls: [],
    streamingText: '',
    transcript: [],
    currentAssistantMessageId: null,
    report,
    reportStatus: 'submitted',
    startedAt,
    completedAt: startedAt + 1
  }
}

async function main() {
  const sourceSettingsPath = process.argv[2]
  const indexOnlyDbFlag = process.argv.indexOf('--index-only-db')
  const indexOnlyDbPath = indexOnlyDbFlag >= 0 ? process.argv[indexOnlyDbFlag + 1] : null
  const tempHome = await mkdtemp(path.join(os.tmpdir(), 'open-cowork-agent-history-'))
  const dataDir = path.join(tempHome, '.open-cowork')
  const endpoint = path.join(tempHome, 'worker.sock')
  const settingsPath = path.join(dataDir, 'settings.json')
  const dbPath = indexOnlyDbPath ? path.resolve(indexOnlyDbPath) : path.join(dataDir, 'data.db')
  const first = historyEntry('call-first', 'session-a', 100, 'first')
  const queued = historyEntry('call-queued', 'session-a', 200, 'queued')
  let expectedImported = 2
  let sessionIds = ['session-a', 'session-b']
  let settingsFixture
  let child
  let client
  let stderr = ''

  try {
    await mkdir(dataDir, { recursive: true })
    if (indexOnlyDbPath) {
      settingsFixture = {}
    } else if (sourceSettingsPath) {
      settingsFixture = JSON.parse(await readFile(sourceSettingsPath, 'utf8'))
      let snapshot = settingsFixture['opencowork-agent-history']
      if (typeof snapshot === 'string') snapshot = JSON.parse(snapshot)
      if (snapshot?.state) snapshot = snapshot.state
      const entries = [
        ...(snapshot?.subAgentHistory ?? []),
        ...Object.values(snapshot?.sessionSubAgentSummaries ?? {}).flat()
      ]
      const entriesById = new Map(entries.map((entry) => [entry.toolUseId, entry]))
      expectedImported = entriesById.size
      sessionIds = [
        ...new Set([...entriesById.values()].map((entry) => entry.sessionId).filter(Boolean))
      ]
    } else {
      settingsFixture = {
        theme: 'dark',
        'opencowork-agent-history': {
          subAgentHistory: [first],
          sessionSubAgentSummaries: { 'session-a': [queued, first] }
        },
        'opencowork-agent': {
          state: {
            approvedToolNames: ['Bash'],
            subAgentHistory: [first],
            sessionSubAgentSummaries: { 'session-a': [first] }
          },
          version: 0
        }
      }
    }
    await writeFile(settingsPath, JSON.stringify(settingsFixture, null, 2))

    const workerCommand = workerPath.endsWith('.dll') ? 'dotnet' : workerPath
    const workerArgs = workerPath.endsWith('.dll')
      ? [workerPath, '--ipc', endpoint]
      : ['--ipc', endpoint]
    child = spawn(workerCommand, workerArgs, {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: tempHome,
        USERPROFILE: tempHome,
        OPEN_COWORK_NATIVE_SETTINGS_PATH: settingsPath
      },
      stdio: ['ignore', 'ignore', 'pipe']
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    client = new WorkerClient(endpoint, child, dbPath)
    await client.connect()

    if (indexOnlyDbPath) {
      const baselineMemory = await client.request('worker/memory')
      const historyIndex = await client.request('db/sub-agent-history-index')
      const indexedMemory = await client.request('worker/memory')
      const largestSession = historyIndex.sessions.reduce(
        (largest, session) => (!largest || session.count > largest.count ? session : largest),
        null
      )
      const loadedHistory = largestSession
        ? await client.request('db/sub-agent-history-list', {
            sessionId: largestSession.sessionId
          })
        : []
      const loadedMemory = await client.request('worker/memory')
      await new Promise((resolve) => setTimeout(resolve, 3_000))
      const loadedIdleMemory = await client.request('worker/memory')
      console.log(
        JSON.stringify({
          success: true,
          total: historyIndex.total,
          sessions: historyIndex.sessions.length,
          baselineWorkingSetBytes: baselineMemory.workingSetBytes,
          indexedWorkingSetBytes: indexedMemory.workingSetBytes,
          indexedManagedBytes: indexedMemory.managedBytes,
          loadedSessionId: largestSession?.sessionId ?? null,
          loadedSessionRecords: loadedHistory.length,
          loadedWorkingSetBytes: loadedMemory.workingSetBytes,
          loadedManagedBytes: loadedMemory.managedBytes,
          loadedIdleWorkingSetBytes: loadedIdleMemory.workingSetBytes,
          loadedIdleManagedBytes: loadedIdleMemory.managedBytes
        })
      )
      return
    }

    const initialized = await client.request('db/initialize')
    assert(initialized.success, initialized.error ?? 'DB initialization failed')
    for (const id of sessionIds) {
      const created = await client.request('db/sessions-create', {
        id,
        title: id,
        mode: 'chat',
        createdAt: Date.now(),
        updatedAt: Date.now()
      })
      assert(created.success, created.error ?? `Failed to create ${id}`)
    }
    const baselineMemory = sourceSettingsPath ? await client.request('worker/memory') : null

    const migration = await client.request('db/sub-agent-history-migrate-settings')
    assert(migration.success, migration.error ?? 'Migration failed')
    assert(migration.migrated, 'Expected settings migration')
    assert(
      migration.imported === expectedImported,
      `Expected ${expectedImported} imported rows, got ${migration.imported}`
    )

    const migratedHistory = await client.request('db/sub-agent-history-list')
    assert(
      migratedHistory.length === expectedImported,
      `Expected ${expectedImported} rows, got ${migratedHistory.length}`
    )
    const historyIndex = await client.request('db/sub-agent-history-index')
    assert(historyIndex.total === expectedImported, 'Sub-agent history index total is incorrect')
    if (sessionIds.length > 0) {
      const firstSessionHistory = await client.request('db/sub-agent-history-list', {
        sessionId: sessionIds[0]
      })
      assert(
        firstSessionHistory.every((entry) => entry.sessionId === sessionIds[0]),
        'Session-scoped history query returned another session'
      )
    }
    const rewrittenSettings = JSON.parse(await readFile(settingsPath, 'utf8'))
    assert(!('opencowork-agent-history' in rewrittenSettings), 'Legacy history key remains')

    if (sourceSettingsPath) {
      const immediateMemory = await client.request('worker/memory')
      await new Promise((resolve) => setTimeout(resolve, 3_000))
      const idleMemory = await client.request('worker/memory')
      console.log(
        JSON.stringify({
          success: true,
          imported: migration.imported,
          originalSettingsBytes: Buffer.byteLength(JSON.stringify(settingsFixture)),
          migratedSettingsBytes: Buffer.byteLength(JSON.stringify(rewrittenSettings)),
          baselineWorkingSetBytes: baselineMemory.workingSetBytes,
          immediateWorkingSetBytes: immediateMemory.workingSetBytes,
          idleWorkingSetBytes: idleMemory.workingSetBytes,
          idleManagedBytes: idleMemory.managedBytes
        })
      )
      return
    }

    assert(migratedHistory[0].toolUseId === 'call-first', 'Global history order was not retained')
    assert(migratedHistory[1].toolUseId === 'call-queued', 'Session-only row was not imported')

    assert(rewrittenSettings.theme === 'dark', 'Unrelated settings were changed')
    assert(
      rewrittenSettings['opencowork-agent'].state.approvedToolNames[0] === 'Bash',
      'Agent preferences were not preserved'
    )
    assert(
      !('subAgentHistory' in rewrittenSettings['opencowork-agent'].state),
      'Nested legacy history remains'
    )

    const updated = historyEntry('call-first', 'session-a', 100, 'updated')
    const third = historyEntry('call-third', 'session-b', 300, 'third')
    const applied = await client.request('db/sub-agent-history-apply', {
      upserts: [updated, third],
      removeIds: ['call-queued']
    })
    assert(applied.success, applied.error ?? 'Incremental apply failed')

    const afterApply = await client.request('db/sub-agent-history-list')
    assert(afterApply.length === 2, `Expected 2 rows after apply, got ${afterApply.length}`)
    assert(afterApply[0].report === 'updated', 'Existing row was not updated in place')
    assert(afterApply[1].toolUseId === 'call-third', 'New row was not appended')

    const tableOrder = await client.request('db/sync-table-order')
    assert(tableOrder.success, tableOrder.error ?? 'Failed to read DB sync table order')
    assert(
      tableOrder.tables.indexOf('sessions') < tableOrder.tables.indexOf('sub_agent_history'),
      'DB sync does not order sessions before sub-agent history'
    )
    const captured = await client.request('db/sync-capture-local', {
      providerId: 'sub-agent-history-test',
      limit: 2000
    })
    assert(captured.success, captured.error ?? 'DB sync capture failed')
    assert(
      captured.records.filter((record) => record.domain === 'db:sub_agent_history').length === 2,
      'DB sync did not capture sub-agent history rows'
    )

    const removed = await client.request('db/sub-agent-history-apply', {
      removeSessionIds: ['session-a']
    })
    assert(removed.success, removed.error ?? 'Session delete failed')
    const afterDelete = await client.request('db/sub-agent-history-list')
    assert(
      afterDelete.length === 1,
      `Expected 1 row after session delete, got ${afterDelete.length}`
    )
    assert(afterDelete[0].sessionId === 'session-b', 'Wrong session history survived deletion')

    const deletedSession = await client.request('db/sessions-delete', { id: 'session-b' })
    assert(deletedSession.success, deletedSession.error ?? 'Session cascade delete failed')
    const afterCascadeDelete = await client.request('db/sub-agent-history-list')
    assert(afterCascadeDelete.length === 0, 'Session deletion did not cascade to sub-agent history')

    console.log(
      JSON.stringify({
        success: true,
        imported: migration.imported,
        remainingAfterExplicitDelete: afterDelete.length,
        remainingAfterCascadeDelete: afterCascadeDelete.length
      })
    )
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stderr ?? ''}`)
  } finally {
    client?.close()
    child?.kill('SIGTERM')
    await rm(tempHome, { recursive: true, force: true })
  }
}

await main()
