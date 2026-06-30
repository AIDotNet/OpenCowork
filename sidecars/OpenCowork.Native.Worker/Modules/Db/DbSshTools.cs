using System.Text.Json;
using Microsoft.Data.Sqlite;

internal static class DbSshTools
{
    private const string GroupSelectSql = """
        SELECT id,
               name,
               sort_order,
               created_at,
               updated_at
          FROM ssh_groups
        """;

    private const string ConnectionSelectSql = """
        SELECT id,
               group_id,
               name,
               host,
               port,
               username,
               auth_type,
               encrypted_password,
               private_key_path,
               encrypted_passphrase,
               startup_command,
               default_directory,
               proxy_jump,
               keep_alive_interval,
               sort_order,
               last_connected_at,
               created_at,
               updated_at
          FROM ssh_connections
        """;

    public static WorkerResponse ListGroups(JsonElement parameters)
    {
        try
        {
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var command = connection.CreateCommand();
            command.CommandText = $"{GroupSelectSql} ORDER BY sort_order ASC";
            return WorkerResponse.Json(ReadGroups(command), WorkerJsonContext.Default.ListSshGroupRow);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Error(ex.Message);
        }
    }

    public static WorkerResponse CreateGroup(JsonElement parameters)
    {
        try
        {
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            var changed = DbSql.ExecuteNonQuery(
                connection,
                transaction,
                """
                INSERT INTO ssh_groups (
                  id,
                  name,
                  sort_order,
                  created_at,
                  updated_at
                )
                VALUES (
                  $id,
                  $name,
                  $sortOrder,
                  $createdAt,
                  $updatedAt
                )
                """,
                new DbSql.SqlParam("$id", RequireString(parameters, "id")),
                new DbSql.SqlParam("$name", RequireString(parameters, "name")),
                new DbSql.SqlParam("$sortOrder", JsonHelpers.GetInt(parameters, "sortOrder", 0)),
                new DbSql.SqlParam("$createdAt", JsonHelpers.GetLong(parameters, "createdAt", Now())),
                new DbSql.SqlParam("$updatedAt", JsonHelpers.GetLong(parameters, "updatedAt", Now())));
            transaction.Commit();
            return Mutation(changed);
        }
        catch (Exception ex)
        {
            return MutationError(ex.Message);
        }
    }

    public static WorkerResponse UpdateGroup(JsonElement parameters)
    {
        try
        {
            var id = RequireString(parameters, "id");
            if (!parameters.TryGetProperty("patch", out var patch) || patch.ValueKind != JsonValueKind.Object)
            {
                return Mutation(0);
            }

            var sets = new List<string>();
            var values = new List<DbSql.SqlParam>();
            AddStringPatch(patch, sets, values, "name", "name");
            AddIntPatch(patch, sets, values, "sortOrder", "sort_order");
            AddLongPatch(patch, sets, values, "updatedAt", "updated_at");
            if (sets.Count == 0)
            {
                return Mutation(0);
            }

            values.Add(new DbSql.SqlParam("$id", id));
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            var changed = ExecutePatch(connection, transaction, $"UPDATE ssh_groups SET {string.Join(", ", sets)} WHERE id = $id", values);
            transaction.Commit();
            return Mutation(changed);
        }
        catch (Exception ex)
        {
            return MutationError(ex.Message);
        }
    }

    public static WorkerResponse DeleteGroup(JsonElement parameters)
    {
        try
        {
            var id = RequireString(parameters, "id");
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            DbSql.ExecuteNonQuery(
                connection,
                transaction,
                "UPDATE ssh_connections SET group_id = NULL WHERE group_id = $id",
                new DbSql.SqlParam("$id", id));
            var changed = DbSql.ExecuteNonQuery(
                connection,
                transaction,
                "DELETE FROM ssh_groups WHERE id = $id",
                new DbSql.SqlParam("$id", id));
            transaction.Commit();
            return Mutation(changed);
        }
        catch (Exception ex)
        {
            return MutationError(ex.Message);
        }
    }

