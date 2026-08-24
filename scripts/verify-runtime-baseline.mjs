#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decode, encode } from '@msgpack/msgpack'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixturePath = resolve(root, 'scripts/fixtures/runtime-baseline.json')

function readRepoFile(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function parseTypeScript(path) {
  return ts.createSourceFile(path, readRepoFile(path), ts.ScriptTarget.ES2022, true)
}

function fail(message) {
  throw new Error(`[verify:runtime-baseline] ${message}`)
}

function findInterface(source, name) {
  const declaration = source.statements.find(
    (statement) => ts.isInterfaceDeclaration(statement) && statement.name.text === name
  )
  if (!declaration) fail(`Missing interface ${name} in ${source.fileName}`)
  return declaration
}

function requiredInterfaceFields(source, name) {
  return findInterface(source, name)
    .members.filter(ts.isPropertySignature)
    .filter((member) => !member.questionToken)
    .map((member) => member.name?.getText(source))
    .filter(Boolean)
}

function assertRequiredFields(sample, fields, label) {
  assert.ok(sample && typeof sample === 'object' && !Array.isArray(sample), `${label} is an object`)
  for (const field of fields) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(sample, field),
      `${label} contains required field ${field}`
    )
  }
}

function readProtocolConstants() {
  const source = parseTypeScript('src/shared/worker-contracts/model.ts')
  const statement = source.statements.find((item) => {
    if (!ts.isVariableStatement(item)) return false
    return item.declarationList.declarations.some(
      (declaration) => declaration.name.getText(source) === 'constants'
    )
  })
  if (!statement || !ts.isVariableStatement(statement)) fail('Missing worker contract constants')

  const declaration = statement.declarationList.declarations.find(
    (item) => item.name.getText(source) === 'constants'
  )
  let initializer = declaration?.initializer
  if (initializer && ts.isAsExpression(initializer)) initializer = initializer.expression
  if (!initializer || !ts.isObjectLiteralExpression(initializer)) {
    fail('Worker contract constants must remain an object literal')
  }

  return Object.fromEntries(
    initializer.properties.map((property) => {
      if (!ts.isPropertyAssignment(property) || !ts.isNumericLiteral(property.initializer)) {
        fail('Worker contract protocol constants must remain numeric properties')
      }
      return [property.name.getText(source), Number(property.initializer.text)]
    })
  )
}

function agentStreamEventTypes() {
  const source = parseTypeScript('src/shared/agent-stream-protocol.ts')
  const alias = source.statements.find(
    (statement) =>
      ts.isTypeAliasDeclaration(statement) && statement.name.text === 'AgentStreamEvent'
  )
  if (!alias || !ts.isTypeAliasDeclaration(alias) || !ts.isUnionTypeNode(alias.type)) {
    fail('AgentStreamEvent must remain a discriminated union')
  }

  const eventTypes = new Set()
  for (const member of alias.type.types) {
    if (!ts.isTypeLiteralNode(member)) continue
    const discriminator = member.members.find(
      (item) => ts.isPropertySignature(item) && item.name?.getText(source) === 'type'
    )
    if (
      discriminator &&
      ts.isPropertySignature(discriminator) &&
      discriminator.type &&
      ts.isLiteralTypeNode(discriminator.type) &&
      ts.isStringLiteral(discriminator.type.literal)
    ) {
      eventTypes.add(discriminator.type.literal.text)
    }
  }
  return eventTypes
}

function handlerSlice(source, channel, nextChannel = null) {
  const startMarker = `'${channel}'`
  const start = source.indexOf(startMarker)
  if (start < 0) fail(`Missing ${channel} handler`)
  const end = nextChannel ? source.indexOf(`'${nextChannel}'`, start + startMarker.length) : -1
  return source.slice(start, end >= 0 ? end : undefined)
}

function assertSourceInvariant(source, pattern, message) {
  assert.match(source, pattern, message)
}

