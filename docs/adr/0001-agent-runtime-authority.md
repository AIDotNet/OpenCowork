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

- Native Worker owns provider loops, hosted agent sessions, canonical in-flight conversation, run/tool/approval/cancellation semantics, and Worker job/outbox/checkpoint data.
- Electron Main owns Worker lifecycle and transport, window subscriptions, credentials and OS security boundaries, the rebuildable runtime projection/journal, and desktop transcript persistence.
- React Renderer owns views, interaction, UI-only ephemeral state, runtime read models, and DOM/React capabilities.

The full matrix and operational rules are documented in [Agent Runtime Boundaries](../architecture/agent-runtime-boundaries.md).

### Durable event acknowledgement

Main acknowledges Worker durable events only after successful validation, projection application, journal append, and any required repository commit. Renderer does not acknowledge the Worker outbox. Renderer attach/replay uses a separate Main projection cursor.

### Desktop persistence

Main is the single writer for desktop session and message tables. Worker continues to own runtime job, durable event outbox, and checkpoint tables. Renderer may use optimistic UI but reconciles against Main repository revisions.

### Protocol evolution

Worker transport, agent stream, runtime model, and tool manifest versions remain separate domains. New runtime commands, queries, events, snapshots, patches, and UI capabilities will be generated from a restricted shared model. New runtime call sites use typed APIs and runtime decode guards rather than string channels plus response casts.

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
