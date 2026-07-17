using System.Text.Json;

// The single IWorkerModule for the CodeGraph sidecar (reference/06 §3, §9: one module,
// Name="codegraph", every method prefixed "codegraph/"). Global namespace, CodeGraph*
// prefix. M0 wires two stub methods; the real query/index surface lands in M1+.
//
// Error convention (reference/06 §3.3): WorkerResponse.Error RESOLVES (does not reject)
// on the JS side, so success/failure is modelled inside the result DTO
// (CodeGraphDbSmokeResult.Success/Error), never via a thrown promise.
internal sealed class CodeGraphModule : IWorkerModule
{
    public string Name => "codegraph";

    public void Register(WorkerModuleContext context)
    {
        // M0 methods take no input; use the synchronous
        // Func<JsonElement, WorkerResponse> Register overload and ignore the args.
        context.Register("codegraph/status", _ =>
            WorkerResponse.Json(
                new CodeGraphStatusResult(
                    Success: true,
                    Version: "0.0.1-m0",
                    Message: "codegraph module alive"),
                CodeGraphJsonContext.Default.CodeGraphStatusResult));

        context.Register("codegraph/db-smoke", _ =>
            WorkerResponse.Json(
                CodeGraphDbSmoke.Run(),
                CodeGraphJsonContext.Default.CodeGraphDbSmokeResult));
    }
}
