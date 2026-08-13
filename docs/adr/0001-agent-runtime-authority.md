# ADR 0001: Agent Runtime Authority and Protocol Boundaries

- **Status:** Accepted
- **Date:** 2026-08-12
- **Decision owners:** OpenCowork maintainers

## Context

The desktop runtime currently spans React Renderer, Electron Main, and the .NET Native Worker. The underlying transport already provides dual local IPC sockets, MessagePack framing, heartbeats, reconnects, per-run stream sequences, and durable Worker events. However, authority is split ambiguously:

- Renderer builds provider requests and participates in orchestration;
- Renderer owns important in-flight state and initiates transcript persistence;
- Main supervises the Worker but often acts as a pass-through broadcaster;
- Worker has session and durable-job primitives but is not yet the sole semantic authority;
- runtime channels and response types are duplicated across process boundaries.

This makes reload recovery, multi-window observation, acknowledgement ownership, cancellation, and persistence difficult to reason about.

## Decision

We will migrate incrementally to a Worker-authoritative runtime with Main as the host gateway and Renderer as a command/read-model/UI-capability client.

### Authority

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

Operational rules live in [Agent Runtime Boundaries](../architecture/agent-runtime-boundaries.md).

### Durable event acknowledgement

Main acknowledges Worker durable events only after successful validation, projection application, journal append, and any required repository commit. Renderer does not acknowledge the Worker outbox. Renderer attach/replay uses a separate Main projection cursor.

### Desktop persistence

Main is the single writer for desktop session and message tables. Worker continues to own runtime job, durable event outbox, and checkpoint tables. Renderer may use optimistic UI but reconciles against Main repository revisions.

### Protocol evolution

Compatibility is split across four independently evolving constants. Only an incompatible change advances the matching version:

| Constant                        | Current value | Source                                  | Domain                                                              |
| ------------------------------- | ------------: | --------------------------------------- | ------------------------------------------------------------------- |
| `WORKER_PROTOCOL_VERSION`       |             2 | `src/shared/worker-contracts/model.ts`  | Low-level framing, dispatch, and `worker/hello` handshake           |
| `AGENT_STREAM_PROTOCOL_VERSION` |             1 | `src/shared/worker-contracts/model.ts`  | Worker `agent/stream` envelope                                      |
| `RUNTIME_MODEL_SCHEMA_VERSION`  |             1 | `src/shared/runtime-contracts/model.ts` | Generated runtime commands, queries, events, snapshots, and patches |
| `TOOL_MANIFEST_SCHEMA_VERSION`  |             2 | `src/shared/agent-runtime-v2.ts`        | Tool/capability catalog schema                                      |

New runtime commands, queries, events, snapshots, patches, and UI capabilities are generated from a restricted shared model. New runtime call sites use typed APIs and runtime decode guards rather than string channels plus response casts.

### Tool and capability execution

Every capability will explicitly declare its execution location and policy. Worker makes authorization and approval decisions. Main routes host capabilities and owns pending-request lifetime. Renderer executes only capabilities that require UI/DOM state.

### Rollout

Migration uses `legacy`, `shadow`, and `v2` modes. Shadow mode compares reducers and request validation over one canonical execution. It must not issue a second provider request or repeat a tool side effect.

## Consequences

### Positive

- Renderer reload and multi-window attach no longer define runtime liveness.
- Worker outbox progress continues with no open Renderer window.
- Runtime state has one semantic source and one desktop transcript writer.
- Protocol drift becomes detectable through generated contracts and fixtures.
- Main/Renderer responsibilities become independently testable.

### Costs

- Main needs a typed projection, journal, window router, and repository facade.
- Worker hosted sessions need explicit restart behavior and eventually checkpoints.
- Existing Renderer orchestration and tool execution must coexist with the replacement during rollout.
- Generated contract tooling must support TS, C#, AOT serialization metadata, and decode validation.

## Rejected alternatives

### Introduce JetBrains RD directly

Rejected. The useful properties are explicit boundaries, generated protocols, projections, and lifecycle semantics. Replacing the existing local transport would add migration cost without solving authority first.

### Move all state to the Worker

Rejected. Drafts, selection, scroll, panels, and other view state belong in Renderer. OS and credential capabilities belong at the Electron Main security boundary. Main also remains the desktop transcript writer.

### Keep Renderer acknowledgement ownership

Rejected. A window reload or closure would continue to block or delay durable Worker event progress.

### Run legacy and v2 providers in production shadow mode

Rejected. It doubles cost and can duplicate side effects. Deterministic fixtures provide full execution parity; production shadow compares projections over one execution.

### Rewrite all stream DTOs before a vertical slice

Rejected. Control-plane contracts and a text/thinking/tool-card projection slice provide an incremental path with smaller rollback scope.

## Compliance and rollback

- `npm run verify:architecture` prevents new boundary violations while existing debt is ratcheted down.
- `npm run verify:runtime-baseline` checks recorded legacy runtime fixture invariants.
- `npm run contracts:check` rejects stale generated contracts.
- Each migration phase retains the preceding path until its parity gate passes.
- Rollback changes `RuntimeRolloutMode` to the preceding mode; it never requires a second production execution.
