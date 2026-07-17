using System.Text;

internal static class Program
{
    private const string AskPassModeEnv = "OPEN_COWORK_SSH_ASKPASS_MODE";
    private const string AskPassSecretEnv = "OPEN_COWORK_SSH_ASKPASS_SECRET";

    public static async Task<int> Main(string[] args)
    {
        Console.OutputEncoding = Encoding.UTF8;
        if (string.Equals(Environment.GetEnvironmentVariable(AskPassModeEnv), "1", StringComparison.Ordinal))
        {
            Console.Write(Environment.GetEnvironmentVariable(AskPassSecretEnv) ?? string.Empty);
            Console.WriteLine();
            return 0;
        }

        try
        {
            // CodeGraph tree-sitter grammars resolve from the bundled grammars dir
            // (OPEN_COWORK_CODEGRAPH_GRAMMARS_DIR, or <binary>/grammars fallback);
            // a missing grammar disables one language, never boot.
            CodeGraphNativeLibraryResolver.Install();

            var endpoint = WorkerEndpoint.Parse(args);
            await WorkerHost.CreateDefault(endpoint).RunAsync();
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex);
            return 1;
        }
    }
}
