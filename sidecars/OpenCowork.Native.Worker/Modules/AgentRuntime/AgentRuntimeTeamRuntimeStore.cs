using System.Security.Cryptography;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

internal static partial class AgentRuntimeTeamRuntimeStore
{
    private const string TeamFileName = "team.json";
    private const string MessagesFileName = "messages.jsonl";
    private const string LegacyMessagesFileName = "messages.json";
    private const string IdAlphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    private static readonly int[] LockRetryDelaysMs = [25, 50, 100, 200, 400];
    private static readonly JsonSerializerOptions IndentedJsonOptions = new()
    {
        WriteIndented = true
    };

    public static string CreateTeam(
        string rawTeamName,
        string description,
        string? sessionId,
        string? workingFolder,
        string? defaultBackend,
        out string safeTeamName,
        out JsonObject manifest)
    {
        safeTeamName = SanitizeTeamName(rawTeamName);
        if (safeTeamName.Length == 0)
        {
            throw new InvalidOperationException("Invalid team name");
        }

        var runtimePath = GetTeamRuntimePath(safeTeamName);
        var teamFilePath = GetTeamFilePath(safeTeamName);
        using var fileLock = AcquireFileLock(teamFilePath);
        if (File.Exists(teamFilePath))
        {
            throw new InvalidOperationException($"Team \"{safeTeamName}\" already exists");
        }

        Directory.CreateDirectory(runtimePath);
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var leadAgentId = $"team-lead@{safeTeamName}-{CreateId(6)}";
        var backend = NormalizeBackend(defaultBackend);
        var members = new JsonArray();
        var leadMember = new JsonObject
        {
            ["agentId"] = leadAgentId,
            ["name"] = "lead",
            ["role"] = "lead",
            ["backendType"] = backend,
            ["status"] = "idle",
            ["currentTaskId"] = null,
            ["isActive"] = true,
            ["startedAt"] = now,
            ["completedAt"] = null
        };
        members.Add((JsonNode?)leadMember);

        manifest = new JsonObject
        {
            ["version"] = 1,
            ["name"] = safeTeamName,
            ["description"] = description,
            ["createdAt"] = now,
            ["updatedAt"] = now,
            ["runtimePath"] = runtimePath,
            ["leadAgentId"] = leadAgentId,
            ["defaultBackend"] = backend,
            ["permissionMode"] = "default",
            ["teamAllowedPaths"] = string.IsNullOrWhiteSpace(workingFolder) ? new JsonArray() : ToJsonArray([workingFolder]),
            ["members"] = members,
            ["tasks"] = new JsonArray()
        };
        if (!string.IsNullOrWhiteSpace(sessionId))
        {
            manifest["leadSessionId"] = sessionId;
            leadMember["sessionId"] = sessionId;
        }

        WriteJsonNode(teamFilePath, manifest);
        File.WriteAllText(
            GetMessagesFilePath(safeTeamName),
            string.Empty,
            new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        return runtimePath;
    }

    public static TeamSnapshot ReadSnapshot(string teamName, int limit = 10)
    {
        var manifest = ReadManifest(teamName) ??
            throw new InvalidOperationException($"Team \"{teamName}\" does not exist");
        return new TeamSnapshot(teamName, manifest, ReadRecentMessages(teamName, limit));
    }

    public static TeamSnapshot? TryReadSnapshot(string teamName, int limit = 10)
    {
        var manifest = ReadManifest(teamName);
        return manifest is null ? null : new TeamSnapshot(teamName, manifest, ReadRecentMessages(teamName, limit));
    }

    public static string ResolveTeamName(JsonElement input, JsonElement parameters)
    {
        var explicitName = JsonHelpers.GetString(input, "team_name") ??
            JsonHelpers.GetString(input, "teamName") ??
            JsonHelpers.GetString(parameters, "activeTeamName");
        if (!string.IsNullOrWhiteSpace(explicitName))
        {
            return SanitizeTeamName(explicitName);
        }

        var sessionId = JsonHelpers.GetString(parameters, "sessionId")?.Trim();
        if (!string.IsNullOrWhiteSpace(sessionId))
        {
            var bySession = FindTeamBySession(sessionId);
            if (!string.IsNullOrWhiteSpace(bySession))
            {
                return bySession;
            }
        }

        var latest = FindLatestTeam();
        return latest ?? string.Empty;
    }

    public static string ResolveTeamName(JsonElement parameters)
    {
        var explicitName = JsonHelpers.GetString(parameters, "activeTeamName");
        if (!string.IsNullOrWhiteSpace(explicitName))
        {
            return SanitizeTeamName(explicitName);
        }

        var sessionId = JsonHelpers.GetString(parameters, "sessionId")?.Trim();
        if (!string.IsNullOrWhiteSpace(sessionId))
        {
            var bySession = FindTeamBySession(sessionId);
            if (!string.IsNullOrWhiteSpace(bySession))
            {
                return bySession;
            }
        }

        return string.Empty;
    }

    public static TeamSnapshot AppendMessage(
        string teamName,
        string type,
        string recipient,
        string content,
        string sender,
        string? summary)
    {
        var normalizedType = NormalizeMessageType(type);
        var normalizedRecipient = normalizedType == "broadcast" ? "all" : (recipient.Length == 0 ? "all" : recipient);
        var message = new JsonObject
        {
            ["id"] = CreateId(8),
            ["from"] = string.IsNullOrWhiteSpace(sender) ? "lead" : sender,
            ["to"] = normalizedRecipient,
            ["type"] = normalizedType,
            ["content"] = content,
            ["timestamp"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
        };
        if (!string.IsNullOrWhiteSpace(summary))
        {
            message["summary"] = summary;
        }

        var messagesFilePath = GetMessagesFilePath(teamName);
        using (AcquireFileLock(messagesFilePath))
        {
            EnsureMessagesLog(teamName);
            AppendJsonLine(messagesFilePath, message);
        }

        var manifest = TouchManifest(teamName);
        return new TeamSnapshot(teamName, manifest, ReadRecentMessages(teamName, 10));
    }

    public static TeamSnapshot UpdatePermissionFromMessage(string teamName, string content)
    {
        var permissionMode = ParsePermissionMode(content);
        var allowedPaths = ParseAllowedPaths(content);
        if (permissionMode is null && allowedPaths is null)
        {
            throw new InvalidOperationException("Invalid permission update payload");
        }

        UpdateManifest(teamName, manifest =>
        {
            if (permissionMode is not null)
            {
                manifest["permissionMode"] = permissionMode;
            }
            if (allowedPaths is not null)
            {
                var next = new JsonArray();
                foreach (var item in allowedPaths)
                {
                    next.Add((JsonNode?)JsonValue.Create(item));
                }
                manifest["teamAllowedPaths"] = next;
            }
        });
        return ReadSnapshot(teamName, 10);
    }

    public static TeamSnapshot CreateTask(
        string teamName,
        string subject,
        string? activeForm,
        string[] dependsOn,
        out JsonObject task,
        out bool existing)
    {
        JsonObject? selectedTask = null;
        var wasExisting = false;
        UpdateManifest(teamName, manifest =>
        {
            var tasks = EnsureArray(manifest, "tasks");
            foreach (var item in tasks)
            {
                if (item is JsonObject candidate &&
                    string.Equals(GetString(candidate, "subject"), subject, StringComparison.Ordinal))
                {
                    selectedTask = candidate.DeepClone().AsObject();
                    wasExisting = true;
                    return;
                }
            }

            selectedTask = new JsonObject
            {
                ["id"] = CreateId(8),
                ["subject"] = subject,
                ["description"] = string.Empty,
                ["status"] = "pending",
                ["owner"] = null,
                ["dependsOn"] = ToJsonArray(dependsOn)
            };
            if (!string.IsNullOrWhiteSpace(activeForm))
            {
                selectedTask["activeForm"] = activeForm;
            }
            tasks.Add(selectedTask.DeepClone());
        });

        task = selectedTask ?? throw new InvalidOperationException("TaskCreate failed");
        existing = wasExisting;
        return ReadSnapshot(teamName, 10);
    }

    public static TeamSnapshot AddWorkerMember(
        string teamName,
        string memberName,
        string? model,
        string? agentType,
        string? backendType,
        string? currentTaskId,
        out JsonObject member)
    {
        JsonObject? selectedMember = null;
        UpdateManifest(teamName, manifest =>
        {
            var members = EnsureArray(manifest, "members");
            foreach (var item in members)
            {
                if (item is JsonObject existing &&
                    string.Equals(GetString(existing, "name"), memberName, StringComparison.Ordinal))
                {
                    throw new InvalidOperationException($"Teammate \"{memberName}\" already exists in the team.");
                }
            }

            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            selectedMember = new JsonObject
            {
                ["agentId"] = $"team-worker@{teamName}-{CreateId(8)}",
                ["name"] = memberName,
                ["role"] = "worker",
                ["backendType"] = NormalizeBackend(backendType),
                ["model"] = string.IsNullOrWhiteSpace(model) ? "default" : model,
                ["status"] = "working",
                ["currentTaskId"] = string.IsNullOrWhiteSpace(currentTaskId) ? null : currentTaskId,
                ["isActive"] = true,
                ["startedAt"] = now,
                ["completedAt"] = null
            };
            if (!string.IsNullOrWhiteSpace(agentType))
            {
                selectedMember["agentType"] = agentType;
            }
            members.Add(selectedMember.DeepClone());
        });

        member = selectedMember ?? throw new InvalidOperationException("Failed to add teammate.");
        return ReadSnapshot(teamName, 10);
    }

    public static TeamSnapshot UpdateMember(
        string teamName,
        string memberId,
        string? status = null,
        string? currentTaskId = null,
        bool clearCurrentTaskId = false,
        bool? isActive = null,
        long? completedAt = null)
    {
        UpdateManifest(teamName, manifest =>
        {
            var member = FindMember(manifest, memberId) ??
                throw new InvalidOperationException($"Team member \"{memberId}\" not found");
            if (status is "working" or "idle" or "waiting" or "stopped")
            {
                member["status"] = status;
            }
            if (clearCurrentTaskId)
            {
                member["currentTaskId"] = null;
            }
            else if (currentTaskId is not null)
            {
                member["currentTaskId"] = currentTaskId.Length == 0 ? null : currentTaskId;
            }
            if (isActive.HasValue)
            {
                member["isActive"] = isActive.Value;
            }
            if (completedAt.HasValue)
            {
                member["completedAt"] = completedAt.Value;
            }
        });

        return ReadSnapshot(teamName, 10);
    }

    public static TeamSnapshot ClaimTask(string teamName, string taskId, string owner)
    {
        UpdateManifest(teamName, manifest =>
        {
            var task = FindTask(manifest, taskId) ??
                throw new InvalidOperationException($"Task \"{taskId}\" not found");
            if (GetString(task, "status") == "completed")
            {
                throw new InvalidOperationException($"Task \"{taskId}\" is already completed.");
            }
            task["status"] = "in_progress";
            task["owner"] = owner;
        });

        return ReadSnapshot(teamName, 10);
    }

    public static TeamSnapshot CompleteTask(string teamName, string taskId, string owner, string report)
    {
        UpdateManifest(teamName, manifest =>
        {
            var task = FindTask(manifest, taskId) ??
                throw new InvalidOperationException($"Task \"{taskId}\" not found");
            task["status"] = "completed";
            task["owner"] = owner;
            task["report"] = report;
        });

        return ReadSnapshot(teamName, 10);
    }

    public static JsonObject GetTask(string teamName, string taskId)
    {
        var snapshot = ReadSnapshot(teamName, 10);
        var task = FindTask(snapshot.Manifest, taskId);
        return task?.DeepClone().AsObject() ??
            throw new InvalidOperationException($"Task \"{taskId}\" not found");
    }

    public static TeamSnapshot UpdateTask(
        string teamName,
        string taskId,
        JsonElement input,
        out JsonObject updatedPatch)
    {
        var patch = new JsonObject();
        UpdateManifest(teamName, manifest =>
        {
            var task = FindTask(manifest, taskId) ??
                throw new InvalidOperationException($"Task \"{taskId}\" not found");
            var currentStatus = GetString(task, "status");
            var newStatus = JsonHelpers.GetString(input, "status");
            if (newStatus == "deleted")
            {
                newStatus = "completed";
                patch["deleted"] = true;
                patch["report"] = "[deleted]";
                task["report"] = "[deleted]";
            }
            if (newStatus is "pending" or "in_progress" or "completed")
            {
                if (currentStatus == "completed" && newStatus != "completed")
                {
                    throw new InvalidOperationException(
                        $"Task \"{taskId}\" is already completed and cannot be reverted.");
                }
                task["status"] = newStatus;
                patch["status"] = newStatus;
            }

            var nextTitle = ResolveTaskTitle(input, GetString(task, "subject") ?? string.Empty);
            if (!string.IsNullOrWhiteSpace(nextTitle) &&
                nextTitle != GetString(task, "subject"))
            {
                task["subject"] = nextTitle;
                patch["subject"] = nextTitle;
            }

            if (input.TryGetProperty("activeForm", out var activeForm))
            {
                var value = activeForm.ValueKind == JsonValueKind.Null ? null : activeForm.ToString();
                task["activeForm"] = value;
                patch["activeForm"] = value;
            }
            if (input.TryGetProperty("owner", out var owner))
            {
                var value = owner.ValueKind == JsonValueKind.Null ? null : owner.ToString();
                task["owner"] = value;
                patch["owner"] = value;
            }
            if (input.TryGetProperty("report", out var report) &&
                patch.TryGetPropertyValue("status", out var statusNode) &&
                statusNode?.GetValue<string>() == "completed")
            {
                var value = report.ToString();
                task["report"] = value;
                patch["report"] = value;
            }
        });

        updatedPatch = patch;
        return ReadSnapshot(teamName, 10);
    }

    public static void DeleteTeam(string teamName)
    {
        var runtimePath = GetTeamRuntimePath(teamName);
        if (Directory.Exists(runtimePath))
        {
            Directory.Delete(runtimePath, recursive: true);
        }
    }

    public static void AppendMessageRecord(string teamName, JsonElement message)
    {
        if (ReadManifest(teamName) is null)
        {
            throw new InvalidOperationException($"Team \"{teamName}\" does not exist");
        }

        var messageNode = CloneElementAsNode(message) as JsonObject ??
            throw new InvalidOperationException("Invalid team runtime message");
        var messagesFilePath = GetMessagesFilePath(teamName);
        using (AcquireFileLock(messagesFilePath))
        {
            EnsureMessagesLog(teamName);
            AppendJsonLine(messagesFilePath, messageNode);
        }

        TouchManifest(teamName);
    }

    public static void PatchManifest(string teamName, JsonElement patch)
    {
        if (patch.ValueKind != JsonValueKind.Object)
        {
            throw new InvalidOperationException("Invalid team manifest patch");
        }

        UpdateManifest(teamName, manifest =>
        {
            foreach (var property in patch.EnumerateObject())
            {
                manifest[property.Name] = CloneElementAsNode(property.Value);
            }
        });
    }

    public static void PatchMember(string teamName, string memberId, JsonElement patch)
    {
        if (patch.ValueKind != JsonValueKind.Object)
        {
            throw new InvalidOperationException("Invalid team member patch");
        }

        UpdateManifest(teamName, manifest =>
        {
            var member = FindMember(manifest, memberId);
            if (member is null)
            {
                member = new JsonObject
                {
                    ["agentId"] = memberId,
                    ["name"] = memberId,
                    ["role"] = "worker",
                    ["backendType"] = "in-process",
                    ["status"] = "idle",
                    ["currentTaskId"] = null,
                    ["isActive"] = true,
                    ["startedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                    ["completedAt"] = null
                };
                EnsureArray(manifest, "members").Add((JsonNode?)member);
            }

            foreach (var property in patch.EnumerateObject())
            {
                member[property.Name] = CloneElementAsNode(property.Value);
            }
        });
    }

    public static JsonArray ConsumeMessages(
        string teamName,
        long afterTimestamp,
        string? recipient,
        bool includeBroadcast,
        int limit)
    {
        if (ReadManifest(teamName) is null)
        {
            return new JsonArray();
        }

        var normalizedLimit = Math.Max(1, Math.Min(limit, 50));
        var normalizedRecipient = recipient?.Trim();
        var matches = new List<JsonNode?>();
        foreach (var message in EnumerateMessages(teamName))
        {
            if (GetLong(message, "timestamp") <= afterTimestamp)
            {
                continue;
            }

            if (!string.IsNullOrWhiteSpace(normalizedRecipient))
            {
                var to = GetString(message, "to");
                if (!string.Equals(to, normalizedRecipient, StringComparison.Ordinal) &&
                    !(includeBroadcast && string.Equals(to, "all", StringComparison.Ordinal)))
                {
                    continue;
                }
            }

            matches.Add(message.DeepClone());
        }

        var start = Math.Max(0, matches.Count - normalizedLimit);
        var result = new JsonArray();
        for (var index = start; index < matches.Count; index++)
        {
            result.Add(matches[index]);
        }
        return result;
    }

    public static string GetString(JsonObject obj, string propertyName)
    {
        return obj.TryGetPropertyValue(propertyName, out var node) &&
            node is JsonValue value &&
            value.TryGetValue<string>(out var text)
                ? text
                : string.Empty;
    }

    public static JsonArray EnsureArray(JsonObject obj, string propertyName)
    {
        if (obj[propertyName] is JsonArray array)
        {
            return array;
        }
        array = new JsonArray();
        obj[propertyName] = array;
        return array;
    }

    public static void WriteSnapshot(Utf8JsonWriter writer, TeamSnapshot snapshot)
    {
        writer.WriteStartObject();
        writer.WritePropertyName("team");
        snapshot.Manifest.WriteTo(writer);
        writer.WritePropertyName("recentMessages");
        snapshot.RecentMessages.WriteTo(writer);
        writer.WriteEndObject();
    }

    private static JsonArray ReadRecentMessages(string teamName, int limit)
    {
        var normalizedLimit = Math.Max(1, Math.Min(limit, 50));
        var messages = ReadLastMessages(teamName, normalizedLimit);
        var result = new JsonArray();
        foreach (var message in messages)
        {
            result.Add((JsonNode?)message.DeepClone());
        }
        return result;
    }

    private static IEnumerable<JsonObject> EnumerateMessages(string teamName)
    {
        var filePath = GetMessagesFilePath(teamName);
        if (File.Exists(filePath))
        {
            foreach (var line in File.ReadLines(filePath, Encoding.UTF8))
            {
                if (string.IsNullOrWhiteSpace(line))
                {
                    continue;
                }
                JsonObject? message = null;
                try
                {
                    message = JsonNode.Parse(line) as JsonObject;
                }
                catch
                {
                    // Ignore a partial/corrupt line and continue with later messages.
                }
                if (message is not null)
                {
                    yield return message;
                }
            }
            yield break;
        }

        var legacyPath = GetLegacyMessagesFilePath(teamName);
        if (!File.Exists(legacyPath))
        {
            yield break;
        }

        JsonArray? legacy = null;
        try
        {
            legacy = JsonNode.Parse(File.ReadAllText(legacyPath, Encoding.UTF8)) as JsonArray;
        }
        catch
        {
            yield break;
        }
        foreach (var item in legacy ?? [])
        {
            if (item is JsonObject message)
            {
                yield return message;
            }
        }
    }

    private static List<JsonObject> ReadLastMessages(string teamName, int limit)
    {
        var filePath = GetMessagesFilePath(teamName);
        if (!File.Exists(filePath))
        {
            return EnumerateMessages(teamName).TakeLast(limit).ToList();
        }

        var lines = ReadLastNonEmptyLines(filePath, limit);
        var result = new List<JsonObject>(lines.Count);
        foreach (var line in lines)
        {
            try
            {
                if (JsonNode.Parse(line) is JsonObject message)
                {
                    result.Add(message);
                }
            }
            catch
            {
                // Ignore a corrupt tail line; older valid lines remain usable.
            }
        }
        return result;
    }

    private static List<string> ReadLastNonEmptyLines(string filePath, int limit)
    {
        var lines = new List<string>(limit);
        using var stream = new FileStream(filePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        var reverseLine = new List<byte>();
        var buffer = new byte[4096];
        var position = stream.Length;
        while (position > 0 && lines.Count < limit)
        {
            var readLength = (int)Math.Min(buffer.Length, position);
            position -= readLength;
            stream.Position = position;
            stream.ReadExactly(buffer.AsSpan(0, readLength));
            for (var index = readLength - 1; index >= 0; index--)
            {
                var current = buffer[index];
                if (current == (byte)'\n')
                {
                    AddReversedLine(lines, reverseLine);
                    if (lines.Count >= limit)
                    {
                        break;
                    }
                }
                else if (current != (byte)'\r')
                {
                    reverseLine.Add(current);
                }
            }
        }
        if (lines.Count < limit)
        {
            AddReversedLine(lines, reverseLine);
        }
        lines.Reverse();
        return lines;
    }

    private static void AddReversedLine(List<string> lines, List<byte> reverseLine)
    {
        if (reverseLine.Count == 0)
        {
            return;
        }
        reverseLine.Reverse();
        lines.Add(Encoding.UTF8.GetString(CollectionsMarshal.AsSpan(reverseLine)));
        reverseLine.Clear();
    }

    private static JsonObject? ReadManifest(string teamName)
    {
        var filePath = GetTeamFilePath(teamName);
        if (!File.Exists(filePath))
        {
            return null;
        }
        try
        {
            return JsonNode.Parse(File.ReadAllText(filePath, Encoding.UTF8)) as JsonObject;
        }
        catch
        {
            return null;
        }
    }

    private static JsonObject UpdateManifest(string teamName, Action<JsonObject> update)
    {
        var filePath = GetTeamFilePath(teamName);
        using var fileLock = AcquireFileLock(filePath);
        var manifest = ReadManifest(teamName) ??
            throw new InvalidOperationException($"Team \"{teamName}\" does not exist");
        update(manifest);
        manifest["updatedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        WriteJsonNode(filePath, manifest);
        return (JsonObject)manifest.DeepClone();
    }

    private static JsonObject TouchManifest(string teamName)
    {
        return UpdateManifest(teamName, _ => { });
    }

    private static JsonNode? CloneElementAsNode(JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.Undefined)
        {
            return null;
        }
        return JsonNode.Parse(element.GetRawText());
    }

    private static JsonObject? FindTask(JsonObject manifest, string taskId)
    {
        var tasks = EnsureArray(manifest, "tasks");
        foreach (var item in tasks)
        {
            if (item is JsonObject task &&
                string.Equals(GetString(task, "id"), taskId, StringComparison.Ordinal))
            {
                return task;
            }
        }
        return null;
    }

    private static JsonObject? FindMember(JsonObject manifest, string memberId)
    {
        var members = EnsureArray(manifest, "members");
        foreach (var item in members)
        {
            if (item is JsonObject member &&
                string.Equals(GetString(member, "agentId"), memberId, StringComparison.Ordinal))
            {
                return member;
            }
        }
        return null;
    }

    private static string? FindTeamBySession(string sessionId)
    {
        foreach (var manifest in EnumerateManifests())
        {
            if (string.Equals(GetString(manifest, "leadSessionId"), sessionId, StringComparison.Ordinal))
            {
                return GetString(manifest, "name");
            }
        }
        return null;
    }

    private static string? FindLatestTeam()
    {
        var latestName = default(string);
        var latestUpdatedAt = long.MinValue;
        foreach (var manifest in EnumerateManifests())
        {
            var name = GetString(manifest, "name");
            var updatedAt = GetLong(manifest, "updatedAt");
            if (name.Length > 0 && updatedAt > latestUpdatedAt)
            {
                latestName = name;
                latestUpdatedAt = updatedAt;
            }
        }
        return latestName;
    }

    private static IEnumerable<JsonObject> EnumerateManifests()
    {
        var teamsDir = GetTeamsDir();
        if (!Directory.Exists(teamsDir))
        {
            yield break;
        }

        foreach (var directory in Directory.EnumerateDirectories(teamsDir))
        {
            var manifest = ReadManifest(Path.GetFileName(directory));
            if (manifest is not null)
            {
                yield return manifest;
            }
        }
    }

    private static long GetLong(JsonObject obj, string propertyName)
    {
        return obj.TryGetPropertyValue(propertyName, out var node) &&
            node is JsonValue value &&
            value.TryGetValue<long>(out var number)
                ? number
                : 0;
    }

    private static string ResolveTaskTitle(JsonElement input, string fallbackTitle = "")
    {
        var title = NormalizeTaskTitlePart(JsonHelpers.GetString(input, "title") ??
            JsonHelpers.GetString(input, "subject"));
        var description = NormalizeTaskTitlePart(JsonHelpers.GetString(input, "description"));
        if (title.Length > 0)
        {
            return MergeTaskTitle(title, description);
        }
        if (description.Length > 0)
        {
            return description;
        }
        return NormalizeTaskTitlePart(fallbackTitle);
    }

    private static string NormalizeTaskTitlePart(string? value)
    {
        return string.IsNullOrWhiteSpace(value)
            ? string.Empty
            : WhitespaceRegex().Replace(value, " ").Trim();
    }

    private static string MergeTaskTitle(string title, string description)
    {
        if (title.Length == 0) return description;
        if (description.Length == 0) return title;
        if (title == description) return title;
        if (title.Contains(description, StringComparison.Ordinal)) return title;
        if (description.Contains(title, StringComparison.Ordinal)) return description;
        return ":;\uFF1A\uFF1B,.\uFF0C\u3002!?\uFF01\uFF1F".Contains(title[^1], StringComparison.Ordinal)
            ? $"{title} {description}"
            : $"{title}: {description}";
    }

    private static string SanitizeTeamName(string rawName)
    {
        var trimmed = rawName.Trim();
        trimmed = InvalidTeamNameCharsRegex().Replace(trimmed, "-");
        trimmed = WhitespaceRegex().Replace(trimmed, "-");
        trimmed = RepeatedDashRegex().Replace(trimmed, "-");
        return trimmed.Trim('-');
    }

    private static string NormalizeBackend(string? value)
    {
        _ = value;
        return "in-process";
    }

    private static string NormalizeMessageType(string value)
    {
        return value switch
        {
            "message" or "broadcast" or "shutdown_request" or "shutdown_response" or
            "idle_notification" or "permission_request" or "permission_response" or
            "plan_approval_request" or "plan_approval_response" or "team_permission_update" or
            "mode_set_request" => value,
            _ => throw new InvalidOperationException($"Invalid message type: {value}")
        };
    }

    private static string? ParsePermissionMode(string content)
    {
        var trimmed = content.Trim();
        if (trimmed == "default" || trimmed == "plan")
        {
            return trimmed;
        }
        try
        {
            using var document = JsonDocument.Parse(trimmed);
            var mode = JsonHelpers.GetString(document.RootElement, "permissionMode");
            return mode is "default" or "plan" ? mode : null;
        }
        catch
        {
            return null;
        }
    }

    private static string[]? ParseAllowedPaths(string content)
    {
        try
        {
            using var document = JsonDocument.Parse(content);
            if (!document.RootElement.TryGetProperty("teamAllowedPaths", out var paths) ||
                paths.ValueKind != JsonValueKind.Array)
            {
                return null;
            }
            return paths.EnumerateArray()
                .Select(item => item.ValueKind == JsonValueKind.String ? item.GetString() : null)
                .Where(item => !string.IsNullOrWhiteSpace(item))
                .Select(item => item!)
                .ToArray();
        }
        catch
        {
            return null;
        }
    }

    private static JsonArray ToJsonArray(IEnumerable<string> values)
    {
        var array = new JsonArray();
        foreach (var value in values)
        {
            array.Add((JsonNode?)JsonValue.Create(value));
        }
        return array;
    }

    private static string[] GetStringArray(JsonElement input, string propertyName)
    {
        if (!input.TryGetProperty(propertyName, out var value) ||
            value.ValueKind != JsonValueKind.Array)
        {
            return [];
        }
        return value.EnumerateArray()
            .Select(item => item.ValueKind == JsonValueKind.String ? item.GetString() : item.ToString())
            .Where(item => !string.IsNullOrWhiteSpace(item))
            .Select(item => item!)
            .ToArray();
    }

    public static string[] GetTaskDependencies(JsonElement input)
    {
        var dependsOn = GetStringArray(input, "depends_on");
        return dependsOn.Length > 0 ? dependsOn : GetStringArray(input, "dependsOn");
    }

    private static string CreateId(int length)
    {
        Span<byte> bytes = stackalloc byte[length];
        RandomNumberGenerator.Fill(bytes);
        var chars = new char[length];
        for (var index = 0; index < length; index++)
        {
            chars[index] = IdAlphabet[bytes[index] % IdAlphabet.Length];
        }
        return new string(chars);
    }

    private static string GetTeamsDir()
    {
        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            ".open-cowork",
            "teams");
    }

    private static string GetTeamRuntimePath(string teamName)
    {
        return Path.Combine(GetTeamsDir(), SanitizeTeamName(teamName));
    }

    private static string GetTeamFilePath(string teamName)
    {
        return Path.Combine(GetTeamRuntimePath(teamName), TeamFileName);
    }

    private static string GetMessagesFilePath(string teamName)
    {
        return Path.Combine(GetTeamRuntimePath(teamName), MessagesFileName);
    }

    private static string GetLegacyMessagesFilePath(string teamName)
    {
        return Path.Combine(GetTeamRuntimePath(teamName), LegacyMessagesFileName);
    }

    private static void EnsureMessagesLog(string teamName)
    {
        var filePath = GetMessagesFilePath(teamName);
        if (File.Exists(filePath))
        {
            return;
        }

        Directory.CreateDirectory(Path.GetDirectoryName(filePath)!);
        var tempPath = $"{filePath}.{Guid.NewGuid():N}.tmp";
        using (var writer = new StreamWriter(
            tempPath,
            append: false,
            new UTF8Encoding(encoderShouldEmitUTF8Identifier: false)))
        {
            foreach (var message in EnumerateMessages(teamName))
            {
                writer.WriteLine(message.ToJsonString());
            }
        }
        File.Move(tempPath, filePath, true);
    }

    private static void AppendJsonLine(string filePath, JsonObject message)
    {
        using var stream = new FileStream(filePath, FileMode.Append, FileAccess.Write, FileShare.Read);
        using var writer = new StreamWriter(
            stream,
            new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        writer.WriteLine(message.ToJsonString());
    }

    private static void WriteJsonNode(string filePath, JsonNode node)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(filePath)!);
        File.WriteAllText(filePath, node.ToJsonString(IndentedJsonOptions) + "\n", Encoding.UTF8);
    }

    private static IDisposable AcquireFileLock(string filePath)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(filePath)!);
        var lockPath = $"{filePath}.lock";
        for (var attempt = 0; attempt <= LockRetryDelaysMs.Length; attempt++)
        {
            try
            {
                return new FileLock(File.Open(lockPath, FileMode.CreateNew, FileAccess.Write, FileShare.None), lockPath);
            }
            catch (IOException) when (attempt < LockRetryDelaysMs.Length)
            {
                Thread.Sleep(LockRetryDelaysMs[attempt]);
            }
        }
        throw new IOException($"Timed out acquiring lock for {Path.GetFileName(lockPath)}");
    }

    [GeneratedRegex("[<>:\"/\\\\|?*]+")]
    private static partial Regex InvalidTeamNameCharsRegex();

    [GeneratedRegex("\\s+")]
    private static partial Regex WhitespaceRegex();

    [GeneratedRegex("-+")]
    private static partial Regex RepeatedDashRegex();

    private sealed class FileLock(FileStream stream, string lockPath) : IDisposable
    {
        public void Dispose()
        {
            stream.Dispose();
            try
            {
                File.Delete(lockPath);
            }
            catch
            {
                // best effort cleanup
            }
        }
    }
}

internal sealed record TeamSnapshot(string TeamName, JsonObject Manifest, JsonArray RecentMessages);
