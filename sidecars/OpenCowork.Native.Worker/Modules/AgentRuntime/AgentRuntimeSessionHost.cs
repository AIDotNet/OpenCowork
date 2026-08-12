using System.Buffers;
using System.Collections.Concurrent;
using System.Text.Json;

/// <summary>
/// Worker-side session host for agent/session-open|send|close. A hosted session keeps the
/// run-request template (provider, tools, capability snapshot, permissions) and the
/// canonical conversation inside the Worker, so hosts submit only the new user message per
/// turn instead of rebuilding and re-sending the whole run request. agent/run stays
/// unchanged; session-send composes a full run request from stored state and executes it
/// through the same job path, streams, approvals, and cancellation as agent/run.
/// </summary>
internal static class AgentRuntimeSessionHost
{
    private const int MaxHostedSessions = 64;
    private static readonly JsonWriterOptions WriterOptions = new() { SkipValidation = true };
    private static readonly ConcurrentDictionary<string, HostedSession> Sessions =
        new(StringComparer.Ordinal);

    private sealed class HostedSession
    {
        public required string SessionId { get; init; }
        public required JsonElement Template { get; set; }
        public List<JsonElement> Messages { get; } = new();
        public object SyncRoot { get; } = new();
        public long LastUsedAt { get; set; }
    }

    public static WorkerResponse Open(JsonElement parameters)
    {
        var sessionId = JsonHelpers.GetString(parameters, "sessionId")?.Trim();
        if (string.IsNullOrEmpty(sessionId))
        {
            throw new InvalidOperationException("agent/session-open requires params.sessionId");
        }
        if (!parameters.TryGetProperty("provider", out var provider) ||
            provider.ValueKind != JsonValueKind.Object)
        {
            throw new InvalidOperationException("agent/session-open requires params.provider");
        }

        var session = new HostedSession
        {
            SessionId = sessionId,
            Template = BuildTemplate(parameters),
            LastUsedAt = NowMs()
        };
        if (parameters.TryGetProperty("messages", out var messages) &&
            messages.ValueKind == JsonValueKind.Array)
        {
            foreach (var message in messages.EnumerateArray())
            {
                session.Messages.Add(message.Clone());
            }
        }

        Sessions[sessionId] = session;
        EvictStaleSessions();
        WorkerLog.Info(
            $"agent session opened sessionId={sessionId} messages={session.Messages.Count}");
        return WorkerResponse.Json(
            new AgentRuntimeSessionOpenResult(true, sessionId, session.Messages.Count),
            WorkerJsonContext.Default.AgentRuntimeSessionOpenResult);
    }

    public static async Task<WorkerResponse> SendJobAsync(
        JsonElement parameters,
        WorkerRequestContext context)
    {
        var sessionId = JsonHelpers.GetString(parameters, "sessionId")?.Trim();
        if (string.IsNullOrEmpty(sessionId) || !Sessions.TryGetValue(sessionId, out var session))
        {
            throw new InvalidOperationException(
                $"agent session is not open: {sessionId ?? "(missing sessionId)"}. " +
                "Call agent/session-open first.");
        }
        var runId = JsonHelpers.GetString(parameters, "runId")?.Trim();
        if (string.IsNullOrEmpty(runId))
        {
            throw new InvalidOperationException("agent/session-send requires params.runId");
        }

        JsonElement runParameters;
        lock (session.SyncRoot)
        {
            session.LastUsedAt = NowMs();
            // The incoming user messages become part of the canonical history immediately;
            // OnRunCompleted replaces the whole history with the loop's final conversation
            // once the run finishes, which also covers assistant/tool messages.
            if (parameters.TryGetProperty("messages", out var newMessages) &&
                newMessages.ValueKind == JsonValueKind.Array)
            {
                foreach (var message in newMessages.EnumerateArray())
                {
                    session.Messages.Add(message.Clone());
                }
            }
            runParameters = ComposeRunParameters(session, parameters, runId);
        }

        return await AgentRuntimeTools.ExecuteJobAsync(runParameters, context);
    }

