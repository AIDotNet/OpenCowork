import { createCapabilitySnapshotV2 } from '../vendor/agent-runtime-v2.js'
import type { WorkerToolDefinition } from './worker-session.js'
import type { JsonRecord } from './provider-catalog.js'

/**
 * Capability Snapshot V2 for CLI runs, built by the same shared builder the desktop
 * renderer uses (vendored from src/shared/agent-runtime-v2.ts). Tool classification —
 * source identity, side-effect/parallel/recovery classes, executor routes — therefore
 * cannot drift between the two hosts. Only the CLI-specific envelope fields
 * (mode/settingsRevision/resolutionReason) are set here.
 */
export function createCliCapabilitySnapshot(args: {
  permissionPolicy?: unknown
  sessionId: string
  tools: WorkerToolDefinition[]
}): JsonRecord {
  const snapshot = createCapabilitySnapshotV2({
    sessionId: args.sessionId,
    mode: 'code',
    tools: args.tools,
    settingsRevision: 'cli-shared-provider-store',
    permissionPolicy: args.permissionPolicy,
    resolutionReason: 'OpenCowork CLI Native Worker session'
  })
  return snapshot as unknown as JsonRecord
}
