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
            // The submodule owns WorkerProtocol.Version; the generated contract is
            // authored in the main repo. Refuse to boot if a submodule bump and the
            // contract model ever disagree — a silent skew corrupts the handshake.
            if (WorkerProtocol.Version
                != OpenCowork.Contracts.Generated.WorkerContractConstants.WorkerProtocolVersion)
            {
                throw new InvalidOperationException(
                    "WorkerProtocol.Version (submodule) and WorkerContractConstants.WorkerProtocolVersion " +
                    "(generated) disagree; update src/shared/worker-contracts/model.ts and regenerate.");
            }

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
