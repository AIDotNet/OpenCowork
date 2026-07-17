using System.Text;
using System.Text.Json;

// Host for the opt-in CodeGraph sidecar (reference/04). Two modes:
//   --ipc <endpoint>  → run the length-prefixed MessagePack IPC worker; module catalog =
//                       { SystemModule (worker/ping·routes·memory), CodeGraphModule (codegraph/*) }.
//                       The shared runtime (WorkerHostBuilder, LocalIpcWorkerServer, transport,
//                       SystemModule) comes from OpenCowork.Worker.Runtime.
//   (no --ipc)        → M0 self-test: prove FTS5 + the tree-sitter binding in this binary, then exit.
internal static class Program
{
    public static async Task<int> Main(string[] args)
    {
        Console.OutputEncoding = Encoding.UTF8;

        // Resolve tree-sitter grammars from OPEN_COWORK_CODEGRAPH_GRAMMARS_DIR (the
        // downloaded pack or a dev grammar dir) — grammars are not bundled here.
        CodeGraphNativeLibraryResolver.Install();

        if (Array.IndexOf(args, "--ipc") >= 0)
        {
            try
            {
                WorkerEndpoint endpoint = WorkerEndpoint.Parse(args);
                WorkerHost host = new WorkerHostBuilder()
                    .UseEndpoint(endpoint)
                    .AddModule(new SystemModule())
                    .AddModule(new CodeGraphModule())
                    .Build();
                await host.RunAsync();
                return 0;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine(ex);
                return 1;
            }
        }

        return RunSelfTest();
    }

    private static int RunSelfTest()
    {
        Console.WriteLine("== OpenCowork.CodeGraph.Worker · self-test (no --ipc) ==");

        CodeGraphDbSmokeResult smoke = CodeGraphDbSmoke.Run();
        Console.WriteLine("db-smoke : " + JsonSerializer.Serialize(smoke, CodeGraphJsonContext.Default.CodeGraphDbSmokeResult));

        string tsProbe;
        try
        {
            nint? handle = new CodeGraphGrammarRegistry().GetLanguage("typescript");
            tsProbe = handle is null
                ? "binding callable; grammar 'typescript' not loaded (expected without a grammar lib)"
                : $"grammar 'typescript' loaded (handle=0x{(long)handle.Value:x})";
        }
        catch (Exception ex)
        {
            tsProbe = $"binding probe threw {ex.GetType().Name}: {ex.Message}";
        }
        Console.WriteLine("tree-sit : " + tsProbe);

        bool ok = smoke.Success && smoke.Fts5;
        Console.WriteLine(ok ? "RESULT   : SELF-TEST OK" : "RESULT   : SELF-TEST FAILED");
        return ok ? 0 : 1;
    }
}
