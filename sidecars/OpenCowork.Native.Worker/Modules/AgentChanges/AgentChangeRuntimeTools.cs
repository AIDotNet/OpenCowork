using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization.Metadata;

internal static class AgentChangeRuntimeTools
{
    private const int InlineTextSnapshotLimitBytes = 64 * 1024;
    private static readonly UTF8Encoding Utf8NoBom = new(encoderShouldEmitUTF8Identifier: false);

    public static WorkerResponse ListSessionHydrated(JsonElement parameters)
    {
        try
        {
            var sessionId = RequireString(parameters, "sessionId").Trim();
            if (sessionId.Length == 0)
            {
                return Json(
                    new AgentChangeHydratedListResult(true, new List<StoredRunChangeSet>(), null),
                    WorkerJsonContext.Default.AgentChangeHydratedListResult);
            }

            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            var changeSets = DbAgentChangeTools.LoadChangeSetsBySession(connection, sessionId)
                .Select(HydrateLocalAfterSnapshots)
                .ToList();

            return Json(
                new AgentChangeHydratedListResult(true, changeSets, null),
                WorkerJsonContext.Default.AgentChangeHydratedListResult);
        }
        catch (Exception ex)
        {
            return Json(
                new AgentChangeHydratedListResult(false, null, ex.Message),
                WorkerJsonContext.Default.AgentChangeHydratedListResult);
        }
    }

    public static WorkerResponse GetHydrated(JsonElement parameters)
    {
        try
        {
            var runId = RequireString(parameters, "runId");
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            var changeSet = DbAgentChangeTools.LoadChangeSetByRunId(connection, runId);

            return Json(
                new AgentChangeHydratedGetResult(
                    true,
                    changeSet is null ? null : HydrateLocalAfterSnapshots(changeSet),
                    null),
                WorkerJsonContext.Default.AgentChangeHydratedGetResult);
        }
        catch (Exception ex)
        {
            return Json(
                new AgentChangeHydratedGetResult(false, null, ex.Message),
                WorkerJsonContext.Default.AgentChangeHydratedGetResult);
        }
    }

    public static WorkerResponse DiffLocal(JsonElement parameters)
    {
        try
        {
            var runId = RequireString(parameters, "runId");
            var changeId = RequireString(parameters, "changeId");
            var found = FindChange(parameters, runId, changeId);
            if (found is null)
            {
                return Json(
                    new AgentChangeDiffResult(true, true, true, null, null, null),
                    WorkerJsonContext.Default.AgentChangeDiffResult);
            }

            var change = found.Value.Change;
            if (!IsLocal(change))
            {
                return Json(
                    new AgentChangeDiffResult(true, false, false, null, null, null),
                    WorkerJsonContext.Default.AgentChangeDiffResult);
            }

            var beforeText = ResolveSnapshotFullText(change.Before);
            var afterText = ResolveSnapshotFullText(change.After);

            if (afterText is null && change.Status == "open")
            {
                afterText = TryReadLocalTextMatchingHash(change.FilePath, change.After.Hash);
            }

            if (beforeText is null || afterText is null)
            {
                return Json(
                    new AgentChangeDiffResult(
                        false,
                        true,
                        false,
                        null,
                        null,
                        "Full diff is unavailable for this change"),
                    WorkerJsonContext.Default.AgentChangeDiffResult);
            }

            return Json(
                new AgentChangeDiffResult(true, true, false, beforeText, afterText, null),
                WorkerJsonContext.Default.AgentChangeDiffResult);
        }
        catch (Exception ex)
        {
            return Json(
                new AgentChangeDiffResult(false, true, false, null, null, ex.Message),
                WorkerJsonContext.Default.AgentChangeDiffResult);
        }
    }

    public static WorkerResponse RollbackLocalChange(JsonElement parameters)
    {
        try
        {
            var change = ReadChange(parameters);
            if (!IsLocal(change))
            {
                return Json(
                    new AgentChangeRollbackResult(true, false, false, null, null, null),
                    WorkerJsonContext.Default.AgentChangeRollbackResult);
            }

            if (change.Status == "reverted")
            {
                return Json(
                    new AgentChangeRollbackResult(true, true, true, change.RevertedAt, null, null),
                    WorkerJsonContext.Default.AgentChangeRollbackResult);
            }

            var result = RollbackLocalFile(change);
            return Json(result, WorkerJsonContext.Default.AgentChangeRollbackResult);
        }
        catch (Exception ex)
        {
            return Json(
                new AgentChangeRollbackResult(false, true, false, null, null, ex.Message),
                WorkerJsonContext.Default.AgentChangeRollbackResult);
        }
    }

    private static (StoredRunChangeSet ChangeSet, StoredTrackedFileChange Change)? FindChange(
        JsonElement parameters,
        string runId,
        string changeId)
    {
        using var connection = DbConnectionFactory.OpenReadWrite(parameters);
        var changeSet = DbAgentChangeTools.LoadChangeSetByRunId(connection, runId);
        var change = changeSet?.Changes.FirstOrDefault(entry => entry.Id == changeId);
        return changeSet is null || change is null ? null : (changeSet, change);
    }

    private static StoredTrackedFileChange ReadChange(JsonElement parameters)
    {
        if (!parameters.TryGetProperty("change", out var changeElement) ||
            changeElement.ValueKind != JsonValueKind.Object)
        {
            throw new InvalidOperationException("Missing required agent change object: change");
        }

        return JsonSerializer.Deserialize(
                changeElement.GetRawText(),
                WorkerJsonContext.Default.StoredTrackedFileChange) ??
            throw new InvalidOperationException("Invalid agent change payload.");
    }

