using System.Buffers;
using System.Diagnostics;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using Microsoft.Data.Sqlite;

internal static class AgentRuntimeMemoryExecutor
{
    private static readonly string[] MemoryReadFiles =
    [
        "memory_summary.md",
        "MEMORY.md",
        "USER.md",
        "raw_memories.md"
    ];

    private static readonly HashSet<string> MemoryToolNames = new(StringComparer.Ordinal)
    {
        "MemoryList", "MemoryRead", "MemorySearch"
    };

    private static readonly JsonWriterOptions WriterOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    public static bool IsMemoryTool(string toolName)
    {
        return MemoryToolNames.Contains(toolName);
    }

    public static bool CanExecute(JsonElement parameters)
    {
        return string.IsNullOrWhiteSpace(JsonHelpers.GetString(parameters, "pluginId"));
    }

    public static async Task<string> ExecuteAsync(
        NativeToolCallView call,
        JsonElement parameters,
        CancellationToken cancellationToken)
    {
        return call.Name switch
        {
            "MemoryList" => ExecuteList(call.Input, parameters),
            "MemoryRead" => await ExecuteReadAsync(call.Input, parameters, cancellationToken),
            "MemorySearch" => await ExecuteSearchAsync(call.Input, parameters, cancellationToken),
            _ => EncodeError($"Native memory tool not registered: {call.Name}")
        };
    }

    private static string ExecuteList(JsonElement input, JsonElement parameters)
    {
        var startedAt = Stopwatch.GetTimestamp();
        var scope = ReadScope(input);
        var roots = EnsureCurrentRoots(parameters, scope);
        WorkerLog.Debug(
            $"memory tool list scope={scope} roots={roots.Count} elapsedMs={ElapsedMs(startedAt)}");
        return EncodeJsonObject(writer =>
        {
            writer.WriteStartArray("roots");
            foreach (var root in roots)
            {
                WriteRootForTool(writer, root);
            }
            writer.WriteEndArray();
        });
    }

    private static async Task<string> ExecuteReadAsync(
        JsonElement input,
        JsonElement parameters,
        CancellationToken cancellationToken)
    {
        var startedAt = Stopwatch.GetTimestamp();
        var scope = ReadScope(input);
        var memoryRootId = JsonHelpers.GetString(input, "memoryRootId")?.Trim() ?? string.Empty;
        var file = ResolveMemoryFile(JsonHelpers.GetString(input, "file"));
        var roots = EnsureCurrentRoots(parameters, scope);
        var root = PickRoot(roots, memoryRootId, scope);
        if (root is null)
        {
            WorkerLog.Debug(
                $"memory tool read miss scope={scope} rootIdSet={memoryRootId.Length > 0} elapsedMs={ElapsedMs(startedAt)}");
            return EncodeError("No matching memory root found.");
        }

        var path = ResolveMemoryFilePath(root, file);
        string content;
        if (IsSshRoot(root))
        {
            if (!HasSshConnection(parameters))
            {
                WorkerLog.Debug(
                    $"memory tool read skipped ssh rootId={root.Id} scope={root.Scope} reason=missing-connection elapsedMs={ElapsedMs(startedAt)}");
                return EncodeError(
                    "SSH memory root requires the resolved native SSH connection payload.");
            }

            var sshRead = await ReadSshTextAsync(parameters, path);
            if (!sshRead.Success)
            {
                WorkerLog.Debug(
                    $"memory tool read failed ssh rootId={root.Id} path={path} elapsedMs={ElapsedMs(startedAt)} error={sshRead.Error}");
                return EncodeError($"Memory read failed: {sshRead.Error}");
            }
            content = sshRead.Content ?? string.Empty;
        }
        else
        {
            try
            {
                content = await File.ReadAllTextAsync(path, Encoding.UTF8, cancellationToken);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                WorkerLog.Debug(
                    $"memory tool read failed rootId={root.Id} path={path} elapsedMs={ElapsedMs(startedAt)} error={ex.GetType().Name}: {ex.Message}");
                return EncodeError($"Memory read failed: {ex.Message}");
            }
        }

        RecordUsage(parameters, root, path, null);
        var lines = content.Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n').Split('\n');
        WorkerLog.Debug(
            $"memory tool read ok rootId={root.Id} scope={root.Scope} lines={lines.Length} elapsedMs={ElapsedMs(startedAt)}");
        return EncodeJsonObject(writer =>
        {
            writer.WriteString("scope", root.Scope);
            writer.WriteString("memoryRootId", root.Id);
            WriteNullableString(writer, "projectId", root.ProjectId);
            writer.WriteString("path", path);
            writer.WriteStartArray("lines");
            for (var index = 0; index < lines.Length; index++)
            {
                writer.WriteStartObject();
                writer.WriteNumber("line", index + 1);
                writer.WriteString("text", lines[index]);
                writer.WriteEndObject();
            }
            writer.WriteEndArray();
        });
    }

