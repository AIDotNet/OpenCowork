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
