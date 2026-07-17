using System.Text.Json.Serialization;

internal sealed record SessionResetResult(
    bool Success,
    int DeletedMessages,
    long UpdatedAt,
    string? Error);

internal sealed record SessionStatusResult(
    bool Success,
    bool Found,
    string? Title,
    long? CreatedAt,
    long? UpdatedAt,
    int MessageCount,
    string? Error);

internal sealed class SessionRow
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;

    [JsonPropertyName("title")]
    public string Title { get; set; } = string.Empty;

    [JsonPropertyName("icon")]
    public string? Icon { get; set; }

    [JsonPropertyName("mode")]
    public string Mode { get; set; } = "chat";

    [JsonPropertyName("created_at")]
    public long CreatedAt { get; set; }

    [JsonPropertyName("updated_at")]
    public long UpdatedAt { get; set; }

    [JsonPropertyName("project_id")]
    public string? ProjectId { get; set; }

    [JsonPropertyName("working_folder")]
    public string? WorkingFolder { get; set; }

    [JsonPropertyName("ssh_connection_id")]
    public string? SshConnectionId { get; set; }

    [JsonPropertyName("plan_id")]
    public string? PlanId { get; set; }

    [JsonPropertyName("pinned")]
    public int Pinned { get; set; }

    [JsonPropertyName("plugin_id")]
    public string? PluginId { get; set; }

    [JsonPropertyName("external_chat_id")]
    public string? ExternalChatId { get; set; }

    [JsonPropertyName("provider_id")]
    public string? ProviderId { get; set; }

    [JsonPropertyName("model_id")]
    public string? ModelId { get; set; }

    [JsonPropertyName("model_selection_mode")]
    public string? ModelSelectionMode { get; set; }

    [JsonPropertyName("message_count")]
    public int MessageCount { get; set; }
}

internal sealed record SessionFindResult(
    bool Success,
    SessionRow? Session,
    string? Error);

internal sealed record SessionMutationResult(
    bool Success,
    int Changed,
    string? Error);

internal sealed record SessionClearAllResult(
    bool Success,
    List<string> SessionIds,
    int DeletedMessages,
    int DeletedSessions,
    string? Error);

internal sealed record SessionClearProjectInput(
    string ProjectId,
    List<string>? ExcludeSessionIds);
