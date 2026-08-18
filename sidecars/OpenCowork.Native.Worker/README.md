# OpenCowork Native Worker

This sidecar owns native, backend-heavy workloads that are expensive to keep in the Electron
main process. It is intentionally named `Native.Worker` because it will host more than tool calls
over time, including database maintenance, local indexing, patch operations, and eventually parts
of the agent runtime.

## Structure

- `Program.cs` is process bootstrap only. It sets console encoding, starts the host, and reports
  fatal startup failures to stderr. It must not contain business logic or module registration.
- `Hosting/` is the composition root. It builds the worker host, selects the default module
  catalog, and wires modules into the dispatcher.
- `Runtime/` owns the local IPC RPC loop, MessagePack framing, dispatch, response serialization,
  module contracts, and request helpers.
- `Contracts/` contains shared response contracts used by multiple modules.
- `Serialization/` contains source-generated JSON metadata for Native AOT.
- `Modules/` contains feature modules. Each module registers endpoint names and delegates to its
  own business implementation files.

## Startup Flow

```
Program.Main
  -> WorkerEndpoint.Parse(--control-ipc, --event-ipc, --host-id)
  -> RuntimeJobCoordinator.Configure()
  -> WorkerHost.CreateDefault()
  -> WorkerHostBuilder.UseDefaultModules()
  -> WorkerModuleCatalog.Default
  -> IWorkerModule.Register(WorkerModuleContext)
  -> LocalIpcWorkerServer.RunAsync()
     -> Control IPC: WorkerDispatcher.DispatchAsync()
     -> Event IPC: LocalIpcWorkerEventServer.RunAsync()
     -> RuntimeJobCoordinator: SQLite inbox -> bounded scheduler -> result/outbox
```

Node starts this process with:

```text
OpenCowork.Native.Worker \
  --control-ipc <control-endpoint> \
  --event-ipc <event-endpoint> \
  --host-id <stable-client-id>
```

On Unix-like systems each endpoint is a distinct Unix-domain socket path; on Windows each is a
distinct named pipe path. Both transports use length-prefixed MessagePack frames. Protocol v2
separates request/response, heartbeat, cancellation, and reverse RPC on Control IPC from one-way
progress/stream output on Event IPC. A slow or blocked event consumer can therefore reconnect
without blocking `worker/ping` or causing the worker supervisor to recycle a healthy process.

## Background Jobs

Long-running routes register through `WorkerModuleContext.RegisterJob(...)`. The host commits a
`jobs/submit` request to the SQLite `runtime_jobs` inbox before acknowledging it, then executes it
from a bounded scheduler. This keeps the submitting Control RPC short even when a provider, shell,
file, Git, media, sync, or CodeGraph operation takes minutes. Protocol v2 rejects direct invocation
of a Job route, so clients cannot accidentally move slow execution back onto a Control request.

- Jobs in the same session lane execute FIFO and serially; the scheduler samples one queue head per
  lane so a deep backlog cannot starve independent lanes, which execute with bounded concurrency.
- A client timeout stops only that client's wait. It does not stop the committed Job. Explicit
  cancellation uses `jobs/cancel`.
- On restart, `queued` Jobs for the same host resume. Jobs that were `running` or `cancelling` are
  failed with `worker_interrupted`: an interrupted run is not resumed mid-loop, because provider
  checkpoint recovery is not yet available.
- Agent stream envelopes are written to `runtime_event_batches` before Event IPC publication.
  Clients replay with `events/subscribe` / `events/replay` and advance durable cursors with
  `events/ack` only after applying an envelope.
- Every finished tool call is journaled to `runtime_tool_results` on the emit path, before the
  stream envelope is published and before the loop appends the result to the conversation. A host
  that lost a tool_result — renderer crash, app kill, worker recycle mid-turn — recovers the real
  output with `agent/tool-results-lookup` instead of reporting the call as interrupted and letting
  the model re-run it. Rows expire after 3 days.
- Hosted sessions snapshot their canonical history at every tool-batch boundary, not only at loop
  end, so an interrupted turn does not roll back past tools that already ran. Snapshots are taken
  only where every call in the batch has a result, since a conversation carrying an unanswered
  tool_use is rejected by providers.
- Event IPC uses a count-and-byte-bounded in-memory wake queue and a write deadline. Dropped or
  disconnected Agent stream wakes are recovered from the durable outbox and never inherit Control
  IPC health.

Provider transports retain a 100-second response-header deadline and default to a 120-second
stream-idle deadline for SSE/WebSocket reads and stalled non-success response bodies. Set
`streamIdleTimeoutSeconds` on a provider request, or
`OPEN_COWORK_AGENT_STREAM_IDLE_TIMEOUT_SECONDS` globally; zero disables these body/idle deadlines.

Reads taken while a server-side `image_generation` call is open use a separate 900-second
deadline, because the provider stays silent for the whole render. Override it with
`imageStreamIdleTimeoutSeconds` on the request or
`OPEN_COWORK_AGENT_IMAGE_STREAM_IDLE_TIMEOUT_SECONDS` globally; zero waits indefinitely.

## Module Rules

- Modules implement `IWorkerModule`; only `Hosting/WorkerModuleCatalog.cs` decides which modules
  are loaded by default.
- Modules register methods through `WorkerModuleContext`, not directly from `Program.cs`.
- Duplicate module names and duplicate method names fail at startup.
- Business code returns `WorkerResponse`; only `Runtime/` serializes it for the IPC transport.
- Routes that may wait on network, process, or large I/O must use `RegisterJob(...)`; keep health,
  status, cancellation, command, and short metadata routes inline.
- New business areas should get their own folder under `Modules/`.
- Keep DTOs near their owning module unless they are shared by multiple modules.
- Add every serialized response type to `WorkerJsonContext` so Native AOT does not need reflection.

## Business Migration Pattern

For a new backend-heavy area:

1. Add `Modules/<Area>/<Area>Module.cs` implementing `IWorkerModule`.
2. Keep endpoint DTOs/models in `Modules/<Area>/<Area>Models.cs`.
3. Keep implementation in focused files such as `<Area>QueryTools.cs`, `<Area>WriterTools.cs`, or
   `<Area>MaintenanceTools.cs`.
4. Register slow work with `RegisterJob(...)` and choose a stable session/project lane input.
5. Add the module to `WorkerModuleCatalog.Default`.
6. Add every JSON result model to `Serialization/WorkerJsonContext.cs`.
