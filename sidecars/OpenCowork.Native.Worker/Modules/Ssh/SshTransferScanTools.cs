using System.Diagnostics;
using System.Text.Json;

internal static class SshTransferScanTools
{
    private const int DefaultTransferScanTimeoutMs = 30 * 60_000;
    private const int DefaultMaxScanNodes = 200_000;
    private const int MaxScanNodes = 1_000_000;
    private const int MaxScanStdoutChars = 96 * 1024 * 1024;

    public static async Task<WorkerResponse> ScanAsync(JsonElement parameters)
    {
        var startedAt = Stopwatch.GetTimestamp();
        try
        {
            var remotePath = JsonHelpers.GetString(parameters, "path") ??
                throw new InvalidOperationException("Missing required SSH transfer scan field: path");
            var timeoutMs = JsonHelpers.GetInt(parameters, "timeoutMs", DefaultTransferScanTimeoutMs);
            var maxNodes = Math.Clamp(JsonHelpers.GetInt(parameters, "maxNodes", DefaultMaxScanNodes), 1, MaxScanNodes);
            var connectionId = ResolveConnectionId(parameters);

            WorkerLog.Debug(
                $"ssh transfer scan start connectionId={FormatLogValue(connectionId)} " +
                $"path={remotePath} maxNodes={maxNodes}");

            var node = await ScanRemoteNodeAsync(parameters, remotePath, connectionId, timeoutMs, maxNodes);

            WorkerLog.Debug(
                $"ssh transfer scan done connectionId={FormatLogValue(connectionId)} " +
                $"path={node.RemotePath} items={node.ItemCount} bytes={node.TotalBytes} " +
                $"elapsedMs={ElapsedMs(startedAt)}");

            return ScanResult(true, node, null);
        }
        catch (Exception ex)
        {
            WorkerLog.Warn(
                $"ssh transfer scan failed elapsedMs={ElapsedMs(startedAt)} " +
                $"error={ex.GetType().Name}: {ex.Message}");
            return ScanResult(false, null, ex.Message);
        }
    }

    internal static async Task<SshTransferNode> ScanRemoteNodeAsync(
        JsonElement parameters,
        string remotePath,
        string connectionId,
        int timeoutMs,
        int maxNodes,
        string connectionPropertyName = "connection")
    {
        var result = await SshOpenSsh.ExecuteAsync(
            parameters,
            connectionPropertyName,
            BuildScanCommand(remotePath, maxNodes),
            timeoutMs,
            maxStdoutChars: MaxScanStdoutChars);

        if (result.ExitCode != 0)
        {
            throw new InvalidOperationException(
                result.TimedOut ? "SSH transfer scan timeout" : NormalizeSshError(result.Stderr));
        }

        using var document = JsonDocument.Parse(result.Stdout);
        return ParseNode(document.RootElement, connectionId);
    }

    internal static string BuildScanCommand(string remotePath, int maxNodes)
    {
        var script = """
            import json, os, stat, sys

            root_arg = sys.argv[1]
            max_nodes = int(sys.argv[2])
            root = os.path.abspath(os.path.expanduser(root_arg))
            seen_dirs = set()
            scanned_nodes = 0

            def node_name(path):
                return os.path.basename(os.path.normpath(path)) or path

            def scan(path):
                global scanned_nodes
                scanned_nodes += 1
                if scanned_nodes > max_nodes:
                    raise RuntimeError("SSH transfer scan node limit exceeded")

                st = os.stat(path)
                if stat.S_ISDIR(st.st_mode):
                    real = os.path.realpath(path)
                    if real in seen_dirs:
                        return {
                            "name": node_name(path),
                            "type": "directory",
                            "size": 0,
                            "itemCount": 1,
                            "totalBytes": 0,
                            "remotePath": path,
                            "children": []
                        }
                    seen_dirs.add(real)

                    children = []
                    names = sorted(os.listdir(path))
                    for name in names:
                        child_path = os.path.join(path, name)
                        try:
                            children.append(scan(child_path))
                        except OSError:
                            continue

                    item_count = 1 + sum(child["itemCount"] for child in children)
                    total_bytes = sum(child["totalBytes"] for child in children)
                    return {
                        "name": node_name(path),
                        "type": "directory",
                        "size": 0,
                        "itemCount": item_count,
                        "totalBytes": total_bytes,
                        "remotePath": path,
                        "children": children
                    }

                size = int(st.st_size)
                return {
                    "name": node_name(path),
                    "type": "file",
                    "size": size,
                    "itemCount": 1,
                    "totalBytes": size,
                    "remotePath": path
                }

            print(json.dumps(scan(root), separators=(",", ":")))
            """;

        return
            $"python3 -c {SshOpenSsh.ShellEscape(script)} " +
            $"{SshOpenSsh.ShellPathExpr(remotePath)} {maxNodes}";
    }

    private static SshTransferNode ParseNode(JsonElement element, string connectionId)
    {
        List<SshTransferNode>? children = null;
        if (element.TryGetProperty("children", out var childrenElement) &&
            childrenElement.ValueKind == JsonValueKind.Array)
        {
            children = new List<SshTransferNode>();
            foreach (var child in childrenElement.EnumerateArray())
            {
                children.Add(ParseNode(child, connectionId));
            }
        }

        return new SshTransferNode(
            GetString(element, "name") ?? string.Empty,
            GetString(element, "type") ?? "file",
            GetLong(element, "size"),
            GetLong(element, "itemCount"),
            GetLong(element, "totalBytes"),
            GetString(element, "remotePath") ?? string.Empty,
            connectionId,
            children is { Count: > 0 } ? children : null);
    }

    private static WorkerResponse ScanResult(bool success, SshTransferNode? node, string? error)
    {
        return WorkerResponse.Json(
            new SshTransferScanResult(success, node, error),
            WorkerJsonContext.Default.SshTransferScanResult);
    }

    private static string ResolveConnectionId(JsonElement parameters)
    {
        if (JsonHelpers.GetString(parameters, "connectionId") is { Length: > 0 } explicitId)
        {
            return explicitId;
        }

        if (parameters.TryGetProperty("connection", out var connection))
        {
            return JsonHelpers.GetString(connection, "id") ?? string.Empty;
        }

        return string.Empty;
    }

    internal static string NormalizeSshError(string stderr)
    {
        var trimmed = stderr.Trim();
        return string.IsNullOrEmpty(trimmed) ? "SSH transfer scan failed" : trimmed;
    }

    private static string? GetString(JsonElement element, string name)
    {
        return element.TryGetProperty(name, out var property) && property.ValueKind == JsonValueKind.String
            ? property.GetString()
            : null;
    }

    private static long GetLong(JsonElement element, string name)
    {
        return element.TryGetProperty(name, out var property) && property.TryGetInt64(out var value)
            ? value
            : 0;
    }

    private static string FormatLogValue(string? value)
    {
        return string.IsNullOrWhiteSpace(value) ? "none" : value;
    }

    private static long ElapsedMs(long startedAt)
    {
        return (long)Math.Round(Stopwatch.GetElapsedTime(startedAt).TotalMilliseconds);
    }
}