    public static WorkerResponse ListConnections(JsonElement parameters)
    {
        try
        {
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var command = connection.CreateCommand();
            command.CommandText = $"{ConnectionSelectSql} ORDER BY sort_order ASC";
            return WorkerResponse.Json(ReadConnections(command), WorkerJsonContext.Default.ListSshConnectionRow);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Error(ex.Message);
        }
    }

    public static WorkerResponse GetConnection(JsonElement parameters)
    {
        try
        {
            var id = RequireString(parameters, "id");
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var command = connection.CreateCommand();
            command.CommandText = $"{ConnectionSelectSql} WHERE id = $id LIMIT 1";
            command.Parameters.AddWithValue("$id", id);
            var row = ReadConnections(command).FirstOrDefault();
            return WorkerResponse.Json(
                new SshConnectionFindResult(true, row, null),
                WorkerJsonContext.Default.SshConnectionFindResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new SshConnectionFindResult(false, null, ex.Message),
                WorkerJsonContext.Default.SshConnectionFindResult);
        }
    }

    public static WorkerResponse CreateConnection(JsonElement parameters)
    {
        try
        {
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            var changed = DbSql.ExecuteNonQuery(
                connection,
                transaction,
                """
                INSERT INTO ssh_connections (
                  id,
                  group_id,
                  name,
                  host,
                  port,
                  username,
                  auth_type,
                  encrypted_password,
                  private_key_path,
                  encrypted_passphrase,
                  startup_command,
                  default_directory,
                  proxy_jump,
                  keep_alive_interval,
                  sort_order,
                  created_at,
                  updated_at
                )
                VALUES (
                  $id,
                  $groupId,
                  $name,
                  $host,
                  $port,
                  $username,
                  $authType,
                  $encryptedPassword,
                  $privateKeyPath,
                  $encryptedPassphrase,
                  $startupCommand,
                  $defaultDirectory,
                  $proxyJump,
                  $keepAliveInterval,
                  $sortOrder,
                  $createdAt,
                  $updatedAt
                )
                """,
                new DbSql.SqlParam("$id", RequireString(parameters, "id")),
                new DbSql.SqlParam("$groupId", JsonHelpers.GetString(parameters, "groupId")),
                new DbSql.SqlParam("$name", RequireString(parameters, "name")),
                new DbSql.SqlParam("$host", RequireString(parameters, "host")),
                new DbSql.SqlParam("$port", JsonHelpers.GetInt(parameters, "port", 22)),
                new DbSql.SqlParam("$username", RequireString(parameters, "username")),
                new DbSql.SqlParam("$authType", JsonHelpers.GetString(parameters, "authType") ?? "password"),
                new DbSql.SqlParam("$encryptedPassword", JsonHelpers.GetString(parameters, "encryptedPassword")),
                new DbSql.SqlParam("$privateKeyPath", JsonHelpers.GetString(parameters, "privateKeyPath")),
                new DbSql.SqlParam("$encryptedPassphrase", JsonHelpers.GetString(parameters, "encryptedPassphrase")),
                new DbSql.SqlParam("$startupCommand", JsonHelpers.GetString(parameters, "startupCommand")),
                new DbSql.SqlParam("$defaultDirectory", JsonHelpers.GetString(parameters, "defaultDirectory")),
                new DbSql.SqlParam("$proxyJump", JsonHelpers.GetString(parameters, "proxyJump")),
                new DbSql.SqlParam("$keepAliveInterval", JsonHelpers.GetInt(parameters, "keepAliveInterval", 60)),
                new DbSql.SqlParam("$sortOrder", JsonHelpers.GetInt(parameters, "sortOrder", 0)),
                new DbSql.SqlParam("$createdAt", JsonHelpers.GetLong(parameters, "createdAt", Now())),
                new DbSql.SqlParam("$updatedAt", JsonHelpers.GetLong(parameters, "updatedAt", Now())));
            transaction.Commit();
            return Mutation(changed);
        }
        catch (Exception ex)
        {
            return MutationError(ex.Message);
        }
    }

