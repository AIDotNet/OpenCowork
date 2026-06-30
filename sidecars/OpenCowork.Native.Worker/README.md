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
  -> WorkerHost.CreateDefault()
  -> WorkerHostBuilder.UseDefaultModules()
  -> WorkerModuleCatalog.Default
  -> IWorkerModule.Register(WorkerModuleContext)
  -> LocalIpcWorkerServer.RunAsync()
  -> WorkerDispatcher.DispatchAsync()
```

Node starts this process with `--ipc <endpoint>`. On Unix-like systems the endpoint is a Unix
domain socket path; on Windows it is a named pipe path. Requests and responses are length-prefixed
MessagePack frames so heavy DB/file/git payloads do not flow through stdout/stderr.

## Module Rules

- Modules implement `IWorkerModule`; only `Hosting/WorkerModuleCatalog.cs` decides which modules
  are loaded by default.
- Modules register methods through `WorkerModuleContext`, not directly from `Program.cs`.
- Duplicate module names and duplicate method names fail at startup.
- Business code returns `WorkerResponse`; only `Runtime/` serializes it for the IPC transport.
- New business areas should get their own folder under `Modules/`.
- Keep DTOs near their owning module unless they are shared by multiple modules.
- Add every serialized response type to `WorkerJsonContext` so Native AOT does not need reflection.

## Business Migration Pattern

For a new backend-heavy area:

1. Add `Modules/<Area>/<Area>Module.cs` implementing `IWorkerModule`.
2. Keep endpoint DTOs/models in `Modules/<Area>/<Area>Models.cs`.
3. Keep implementation in focused files such as `<Area>QueryTools.cs`, `<Area>WriterTools.cs`, or
   `<Area>MaintenanceTools.cs`.
4. Add the module to `WorkerModuleCatalog.Default`.
5. Add every JSON result model to `Serialization/WorkerJsonContext.cs`.
