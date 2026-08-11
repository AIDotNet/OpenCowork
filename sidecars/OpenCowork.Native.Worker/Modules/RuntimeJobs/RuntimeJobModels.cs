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
    RuntimeJobRecord Job);

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
