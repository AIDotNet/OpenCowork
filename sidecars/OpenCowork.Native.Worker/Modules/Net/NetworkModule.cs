using System.Text.Json;

/// <summary>
/// Host-driven network configuration. Currently only the outbound proxy, which the host resolves
/// with Chromium's resolver because .NET cannot see the OS proxy settings on macOS or Linux.
/// See <see cref="WorkerHttpProxy"/> for why this is pushed rather than read from the environment.
/// </summary>
internal sealed class NetworkModule : IWorkerModule
{
    public string Name => "network";

    public void Register(WorkerModuleContext context)
    {
        context.Register("network/set-proxy", parameters =>
        {
            var applied = WorkerHttpProxy.Configure(
                JsonHelpers.GetString(parameters, "url"),
                JsonHelpers.GetStringArray(parameters, "bypass"));
            WorkerLog.Info($"http proxy set to {applied}");
            return WorkerResponse.FromWriter(writer =>
            {
                writer.WriteStartObject();
                writer.WriteBoolean("success", true);
                writer.WriteString("proxy", applied);
                writer.WriteEndObject();
            });
        });
    }
}
