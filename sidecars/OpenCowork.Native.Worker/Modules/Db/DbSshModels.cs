using System.Text.Json.Serialization;

internal sealed class SshGroupRow
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;

    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;

    [JsonPropertyName("sort_order")]
    public int SortOrder { get; set; }

    [JsonPropertyName("created_at")]
    public long CreatedAt { get; set; }

    [JsonPropertyName("updated_at")]
    public long UpdatedAt { get; set; }
}

internal sealed class SshConnectionRow
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;

    [JsonPropertyName("group_id")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? GroupId { get; set; }

    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;

    [JsonPropertyName("host")]
    public string Host { get; set; } = string.Empty;

    [JsonPropertyName("port")]
    public int Port { get; set; }

    [JsonPropertyName("username")]
    public string Username { get; set; } = string.Empty;

    [JsonPropertyName("auth_type")]
    public string AuthType { get; set; } = "password";

    [JsonPropertyName("encrypted_password")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? EncryptedPassword { get; set; }

    [JsonPropertyName("private_key_path")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? PrivateKeyPath { get; set; }

    [JsonPropertyName("encrypted_passphrase")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? EncryptedPassphrase { get; set; }

    [JsonPropertyName("startup_command")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? StartupCommand { get; set; }

    [JsonPropertyName("default_directory")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? DefaultDirectory { get; set; }

    [JsonPropertyName("proxy_jump")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? ProxyJump { get; set; }

    [JsonPropertyName("keep_alive_interval")]
    public int KeepAliveInterval { get; set; }

    [JsonPropertyName("sort_order")]
    public int SortOrder { get; set; }

    [JsonPropertyName("last_connected_at")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public long? LastConnectedAt { get; set; }

    [JsonPropertyName("created_at")]
    public long CreatedAt { get; set; }

    [JsonPropertyName("updated_at")]
    public long UpdatedAt { get; set; }
}

internal sealed record SshConnectionFindResult(
    bool Success,
    SshConnectionRow? Connection,
    string? Error);

internal sealed record SshMutationResult(
    bool Success,
    int Changed,
    string? Error);