    public static WorkerResponse UpdateConnection(JsonElement parameters)
    {
        try
        {
            var id = RequireString(parameters, "id");
            if (!parameters.TryGetProperty("patch", out var patch) || patch.ValueKind != JsonValueKind.Object)
            {
                return Mutation(0);
            }

            var sets = new List<string>();
            var values = new List<DbSql.SqlParam>();
            AddNullableStringPatch(patch, sets, values, "groupId", "group_id");
            AddStringPatch(patch, sets, values, "name", "name");
            AddStringPatch(patch, sets, values, "host", "host");
            AddIntPatch(patch, sets, values, "port", "port");
            AddStringPatch(patch, sets, values, "username", "username");
            AddStringPatch(patch, sets, values, "authType", "auth_type");
            AddNullableStringPatch(patch, sets, values, "encryptedPassword", "encrypted_password");
            AddNullableStringPatch(patch, sets, values, "privateKeyPath", "private_key_path");
            AddNullableStringPatch(patch, sets, values, "encryptedPassphrase", "encrypted_passphrase");
            AddNullableStringPatch(patch, sets, values, "startupCommand", "startup_command");
            AddNullableStringPatch(patch, sets, values, "defaultDirectory", "default_directory");
            AddNullableStringPatch(patch, sets, values, "proxyJump", "proxy_jump");
            AddIntPatch(patch, sets, values, "keepAliveInterval", "keep_alive_interval");
            AddIntPatch(patch, sets, values, "sortOrder", "sort_order");
            AddNullableLongPatch(patch, sets, values, "lastConnectedAt", "last_connected_at");
            AddLongPatch(patch, sets, values, "updatedAt", "updated_at");
            if (sets.Count == 0)
            {
                return Mutation(0);
            }

            values.Add(new DbSql.SqlParam("$id", id));
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            var changed = ExecutePatch(connection, transaction, $"UPDATE ssh_connections SET {string.Join(", ", sets)} WHERE id = $id", values);
            transaction.Commit();
            return Mutation(changed);
        }
        catch (Exception ex)
        {
            return MutationError(ex.Message);
        }
    }

    public static WorkerResponse DeleteConnection(JsonElement parameters)
    {
        try
        {
            var id = RequireString(parameters, "id");
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            var changed = DbSql.ExecuteNonQuery(
                connection,
                transaction,
                "DELETE FROM ssh_connections WHERE id = $id",
                new DbSql.SqlParam("$id", id));
            transaction.Commit();
            return Mutation(changed);
        }
        catch (Exception ex)
        {
            return MutationError(ex.Message);
        }
    }

    private static List<SshGroupRow> ReadGroups(SqliteCommand command)
    {
        using var reader = command.ExecuteReader();
        var rows = new List<SshGroupRow>();
        while (reader.Read())
        {
            rows.Add(new SshGroupRow
            {
                Id = reader.GetString(0),
                Name = reader.GetString(1),
                SortOrder = reader.GetInt32(2),
                CreatedAt = reader.GetInt64(3),
                UpdatedAt = reader.GetInt64(4)
            });
        }

        return rows;
    }

