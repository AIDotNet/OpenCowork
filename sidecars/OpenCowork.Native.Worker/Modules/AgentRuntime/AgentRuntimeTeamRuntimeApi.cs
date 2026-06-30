using System.Text.Json;
using System.Text.Json.Nodes;

internal static class AgentRuntimeTeamRuntimeApi
{
    public static WorkerResponse Create(JsonElement parameters)
    {
        var teamName = RequiredString(parameters, "teamName");
        var runtimePath = AgentRuntimeTeamRuntimeStore.CreateTeam(
            teamName,
            JsonHelpers.GetString(parameters, "description") ?? string.Empty,
            JsonHelpers.GetString(parameters, "sessionId"),
            JsonHelpers.GetString(parameters, "workingFolder"),
            JsonHelpers.GetString(parameters, "defaultBackend"),
            out var safeTeamName,
            out var manifest);

        WorkerLog.Debug($"team-runtime create team={safeTeamName} path={runtimePath}");
        return JsonNodeResult(new JsonObject
        {
            ["teamName"] = safeTeamName,
            ["runtimePath"] = runtimePath,
            ["leadAgentId"] = AgentRuntimeTeamRuntimeStore.GetString(manifest, "leadAgentId"),
            ["createdAt"] = GetLong(manifest, "createdAt"),
            ["defaultBackend"] = AgentRuntimeTeamRuntimeStore.GetString(manifest, "defaultBackend"),
            ["permissionMode"] = AgentRuntimeTeamRuntimeStore.GetString(manifest, "permissionMode"),
            ["teamAllowedPaths"] = manifest["teamAllowedPaths"]?.DeepClone()
        });
    }

    public static WorkerResponse Delete(JsonElement parameters)
    {
        var teamName = RequiredString(parameters, "teamName");
        AgentRuntimeTeamRuntimeStore.DeleteTeam(teamName);
        WorkerLog.Debug($"team-runtime delete team={teamName}");
        return Success();
    }

    public static WorkerResponse AppendMessage(JsonElement parameters)
    {
        var teamName = RequiredString(parameters, "teamName");
        if (!parameters.TryGetProperty("message", out var message))
        {
            throw new InvalidOperationException("Missing team runtime message");
        }

        AgentRuntimeTeamRuntimeStore.AppendMessageRecord(teamName, message);
        WorkerLog.Debug($"team-runtime message append team={teamName}");
        return Success();
    }

    public static WorkerResponse Snapshot(JsonElement parameters)
    {
        var teamName = RequiredString(parameters, "teamName");
        var limit = ClampLimit(JsonHelpers.GetInt(parameters, "limit", 10), 10);
        return SnapshotResult(AgentRuntimeTeamRuntimeStore.TryReadSnapshot(teamName, limit));
    }

    public static WorkerResponse UpdateMember(JsonElement parameters)
    {
        var teamName = RequiredString(parameters, "teamName");
        var memberId = RequiredString(parameters, "memberId");
        if (!parameters.TryGetProperty("patch", out var patch))
        {
            throw new InvalidOperationException("Missing team member patch");
        }

        AgentRuntimeTeamRuntimeStore.PatchMember(teamName, memberId, patch);
        WorkerLog.Debug($"team-runtime member update team={teamName} member={memberId}");
        return Success();
    }

    public static WorkerResponse UpdateManifest(JsonElement parameters)
    {
        var teamName = RequiredString(parameters, "teamName");
        if (!parameters.TryGetProperty("patch", out var patch))
        {
            throw new InvalidOperationException("Missing team manifest patch");
        }

        AgentRuntimeTeamRuntimeStore.PatchManifest(teamName, patch);
        WorkerLog.Debug($"team-runtime manifest update team={teamName}");
        return Success();
    }

    public static WorkerResponse ConsumeMessages(JsonElement parameters)
    {
        var teamName = RequiredString(parameters, "teamName");
        var messages = AgentRuntimeTeamRuntimeStore.ConsumeMessages(
            teamName,
            JsonHelpers.GetLong(parameters, "afterTimestamp", 0),
            JsonHelpers.GetString(parameters, "recipient"),
            JsonHelpers.GetBool(parameters, "includeBroadcast", true),
            ClampLimit(JsonHelpers.GetInt(parameters, "limit", 20), 20));
        WorkerLog.Debug($"team-runtime messages consume team={teamName} count={messages.Count}");
        return JsonNodeResult(messages);
    }

    private static WorkerResponse SnapshotResult(TeamSnapshot? snapshot)
    {
        if (snapshot is null)
        {
            return WorkerResponse.RawJson("null");
        }

        return JsonNodeResult(new JsonObject
        {
            ["team"] = snapshot.Manifest.DeepClone(),
            ["recentMessages"] = snapshot.RecentMessages.DeepClone()
        });
    }

    private static WorkerResponse JsonNodeResult(JsonNode node)
    {
        return WorkerResponse.RawJson(node.ToJsonString());
    }

    private static WorkerResponse Success()
    {
        return WorkerResponse.RawJson("{\"success\":true}");
    }

    private static string RequiredString(JsonElement parameters, string name)
    {
        var value = JsonHelpers.GetString(parameters, name);
        if (string.IsNullOrWhiteSpace(value))
        {
            throw new InvalidOperationException($"Missing {name}");
        }
        return value;
    }

    private static int ClampLimit(int value, int fallback)
    {
        var next = value <= 0 ? fallback : value;
        return Math.Max(1, Math.Min(next, 50));
    }

    private static long GetLong(JsonObject obj, string propertyName)
    {
        return obj.TryGetPropertyValue(propertyName, out var node) &&
            node is JsonValue value &&
            value.TryGetValue<long>(out var number)
                ? number
                : 0;
    }
}
