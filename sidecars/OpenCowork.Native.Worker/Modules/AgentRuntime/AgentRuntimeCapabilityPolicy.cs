using System.Text.Json;

internal sealed record AgentRuntimeToolAuthorization(
    bool Authorized,
    bool Visible,
    JsonElement? InputSchema,
    string? ToolId,
    string? DefinitionHash,
    string? ErrorCode,
    string? ErrorMessage)
{
    public static AgentRuntimeToolAuthorization Deny(string code, string message)
    {
        return new AgentRuntimeToolAuthorization(false, false, null, null, null, code, message);
    }
}

internal static class AgentRuntimeCapabilityPolicy
{
    public static string? ValidateRunRequest(JsonElement parameters)
    {
        if (JsonHelpers.GetInt(parameters, "runtimeProtocolVersion", 1) < 2)
        {
            return null;
        }

        if (!parameters.TryGetProperty("capabilitySnapshot", out var snapshot) ||
            snapshot.ValueKind != JsonValueKind.Object)
        {
            return "manifest_mismatch: Runtime v2 requires a capabilitySnapshot.";
        }

        if (JsonHelpers.GetInt(snapshot, "schemaVersion", 0) != 2 ||
            JsonHelpers.GetInt(snapshot, "manifestSchemaVersion", 0) != 2)
        {
            return "manifest_mismatch: Unsupported Capability Snapshot or Tool Manifest schema.";
        }

        var requestSessionId = JsonHelpers.GetString(parameters, "sessionId")?.Trim() ?? string.Empty;
        var snapshotSessionId = JsonHelpers.GetString(snapshot, "sessionId")?.Trim() ?? string.Empty;
        if (!string.Equals(requestSessionId, snapshotSessionId, StringComparison.Ordinal))
        {
            return "capability_context_mismatch: Snapshot sessionId does not match the run.";
        }

        var requestProjectId = JsonHelpers.GetString(parameters, "projectId")?.Trim() ?? string.Empty;
        var snapshotProjectId = JsonHelpers.GetString(snapshot, "projectId")?.Trim() ?? string.Empty;
        if (!string.Equals(requestProjectId, snapshotProjectId, StringComparison.Ordinal))
        {
            return "capability_context_mismatch: Snapshot projectId does not match the run.";
        }

        if (!snapshot.TryGetProperty("authorizedTools", out var tools) ||
            tools.ValueKind != JsonValueKind.Array ||
            !snapshot.TryGetProperty("providerVisibleTools", out var visible) ||
            visible.ValueKind != JsonValueKind.Array)
        {
            return "manifest_mismatch: Snapshot Tool membership is missing.";
        }

        var wireNames = new HashSet<string>(StringComparer.Ordinal);
        var toolIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (var tool in tools.EnumerateArray())
        {
            if (tool.ValueKind != JsonValueKind.Object)
            {
                return "manifest_mismatch: Snapshot contains a non-object Tool manifest.";
            }
            var wireName = JsonHelpers.GetString(tool, "wireName")?.Trim();
            var toolId = JsonHelpers.GetString(tool, "toolId")?.Trim();
            if (string.IsNullOrEmpty(wireName) || string.IsNullOrEmpty(toolId) ||
                !wireNames.Add(wireName) || !toolIds.Add(toolId))
            {
                return "manifest_mismatch: Snapshot contains a missing or duplicate Tool identity.";
            }
            string? schemaError = null;
            if (!tool.TryGetProperty("inputSchema", out var schema) ||
                !AgentRuntimeToolSchemaValidator.ValidateSchema(schema, out schemaError))
            {
                return $"tool_schema_invalid: {wireName}: {schemaError}";
            }
        }

        foreach (var item in visible.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.String ||
                item.GetString() is not { Length: > 0 } identity ||
                (!toolIds.Contains(identity) && !wireNames.Contains(identity)))
            {
                return "manifest_mismatch: providerVisibleTools is not a subset of authorizedTools.";
            }
        }

