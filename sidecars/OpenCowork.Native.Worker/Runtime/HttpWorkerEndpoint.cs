/// <summary>
/// Startup arguments for the HTTP transport.
///
/// The supervisor generates the shared secret and the worker chooses the port, so
/// a stale worker can never occupy the port a new one needs. The chosen port is
/// published on stdout (see <see cref="HttpWorkerServer"/>) because only the
/// worker knows it.
/// </summary>
internal sealed record HttpWorkerEndpoint(string Token, string HostId, int RequestedPort)
{
    public static HttpWorkerEndpoint Parse(string[] args)
    {
        var token = ReadArgument(args, "--http-token");
        var hostId = ReadArgument(args, "--host-id");
        var port = ReadArgument(args, "--http-port");

        if (string.IsNullOrWhiteSpace(token))
        {
            throw new ArgumentException(
                "Native worker requires --http-token <shared-secret>.");
        }

        if (string.IsNullOrWhiteSpace(hostId))
        {
            throw new ArgumentException("Native worker requires --host-id <stable-client-id>.");
        }

        var requestedPort = 0;
        if (!string.IsNullOrWhiteSpace(port) &&
            (!int.TryParse(port, out requestedPort) || requestedPort is < 0 or > 65535))
        {
            throw new ArgumentException($"Invalid --http-port value: {port}");
        }

        return new HttpWorkerEndpoint(token, hostId, requestedPort);
    }


    private static string? ReadArgument(string[] args, string name)
    {
        for (var i = 0; i < args.Length; i++)
        {
            if (!string.Equals(args[i], name, StringComparison.Ordinal))
            {
                continue;
            }

            if (i + 1 >= args.Length || string.IsNullOrWhiteSpace(args[i + 1]))
            {
                throw new ArgumentException($"Missing value for {name}.");
            }

            return args[i + 1].Trim();
        }

        return null;
    }
}