const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))
assert.equal(fixture.version, 1, 'runtime baseline fixture version')

const sidecarProtocol = parseTypeScript('src/renderer/src/lib/ipc/sidecar-protocol.ts')
const streamProtocol = parseTypeScript('src/shared/agent-stream-protocol.ts')
const runtimeRegistry = parseTypeScript('src/main/ipc/runtime-registry.ts')

assertRequiredFields(
  fixture.runRequest,
  requiredInterfaceFields(sidecarProtocol, 'SidecarAgentRunRequest'),
  'runRequest'
)
assertRequiredFields(
  fixture.streamEnvelope,
  requiredInterfaceFields(streamProtocol, 'AgentStreamEnvelope'),
  'streamEnvelope'
)
for (const [index, run] of fixture.runtimeSnapshot.runs.entries()) {
  assertRequiredFields(
    run,
    requiredInterfaceFields(runtimeRegistry, 'RuntimeRunSnapshot'),
    `runtimeSnapshot.runs[${index}]`
  )
}
for (const [index, approval] of fixture.runtimeSnapshot.approvals.entries()) {
  assertRequiredFields(
    approval,
    requiredInterfaceFields(runtimeRegistry, 'RuntimeApprovalSnapshot'),
    `runtimeSnapshot.approvals[${index}]`
  )
}

const constants = readProtocolConstants()
assert.equal(
  fixture.streamEnvelope.v,
  constants.AGENT_STREAM_PROTOCOL_VERSION,
  'stream envelope version matches the generated worker contract model'
)
assert.equal(
  fixture.runRequest.runtimeProtocolVersion,
  2,
  'legacy run request records the current Agent Runtime v2 contract'
)

const knownEventTypes = agentStreamEventTypes()
for (const event of fixture.streamEnvelope.events) {
  assert.ok(knownEventTypes.has(event.type), `known AgentStreamEvent discriminator: ${event.type}`)
}

assert.equal(fixture.approvalReverseRequest.method, 'approval/request')
assert.equal(fixture.approvalReverseRequest.params.runId, fixture.runRequest.runId)
assert.equal(fixture.approvalReverseRequest.params.sessionId, fixture.runRequest.sessionId)
assert.equal(fixture.runtimeSnapshot.runs[0].runId, fixture.runRequest.runId)
assert.equal(fixture.attachReplay.request.runId, fixture.runRequest.runId)
assert.ok(fixture.attachReplay.request.sinceSeq >= -1, 'attach replay cursor is valid')
assert.equal(fixture.attachReplay.invariants.replayOnlyAfterSinceSeq, true)
assert.equal(fixture.attachReplay.invariants.usesNormalStreamChannel, true)
assert.equal(fixture.attachReplay.invariants.addsObserverWithoutStealingPrimaryRoute, true)
assert.equal(fixture.attachReplay.invariants.repostsMatchingPendingApprovals, true)

const roundTripped = decode(encode(fixture))
assert.deepEqual(roundTripped, fixture, 'runtime fixture survives MessagePack round-trip')

const sidecarManager = readRepoFile('src/main/ipc/sidecar-manager.ts')
const commandGateway = readRepoFile('src/main/ipc/agent-runtime/runtime-command-gateway.ts')
const uiCapabilityRouter = readRepoFile('src/main/ipc/agent-runtime/ui-capability-router.ts')
const consumerHost = readRepoFile('src/main/ipc/agent-runtime/worker-event-consumer-host.ts')
const consumer = readRepoFile('src/main/ipc/agent-runtime/worker-event-consumer.ts')

const runtimeStateHandler = handlerSlice(commandGateway, 'agent:runtime-state', 'agent:attach-run')
assertSourceInvariant(
  runtimeStateHandler,
  /runs:\s*registry\.getRunSnapshots\(\)/u,
  'runtime snapshot reads run state from the Main registry'
)
assertSourceInvariant(
  runtimeStateHandler,
  /approvals:\s*registry\.getApprovalSnapshots\(\)/u,
  'runtime snapshot reads pending approvals from the Main registry'
)