    private static StoredRunChangeSet HydrateLocalAfterSnapshots(StoredRunChangeSet changeSet)
    {
        return new StoredRunChangeSet
        {
            RunId = changeSet.RunId,
            SessionId = changeSet.SessionId,
            AssistantMessageId = changeSet.AssistantMessageId,
            Status = changeSet.Status,
            Changes = changeSet.Changes.Select(HydrateLocalAfterSnapshot).ToList(),
            CreatedAt = changeSet.CreatedAt,
            UpdatedAt = changeSet.UpdatedAt
        };
    }

    private static StoredTrackedFileChange HydrateLocalAfterSnapshot(StoredTrackedFileChange change)
    {
        return new StoredTrackedFileChange
        {
            Id = change.Id,
            RunId = change.RunId,
            SessionId = change.SessionId,
            ToolUseId = change.ToolUseId,
            ToolName = change.ToolName,
            FilePath = change.FilePath,
            Transport = change.Transport,
            ConnectionId = change.ConnectionId,
            Op = change.Op,
            Status = change.Status,
            Before = CloneSnapshot(change.Before),
            After = HydrateLocalAfterSnapshot(change, change.After),
            CreatedAt = change.CreatedAt,
            RevertedAt = change.RevertedAt
        };
    }

    private static StoredFileSnapshot HydrateLocalAfterSnapshot(
        StoredTrackedFileChange change,
        StoredFileSnapshot snapshot)
    {
        var cloned = CloneSnapshot(snapshot);
        if (cloned.Text is not null)
        {
            return cloned;
        }
        if (!IsLocal(change) || snapshot.Size > InlineTextSnapshotLimitBytes || string.IsNullOrEmpty(snapshot.Hash))
        {
            return cloned;
        }

        var text = TryReadSmallLocalText(change.FilePath);
        if (text is null || !string.Equals(HashText(text), snapshot.Hash, StringComparison.OrdinalIgnoreCase))
        {
            return cloned;
        }

        cloned.Text = text;
        return cloned;
    }

    private static StoredFileSnapshot CloneSnapshot(StoredFileSnapshot snapshot)
    {
        return new StoredFileSnapshot
        {
            Exists = snapshot.Exists,
            Text = snapshot.Text ?? (snapshot.Size <= InlineTextSnapshotLimitBytes ? snapshot.FullText : null),
            FullText = snapshot.FullText,
            PreviewText = snapshot.PreviewText,
            TailPreviewText = snapshot.TailPreviewText,
            TextOmitted = snapshot.TextOmitted,
            Hash = snapshot.Hash,
            Size = snapshot.Size,
            LineCount = snapshot.LineCount
        };
    }

    private static AgentChangeRollbackResult RollbackLocalFile(StoredTrackedFileChange change)
    {
        try
        {
            if (change.Op == "create")
            {
                if (File.Exists(change.FilePath))
                {
                    File.Delete(change.FilePath);
                }

                var deletedAt = Now();
                return new AgentChangeRollbackResult(true, true, true, deletedAt, null, null);
            }

            var beforeText = ResolveSnapshotFullText(change.Before);
            if (change.Before.Exists && beforeText is null)
            {
                return new AgentChangeRollbackResult(
                    false,
                    true,
                    false,
                    null,
                    "Original content was not captured in full (file too large at capture time)",
                    null);
            }

            File.WriteAllText(change.FilePath, beforeText ?? string.Empty, Utf8NoBom);
            var revertedAt = Now();
            return new AgentChangeRollbackResult(true, true, true, revertedAt, null, null);
        }
        catch (Exception ex)
        {
            return new AgentChangeRollbackResult(false, true, false, null, ex.Message, null);
        }
    }

    private static string? ResolveSnapshotFullText(StoredFileSnapshot snapshot)
    {
        if (!snapshot.Exists)
        {
            return string.Empty;
        }

        return snapshot.FullText ?? snapshot.Text;
    }

    private static string? TryReadLocalTextMatchingHash(string filePath, string? expectedHash)
    {
        if (string.IsNullOrEmpty(expectedHash))
        {
            return null;
        }

        var text = TryReadLocalText(filePath);
        return text is not null &&
            string.Equals(HashText(text), expectedHash, StringComparison.OrdinalIgnoreCase)
                ? text
                : null;
    }

    private static string? TryReadSmallLocalText(string filePath)
    {
        try
        {
            if (!File.Exists(filePath))
            {
                return null;
            }

            var info = new FileInfo(filePath);
            if (info.Length > InlineTextSnapshotLimitBytes)
            {
                return null;
            }

            return File.ReadAllText(filePath, Utf8NoBom);
        }
        catch
        {
            return null;
        }
    }

    private static string? TryReadLocalText(string filePath)
    {
        try
        {
            return File.Exists(filePath) ? File.ReadAllText(filePath, Utf8NoBom) : null;
        }
        catch
        {
            return null;
        }
    }

    private static string HashText(string text)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(text));
        return Convert.ToHexString(hash).ToLowerInvariant();
    }

    private static bool IsLocal(StoredTrackedFileChange change)
    {
        return !string.Equals(change.Transport, "ssh", StringComparison.Ordinal);
    }

    private static string RequireString(JsonElement parameters, string name)
    {
        return JsonHelpers.GetString(parameters, name) is { Length: > 0 } value
            ? value
            : throw new InvalidOperationException($"Missing required agent change field: {name}");
    }

    private static long Now()
    {
        return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    }

    private static WorkerResponse Json<T>(T result, JsonTypeInfo<T> typeInfo)
    {
        return WorkerResponse.Json(result, typeInfo);
    }
}
