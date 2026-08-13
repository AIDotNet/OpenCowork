using System.Buffers;
using System.Text.Json;

internal static class FileSystemAccess
{
    public static async Task<T> RetryOnAccessDeniedAsync<T>(
        string path,
        string operation,
        JsonElement parameters,
        WorkerRequestContext context,
        CancellationToken cancellationToken,
        Func<Task<T>> action)
    {
        try
        {
            return await action();
        }
        catch (Exception ex) when (ShouldRequestSystemAccess(ex))
        {
            var granted = await RequestSystemAccessAsync(
                path,
                operation,
                parameters,
                context,
                cancellationToken);
            if (!granted)
            {
                throw new UnauthorizedAccessException(
                    BuildDeniedMessage(path, "The user did not grant system access."),
                    ex);
            }

            try
            {
                return await action();
            }
            catch (Exception retryEx) when (ShouldRequestSystemAccess(retryEx))
            {
                throw new UnauthorizedAccessException(
                    BuildDeniedMessage(
                        path,
                        "System access was requested, but the operating system still denied the path."),
                    retryEx);
            }
        }
    }

    public static bool IsAccessDenied(Exception ex)
    {
        if (ex is UnauthorizedAccessException)
        {
            return true;
        }

        if (ex is IOException ioException)
        {
            if (ioException.HResult == unchecked((int)0x80070005))
            {
                return true;
            }

            var message = ioException.Message;
            return message.Contains("permission denied", StringComparison.OrdinalIgnoreCase) ||
                message.Contains("access denied", StringComparison.OrdinalIgnoreCase) ||
                message.Contains("operation not permitted", StringComparison.OrdinalIgnoreCase) ||
                message.Contains("EACCES", StringComparison.OrdinalIgnoreCase) ||
                message.Contains("EPERM", StringComparison.OrdinalIgnoreCase) ||
                message.Contains("UnauthorizedAccess_", StringComparison.Ordinal) ||
                message.Contains("IODenied", StringComparison.Ordinal);
        }

        return false;
    }

    private static bool ShouldRequestSystemAccess(Exception ex)
    {
        return ex is not OperationCanceledException && IsAccessDenied(ex);
    }

    private static async Task<bool> RequestSystemAccessAsync(
        string path,
        string operation,
        JsonElement parameters,
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return false;
        }

        try
        {
            var request = CreateJsonElement(writer =>
            {
                writer.WriteString("path", path);
                writer.WriteString("operation", operation);
                WriteOptionalParameter(writer, parameters, "runId");
                WriteOptionalParameter(writer, parameters, "sessionId");
                WriteOptionalParameter(writer, parameters, "workingFolder");
            });

            var result = await AgentRuntimeReverseRequests.RequestAsync(
                context,
                "fs/request-system-access",
                request,
                cancellationToken);

            return ReadBool(result, "granted") || ReadBool(result, "success");
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            WorkerLog.Warn(
                $"system file access request failed path={FormatLogPath(path)} " +
                $"operation={operation} error={ex.GetType().Name}: {ex.Message}");
            return false;
        }
    }

    private static bool ReadBool(JsonElement element, string propertyName)
    {
        return element.ValueKind == JsonValueKind.Object &&
            element.TryGetProperty(propertyName, out var value) &&
            value.ValueKind == JsonValueKind.True;
    }

    private static JsonElement CreateJsonElement(Action<Utf8JsonWriter> writeProperties)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writeProperties(writer);
            writer.WriteEndObject();
        }

        using var document = JsonDocument.Parse(buffer.WrittenMemory);
        return document.RootElement.Clone();
    }

    private static void WriteOptionalParameter(
        Utf8JsonWriter writer,
        JsonElement parameters,
        string propertyName)
    {
        if (parameters.ValueKind != JsonValueKind.Object ||
            !parameters.TryGetProperty(propertyName, out var value) ||
            value.ValueKind != JsonValueKind.String)
        {
            return;
        }

        var text = value.GetString()?.Trim();
        if (!string.IsNullOrEmpty(text))
        {
            writer.WriteString(propertyName, text);
        }
    }

    private static string BuildDeniedMessage(string path, string reason)
    {
        return $"Access to the path '{path}' is denied. {reason}";
    }

    private static string FormatLogPath(string path)
    {
        return string.IsNullOrWhiteSpace(path) ? "<empty>" : path;
    }
}
