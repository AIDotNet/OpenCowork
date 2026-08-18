internal sealed record RuntimeJobRecord(
    string JobId,
    string HostId,
    string IdempotencyKey,
    string Method,
    string ParamsJson,
    string? SessionId,
    string? RunId,
    string LaneKey,
    string State,
    long CreatedAt,
    long UpdatedAt,
    long? StartedAt,
    long? FinishedAt,
    string? ResultJson,
    string? ErrorCode,
    string? ErrorMessage);

internal sealed record RuntimeJobSubmission(
    bool Accepted,
    bool Duplicate,
    RuntimeJobRecord Job,
    string? AssistantMessageId = null);

internal sealed class RuntimeJobRejectedException : InvalidOperationException
{
    public string ErrorCode { get; }

    public RuntimeJobRejectedException(string errorCode, string message)
        : base(message)
    {
        ErrorCode = errorCode;
    }
}

internal sealed record RuntimeJobCommand(
    long CommandId,
    long Seq,
    string Kind,
    string PayloadJson);

internal sealed record RuntimeEventBatch(
    string JobId,
    long Seq,
    byte[] Payload,
    bool Terminal);

/// <summary>
/// One journaled tool result. Doubles as the wire shape for `agent/tool-results-lookup`;
/// <see cref="ContentJson"/> stays a raw JSON string so the row can be stored and
/// replayed without reshaping the provider-facing tool_result content.
/// </summary>
internal sealed class RuntimeToolResultRecord
{
    public string SessionId { get; set; } = string.Empty;

    public string ToolUseId { get; set; } = string.Empty;

    public string RunId { get; set; } = string.Empty;

    public string ToolName { get; set; } = string.Empty;

    public string Status { get; set; } = string.Empty;

    public string ContentJson { get; set; } = string.Empty;

    public bool IsError { get; set; }

    public long? StartedAt { get; set; }

    public long CompletedAt { get; set; }
}
