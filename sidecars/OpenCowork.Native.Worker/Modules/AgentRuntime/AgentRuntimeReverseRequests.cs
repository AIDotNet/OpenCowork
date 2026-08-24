using System.Collections.Concurrent;
using System.Text.Json;
using OpenCowork.Contracts.Generated;

internal static class AgentRuntimeReverseRequests
{
    private static readonly ConcurrentDictionary<string, PendingReverseRequest> Pending = new(StringComparer.Ordinal);

    /// <summary>
    /// How long a reverse request waits for the host before giving up.
    ///
    /// There was no deadline here at all: a host that never answered left the run
    /// blocked forever, holding its lane and looking indistinguishable from a slow
    /// tool. The host's own UI prompts expire after ten minutes, so this sits just
    /// past that — long enough that a human deciding on an approval is never cut
    /// off, short enough that a lost host surfaces as an error.
    /// </summary>
    private static readonly TimeSpan ReverseRequestTimeout = TimeSpan.FromMinutes(11);

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

        using var deadline = new CancellationTokenSource(ReverseRequestTimeout);
        using var combined = CancellationTokenSource.CreateLinkedTokenSource(
            cancellationToken,
            deadline.Token);

        using var registration = combined.Token.Register(static state =>
        {
            var requestId = (string)state!;
            if (Pending.TryRemove(requestId, out var request))
            {
                request.TrySetCanceled();
            }
        }, id);

        try
        {
            // Emit detached from the job token: cancellation is governed by
            // `cancellationToken` via the registration above, and callers may pass
            // a token that outlives a cancelled job (terminal Stop hooks). The
            // job token would fail the pipe write before the request ever left.
            await context.EmitEventIgnoringCancellationAsync(
                "agent/reverse-request",
                new ReverseRequestEnvelope(id, method, parameters),
                AgentRuntimeContractsJsonContext.Default.ReverseRequestEnvelope);

            return await pending.Task.ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (
            deadline.IsCancellationRequested && !cancellationToken.IsCancellationRequested)
        {
            // The host never answered. Surfacing this as an error fails the tool
            // rather than the whole run, which is what a caller can act on.
            WorkerLog.Warn(
                $"reverse request timed out id={id} method={method} " +
                $"afterSeconds={ReverseRequestTimeout.TotalSeconds:0}");
            throw new TimeoutException(
                $"Host did not answer reverse request '{method}' within " +
                $"{ReverseRequestTimeout.TotalMinutes:0} minutes.");
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            try
            {
                await context.EmitEventIgnoringCancellationAsync(
                    "agent/reverse-cancel",
                    new ReverseCancelEnvelope(id, method),
                    AgentRuntimeContractsJsonContext.Default.ReverseCancelEnvelope);
            }
            catch (Exception ex)
            {
                WorkerLog.Warn(
                    $"reverse cancel notification failed id={id} method={method} error={ex.GetType().Name}: {ex.Message}");
            }
            throw;
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
                new ReverseResponseResult(false),
                AgentRuntimeContractsJsonContext.Default.ReverseResponseResult);
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
            new ReverseResponseResult(true),
            AgentRuntimeContractsJsonContext.Default.ReverseResponseResult);
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
