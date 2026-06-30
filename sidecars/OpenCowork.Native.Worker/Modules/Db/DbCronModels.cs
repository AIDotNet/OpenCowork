using System.Text.Json.Serialization;

internal sealed class CronJobRow
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;

    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;

    [JsonPropertyName("schedule_kind")]
    public string ScheduleKind { get; set; } = "at";

    [JsonPropertyName("schedule_at")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public long? ScheduleAt { get; set; }

    [JsonPropertyName("schedule_every")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public long? ScheduleEvery { get; set; }

    [JsonPropertyName("schedule_expr")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? ScheduleExpr { get; set; }

    [JsonPropertyName("schedule_tz")]
    public string ScheduleTz { get; set; } = "UTC";

    [JsonPropertyName("prompt")]
    public string Prompt { get; set; } = string.Empty;

    [JsonPropertyName("agent_id")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? AgentId { get; set; }

    [JsonPropertyName("model")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? Model { get; set; }

    [JsonPropertyName("working_folder")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? WorkingFolder { get; set; }

    [JsonPropertyName("ssh_connection_id")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? SshConnectionId { get; set; }

    [JsonPropertyName("session_id")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? SessionId { get; set; }

    [JsonPropertyName("source_session_title")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? SourceSessionTitle { get; set; }

    [JsonPropertyName("source_project_id")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? SourceProjectId { get; set; }

    [JsonPropertyName("source_project_name")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? SourceProjectName { get; set; }

    [JsonPropertyName("source_provider_id")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? SourceProviderId { get; set; }

    [JsonPropertyName("delivery_mode")]
    public string DeliveryMode { get; set; } = "desktop";

    [JsonPropertyName("delivery_target")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? DeliveryTarget { get; set; }

    [JsonPropertyName("plugin_id")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? PluginId { get; set; }

    [JsonPropertyName("plugin_chat_id")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? PluginChatId { get; set; }

    [JsonPropertyName("enabled")]
    public int Enabled { get; set; } = 1;

    [JsonPropertyName("delete_after_run")]
    public int DeleteAfterRun { get; set; }

    [JsonPropertyName("max_iterations")]
    public int MaxIterations { get; set; } = 15;

    [JsonPropertyName("deleted_at")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public long? DeletedAt { get; set; }

    [JsonPropertyName("last_fired_at")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public long? LastFiredAt { get; set; }

    [JsonPropertyName("fire_count")]
    public int FireCount { get; set; }

    [JsonPropertyName("created_at")]
    public long CreatedAt { get; set; }

    [JsonPropertyName("updated_at")]
    public long UpdatedAt { get; set; }
}

internal sealed class CronRunRow
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;

    [JsonPropertyName("job_id")]
    public string JobId { get; set; } = string.Empty;

    [JsonPropertyName("started_at")]
    public long StartedAt { get; set; }

    [JsonPropertyName("finished_at")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public long? FinishedAt { get; set; }

    [JsonPropertyName("status")]
    public string Status { get; set; } = "running";

    [JsonPropertyName("tool_call_count")]
    public int ToolCallCount { get; set; }

    [JsonPropertyName("output_summary")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? OutputSummary { get; set; }

    [JsonPropertyName("error")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? Error { get; set; }

    [JsonPropertyName("scheduled_for")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public long? ScheduledFor { get; set; }

    [JsonPropertyName("job_name_snapshot")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? JobNameSnapshot { get; set; }

    [JsonPropertyName("prompt_snapshot")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? PromptSnapshot { get; set; }

    [JsonPropertyName("source_session_id_snapshot")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? SourceSessionIdSnapshot { get; set; }

    [JsonPropertyName("source_session_title_snapshot")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? SourceSessionTitleSnapshot { get; set; }

    [JsonPropertyName("source_project_id_snapshot")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? SourceProjectIdSnapshot { get; set; }

    [JsonPropertyName("source_project_name_snapshot")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? SourceProjectNameSnapshot { get; set; }

    [JsonPropertyName("source_provider_id_snapshot")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? SourceProviderIdSnapshot { get; set; }

    [JsonPropertyName("model_snapshot")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? ModelSnapshot { get; set; }

    [JsonPropertyName("working_folder_snapshot")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? WorkingFolderSnapshot { get; set; }

    [JsonPropertyName("delivery_mode_snapshot")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? DeliveryModeSnapshot { get; set; }

    [JsonPropertyName("delivery_target_snapshot")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? DeliveryTargetSnapshot { get; set; }
}

internal sealed class CronRunMessageRow
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;

    [JsonPropertyName("role")]
    public string Role { get; set; } = string.Empty;

    [JsonPropertyName("content")]
    public string Content { get; set; } = "null";

    [JsonPropertyName("usage")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? Usage { get; set; }

    [JsonPropertyName("message_source")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? MessageSource { get; set; }

    [JsonPropertyName("created_at")]
    public long CreatedAt { get; set; }
}

internal sealed class CronRunLogRow
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;

    [JsonPropertyName("timestamp")]
    public long Timestamp { get; set; }

    [JsonPropertyName("type")]
    public string Type { get; set; } = "text";

    [JsonPropertyName("content")]
    public string Content { get; set; } = string.Empty;
}

internal sealed record CronMutationResult(
    bool Success,
    int Changed,
    string? Error);

internal sealed record CronJobFindResult(
    bool Success,
    CronJobRow? Job,
    string? Error);

internal sealed record CronJobListResult(
    bool Success,
    List<CronJobRow> Jobs,
    string? Error);

internal sealed record CronRunFindResult(
    bool Success,
    CronRunRow? Run,
    string? Error);

internal sealed record CronRunListResult(
    bool Success,
    List<CronRunRow> Runs,
    string? Error);

internal sealed record CronRunDetailResult(
    bool Success,
    CronRunRow? Run,
    CronJobRow? Job,
    List<CronRunMessageRow> Messages,
    List<CronRunLogRow> Logs,
    string? Error);

internal sealed record CronStartupLoadResult(
    bool Success,
    List<CronJobRow> Jobs,
    int AbortedRuns,
    int ExpiredJobs,
    string? Error);
