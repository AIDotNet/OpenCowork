using System.Text.Json.Serialization;

internal sealed class ProjectRow
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;

    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;

    [JsonPropertyName("working_folder")]
    public string? WorkingFolder { get; set; }

    [JsonPropertyName("ssh_connection_id")]
    public string? SshConnectionId { get; set; }

    [JsonPropertyName("plugin_id")]
    public string? PluginId { get; set; }

    [JsonPropertyName("pinned")]
    public int Pinned { get; set; }

    [JsonPropertyName("created_at")]
    public long CreatedAt { get; set; }

    [JsonPropertyName("updated_at")]
    public long UpdatedAt { get; set; }

    [JsonPropertyName("session_count")]
    public int SessionCount { get; set; }
}

internal sealed record ProjectFindResult(
    bool Success,
    ProjectRow? Project,
    string? Error);

internal sealed record ProjectDeleteResult(
    bool Success,
    bool Deleted,
    string? ProjectId,
    List<string> SessionIds,
    string? Error);