        return null;
    }

    public static AgentRuntimeToolAuthorization Resolve(JsonElement parameters, string toolName)
    {
        if (string.IsNullOrWhiteSpace(toolName))
        {
            return AgentRuntimeToolAuthorization.Deny(
                "tool_not_authorized",
                "Tool call has no valid name.");
        }

        if (parameters.TryGetProperty("capabilitySnapshot", out var snapshot) &&
            snapshot.ValueKind == JsonValueKind.Object)
        {
            return ResolveV2(snapshot, toolName);
        }

        return ResolveLegacy(parameters, toolName);
    }

    private static AgentRuntimeToolAuthorization ResolveV2(JsonElement snapshot, string toolName)
    {
        if (!snapshot.TryGetProperty("authorizedTools", out var tools) ||
            tools.ValueKind != JsonValueKind.Array)
        {
            return AgentRuntimeToolAuthorization.Deny(
                "manifest_mismatch",
                "Capability Snapshot has no authorizedTools array.");
        }

        JsonElement? matched = null;
        foreach (var tool in tools.EnumerateArray())
        {
            if (tool.ValueKind != JsonValueKind.Object ||
                !string.Equals(
                    JsonHelpers.GetString(tool, "wireName"),
                    toolName,
                    StringComparison.Ordinal))
            {
                continue;
            }
            if (matched.HasValue)
            {
                return AgentRuntimeToolAuthorization.Deny(
                    "manifest_mismatch",
                    $"Capability Snapshot contains duplicate Tool name '{toolName}'.");
            }
            matched = tool;
        }

        if (!matched.HasValue)
        {
            return AgentRuntimeToolAuthorization.Deny(
                "tool_not_authorized",
                $"Tool '{toolName}' is not authorized by this run's Capability Snapshot.");
        }

        var manifest = matched.Value;
        var toolId = JsonHelpers.GetString(manifest, "toolId") ?? string.Empty;
        var visible = IsProviderVisible(snapshot, toolId, toolName);
        if (!visible)
        {
            return new AgentRuntimeToolAuthorization(
                true,
                false,
                null,
                toolId,
                JsonHelpers.GetString(manifest, "definitionHash"),
                "tool_not_loaded",
                $"Tool '{toolName}' is authorized but not loaded for this Provider turn.");
        }

        if (!manifest.TryGetProperty("inputSchema", out var schema))
        {
            return AgentRuntimeToolAuthorization.Deny(
                "tool_schema_invalid",
                $"Tool '{toolName}' has no input schema.");
        }
        if (!AgentRuntimeToolSchemaValidator.ValidateSchema(schema, out var schemaError))
        {
            return AgentRuntimeToolAuthorization.Deny(
                "tool_schema_invalid",
                $"Tool '{toolName}' schema is invalid: {schemaError}");
        }

        return new AgentRuntimeToolAuthorization(
            true,
            true,
            schema.Clone(),
            toolId,
            JsonHelpers.GetString(manifest, "definitionHash"),
            null,
            null);
    }

    private static AgentRuntimeToolAuthorization ResolveLegacy(JsonElement parameters, string toolName)
    {
        if (!parameters.TryGetProperty("tools", out var tools) || tools.ValueKind != JsonValueKind.Array)
        {
            return AgentRuntimeToolAuthorization.Deny(
                "tool_not_authorized",
                $"Tool '{toolName}' was not declared for this run.");
        }

        JsonElement? matched = null;
        foreach (var tool in tools.EnumerateArray())
        {
            if (tool.ValueKind != JsonValueKind.Object ||
                !string.Equals(JsonHelpers.GetString(tool, "name"), toolName, StringComparison.Ordinal))
            {
                continue;
            }
            if (matched.HasValue)
            {
                return AgentRuntimeToolAuthorization.Deny(
                    "manifest_mismatch",
                    $"Run contains duplicate Tool name '{toolName}'.");
            }
            matched = tool;
        }

        if (!matched.HasValue)
        {
            return AgentRuntimeToolAuthorization.Deny(
                "tool_not_authorized",
                $"Tool '{toolName}' was not declared for this run.");
        }

        var definition = matched.Value;
        string? schemaError = null;
        if (!definition.TryGetProperty("inputSchema", out var schema) ||
            !AgentRuntimeToolSchemaValidator.ValidateSchema(schema, out schemaError))
        {
            return AgentRuntimeToolAuthorization.Deny(
                "tool_schema_invalid",
                $"Tool '{toolName}' schema is invalid: {schemaError}");
        }

        return new AgentRuntimeToolAuthorization(
            true,
            true,
            schema.Clone(),
            $"legacy:{toolName}",
            null,
            null,
            null);
    }

    private static bool IsProviderVisible(JsonElement snapshot, string toolId, string wireName)
    {
        if (!snapshot.TryGetProperty("providerVisibleTools", out var visible) ||
            visible.ValueKind != JsonValueKind.Array)
        {
            return false;
        }

        foreach (var item in visible.EnumerateArray())
        {
            if (item.ValueKind == JsonValueKind.String &&
                (string.Equals(item.GetString(), toolId, StringComparison.Ordinal) ||
                 string.Equals(item.GetString(), wireName, StringComparison.Ordinal)))
            {
                return true;
            }
        }
        return false;
    }
}
