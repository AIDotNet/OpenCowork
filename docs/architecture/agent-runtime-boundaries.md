# Agent Runtime Boundaries

OpenCowork keeps Electron and React. The runtime migration changes authority and protocol boundaries rather than replacing the UI stack.

The agent runtime has one implementation behind `WorkerRuntimeClient` (`src/shared/worker-runtime-client.ts`): the .NET Native Worker child process, reached over a loopback HTTP API. **Everything in this document is transport-independent**; "Worker" below names the runtime authority.

## Target layering

```text
React Renderer
  ├─ views and interaction
  ├─ UI-only ephemeral state
  ├─ session/runtime read models
  └─ typed commands, queries, subscriptions, and UI capabilities
                ↕ Renderer protocol
Electron Main / Host Gateway
  ├─ BrowserWindow routing and connection lifetime
  ├─ Native Worker supervision and transport
  ├─ security, credentials, and OS capabilities
  ├─ runtime projection cache and run status (no frame journal)
  └─ desktop session repository (single writer)
                ↕ WorkerRuntimeClient (loopback HTTP + SSE)
                  Renderer also calls /rpc directly; Main supplies endpoint + token
Agent Runtime — OpenCowork.Native.Worker
  ├─ authoritative agent session and run state
  ├─ provider and loop orchestration
  ├─ tool catalog, policy, and execution state
  ├─ cancellation and reverse-request lifetime
  └─ durable jobs, events, and checkpoints
```

The migration is incremental. Existing paths remain available behind `RuntimeRolloutMode` until their replacement passes deterministic parity checks.

## Authority matrix

| State or responsibility                                     | Authority                 | Boundary rule                                                                                 |
| ----------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------- |
| Provider loop, run status, canonical in-flight conversation | Native Worker             | Main transports and projects events but does not make loop decisions.                         |
| Tool invocation state, approval policy, cancellation state  | Native Worker             | Main routes capabilities; Renderer presents state and submits decisions.                      |
| Worker process, port, heartbeat, worker instance epoch      | Main                      | `src/main/lib/native-worker.ts` remains the process supervisor and owns the endpoint + token. |
| Reverse RPC (`GET /reverse`)                                | Main                      | Host capabilities answered in place; UI capabilities forwarded to the owning window.          |
| Host capabilities the runtime needs (browser, desktop, MCP) | Main                      | Reached only through `agent/reverse-request`, never by importing host code into the runtime.  |
| Window connection, session visibility, subscription cursor  | Main                      | Each `webContents` owns an independent subscription and cursor.                               |
| Desktop session/message durable writes                      | Main repository           | Renderer and Worker do not independently write desktop transcript tables.                     |
| Active runtime projection                                   | Worker source; Main cache | Main may rebuild the projection but may not invent agent semantics.                           |
| Draft, selection, scroll, panel, hover, animation           | Renderer                  | UI-only state does not enter the runtime domain protocol.                                     |
| Dialogs, clipboard, notifications, credentials, OS security | Main                      | Exposed as typed host capabilities.                                                           |
| DOM/React interactions                                      | Renderer                  | Exposed only as typed UI capability endpoints.                                                |

Worker canonical conversation and the Main durable transcript serve different lifetimes. The Worker is authoritative while a hosted session is alive. Main persists the desktop transcript and can reopen a Worker session after a Worker restart.

## Protocol domains

Compatibility is split across independently evolving domains:

- `WORKER_PROTOCOL_VERSION`: low-level worker handshake and dispatch protocol.
- `AGENT_STREAM_PROTOCOL_VERSION`: Worker stream envelope.
- `RUNTIME_MODEL_SCHEMA_VERSION`: generated runtime commands, queries, events, snapshots, and patches.
- `TOOL_MANIFEST_SCHEMA_VERSION`: tool/capability catalog schema.

Only incompatible changes advance the relevant major/schema version. Additive nullable fields and negotiated capabilities do not require unrelated protocol versions to move.

## Event ownership and acknowledgements

The target durable-event flow is:

1. Main receives a durable Worker event.
2. Main validates it, applies it to the runtime projection, and performs any required repository commit.
3. Main acknowledges the Worker event.
4. Renderer clients attach to Main using an epoch and projection revision, receiving a snapshot or ordered patches.

Renderer liveness must never control the Worker durable outbox cursor. Closing or reloading every window must not stop Main from consuming and acknowledging Worker events.

Transport batching may combine logical events into one delivery, but it does not change event identity, per-run sequence, or projection revision.

## Renderer protocol rules

New runtime Renderer code must use a generated, namespaced API rather than arbitrary channel strings. A runtime client must:

1. subscribe to patches before requesting attach;
2. buffer live patches while attach is in flight;
3. apply the returned snapshot or replay in revision order;
4. drain buffered patches after removing duplicates;
5. request a full snapshot when the gateway epoch changes or a retained-patch gap is detected.

Runtime read-model code may not import provider configuration, provider transports, Main/Preload modules, or non-UI tool executors.

## Capability execution boundary

Capabilities declare their execution location and lifetime policy; names and prefixes are not a security boundary.

- **Worker:** provider/agent orchestration, pure computation, and native backend capabilities.
- **Main:** MCP clients, Electron/Node extensions, credentials, OS services, and non-visual desktop capabilities.
- **Renderer:** user prompts and effects that require React, DOM, canvas, or visible browser interaction.

