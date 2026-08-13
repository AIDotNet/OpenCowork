import assert from 'node:assert/strict'
import test from 'node:test'
import { WorkerEventConsumer } from '../../src/main/ipc/agent-runtime/worker-event-consumer.ts'
import type { RuntimeEventEnvelope } from '../../src/shared/runtime-contracts/generated/contracts.ts'

function frame(seq: number): Parameters<WorkerEventConsumer['consumeFrame']>[0] {
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    seq,
    bytes: Buffer.from('x'),
    byteLength: 1
  } as Parameters<WorkerEventConsumer['consumeFrame']>[0]
}

test('ACKs after journal and projection, even when UI fanout throws', () => {
  const acks: Array<{ runId: string; throughSeq: number }> = []
  let published = 0
  const consumer = new WorkerEventConsumer({
    recordFrame: () => undefined,
    ingestFrame: () => [{ projectionRevision: 1 } as RuntimeEventEnvelope],
    publishPatches: () => {
      published += 1
      throw new Error('window gone')
    },
    ack: (runId, throughSeq) => {
      acks.push({ runId, throughSeq })
    },
    isRunning: () => true,
    request: async () => ({})
  })

  const result = consumer.consumeFrame(frame(3))
  assert.equal(result.journaled, true)
  assert.equal(result.projected, true)
  assert.equal(result.acked, true)
  assert.equal(result.publishedUi, false)
  assert.deepEqual(acks, [{ runId: 'run-1', throughSeq: 3 }])
  assert.equal(published, 1)
  assert.equal(consumer.getDiagnostics().droppedUiFanouts, 1)
  assert.equal(consumer.getDiagnostics().pendingAckCount, 0)
  assert.equal(consumer.getDiagnostics().ackedCount, 1)
})

test('withholds ACK when the journal write fails', () => {
  const acks: Array<{ runId: string; throughSeq: number }> = []
  const consumer = new WorkerEventConsumer({
    recordFrame: () => {
      throw new Error('disk full')
    },
    ingestFrame: () => {
      throw new Error('should not ingest')
    },
    publishPatches: () => {
      throw new Error('should not publish')
    },
    ack: (runId, throughSeq) => {
      acks.push({ runId, throughSeq })
    },
    isRunning: () => true,
    request: async () => ({})
  })

  const result = consumer.consumeFrame(frame(1))
  assert.equal(result.journaled, false)
  assert.equal(result.acked, false)
  assert.equal(acks.length, 0)
  assert.equal(consumer.getDiagnostics().pendingAckCount, 0)
})

test('withholds ACK when projection ingest fails', () => {
  const acks: Array<{ runId: string; throughSeq: number }> = []
  const consumer = new WorkerEventConsumer({
    recordFrame: () => undefined,
    ingestFrame: () => {
      throw new Error('reducer exploded')
    },
    publishPatches: () => {
      throw new Error('should not publish')
    },
    ack: (runId, throughSeq) => {
      acks.push({ runId, throughSeq })
    },
    isRunning: () => true,
    request: async () => ({})
  })

  const result = consumer.consumeFrame(frame(2))
  assert.equal(result.journaled, true)
  assert.equal(result.projected, false)
  assert.equal(result.acked, false)
  assert.equal(acks.length, 0)
})

test('ACKs before UI publish so renderer liveness cannot stall the outbox', () => {
  const order: string[] = []
  const consumer = new WorkerEventConsumer({
    recordFrame: () => order.push('journal'),
    ingestFrame: () => {
      order.push('ingest')
      return [{ projectionRevision: 1 } as RuntimeEventEnvelope]
    },
    publishPatches: () => {
      order.push('ui')
    },
    ack: () => {
      order.push('ack')
    },
    isRunning: () => true,
    request: async () => ({})
  })

  consumer.consumeFrame(frame(4))
  assert.deepEqual(order, ['journal', 'ingest', 'ack', 'ui'])
})
