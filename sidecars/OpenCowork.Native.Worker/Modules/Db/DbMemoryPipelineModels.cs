using System.Text.Json.Serialization;

internal sealed class MemoryRootDescriptor
{
    public string Id { get; set; } = string.Empty;

    public string Scope { get; set; } = "global";

    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? ProjectId { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? WorkingFolder { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? SshConnectionId { get; set; }

    public string RootPath { get; set; } = string.Empty;

    public string Transport { get; set; } = "local";

    public string OwnerKey { get; set; } = string.Empty;

    public long CreatedAt { get; set; }

    public long UpdatedAt { get; set; }
}

internal sealed class MemoryPipelineJob
{
    public string Id { get; set; } = string.Empty;

    public string Kind { get; set; } = "stage1";

    public string Status { get; set; } = "running";

    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? MemoryRootId { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? SourceSessionId { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? LeaseOwner { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public long? LeaseExpiresAt { get; set; }

    public int Attempts { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? Error { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public long? StartedAt { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public long? FinishedAt { get; set; }

    public long CreatedAt { get; set; }

    public long UpdatedAt { get; set; }
}

internal sealed class MemoryStage1Output
{
    public string Id { get; set; } = string.Empty;

    public string MemoryRootId { get; set; } = string.Empty;

    public string Scope { get; set; } = "global";

    public string SourceSessionId { get; set; } = string.Empty;

    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public long? SourceUpdatedAt { get; set; }

    public string RawMemory { get; set; } = string.Empty;

    public string RolloutSummary { get; set; } = string.Empty;

    public string RolloutSlug { get; set; } = string.Empty;

    public string Fingerprint { get; set; } = string.Empty;

    public string Status { get; set; } = "active";

    public int UsageCount { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public long? LastUsageAt { get; set; }

    public long CreatedAt { get; set; }

    public long UpdatedAt { get; set; }
}

internal sealed record MemoryRootFindResult(
    bool Success,
    MemoryRootDescriptor? Root,
    string? Error);

internal sealed record MemoryJobFindResult(
    bool Success,
    MemoryPipelineJob? Job,
    string? Error);

internal sealed record MemoryClearRootResult(
    bool Success,
    int DeletedStage1Outputs,
    int DeletedJobs,
    string? Error);

internal sealed record MemoryMutationResult(
    bool Success,
    int Changed,
    string? Error);
