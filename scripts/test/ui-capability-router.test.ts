import assert from 'node:assert/strict'
import test from 'node:test'
import { UiCapabilityRouter } from '../../src/main/ipc/agent-runtime/ui-capability-router.ts'
import { SIDECAR_APPROVAL_REQUEST_MSGPACK_CHANNEL } from '../../src/shared/messagepack/binary-ipc.ts'

test('keeps pending approvals in Main and resolves them without a live window blocking ACK semantics', async () => {
  const sent: Array<{ windowId: number; channel: string; payload: unknown }> = []
  const router = new UiCapabilityRouter({
    resolveWindow: () => ({ id: 7 }),
    sendReverseRequest: (window, channel, payload) => {
      sent.push({ windowId: window.id, channel, payload })
      return true
    },
    now: () => 1,
    randomId: () => 'abc'
  })

  const pending = router.requestApproval({ sessionId: 'session-1', runId: 'run-1' })
  const snapshots = router.getApprovalSnapshots()
  assert.equal(snapshots.length, 1)
  assert.equal(snapshots[0].requestId, 'sidecar-approval-1-abc')
  assert.equal(snapshots[0].sessionId, 'session-1')
  assert.equal(snapshots[0].runId, 'run-1')
  assert.equal(sent[0]?.channel, SIDECAR_APPROVAL_REQUEST_MSGPACK_CHANNEL)

  const completed = router.completeApproval({
    requestId: snapshots[0].requestId,
    approved: true,
    reason: 'ok'
  })
  assert.equal(completed.ok, true)
  assert.deepEqual(await pending, { approved: true, reason: 'ok' })
  assert.equal(router.getApprovalSnapshots().length, 0)
})

test('does not steal a missing renderer: approval returns unapproved when no window is mapped', async () => {
  const router = new UiCapabilityRouter({
    resolveWindow: () => null,
    sendReverseRequest: () => {
      throw new Error('should not send')
    }
  })
  const result = await router.requestApproval({ runId: 'run-1' })
  assert.deepEqual(result, {
    approved: false,
    reason: 'No renderer available for approval request'
  })
})

test('attach re-posts matching pending approvals to the observer window', async () => {
  const sent: Array<{ windowId: number; method?: string }> = []
  const router = new UiCapabilityRouter({
    resolveWindow: () => ({ id: 1 }),
    sendReverseRequest: (window, _channel, payload) => {
      const record = payload as { method?: string }
      sent.push({ windowId: window.id, method: record.method })
      return true
    },
    now: () => 2,
    randomId: () => 'xyz'
  })

  const pending = router.requestApproval({ sessionId: 'session-1', runId: 'run-1' })
  const observer = { id: 99 }
  const reposted = router.repostApprovals(observer, 'run-1', 'session-1')
  assert.equal(reposted, 1)
  assert.equal(
    sent.some((item) => item.windowId === 99),
    true
  )

  router.completeApproval({ requestId: 'sidecar-approval-2-xyz', approved: false })
  assert.equal((await pending).approved, false)
})

test('UI capability delivery failure rejects without leaving a hanging request', async () => {
  const router = new UiCapabilityRouter({
    resolveWindow: () => ({ id: 3 }),
    sendReverseRequest: () => false,
    now: () => 3,
    randomId: () => 'nope'
  })

  await assert.rejects(
    router.requestUiCapability('ask-user/request', { runId: 'run-1' }),
    /Failed to deliver AskUserQuestion request/
  )
})
