using System.Text;

// Thin AOT host for the opt-in CodeGraph sidecar (reference/04 §2). Mirrors the main
// worker's Program.cs bootstrap (…/OpenCowork.Native.Worker/Program.cs) — parse the
// --ipc endpoint, build a WorkerHost, run the length-prefixed MessagePack IPC server —
// but its module catalog contains ONLY CodeGraphModule. The runtime host types
// (WorkerEndpoint, WorkerHostBuilder, WorkerHost, LocalIpcWorkerServer, …) are ported
// into OpenCowork.CodeGraph.Core and exposed to this exe via InternalsVisibleTo.
//
// The main worker's SSH-askpass re-invocation branch is intentionally omitted: this
// binary is never launched as an SSH_ASKPASS helper (no SshModule here).
internal static class Program
{
    public static async Task<int> Main(string[] args)
    {
        Console.OutputEncoding = Encoding.UTF8;

        try
        {
            var endpoint = WorkerEndpoint.Parse(args);
            var host = new WorkerHostBuilder()
                .UseEndpoint(endpoint)
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
}