    private static async Task<string> ExecuteSearchAsync(
        JsonElement input,
        JsonElement parameters,
        CancellationToken cancellationToken)
    {
        var startedAt = Stopwatch.GetTimestamp();
        var query = JsonHelpers.GetString(input, "query")?.Trim() ?? string.Empty;
        if (query.Length == 0)
        {
            return EncodeError("MemorySearch requires a query.");
        }

        var scope = ReadScope(input);
        var limit = Math.Clamp(JsonHelpers.GetInt(input, "limit", 20), 1, 100);
        var roots = EnsureCurrentRoots(parameters, scope);
        var matches = new List<MemorySearchMatch>();
        var skippedSshRoots = 0;

        foreach (var root in roots)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var isSshRoot = IsSshRoot(root);
            if (isSshRoot && !HasSshConnection(parameters))
            {
                skippedSshRoots++;
                WorkerLog.Debug(
                    $"memory search skipped ssh rootId={root.Id} reason=missing-connection");
                continue;
            }

            foreach (var file in MemoryReadFiles)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var path = ResolveMemoryFilePath(root, file);
                string content;
                if (isSshRoot)
                {
                    var sshRead = await ReadSshTextAsync(parameters, path);
                    if (!sshRead.Success)
                    {
                        WorkerLog.Debug($"memory search skipped ssh path={path} error={sshRead.Error}");
                        continue;
                    }
                    content = sshRead.Content ?? string.Empty;
                }
                else
                {
                    if (!File.Exists(path))
                    {
                        continue;
                    }

                    try
                    {
                        content = await File.ReadAllTextAsync(path, Encoding.UTF8, cancellationToken);
                    }
                    catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                    {
                        WorkerLog.Debug($"memory search skipped path={path} error={ex.GetType().Name}: {ex.Message}");
                        continue;
                    }
                }

                var lines = content.Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n').Split('\n');
                for (var index = 0; index < lines.Length; index++)
                {
                    if (!lines[index].Contains(query, StringComparison.OrdinalIgnoreCase))
                    {
                        continue;
                    }

                    var line = index + 1;
                    matches.Add(new MemorySearchMatch(root, path, line, lines[index]));
                    RecordUsage(parameters, root, path, line);
                    if (matches.Count >= limit)
                    {
                        WorkerLog.Debug(
                            $"memory tool search hit-limit scope={scope} matches={matches.Count} skippedSshRoots={skippedSshRoots} elapsedMs={ElapsedMs(startedAt)}");
                        return EncodeSearchResult(query, matches, skippedSshRoots);
                    }
                }
            }
        }

        WorkerLog.Debug(
            $"memory tool search done scope={scope} matches={matches.Count} skippedSshRoots={skippedSshRoots} elapsedMs={ElapsedMs(startedAt)}");
        return EncodeSearchResult(query, matches, skippedSshRoots);
    }

    private static List<MemoryRootDescriptor> EnsureCurrentRoots(JsonElement parameters, string scope)
    {
        var candidates = new List<MemoryRootCandidate>();
        var globalHome = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            ".open-cowork");
        if (!string.IsNullOrWhiteSpace(globalHome))
        {
            candidates.Add(new MemoryRootCandidate(
                "global",
                null,
                null,
                null,
                globalHome,
                "local"));
        }

        var workingFolder = JsonHelpers.GetString(parameters, "workingFolder")?.Trim();
        if (!string.IsNullOrWhiteSpace(workingFolder))
        {
            var sshConnectionId = JsonHelpers.GetString(parameters, "sshConnectionId")?.Trim();
            candidates.Add(new MemoryRootCandidate(
                "project",
                null,
                workingFolder,
                string.IsNullOrWhiteSpace(sshConnectionId) ? null : sshConnectionId,
                JoinFsPath(workingFolder, ".agents"),
                string.IsNullOrWhiteSpace(sshConnectionId) ? "local" : "ssh"));
        }

        using var connection = DbConnectionFactory.OpenReadWrite(parameters);
        using var transaction = connection.BeginTransaction();
        var roots = new List<MemoryRootDescriptor>();
        foreach (var candidate in candidates)
        {
            if (scope != "both" && !string.Equals(candidate.Scope, scope, StringComparison.Ordinal))
            {
                continue;
            }
            roots.Add(EnsureRoot(connection, transaction, candidate));
        }
        transaction.Commit();
        return roots;
    }

    private static MemoryRootDescriptor EnsureRoot(
        SqliteConnection connection,
        SqliteTransaction transaction,
        MemoryRootCandidate candidate)
    {
        var ownerKey = BuildOwnerKey(candidate);
        var existing = GetRootByOwnerKey(connection, transaction, ownerKey);
        var now = Now();
        if (existing is not null)
        {
            DbSql.ExecuteNonQuery(
                connection,
                transaction,
                """
                UPDATE memory_roots
                   SET project_id = $projectId,
                       working_folder = $workingFolder,
                       ssh_connection_id = $sshConnectionId,
                       root_path = $rootPath,
                       transport = $transport,
                       updated_at = $updatedAt
                 WHERE id = $id
                """,
                new DbSql.SqlParam("$projectId", candidate.ProjectId),
                new DbSql.SqlParam("$workingFolder", candidate.WorkingFolder),
                new DbSql.SqlParam("$sshConnectionId", candidate.SshConnectionId),
                new DbSql.SqlParam("$rootPath", candidate.RootPath),
                new DbSql.SqlParam("$transport", candidate.Transport),
                new DbSql.SqlParam("$updatedAt", now),
                new DbSql.SqlParam("$id", existing.Id));
            return GetRoot(connection, transaction, existing.Id) ?? existing;
        }

        var id = $"oc_{Guid.NewGuid():N}";
        DbSql.ExecuteNonQuery(
            connection,
            transaction,
            """
            INSERT INTO memory_roots (
              id, scope, project_id, working_folder, ssh_connection_id, root_path, transport,
              owner_key, created_at, updated_at
            )
            VALUES ($id, $scope, $projectId, $workingFolder, $sshConnectionId, $rootPath, $transport, $ownerKey, $createdAt, $updatedAt)
            """,
            new DbSql.SqlParam("$id", id),
            new DbSql.SqlParam("$scope", candidate.Scope),
            new DbSql.SqlParam("$projectId", candidate.ProjectId),
            new DbSql.SqlParam("$workingFolder", candidate.WorkingFolder),
            new DbSql.SqlParam("$sshConnectionId", candidate.SshConnectionId),
            new DbSql.SqlParam("$rootPath", candidate.RootPath),
            new DbSql.SqlParam("$transport", candidate.Transport),
            new DbSql.SqlParam("$ownerKey", ownerKey),
            new DbSql.SqlParam("$createdAt", now),
            new DbSql.SqlParam("$updatedAt", now));
        return GetRoot(connection, transaction, id) ??
            throw new InvalidOperationException("Failed to create memory root.");
    }

    private static MemoryRootDescriptor? GetRoot(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string id)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = $"{RootSelectSql()} WHERE id = $id LIMIT 1";
        command.Parameters.AddWithValue("$id", id);
        return ReadRoots(command).FirstOrDefault();
    }

    private static MemoryRootDescriptor? GetRootByOwnerKey(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string ownerKey)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = $"{RootSelectSql()} WHERE owner_key = $ownerKey LIMIT 1";
        command.Parameters.AddWithValue("$ownerKey", ownerKey);
        return ReadRoots(command).FirstOrDefault();
    }

    private static List<MemoryRootDescriptor> ReadRoots(SqliteCommand command)
    {
        using var reader = command.ExecuteReader();
        var rows = new List<MemoryRootDescriptor>();
        while (reader.Read())
        {
            rows.Add(new MemoryRootDescriptor
            {
                Id = reader.GetString(0),
                Scope = reader.GetString(1),
                ProjectId = reader.IsDBNull(2) ? null : reader.GetString(2),
                WorkingFolder = reader.IsDBNull(3) ? null : reader.GetString(3),
                SshConnectionId = reader.IsDBNull(4) ? null : reader.GetString(4),
                RootPath = reader.GetString(5),
                Transport = reader.GetString(6),
                OwnerKey = reader.GetString(7),
                CreatedAt = reader.GetInt64(8),
                UpdatedAt = reader.GetInt64(9)
            });
        }
        return rows;
    }

    private static void RecordUsage(
        JsonElement parameters,
        MemoryRootDescriptor root,
        string path,
        int? line)
    {
        try
        {
            var now = Now();
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            DbSql.ExecuteNonQuery(
                connection,
                transaction,
                """
                INSERT INTO memory_citation_usage (
                  id, memory_root_id, scope, source_session_id, path, line, citation_json, created_at
                )
                VALUES ($id, $memoryRootId, $scope, $sourceSessionId, $path, $line, $citationJson, $createdAt)
                """,
                new DbSql.SqlParam("$id", $"oc_{Guid.NewGuid():N}"),
                new DbSql.SqlParam("$memoryRootId", root.Id),
                new DbSql.SqlParam("$scope", root.Scope),
                new DbSql.SqlParam("$sourceSessionId", JsonHelpers.GetString(parameters, "sessionId")),
                new DbSql.SqlParam("$path", path),
                new DbSql.SqlParam("$line", line),
                new DbSql.SqlParam("$citationJson", BuildCitationJson(path, line)),
                new DbSql.SqlParam("$createdAt", now));
            DbSql.ExecuteNonQuery(
                connection,
                transaction,
                """
                UPDATE memory_stage1_outputs
                   SET usage_count = usage_count + 1,
                       last_usage_at = $lastUsageAt,
                       updated_at = $updatedAt
                 WHERE memory_root_id = $memoryRootId
                """,
                new DbSql.SqlParam("$lastUsageAt", now),
                new DbSql.SqlParam("$updatedAt", now),
                new DbSql.SqlParam("$memoryRootId", root.Id));
            transaction.Commit();
        }
        catch (Exception ex)
        {
            WorkerLog.Debug($"memory citation usage skipped rootId={root.Id} error={ex.GetType().Name}: {ex.Message}");
        }
    }

    private static string EncodeSearchResult(
        string query,
        List<MemorySearchMatch> matches,
        int skippedSshRoots)
    {
        return EncodeJsonObject(writer =>
        {
            writer.WriteString("query", query);
            writer.WriteStartArray("matches");
            foreach (var match in matches)
            {
                writer.WriteStartObject();
                writer.WriteString("scope", match.Root.Scope);
                writer.WriteString("memoryRootId", match.Root.Id);
                WriteNullableString(writer, "projectId", match.Root.ProjectId);
                writer.WriteString("path", match.Path);
                writer.WriteNumber("line", match.Line);
                writer.WriteString("text", match.Text);
                writer.WriteEndObject();
            }
            writer.WriteEndArray();
            if (skippedSshRoots > 0)
            {
                writer.WriteString(
                    "warning",
                    "Some SSH memory roots were skipped because the native run did not include a resolved SSH connection payload.");
            }
        });
    }

    private static void WriteRootForTool(Utf8JsonWriter writer, MemoryRootDescriptor root)
    {
        writer.WriteStartObject();
        writer.WriteString("id", root.Id);
        writer.WriteString("scope", root.Scope);
        WriteNullableString(writer, "projectId", root.ProjectId);
        WriteNullableString(writer, "workingFolder", root.WorkingFolder);
        WriteNullableString(writer, "sshConnectionId", root.SshConnectionId);
        writer.WriteString("rootPath", root.RootPath);
        writer.WriteString("transport", root.Transport);
        writer.WriteStartArray("files");
        foreach (var file in MemoryReadFiles)
        {
            writer.WriteStringValue(ResolveMemoryFilePath(root, file));
        }
        writer.WriteEndArray();
        writer.WriteEndObject();
    }

    private static MemoryRootDescriptor? PickRoot(
        List<MemoryRootDescriptor> roots,
        string memoryRootId,
        string scope)
    {
        if (memoryRootId.Length > 0)
        {
            return roots.FirstOrDefault(root => root.Id == memoryRootId);
        }
        if (scope == "global")
        {
            return roots.FirstOrDefault(root => root.Scope == "global");
        }
        if (scope == "project")
        {
            return roots.FirstOrDefault(root => root.Scope == "project");
        }
        return roots.FirstOrDefault(root => root.Scope == "project") ??
            roots.FirstOrDefault(root => root.Scope == "global");
    }

    private static string ResolveMemoryFilePath(MemoryRootDescriptor root, string file)
    {
        return JoinFsPath(root.RootPath, ResolveMemoryFile(file));
    }

    private static string ResolveMemoryFile(string? value)
    {
        var file = value?.Trim();
        return MemoryReadFiles.Contains(file, StringComparer.Ordinal) ? file! : "memory_summary.md";
    }

    private static string ReadScope(JsonElement input)
    {
        return JsonHelpers.GetString(input, "scope") switch
        {
            "global" => "global",
            "project" => "project",
            _ => "both"
        };
    }

    private static string JoinFsPath(string basePath, params string[] segments)
    {
        var trimmedBase = basePath.TrimEnd('/', '\\');
        var separator = trimmedBase.Contains('\\', StringComparison.Ordinal) ? '\\' : '/';
        var normalizedSegments = segments
            .Select(segment => segment.Trim('/', '\\'))
            .Where(segment => segment.Length > 0)
            .ToArray();
        if (trimmedBase.Length == 0)
        {
            return string.Join(separator, normalizedSegments);
        }
        return normalizedSegments.Length == 0
            ? trimmedBase
            : string.Join(separator, [trimmedBase, .. normalizedSegments]);
    }

    private static string BuildOwnerKey(MemoryRootCandidate candidate)
    {
        return string.Join(
            "::",
            candidate.Scope,
            candidate.Transport,
            candidate.ProjectId ?? string.Empty,
            candidate.SshConnectionId ?? string.Empty,
            NormalizeOwnerPath(candidate.WorkingFolder ?? string.Empty, candidate.SshConnectionId),
            NormalizeOwnerPath(candidate.RootPath, candidate.SshConnectionId));
    }

    private static string NormalizeOwnerPath(string value, string? sshConnectionId)
    {
        var trimmed = value.Trim();
        if (trimmed.Length == 0)
        {
            return string.Empty;
        }

        return !string.IsNullOrWhiteSpace(sshConnectionId)
            ? trimmed.Replace('\\', '/')
            : Path.GetFullPath(trimmed).Replace('\\', '/').ToLowerInvariant();
    }

    private static bool IsSshRoot(MemoryRootDescriptor root)
    {
        return string.Equals(root.Transport, "ssh", StringComparison.Ordinal) ||
            !string.IsNullOrWhiteSpace(root.SshConnectionId);
    }

    private static bool HasSshConnection(JsonElement parameters)
    {
        return parameters.ValueKind == JsonValueKind.Object &&
            parameters.TryGetProperty("connection", out var connection) &&
            connection.ValueKind == JsonValueKind.Object;
    }

    private static async Task<(bool Success, string? Content, string? Error)> ReadSshTextAsync(
        JsonElement parameters,
        string path)
    {
        try
        {
            var result = await SshOpenSsh.ExecuteAsync(
                parameters,
                $"cat -- {SshOpenSsh.ShellPathExpr(path)}",
                60_000,
                maxStdoutChars: 8 * 1024 * 1024,
                maxStderrChars: 64 * 1024);
            if (result.ExitCode != 0)
            {
                return (false, null, result.Stderr.Length > 0 ? result.Stderr : $"Remote memory file not readable: {path}");
            }

            return (true, result.Stdout, null);
        }
        catch (Exception ex)
        {
            return (false, null, ex.Message);
        }
    }

    private static long Now()
    {
        return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    }

    private static long ElapsedMs(long startedAt)
    {
        return (long)Stopwatch.GetElapsedTime(startedAt).TotalMilliseconds;
    }

    private static string RootSelectSql()
    {
        return """
            SELECT id,
                   scope,
                   project_id,
                   working_folder,
                   ssh_connection_id,
                   root_path,
                   transport,
                   owner_key,
                   created_at,
                   updated_at
              FROM memory_roots
            """;
    }

    private static string BuildCitationJson(string path, int? line)
    {
        return EncodeJsonObject(writer =>
        {
            writer.WriteString("tool", "memory");
            writer.WriteString("path", path);
            if (line.HasValue)
            {
                writer.WriteNumber("line", line.Value);
            }
            else
            {
                writer.WriteNull("line");
            }
        });
    }

    private static string EncodeJsonObject(Action<Utf8JsonWriter> writeProperties)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer, WriterOptions))
        {
            writer.WriteStartObject();
            writeProperties(writer);
            writer.WriteEndObject();
        }
        return Encoding.UTF8.GetString(buffer.WrittenSpan);
    }

    private static string EncodeError(string message)
    {
        return EncodeJsonObject(writer => writer.WriteString("error", message));
    }

    private static void WriteNullableString(Utf8JsonWriter writer, string name, string? value)
    {
        if (value is null)
        {
            writer.WriteNull(name);
        }
        else
        {
            writer.WriteString(name, value);
        }
    }

    private sealed record MemoryRootCandidate(
        string Scope,
        string? ProjectId,
        string? WorkingFolder,
        string? SshConnectionId,
        string RootPath,
        string Transport);

    private sealed record MemorySearchMatch(
        MemoryRootDescriptor Root,
        string Path,
        int Line,
        string Text);
}
