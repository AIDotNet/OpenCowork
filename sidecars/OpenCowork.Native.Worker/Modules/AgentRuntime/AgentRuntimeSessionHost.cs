using System.Buffers;
using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using OpenCowork.Contracts.Generated;

/// <summary>
/// Worker-side session host for agent/session-open|send|close. A hosted session keeps the
/// run-request template (provider, tools, capability snapshot, permissions) and the
/// canonical conversation inside the Worker, so hosts submit only the new user message per
/// turn instead of rebuilding and re-sending the whole run request. agent/run stays
/// unchanged; session-send composes a full run request from stored state and executes it
/// through the same job path, streams, approvals, and cancellation as agent/run.
///
/// Sessions are durable: open and turn-completion snapshot the template plus canonical
/// history into runtime_hosted_sessions, and session-send transparently restores a session
/// after a worker restart or memory eviction instead of failing with session_evicted.
/// </summary>
internal static class AgentRuntimeSessionHost
{
    private const int MaxHostedSessions = 64;
    // Oversized histories are not persisted (the host can always reopen from its own
    // transcript); cap keeps snapshot writes and restores predictable.
    private const int MaxPersistedMessagesChars = 8 * 1024 * 1024;
    // session-send may only overlay per-turn context. tools and provider.systemPrompt
    // stay pinned on the session-open template so prompt-cache prefixes stay stable.
    // `connection` is overridable so the host can hand over freshly read SSH credentials
    // on every turn; see SecretTemplateNames for why it is never written to disk.
    private static readonly HashSet<string> SendOverrideNames = new(StringComparer.Ordinal)
    {
        "requestContextTexts",
        "planMode",
        "planRevision",
        "planExecution",
        "planModeAllowedTools",
        "commandMetadata",
        "slashCommand",
        "systemCommand",
        "attachmentIds",
        "connection",
        "includeFullDebugBody"
    };
    // SSH credentials (password / key passphrase) live in the template only for the
    // lifetime of the process. Snapshots stay on disk indefinitely and would otherwise
    // leak plaintext secrets and resurrect rotated ones after a restart.
    private static readonly HashSet<string> SecretTemplateNames = new(StringComparer.Ordinal)
    {
        "connection"
    };
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
        PersistSession(session);
        WorkerLog.Info(
            $"agent session opened sessionId={sessionId} messages={session.Messages.Count}");
        return WorkerResponse.Json(
            new OpenAgentSessionResult(true, sessionId, session.Messages.Count),
            AgentRuntimeContractsJsonContext.Default.OpenAgentSessionResult);
    }

    public static bool IsOpen(string? sessionId)
    {
        return !string.IsNullOrEmpty(sessionId) && Sessions.ContainsKey(sessionId);
    }

    public static async Task<WorkerResponse> SendJobAsync(
        JsonElement parameters,
        WorkerRequestContext context)
    {
        var sessionId = JsonHelpers.GetString(parameters, "sessionId")?.Trim();
        HostedSession? session = null;
        if (!string.IsNullOrEmpty(sessionId) && !Sessions.TryGetValue(sessionId, out session))
        {
            session = TryRestoreSession(sessionId);
        }
        if (string.IsNullOrEmpty(sessionId) || session is null)
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
        if (sessionId.Length > 0)
        {
            try
            {
                RuntimeJobStore.DeleteHostedSession(sessionId);
            }
            catch (Exception ex)
            {
                WorkerLog.Warn(
                    $"agent session snapshot delete failed sessionId={sessionId} error={ex.Message}");
            }
        }
        if (closed)
        {
            WorkerLog.Info($"agent session closed sessionId={sessionId}");
        }
        return WorkerResponse.Json(
            new CloseAgentSessionResult(true, sessionId, closed),
            AgentRuntimeContractsJsonContext.Default.CloseAgentSessionResult);
    }

    /// <summary>
    /// Replaces the hosted history with the run's wire conversation and snapshots it, so
    /// the next session-send starts from it. Called at loop end and at every tool-batch
    /// boundary — the mid-run checkpoints are what keep a worker crash from rolling the
    /// history back past tools that already ran. Empty conversations (error paths that
    /// never built one) are ignored to avoid wiping valid history.
    /// Callers must skip child runs (see OpenAIChatRuntime.SnapshotHostedSession).
    /// </summary>
    public static void ReplaceHistory(
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
        PersistSession(session);
    }

    public static void Clear()
    {
        Sessions.Clear();
    }

    /// <summary>
    /// Best-effort durable snapshot of a hosted session (template + canonical history).
    /// Oversized histories drop the snapshot instead of persisting a stale/partial one,
    /// so restore either yields a faithful session or fails into the reopen path.
    /// </summary>
    private static void PersistSession(HostedSession session)
    {
        string templateJson;
        string messagesJson;
        lock (session.SyncRoot)
        {
            templateJson = SerializeTemplateWithoutSecrets(session.Template);
            messagesJson = SerializeMessages(session.Messages);
        }
        try
        {
            if (messagesJson.Length > MaxPersistedMessagesChars)
            {
                RuntimeJobStore.DeleteHostedSession(session.SessionId);
                WorkerLog.Warn(
                    $"agent session snapshot skipped (history too large) sessionId={session.SessionId} chars={messagesJson.Length}");
                return;
            }
            RuntimeJobStore.UpsertHostedSession(
                session.SessionId,
                templateJson,
                messagesJson,
                NowMs());
        }
        catch (Exception ex)
        {
            WorkerLog.Warn(
                $"agent session snapshot failed sessionId={session.SessionId} error={ex.Message}");
        }
    }

    /// <summary>Restores a hosted session from its durable snapshot after restart/eviction.</summary>
    private static HostedSession? TryRestoreSession(string sessionId)
    {
        try
        {
            var snapshot = RuntimeJobStore.TryLoadHostedSession(sessionId);
            if (snapshot is null)
            {
                return null;
            }

            using var templateDocument = JsonDocument.Parse(snapshot.Value.TemplateJson);
            var session = new HostedSession
            {
                SessionId = sessionId,
                Template = templateDocument.RootElement.Clone(),
                LastUsedAt = NowMs()
            };
            using var messagesDocument = JsonDocument.Parse(snapshot.Value.MessagesJson);
            if (messagesDocument.RootElement.ValueKind == JsonValueKind.Array)
            {
                foreach (var message in messagesDocument.RootElement.EnumerateArray())
                {
                    session.Messages.Add(message.Clone());
                }
            }

            var resolved = Sessions.GetOrAdd(sessionId, session);
            if (ReferenceEquals(resolved, session))
            {
                EvictStaleSessions();
                WorkerLog.Info(
                    $"agent session restored sessionId={sessionId} messages={session.Messages.Count}");
            }
            return resolved;
        }
        catch (Exception ex)
        {
            WorkerLog.Warn(
                $"agent session restore failed sessionId={sessionId} error={ex.Message}");
            return null;
        }
    }

    private static string SerializeTemplateWithoutSecrets(JsonElement template)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer, WriterOptions))
        {
            writer.WriteStartObject();
            foreach (var property in template.EnumerateObject())
            {
                if (SecretTemplateNames.Contains(property.Name))
                {
                    continue;
                }
                property.WriteTo(writer);
            }
            writer.WriteEndObject();
        }
        return Encoding.UTF8.GetString(buffer.WrittenSpan);
    }

    private static string SerializeMessages(List<JsonElement> messages)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer, WriterOptions))
        {
            writer.WriteStartArray();
            foreach (var message in messages)
            {
                message.WriteTo(writer);
            }
            writer.WriteEndArray();
        }
        return Encoding.UTF8.GetString(buffer.WrittenSpan);
    }

    /// <summary>Everything from session-open except per-turn fields becomes the template.</summary>
    private static JsonElement BuildTemplate(JsonElement parameters)
    {
        return CreateObjectElement(writer =>
        {
            foreach (var property in parameters.EnumerateObject())
            {
                if (property.NameEquals("messages") ||
                    property.NameEquals("runId") ||
                    property.NameEquals("slashCommand") ||
                    property.NameEquals("systemCommand"))
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
            if (SendOverrideNames.Contains(property.Name))
            {
                overrides.Add(property.Name);
            }
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
                if (!overrides.Contains(property.Name))
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
            // Durable snapshot stays on disk, so the next session-send restores it.
            WorkerLog.Info($"agent session evicted from memory sessionId={sessionId} (restorable)");
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
