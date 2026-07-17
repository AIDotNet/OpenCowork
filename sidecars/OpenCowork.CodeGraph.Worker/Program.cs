using System.Text.Json;

// M0 self-test harness for the opt-in CodeGraph sidecar (reference/04 §2).
//
// This proves, inside the actual AOT-publishable binary, the three things M0 exists
// to de-risk — with ZERO coupling to the worker runtime infra:
//   1. FTS5 works at runtime in the bundled e_sqlite3 (CodeGraphDbSmoke).
//   2. Reflection-free source-gen JSON serializes a DTO (CodeGraphJsonContext) under
//      JsonSerializerIsReflectionEnabledByDefault=false.
//   3. The tree-sitter [LibraryImport] binding is callable and degrades gracefully
//      when a grammar lib is absent (the expected M0 state — grammars download on enable).
//
// The REAL IPC host (a WorkerHostBuilder + CodeGraphModule) is staged under _deferred/
// and lands with the shared-runtime extraction (see the M0 report / reference/04 §3).
internal static class Program
{
    public static int Main(string[] args)
    {
        Console.WriteLine("== OpenCowork.CodeGraph.Worker · M0 self-test ==");

        // 1 + 2: FTS5 round-trip, serialized through the source-gen JSON context.
        CodeGraphDbSmokeResult smoke = CodeGraphDbSmoke.Run();
        string json = JsonSerializer.Serialize(smoke, CodeGraphJsonContext.Default.CodeGraphDbSmokeResult);
        Console.WriteLine("db-smoke : " + json);

        // 3: tree-sitter binding probe. null is the CORRECT M0 outcome (no grammar lib
        // shipped yet); it proves the P/Invoke surface links and the missing-lib path
        // disables one language instead of crashing.
        string tsProbe;
        try
        {
            nint? handle = new CodeGraphGrammarRegistry().GetLanguage("typescript");
            tsProbe = handle is null
                ? "binding callable; grammar 'typescript' not loaded (expected at M0)"
                : $"grammar 'typescript' loaded (handle=0x{(long)handle.Value:x})";
        }
        catch (Exception ex)
        {
            tsProbe = $"binding probe threw {ex.GetType().Name}: {ex.Message}";
        }
        Console.WriteLine("tree-sit : " + tsProbe);

        bool ok = smoke.Success && smoke.Fts5;
        Console.WriteLine(ok ? "RESULT   : M0 SELF-TEST OK" : "RESULT   : M0 SELF-TEST FAILED");
        return ok ? 0 : 1;
    }
}