const attachHandler = handlerSlice(commandGateway, 'agent:attach-run', 'agent:compress-context')
assertSourceInvariant(
  attachHandler,
  /attachObserver\(runId,\s*sourceWindow\.id\)/u,
  'attach adds an observer window'
)
assert.doesNotMatch(attachHandler, /bindPrimary\(/u, 'attach does not steal the primary run route')
// Attach must not replay frames from this process. Windows subscribe to the
// worker's durable outbox themselves, and the in-memory journal that used to back
// this replay dropped the middle of long runs once it hit its size cap.
assert.doesNotMatch(
  attachHandler,
  /getFramesSince|sendAgentStreamBytes/u,
  'attach does not replay stream frames from Main'
)
assertSourceInvariant(
  attachHandler,
  /repostApprovals\(/u,
  'attach re-posts matching pending approvals'
)

assertSourceInvariant(
  uiCapabilityRouter,
  /pendingApprovals\.set\(requestId/u,
  'approval reverse requests are retained in Main while pending'
)
assertSourceInvariant(
  uiCapabilityRouter,
  /SIDECAR_APPROVAL_REQUEST_MSGPACK_CHANNEL/u,
  'approval reverse requests use the dedicated MessagePack channel'
)

const agentStreamReceiver = readRepoFile('src/renderer/src/lib/ipc/agent-stream-receiver.ts')
assert.doesNotMatch(
  agentStreamReceiver,
  /agent:event-ack/u,
  'the renderer must not route its cursor through this host'
)

const eventAckHandler = handlerSlice(commandGateway, 'agent:event-ack', 'agent:recover-stream')
assert.doesNotMatch(
  eventAckHandler,
  /events\/checkpoint/u,
  'agent:event-ack must not write this host durable cursor'
)
assertSourceInvariant(
  eventAckHandler,
  /ignored:\s*true/u,
  'legacy agent:event-ack remains a counted no-op for one release'
)

assert.doesNotMatch(
  sidecarManager,
  /events\/checkpoint/u,
  'sidecar-manager must not write the durable cursor directly'
)
assertSourceInvariant(
  sidecarManager,
  /consumeFrame\(/u,
  'sidecar raw handler delegates frames to the durable consumer'
)
assert.equal(
  [...consumerHost.matchAll(/events\/checkpoint/gu)].length,
  1,
  'this host writes its durable cursor from exactly one place'
)
assertSourceInvariant(
  consumerHost,
  /consumerId:\s*DESKTOP_EVENT_CONSUMER_ID/u,
  'this host writes its cursor under consumerId desktop'
)
// The cursor may only move after the frame has been journaled and projected, and
// never from consumeFrame itself — advancing it on receipt is what let events the
// UI had not seen be forgotten.
assertSourceInvariant(consumer, /ingestFrame/u, 'the cursor is gated on projection ingest')
assertSourceInvariant(
  consumer,
  /acknowledgeDelivered/u,
  'the cursor advances through an explicit delivery call, not inside consumeFrame'
)

const cronAgent = readRepoFile('src/main/cron/cron-agent-background.ts')
assert.doesNotMatch(cronAgent, /events\/ack/u, 'cron must not ACK the Worker durable outbox')
assert.doesNotMatch(
  cronAgent,
  /['"]agent\/run['"]/u,
  'cron must start runs through the hosted session service, not agent/run'
)
assertSourceInvariant(
  cronAgent,
  /agent\/session-close/u,
  'cron closes the hosted session after the turn'
)

console.log(
  `[verify:runtime-baseline] Passed: ${fixture.streamEnvelope.events.length} stream event samples, ${fixture.runtimeSnapshot.runs.length} run snapshot, ${fixture.runtimeSnapshot.approvals.length} approval snapshot.`
)