    public static WorkerResponse Close(JsonElement parameters)
    {
        var sessionId = JsonHelpers.GetString(parameters, "sessionId")?.Trim() ?? string.Empty;
        var closed = sessionId.Length > 0 && Sessions.TryRemove(sessionId, out _);
        if (closed)
        {
            WorkerLog.Info($"agent session closed sessionId={sessionId}");
        }
        return WorkerResponse.Json(
            new AgentRuntimeSessionCloseResult(true, sessionId, closed),
            WorkerJsonContext.Default.AgentRuntimeSessionCloseResult);
    }

    /// <summary>
    /// Called from the loop-end path with the final wire conversation. Replaces the hosted
    /// history so the next session-send starts from the completed turn. Empty conversations
    /// (error paths that never built one) are ignored to avoid wiping valid history.
    /// </summary>
    public static void OnRunCompleted(
        string? sessionId,
        IReadOnlyList<JsonElement> wireConversation)
    {
        if (string.IsNullOrEmpty(sessionId) ||
            wireConversation.Count == 0 ||
            !Sessions.TryGetValue(sessionId, out var session))
        {
            return;
        }
        lock (session.SyncRoot)
        {
            session.Messages.Clear();
            foreach (var message in wireConversation)
            {
                session.Messages.Add(message.Clone());
            }
            session.LastUsedAt = NowMs();
        }
    }

    public static void Clear()
    {
        Sessions.Clear();
    }

    /// <summary>Everything from session-open except per-turn fields becomes the template.</summary>
    private static JsonElement BuildTemplate(JsonElement parameters)
    {
        return CreateObjectElement(writer =>
        {
            foreach (var property in parameters.EnumerateObject())
            {
                if (property.NameEquals("messages") || property.NameEquals("runId"))
                {
                    continue;
                }
                property.WriteTo(writer);
            }
        });
    }

    private static JsonElement ComposeRunParameters(
        HostedSession session,
        JsonElement sendParameters,
        string runId)
    {
        var overrides = new HashSet<string>(StringComparer.Ordinal);
        foreach (var property in sendParameters.EnumerateObject())
        {
            overrides.Add(property.Name);
        }

        return CreateObjectElement(writer =>
        {
            foreach (var property in session.Template.EnumerateObject())
            {
                if (property.NameEquals("messages") ||
                    property.NameEquals("runId") ||
                    property.NameEquals("sessionId") ||
                    overrides.Contains(property.Name))
                {
                    continue;
                }
                property.WriteTo(writer);
            }
            foreach (var property in sendParameters.EnumerateObject())
            {
                if (property.NameEquals("messages") ||
                    property.NameEquals("runId") ||
                    property.NameEquals("sessionId"))
                {
                    continue;
                }
                property.WriteTo(writer);
            }
            writer.WriteString("runId", runId);
            writer.WriteString("sessionId", session.SessionId);
            writer.WritePropertyName("messages");
            writer.WriteStartArray();
            foreach (var message in session.Messages)
            {
                message.WriteTo(writer);
            }
            writer.WriteEndArray();
        });
    }

    private static void EvictStaleSessions()
    {
        if (Sessions.Count <= MaxHostedSessions)
        {
            return;
        }
        var stale = Sessions.Values
            .OrderBy(session => session.LastUsedAt)
            .Take(Sessions.Count - MaxHostedSessions)
            .Select(session => session.SessionId)
            .ToList();
        foreach (var sessionId in stale)
        {
            Sessions.TryRemove(sessionId, out _);
            WorkerLog.Info($"agent session evicted sessionId={sessionId}");
        }
    }

    private static JsonElement CreateObjectElement(Action<Utf8JsonWriter> writeProperties)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer, WriterOptions))
        {
            writer.WriteStartObject();
            writeProperties(writer);
            writer.WriteEndObject();
        }
        using var document = JsonDocument.Parse(buffer.WrittenMemory);
        return document.RootElement.Clone();
    }

    private static long NowMs()
    {
        return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    }
}
