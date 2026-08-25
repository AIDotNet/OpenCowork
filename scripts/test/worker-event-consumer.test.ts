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

type Deps = ConstructorParameters<typeof WorkerEventConsumer>[0]

function createConsumer(overrides: Partial<Deps> = {}): {
  consumer: WorkerEventConsumer
  acks: Array<{ runId: string; throughSeq: number }>
} {
  const acks: Array<{ runId: string; throughSeq: number }> = []
  const consumer = new WorkerEventConsumer({
    recordFrame: () => undefined,
    ingestFrame: () => [{ projectionRevision: 1 } as RuntimeEventEnvelope],
    publishPatches: () => undefined,
    ack: (runId, throughSeq) => {
      acks.push({ runId, throughSeq })
    },
    isRunning: () => true,
    request: async () => ({}),
    ...overrides
  })
  return { consumer, acks }
}

test('consuming a frame does not advance the durable cursor', () => {
  // Acknowledging on receipt told the worker it could forget events the UI had not
  // seen yet, leaving a bounded in-memory journal as the only way to recover them.
  const { consumer, acks } = createConsumer()

  const result = consumer.consumeFrame(frame(3))
  assert.equal(result.journaled, true)
  assert.equal(result.projected, true)
  assert.equal(result.acked, false)
  assert.deepEqual(acks, [])
  assert.equal(consumer.getDiagnostics().ackedCount, 0)
  assert.equal(consumer.getDiagnostics().pendingAckCount, 0)
})

test('acknowledges once the batch reached a renderer', () => {
  const { consumer, acks } = createConsumer()

  consumer.consumeFrame(frame(3))
  assert.equal(consumer.acknowledgeDelivered('run-1', 3), true)
  assert.deepEqual(acks, [{ runId: 'run-1', throughSeq: 3 }])
  assert.equal(consumer.getDiagnostics().ackedCount, 1)
})

test('withholds the cursor while a run keeps failing delivery', () => {
  const { consumer, acks } = createConsumer()

  for (let seq = 1; seq <= 8; seq += 1) {
    assert.equal(consumer.acknowledgeUndelivered('run-1', seq, 'renderer post failed'), false)
  }
  assert.deepEqual(acks, [])
  assert.equal(consumer.getDiagnostics().withheldBatches, 8)
})

test('forces the cursor forward before one run starves the shared window', () => {
  // The unacknowledged window is shared across runs, so a renderer that never
  // returns must eventually give its slots back rather than stall every other run.
  const { consumer, acks } = createConsumer()

  for (let seq = 1; seq <= 8; seq += 1) {
    consumer.acknowledgeUndelivered('run-1', seq, 'renderer post failed')
  }
  assert.equal(consumer.acknowledgeUndelivered('run-1', 9, 'renderer post failed'), true)
  assert.deepEqual(acks, [{ runId: 'run-1', throughSeq: 9 }])
  assert.equal(consumer.getDiagnostics().forcedAcks, 1)
})

test('a successful delivery resets the withheld budget', () => {
  const { consumer, acks } = createConsumer()

  for (let seq = 1; seq <= 8; seq += 1) {
    consumer.acknowledgeUndelivered('run-1', seq, 'renderer post failed')
  }
  consumer.acknowledgeDelivered('run-1', 9)
  // Without the reset, the very next failure would force an ACK even though the
  // renderer had just proven it is alive.
  assert.equal(consumer.acknowledgeUndelivered('run-1', 10, 'renderer post failed'), false)
  assert.deepEqual(acks, [{ runId: 'run-1', throughSeq: 9 }])
})

test('withholds when the journal write fails', () => {
  const { consumer, acks } = createConsumer({
    recordFrame: () => {
      throw new Error('disk full')
    },
    ingestFrame: () => {
      throw new Error('should not ingest')
    },
    publishPatches: () => {
      throw new Error('should not publish')
    }
  })

  const result = consumer.consumeFrame(frame(1))
  assert.equal(result.journaled, false)
  assert.equal(result.acked, false)
  assert.equal(acks.length, 0)
  assert.equal(consumer.getDiagnostics().pendingAckCount, 0)
})

test('withholds when projection ingest fails', () => {
  const { consumer, acks } = createConsumer({
    ingestFrame: () => {
      throw new Error('reducer exploded')
    },
    publishPatches: () => {
      throw new Error('should not publish')
    }
  })

  const result = consumer.consumeFrame(frame(2))
  assert.equal(result.journaled, true)
  assert.equal(result.projected, false)
  assert.equal(result.acked, false)
  assert.equal(acks.length, 0)
})

test('a failing projection patch does not block the stream cursor', () => {
  // Projection is a shadow overlay; the batched agent stream is the authoritative
  // render path, so overlay failure must not hold back transcript delivery.
  const { consumer, acks } = createConsumer({
    publishPatches: () => {
      throw new Error('window gone')
    }
  })

  const result = consumer.consumeFrame(frame(4))
  assert.equal(result.projected, true)
  assert.equal(result.publishedUi, false)
  assert.equal(consumer.getDiagnostics().droppedUiFanouts, 1)

  consumer.acknowledgeDelivered('run-1', 4)
  assert.deepEqual(acks, [{ runId: 'run-1', throughSeq: 4 }])
})

test('journal and projection still run before any acknowledgement', () => {
  const order: string[] = []
  const { consumer } = createConsumer({
    recordFrame: () => order.push('journal'),
    ingestFrame: () => {
      order.push('ingest')
      return [{ projectionRevision: 1 } as RuntimeEventEnvelope]
    },
    publishPatches: () => order.push('patch'),
    ack: () => order.push('ack')
  })

  consumer.consumeFrame(frame(5))
  consumer.acknowledgeDelivered('run-1', 5)
  assert.deepEqual(order, ['journal', 'ingest', 'patch', 'ack'])
})
