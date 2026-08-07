/**
 * Single source of truth for the Electron ↔ .NET worker IPC contract.
 *
 * `npm run contracts:gen` (scripts/generate-worker-contracts.mjs) compiles this
 * model into:
 *   - src/shared/worker-contracts/generated/contracts.ts   (TS constants + method map helpers)
 *   - sidecars/OpenCowork.Native.Worker/Generated/WorkerContracts.g.cs
 *     (C# records + AOT-safe JsonSerializerContext, namespace OpenCowork.Contracts.Generated)
 *
 * Authoring rules (the generator only understands this subset):
 *   - `export const constants = { NAME: <int literal> } as const` for shared constants.
 *   - `export interface Xxx { ... }` for DTOs. Field types: boolean | number |
 *     string | T[] | `T | null`. Annotate C# integer width with `@cs int` /
 *     `@cs long` JSDoc tags (numbers default to double).
 *   - `export interface WorkerMethods` maps method names to { params; result }.
 */

export const constants = {
  /** Bump on incompatible frame/dispatch contract changes (worker/hello gate). */
  WORKER_PROTOCOL_VERSION: 1,
  /** Version tag embedded in every agent/stream MessagePack envelope. */
  AGENT_STREAM_PROTOCOL_VERSION: 1
} as const

export interface StatusResult {
  ok: boolean
  /** @cs int */
  pid: number
}

export interface WorkerHelloResult {
  ok: boolean
  /** @cs int */
  pid: number
  /** @cs int */
  protocolVersion: number
  appVersion: string | null
}

export interface WorkerRoutesResult {
  methods: string[]
}

export interface SystemMemorySnapshot {
  success: boolean
  /** @cs int */
  pid: number
  /** @cs long */
  managedBytes: number
  /** @cs long */
  heapBytes: number
  /** @cs long */
  fragmentedBytes: number
  /** @cs long */
  workingSetBytes: number
  error: string | null
}

export interface WorkerMethods {
  'worker/ping': { params: Record<string, never>; result: StatusResult }
  'worker/hello': { params: Record<string, never>; result: WorkerHelloResult }
  'worker/routes': { params: Record<string, never>; result: WorkerRoutesResult }
  'worker/memory': { params: Record<string, never>; result: SystemMemorySnapshot }
}
