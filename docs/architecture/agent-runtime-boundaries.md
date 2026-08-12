# Agent Runtime Boundaries

OpenCowork keeps Electron, React, the .NET Native Worker, MessagePack, and the existing dual local IPC sockets. The runtime migration changes authority and protocol boundaries rather than replacing the transport stack.

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
  ├─ runtime projection cache, journal, and attach/replay
  └─ desktop session repository (single writer)
                ↕ Worker protocol + MessagePack
.NET Native Worker
  ├─ authoritative agent session and run state
  ├─ provider and loop orchestration
  ├─ tool catalog, policy, and execution state
  ├─ cancellation and reverse-request lifetime
  └─ durable jobs, events, and checkpoints
```

The migration is incremental. Existing paths remain available behind `RuntimeRolloutMode` until their replacement passes deterministic parity checks.

## Authority matrix

| State or responsibility                                     | Authority                         | Boundary rule                                                             |
| ----------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------- |
| Provider loop, run status, canonical in-flight conversation | Native Worker                     | Main transports and projects events but does not make loop decisions.     |
| Tool invocation state, approval policy, cancellation state  | Native Worker                     | Main routes capabilities; Renderer presents state and submits decisions.  |
| Worker process, sockets, heartbeat, worker instance epoch   | Main                              | `src/main/lib/native-worker.ts` remains the process/transport supervisor. |
| Window connection, session visibility, subscription cursor  | Main                              | Each `webContents` owns an independent subscription and cursor.           |
| Desktop session/message durable writes                      | Main repository                   | Renderer and Worker do not independently write desktop transcript tables. |
| Active runtime projection                                   | Worker source; Main cache/journal | Main may rebuild the projection but may not invent agent semantics.       |
| Draft, selection, scroll, panel, hover, animation           | Renderer                          | UI-only state does not enter the runtime domain protocol.                 |
| Dialogs, clipboard, notifications, credentials, OS security | Main                              | Exposed as typed host capabilities.                                       |
| DOM/React interactions                                      | Renderer                          | Exposed only as typed UI capability endpoints.                            |

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
2. Main validates it, applies it to the runtime projection, appends the Main journal, and performs any required repository commit.
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
5. request a full snapshot when the gateway epoch changes or a retained-journal gap is detected.

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