Approval policy belongs to the Worker. Main owns routing and pending-request lifetime. Renderer owns presentation only. Cancellation must propagate through all three layers.

## Persistence boundary

Desktop `sessions` and `messages` have one writer: the Main session repository. The repository initially wraps the existing DAOs and adds idempotency/revision conditions incrementally. Worker-owned runtime job, outbox, and checkpoint tables remain Worker responsibilities. Standalone CLI routes may use Worker persistence, but they must not create an uncoordinated second desktop writer.

## Rollout modes

- `legacy`: existing visible runtime path.
- `shadow`: one provider/tool execution; legacy remains visible while the new reducer and request validation consume the same canonical facts and report mismatches.
- `v2`: generated runtime protocol, Main projection, and Worker-hosted orchestration are visible.

Shadow mode must never invoke a provider twice or repeat a side effect. Full dual-path execution parity uses deterministic provider and tool fixtures.

## Dependency ratchet

`scripts/verify-architecture-boundaries.mjs` scans TypeScript imports and compares current violations with `scripts/architecture-boundary-baseline.json`.

The baseline is debt, not an allowlist for new code:

- current violations may be removed;
- a new source/target/rule tuple fails verification;
- the baseline must not be regenerated to hide a regression without an explicit architecture decision;
- after migration removes the debt, equivalent ESLint restrictions become hard rules and the baseline is deleted.

The ratchet currently enforces shared-process isolation, isolation of new Renderer runtime clients/projections, and prevention of new direct view dependencies on the legacy agent bridge or Renderer tool executors.

## Worker transport

Main spawns the worker with `--http-token <secret> --host-id <id>` and a piped stdout. The worker binds `127.0.0.1:0` and publishes the chosen port as one `__OPEN_COWORK_WORKER_HTTP__ {json}` line on stdout; letting the worker pick the port means a lingering previous process cannot make a fresh one fail to bind.

| Endpoint                        | Purpose                                                                                                          |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `POST /rpc`                     | `{ id, method, params }` → `{ id, result }`                                                                      |
| `POST /cancel`                  | `{ requestId }`, replacing the `worker/cancel` control frame                                                     |
| `GET /events?consumerId=…`      | SSE stream of `{ event, params }` envelopes, one lane per durable consumer                                       |
| `POST /rpc` `events/subscribe`  | Declares a consumer's position; `fromLatest` starts a new consumer live instead of replaying the retained outbox |
| `POST /rpc` `events/checkpoint` | Records how far a consumer has read; a resume hint, not an acknowledgement                                       |
| `GET /reverse`                  | SSE stream carrying reverse RPC only                                                                             |
| `GET /health`                   | liveness and transport diagnostics, including per-consumer lane state                                            |

Handler failures stay inside `result` as `{ error }`, exactly as the frame protocol delivered them, so callers keep one error shape. HTTP status codes are reserved for transport faults: 401 bad token, 400 malformed JSON or missing `consumerId`, 403 disallowed origin, 404/405 wrong route, 409 that consumer's stream already attached.

Reverse RPC (`agent/reverse-request` / `agent/reverse-cancel`) has its **own** connection, not a lane on the event stream. A consumer that stops draining streamed output must still be able to answer an approval or a hook; sharing one stream would deadlock the run rather than merely delay it. Publishing throws when `/reverse` is unattached, because a silently dropped reverse request hangs the run waiting on it. Streamed `agent/stream` frames use a bounded, droppable lane because the durable outbox is authoritative and the consumer replays from it.

`/events` is keyed by consumer because there is more than one: the renderer subscribes directly for its own window while Main keeps the `desktop` consumer for background and scheduled runs. Each gets an independent cursor, unacknowledged window, and byte budget — a shared cursor would let one consumer's acknowledgement discard frames the other never received, and a shared byte budget would let one stalled consumer cost the others dropped frames.

`src/shared/worker-http-channel.ts` owns the host side of the wire and nothing else; supervision (spawn, restart, heartbeat, job indirection, idempotent replay) stays in `native-worker.ts`, and the CLI vendors the same channel. Frames arrive already parsed. They used to be re-encoded as MessagePack here so a host-side journal could replay the bytes verbatim to late-attaching windows; that journal is gone — windows resume from the worker's durable outbox — so the second encoding went with it.

The renderer is a direct client for commands and queries: `src/renderer/src/lib/runtime/worker-http-client.ts` posts to `/rpc` from the window, using an endpoint and token Main hands over through `sidecar:connection`. Because the window is a different origin from the worker, the server answers a CORS preflight _before_ authenticating — a preflight carries no `Authorization` header — and allows only loopback origins plus the opaque `null` origin of a packaged `file://` window. Each window also subscribes to `/events` under its own durable consumer id and checkpoints after it applies an envelope, so a reload resumes from the worker's on-disk outbox rather than from host memory. A channel belongs in Main only when Main contributes state the renderer lacks (hooks, permission policy, goals, window routing), never as a transport hop.

`npm run verify:worker-http` exercises this against the published binary: port discovery, request correlation, wrong-token rejection, the error shape, the job-route guard, the route catalog, held-open event and reverse streams, per-consumer lane isolation, and the CORS preflight rules.