    private static List<SshConnectionRow> ReadConnections(SqliteCommand command)
    {
        using var reader = command.ExecuteReader();
        var rows = new List<SshConnectionRow>();
        while (reader.Read())
        {
            rows.Add(new SshConnectionRow
            {
                Id = reader.GetString(0),
                GroupId = reader.IsDBNull(1) ? null : reader.GetString(1),
                Name = reader.GetString(2),
                Host = reader.GetString(3),
                Port = reader.GetInt32(4),
                Username = reader.GetString(5),
                AuthType = reader.GetString(6),
                EncryptedPassword = reader.IsDBNull(7) ? null : reader.GetString(7),
                PrivateKeyPath = reader.IsDBNull(8) ? null : reader.GetString(8),
                EncryptedPassphrase = reader.IsDBNull(9) ? null : reader.GetString(9),
                StartupCommand = reader.IsDBNull(10) ? null : reader.GetString(10),
                DefaultDirectory = reader.IsDBNull(11) ? null : reader.GetString(11),
                ProxyJump = reader.IsDBNull(12) ? null : reader.GetString(12),
                KeepAliveInterval = reader.GetInt32(13),
                SortOrder = reader.GetInt32(14),
                LastConnectedAt = reader.IsDBNull(15) ? null : reader.GetInt64(15),
                CreatedAt = reader.GetInt64(16),
                UpdatedAt = reader.GetInt64(17)
            });
        }

        return rows;
    }

    private static int ExecutePatch(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string sql,
        List<DbSql.SqlParam> values)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = sql;
        foreach (var value in values)
        {
            command.Parameters.AddWithValue(value.Name, value.Value ?? DBNull.Value);
        }

        return command.ExecuteNonQuery();
    }

    private static void AddStringPatch(
        JsonElement patch,
        List<string> sets,
        List<DbSql.SqlParam> values,
        string property,
        string column)
    {
        if (!patch.TryGetProperty(property, out var value))
        {
            return;
        }

        sets.Add($"{column} = ${property}");
        values.Add(new DbSql.SqlParam($"${property}", value.ValueKind == JsonValueKind.String ? value.GetString() : null));
    }

    private static void AddNullableStringPatch(
        JsonElement patch,
        List<string> sets,
        List<DbSql.SqlParam> values,
        string property,
        string column)
    {
        if (!patch.TryGetProperty(property, out var value))
        {
            return;
        }

        sets.Add($"{column} = ${property}");
        values.Add(new DbSql.SqlParam($"${property}", value.ValueKind == JsonValueKind.String ? value.GetString() : null));
    }

    private static void AddIntPatch(
        JsonElement patch,
        List<string> sets,
        List<DbSql.SqlParam> values,
        string property,
        string column)
    {
        if (!patch.TryGetProperty(property, out _))
        {
            return;
        }

        sets.Add($"{column} = ${property}");
        values.Add(new DbSql.SqlParam($"${property}", JsonHelpers.GetInt(patch, property, 0)));
    }

    private static void AddLongPatch(
        JsonElement patch,
        List<string> sets,
        List<DbSql.SqlParam> values,
        string property,
        string column)
    {
        if (!patch.TryGetProperty(property, out _))
        {
            return;
        }

        sets.Add($"{column} = ${property}");
        values.Add(new DbSql.SqlParam($"${property}", JsonHelpers.GetLong(patch, property, 0)));
    }

    private static void AddNullableLongPatch(
        JsonElement patch,
        List<string> sets,
        List<DbSql.SqlParam> values,
        string property,
        string column)
    {
        if (!patch.TryGetProperty(property, out _))
        {
            return;
        }

        sets.Add($"{column} = ${property}");
        values.Add(new DbSql.SqlParam($"${property}", JsonHelpers.GetLongNullable(patch, property)));
    }

    private static WorkerResponse Mutation(int changed)
    {
        return WorkerResponse.Json(
            new SshMutationResult(true, changed, null),
            WorkerJsonContext.Default.SshMutationResult);
    }

    private static WorkerResponse MutationError(string error)
    {
        return WorkerResponse.Json(
            new SshMutationResult(false, 0, error),
            WorkerJsonContext.Default.SshMutationResult);
    }

    private static string RequireString(JsonElement parameters, string name)
    {
        return JsonHelpers.GetString(parameters, name) is { Length: > 0 } value
            ? value
            : throw new InvalidOperationException($"Missing required SSH field: {name}");
    }

    private static long Now()
    {
        return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    }
}
