using System.Collections.Concurrent;
using System.Text.Json;

internal static class AgentRuntimeReverseRequests
{
    private static readonly ConcurrentDictionary<string, PendingReverseRequest> Pending = new(StringComparer.Ordinal);
    private static long nextId;

    public static async Task<JsonElement> RequestAsync(
        WorkerRequestContext context,
        string method,
        JsonElement parameters,
        CancellationToken cancellationToken)
    {
        var id = Interlocked.Increment(ref nextId).ToString(System.Globalization.CultureInfo.InvariantCulture);
        var pending = new PendingReverseRequest();
        if (!Pending.TryAdd(id, pending))
        {
            throw new InvalidOperationException($"Duplicate reverse request id: {id}");
        }

        using var registration = cancellationToken.Register(static state =>
        {
            var requestId = (string)state!;
            if (Pending.TryRemove(requestId, out var request))
            {
                request.TrySetCanceled();
            }
        }, id);

        try
        {
            await context.EmitEventAsync(
                "agent/reverse-request",
                new AgentRuntimeReverseRequestEnvelope(id, method, parameters),
                WorkerJsonContext.Default.AgentRuntimeReverseRequestEnvelope);

            return await pending.Task.ConfigureAwait(false);
        }
        finally
        {
            Pending.TryRemove(id, out _);
        }
    }

    public static WorkerResponse Complete(JsonElement parameters)
    {
        var id = ReadId(parameters);
        if (string.IsNullOrEmpty(id) || !Pending.TryRemove(id, out var pending))
        {
            return WorkerResponse.Json(
                new AgentRuntimeReverseResponseResult(false),
                WorkerJsonContext.Default.AgentRuntimeReverseResponseResult);
        }

        var error = JsonHelpers.GetString(parameters, "error");
        if (!string.IsNullOrEmpty(error))
        {
            pending.TrySetException(new InvalidOperationException(error));
        }
        else if (parameters.ValueKind == JsonValueKind.Object &&
            parameters.TryGetProperty("result", out var result))
        {
            pending.TrySetResult(result.Clone());
        }
        else
        {
            pending.TrySetResult(CreateNullElement());
        }

        return WorkerResponse.Json(
            new AgentRuntimeReverseResponseResult(true),
            WorkerJsonContext.Default.AgentRuntimeReverseResponseResult);
    }

    private static string? ReadId(JsonElement parameters)
    {
        if (parameters.ValueKind != JsonValueKind.Object ||
            !parameters.TryGetProperty("id", out var id))
        {
            return null;
        }

        return id.ValueKind switch
        {
            JsonValueKind.String => id.GetString(),
            JsonValueKind.Number => id.GetRawText(),
            _ => null
        };
    }

    private static JsonElement CreateNullElement()
    {
        using var document = JsonDocument.Parse("null");
        return document.RootElement.Clone();
    }

    private sealed class PendingReverseRequest
    {
        private readonly TaskCompletionSource<JsonElement> source =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public Task<JsonElement> Task => source.Task;

        public void TrySetResult(JsonElement result)
        {
            source.TrySetResult(result);
        }

        public void TrySetException(Exception exception)
        {
            source.TrySetException(exception);
        }

        public void TrySetCanceled()
        {
            source.TrySetCanceled();
        }
    }
}
