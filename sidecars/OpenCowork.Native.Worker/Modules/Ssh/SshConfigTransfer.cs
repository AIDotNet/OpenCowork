using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

internal sealed class NativeSshImportConnection
{
    public string ImportId { get; set; } = string.Empty;
    public string Source { get; set; } = "open-cowork";
    public string Name { get; set; } = string.Empty;
    public string Host { get; set; } = string.Empty;
    public int Port { get; set; } = 22;
    public string Username { get; set; } = string.Empty;
    public string AuthType { get; set; } = "password";
    public string? GroupName { get; set; }
    public string? PrivateKeyPath { get; set; }
    public string? ProxyJump { get; set; }
    public string? StartupCommand { get; set; }
    public string? DefaultDirectory { get; set; }
    public int? KeepAliveInterval { get; set; }
    public string? Password { get; set; }
    public string? Passphrase { get; set; }
    public bool HasKnownHost { get; set; }
    public bool NeedsPrivateKeyReview { get; set; }
    public List<string> Warnings { get; set; } = [];
    public string? ConflictConnectionId { get; set; }
    public string? ConflictConnectionName { get; set; }
    public string DefaultAction { get; set; } = "create";
}

internal sealed class NativeSshImportPreview
{
    public string Source { get; set; } = "open-cowork";
    public string FilePath { get; set; } = string.Empty;
    public List<string> Groups { get; set; } = [];
    public List<string> Warnings { get; set; } = [];
    public List<NativeSshImportConnection> Connections { get; set; } = [];
}

internal static partial class SshConfigTransfer
{
    private static readonly JsonSerializerOptions WriteOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        WriteIndented = true
    };

    public static WorkerResponse Export(JsonElement parameters)
    {
        try
        {
            var filePath = JsonHelpers.GetString(parameters, "filePath") ??
                throw new InvalidOperationException("filePath is required");
            var connectionIds = JsonHelpers.GetStringArray(parameters, "connectionIds");
            var selectedIds = connectionIds.Length > 0
                ? new HashSet<string>(connectionIds, StringComparer.Ordinal)
                : null;
            var config = SshConfigStore.ReadConfig();
            var connections = selectedIds is null
                ? config.Connections.ToList()
                : config.Connections.Where(connection => selectedIds.Contains(connection.Id)).ToList();
            var groupIds = connections
                .Select(connection => connection.GroupId)
                .Where(id => !string.IsNullOrWhiteSpace(id))
                .ToHashSet(StringComparer.Ordinal);
            var groups = config.Groups.Where(group => groupIds.Contains(group.Id)).ToList();
            var payload = new JsonObject
            {
                ["schemaVersion"] = 1,
                ["source"] = "open-cowork-ssh",
                ["exportedAt"] = SshConfigStore.Now(),
                ["groups"] = new JsonArray(groups.Select(group => (JsonNode?)SshConfigStore.GroupToJson(group)).ToArray()),
                ["connections"] = new JsonArray(
                    connections.Select(connection => (JsonNode?)SshConfigStore.ConnectionToJson(connection)).ToArray())
            };

            var directory = Path.GetDirectoryName(Path.GetFullPath(filePath));
            if (!string.IsNullOrWhiteSpace(directory))
            {
                Directory.CreateDirectory(directory);
            }
            File.WriteAllText(filePath, payload.ToJsonString(WriteOptions));
            WorkerLog.Debug($"ssh config export path={filePath} connections={connections.Count}");
            return SshConfigStore.ToResponse(new JsonObject { ["success"] = true });
        }
        catch (Exception ex)
        {
            return SshConfigStore.ToResponse(new JsonObject { ["success"] = false, ["error"] = ex.Message });
        }
    }

    public static WorkerResponse PreviewImport(JsonElement parameters)
    {
        try
        {
            var preview = PreviewImportInternal(parameters);
            return SshConfigStore.ToResponse(PreviewToJson(preview));
        }
        catch (Exception ex)
        {
            return SshConfigStore.ToResponse(new JsonObject { ["error"] = ex.Message });
        }
    }

    public static WorkerResponse ApplyImport(JsonElement parameters)
    {
        try
        {
            var source = JsonHelpers.GetString(parameters, "source") ?? "open-cowork";
            var preview = PreviewImportInternal(parameters);
            var decisions = ReadDecisions(parameters);
            var current = SshConfigStore.ReadConfig();
            var next = SshConfigStore.CloneConfig(current);
            var result = new JsonObject
            {
                ["imported"] = 0,
                ["replaced"] = 0,
                ["duplicated"] = 0,
                ["skipped"] = 0,
                ["warnings"] = new JsonArray()
            };
            var now = SshConfigStore.Now();

            foreach (var connection in preview.Connections)
            {
                var action = decisions.TryGetValue(connection.ImportId, out var decision)
                    ? decision
                    : connection.DefaultAction;
                var groupId = EnsureGroupByName(next, connection.GroupName, now);

                if (action == "skip")
                {
                    Increment(result, "skipped");
                    continue;
                }

                if (action == "replace" && !string.IsNullOrWhiteSpace(connection.ConflictConnectionId))
                {
                    var targetIndex = next.Connections.FindIndex(item =>
                        string.Equals(item.Id, connection.ConflictConnectionId, StringComparison.Ordinal));
                    if (targetIndex >= 0)
                    {
                        var existing = next.Connections[targetIndex];
                        if (source == "open-cowork")
                        {
                            next.Connections[targetIndex] = new NativeSshConfigConnection
                            {
                                Id = existing.Id,
                                GroupId = groupId,
                                Name = connection.Name,
                                Host = connection.Host,
                                Port = connection.Port,
                                Username = connection.Username,
                                AuthType = connection.AuthType,
                                Password = connection.Password,
                                PrivateKeyPath = connection.PrivateKeyPath,
                                Passphrase = connection.Passphrase,
                                StartupCommand = connection.StartupCommand,
                                DefaultDirectory = connection.DefaultDirectory,
                                ProxyJump = connection.ProxyJump,
                                KeepAliveInterval = connection.KeepAliveInterval ?? existing.KeepAliveInterval,
                                SortOrder = existing.SortOrder,
                                LastConnectedAt = existing.LastConnectedAt,
                                CreatedAt = existing.CreatedAt,
                                UpdatedAt = now
                            };
                        }
                        else
                        {
                            existing.Name = connection.Name;
                            existing.Host = connection.Host;
                            existing.Port = connection.Port;
                            existing.Username = connection.Username;
                            existing.AuthType = connection.AuthType;
                            existing.PrivateKeyPath = connection.PrivateKeyPath;
                            existing.ProxyJump = connection.ProxyJump;
                            existing.UpdatedAt = now;
                            AddWarning(
                                result,
                                $"Preserved {existing.Name} startup command, default directory, heartbeat and password fields.");
                        }

                        Increment(result, "replaced");
                        continue;
                    }
                }

                var nextConnection = CreateImportedConnection(next, connection, now, groupId);
                if (action == "duplicate")
                {
                    nextConnection.Name = CreateDuplicateName(next, connection.Name);
                    next.Connections.Add(nextConnection);
                    Increment(result, "duplicated");
                    continue;
                }

                next.Connections.Add(nextConnection);
                Increment(result, "imported");
            }

            SshConfigStore.WriteConfig(next);
            WorkerLog.Debug(
                $"ssh config import apply source={source} imported={result["imported"]} " +
                $"replaced={result["replaced"]} duplicated={result["duplicated"]} skipped={result["skipped"]}");
            return SshConfigStore.ToResponse(result);
        }
        catch (Exception ex)
        {
            return SshConfigStore.ToResponse(new JsonObject { ["error"] = ex.Message });
        }
    }

    private static NativeSshImportPreview PreviewImportInternal(JsonElement parameters)
    {
        var filePath = JsonHelpers.GetString(parameters, "filePath") ??
            throw new InvalidOperationException("filePath is required");
        var source = JsonHelpers.GetString(parameters, "source") ?? "open-cowork";
        var current = SshConfigStore.ReadConfig();
        var parsed = source == "openssh"
            ? ParseOpenSshConfig(filePath)
            : ParseOpenCoworkFile(filePath);
        foreach (var connection in parsed.Connections)
        {
            ApplyConflict(connection, current);
        }
        parsed.Source = source;
        parsed.FilePath = filePath;
        return parsed;
    }

    private static NativeSshImportPreview ParseOpenCoworkFile(string filePath)
    {
        var raw = JsonNode.Parse(File.ReadAllText(filePath));
        var warnings = new List<string>();
        JsonArray groupsRaw;
        JsonArray connectionsRaw;
        if (raw is JsonObject root && ReadString(root, "source") == "open-cowork-ssh")
        {
            groupsRaw = root["groups"] as JsonArray ?? [];
            connectionsRaw = root["connections"] as JsonArray ?? [];
        }
        else if (raw is JsonObject original && original["ssh"] is JsonObject ssh)
        {
            warnings.Add("Detected original OpenCoWork config structure, imported as SSH segments.");
            groupsRaw = ssh["groups"] as JsonArray ?? [];
            connectionsRaw = ssh["connections"] as JsonArray ?? [];
        }
        else
        {
            throw new InvalidOperationException("Unsupported OpenCoWork SSH import file");
        }

        var groups = groupsRaw
            .Select(SshConfigStore.GroupFromNode)
            .Where(group => group is not null)
            .Cast<NativeSshConfigGroup>()
            .ToList();
        var groupMap = groups.ToDictionary(group => group.Id, group => group.Name, StringComparer.Ordinal);
        var connections = new List<NativeSshImportConnection>();
        var index = 0;
        foreach (var connection in connectionsRaw
            .Select(SshConfigStore.ConnectionFromNode)
            .Where(connection => connection is not null)
            .Cast<NativeSshConfigConnection>())
        {
            var rowWarnings = warnings.ToList();
            if (!string.IsNullOrWhiteSpace(connection.PrivateKeyPath))
            {
                rowWarnings.Add("Private key path is from old machine, please verify it is still valid after import.");
            }
            if (!string.IsNullOrWhiteSpace(connection.GroupId) && !groupMap.ContainsKey(connection.GroupId))
            {
                rowWarnings.Add("Group ID cannot be matched, will rebuild by name or fallback to ungrouped during import.");
            }

            connections.Add(new NativeSshImportConnection
            {
                ImportId = BuildImportId(index, connection.Name, connection.Host, connection.Port, connection.Username),
                Source = "open-cowork",
                Name = connection.Name,
                Host = connection.Host,
                Port = connection.Port,
                Username = connection.Username,
                AuthType = connection.AuthType,
                GroupName = connection.GroupId is null ? null : groupMap.GetValueOrDefault(connection.GroupId),
                PrivateKeyPath = connection.PrivateKeyPath,
                ProxyJump = connection.ProxyJump,
                StartupCommand = connection.StartupCommand,
                DefaultDirectory = connection.DefaultDirectory,
                KeepAliveInterval = connection.KeepAliveInterval,
                Password = connection.Password,
                Passphrase = connection.Passphrase,
                HasKnownHost = false,
                NeedsPrivateKeyReview = !string.IsNullOrWhiteSpace(connection.PrivateKeyPath),
                Warnings = rowWarnings
            });
            index++;
        }

        return new NativeSshImportPreview
        {
            Groups = groups.Select(group => group.Name).ToList(),
            Warnings = warnings,
            Connections = connections
        };
    }

    private static NativeSshImportPreview ParseOpenSshConfig(string filePath)
    {
        var text = File.ReadAllText(filePath);
        var warnings = new List<string>();
        var defaults = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var entries = new List<(string Alias, Dictionary<string, string> Options, int Line)>();
        List<string>? currentPatterns = null;
        var currentOptions = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var currentLine = 1;

        void Flush()
        {
            if (currentPatterns is null || currentPatterns.Count == 0)
            {
                return;
            }

            if (currentPatterns.Count == 1 && currentPatterns[0] == "*")
            {
                foreach (var (key, value) in currentOptions)
                {
                    defaults[key] = value;
                }
                currentPatterns = null;
                currentOptions = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                return;
            }

            var exactPatterns = currentPatterns.Where(IsExactHostPattern).ToList();
            var ignoredPatterns = currentPatterns.Where(pattern => !IsExactHostPattern(pattern)).ToList();
            if (ignoredPatterns.Count > 0)
            {
                warnings.Add($"Ignored wildcard Host pattern: {string.Join(", ", ignoredPatterns)}");
            }

            foreach (var alias in exactPatterns)
            {
                var options = new Dictionary<string, string>(defaults, StringComparer.OrdinalIgnoreCase);
                foreach (var (key, value) in currentOptions)
                {
                    options[key] = value;
                }
                entries.Add((alias, options, currentLine));
            }

            currentPatterns = null;
            currentOptions = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        }

        var lines = text.Split(["\r\n", "\n"], StringSplitOptions.None);
        for (var index = 0; index < lines.Length; index++)
        {
            var rawLine = lines[index];
            var trimmed = rawLine.Trim();
            if (string.IsNullOrWhiteSpace(trimmed) || trimmed.StartsWith('#'))
            {
                continue;
            }

            var includeMatch = IncludeRegex().Match(trimmed);
            if (includeMatch.Success)
            {
                warnings.Add($"OpenSSH Include not yet supported: {includeMatch.Groups[1].Value}");
                continue;
            }

            var hostMatch = HostRegex().Match(trimmed);
            if (hostMatch.Success)
            {
                Flush();
                currentPatterns = hostMatch.Groups[1].Value
                    .Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                    .ToList();
                currentLine = index + 1;
                continue;
            }

            var optionMatch = OptionRegex().Match(rawLine);
            if (!optionMatch.Success)
            {
                continue;
            }

            var key = optionMatch.Groups[1].Value.ToLowerInvariant();
            var value = optionMatch.Groups[2].Value;
            if (currentPatterns is null)
            {
                defaults[key] = value;
                continue;
            }
            currentOptions[key] = value;
        }

        Flush();
        var knownHosts = BuildKnownHostsSet(filePath);
        var connections = new List<NativeSshImportConnection>();
        for (var index = 0; index < entries.Count; index++)
        {
            var entry = entries[index];
            var host = entry.Options.GetValueOrDefault("hostname") ?? entry.Alias;
            var username = entry.Options.GetValueOrDefault("user");
            if (string.IsNullOrWhiteSpace(username))
            {
                warnings.Add($"Host {entry.Alias} missing User, skipped.");
                continue;
            }

            var port = int.TryParse(entry.Options.GetValueOrDefault("port") ?? "22", out var parsedPort)
                ? parsedPort
                : 22;
            var identityFile = entry.Options.GetValueOrDefault("identityfile");
            var privateKeyPath = string.IsNullOrWhiteSpace(identityFile)
                ? null
                : SshConfigStore.ExpandHome(TrimQuotes(identityFile));
            var rowWarnings = new List<string>();
            if (string.IsNullOrWhiteSpace(privateKeyPath))
            {
                rowWarnings.Add("IdentityFile not found, will default to SSH Agent authentication.");
            }

            connections.Add(new NativeSshImportConnection
            {
                ImportId = BuildImportId(index, entry.Alias, host, port, username),
                Source = "openssh",
                Name = entry.Alias,
                Host = host,
                Port = port,
                Username = username,
                AuthType = string.IsNullOrWhiteSpace(privateKeyPath) ? "agent" : "privateKey",
                GroupName = null,
                PrivateKeyPath = privateKeyPath,
                ProxyJump = entry.Options.GetValueOrDefault("proxyjump"),
                StartupCommand = null,
                DefaultDirectory = null,
                KeepAliveInterval = null,
                Password = null,
                Passphrase = null,
                HasKnownHost = HasKnownHostRecord(knownHosts, host, port),
                NeedsPrivateKeyReview = !string.IsNullOrWhiteSpace(privateKeyPath),
                Warnings = rowWarnings
            });
        }

        return new NativeSshImportPreview
        {
            Groups = [],
            Warnings = warnings,
            Connections = connections
        };
    }

    private static Dictionary<string, string> BuildKnownHostsSet(string configPath)
    {
        var knownHosts = new Dictionary<string, string>(StringComparer.Ordinal);
        var paths = new[]
        {
            Path.Combine(Path.GetDirectoryName(Path.GetFullPath(configPath)) ?? string.Empty, "known_hosts"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".ssh", "known_hosts")
        };

        foreach (var knownHostsPath in paths)
        {
            if (!File.Exists(knownHostsPath))
            {
                continue;
            }

            foreach (var rawLine in File.ReadLines(knownHostsPath))
            {
                var line = rawLine.Trim();
                if (string.IsNullOrWhiteSpace(line) || line.StartsWith('#'))
                {
                    continue;
                }
                var hostField = line.Split(' ', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault();
                if (string.IsNullOrWhiteSpace(hostField) || hostField.StartsWith("|1|", StringComparison.Ordinal))
                {
                    continue;
                }
                foreach (var entry in hostField.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
                {
                    knownHosts[entry] = entry;
                }
            }
        }

        return knownHosts;
    }

    private static bool HasKnownHostRecord(Dictionary<string, string> knownHosts, string host, int port)
    {
        return knownHosts.ContainsKey(host) || knownHosts.ContainsKey($"[{host}]:{port}");
    }

    private static void ApplyConflict(NativeSshImportConnection connection, NativeSshConfigData currentConfig)
    {
        var conflict = currentConfig.Connections.FirstOrDefault(existing =>
            string.Equals(existing.Host, connection.Host, StringComparison.Ordinal) &&
            existing.Port == connection.Port &&
            string.Equals(existing.Username, connection.Username, StringComparison.Ordinal));
        connection.ConflictConnectionId = conflict?.Id;
        connection.ConflictConnectionName = conflict?.Name;
        connection.DefaultAction = conflict is null ? "create" : "skip";
    }

    private static string? EnsureGroupByName(NativeSshConfigData config, string? groupName, long now)
    {
        if (string.IsNullOrWhiteSpace(groupName))
        {
            return null;
        }

        var existing = config.Groups.FirstOrDefault(group => string.Equals(group.Name, groupName, StringComparison.Ordinal));
        if (existing is not null)
        {
            return existing.Id;
        }

        var nextSortOrder = config.Groups.Count > 0 ? config.Groups.Max(group => group.SortOrder) + 1 : 1;
        var group = new NativeSshConfigGroup
        {
            Id = SshConfigStore.NextId("sshg"),
            Name = groupName,
            SortOrder = nextSortOrder,
            CreatedAt = now,
            UpdatedAt = now
        };
        config.Groups.Add(group);
        return group.Id;
    }

    private static NativeSshConfigConnection CreateImportedConnection(
        NativeSshConfigData config,
        NativeSshImportConnection connection,
        long now,
        string? groupId)
    {
        var nextSortOrder = config.Connections.Count > 0
            ? config.Connections.Max(item => item.SortOrder) + 1
            : 1;
        return new NativeSshConfigConnection
        {
            Id = SshConfigStore.NextId("sshc"),
            GroupId = groupId,
            Name = connection.Name,
            Host = connection.Host,
            Port = connection.Port,
            Username = connection.Username,
            AuthType = connection.AuthType,
            Password = connection.Password,
            PrivateKeyPath = connection.PrivateKeyPath,
            Passphrase = connection.Passphrase,
            StartupCommand = connection.StartupCommand,
            DefaultDirectory = connection.DefaultDirectory,
            ProxyJump = connection.ProxyJump,
            KeepAliveInterval = connection.KeepAliveInterval ?? 60,
            SortOrder = nextSortOrder,
            LastConnectedAt = null,
            CreatedAt = now,
            UpdatedAt = now
        };
    }

    private static string CreateDuplicateName(NativeSshConfigData config, string baseName)
    {
        var candidate = $"{baseName} (Imported)";
        var index = 2;
        var names = config.Connections.Select(connection => connection.Name).ToHashSet(StringComparer.Ordinal);
        while (names.Contains(candidate))
        {
            candidate = $"{baseName} (Imported {index})";
            index++;
        }
        return candidate;
    }

    private static Dictionary<string, string> ReadDecisions(JsonElement parameters)
    {
        var decisions = new Dictionary<string, string>(StringComparer.Ordinal);
        if (!parameters.TryGetProperty("decisions", out var decisionsElement) ||
            decisionsElement.ValueKind != JsonValueKind.Array)
        {
            return decisions;
        }

        foreach (var decision in decisionsElement.EnumerateArray())
        {
            var importId = JsonHelpers.GetString(decision, "importId");
            var action = JsonHelpers.GetString(decision, "action");
            if (string.IsNullOrWhiteSpace(importId) || string.IsNullOrWhiteSpace(action))
            {
                continue;
            }
            decisions[importId] = action;
        }
        return decisions;
    }

    private static JsonObject PreviewToJson(NativeSshImportPreview preview)
    {
        return new JsonObject
        {
            ["source"] = preview.Source,
            ["filePath"] = preview.FilePath,
            ["connectionCount"] = preview.Connections.Count,
            ["groups"] = ToJsonArray(preview.Groups),
            ["warnings"] = ToJsonArray(preview.Warnings),
            ["connections"] = new JsonArray(preview.Connections.Select(connection => (JsonNode?)ConnectionToJson(connection)).ToArray())
        };
    }

    private static JsonObject ConnectionToJson(NativeSshImportConnection connection)
    {
        return new JsonObject
        {
            ["importId"] = connection.ImportId,
            ["source"] = connection.Source,
            ["name"] = connection.Name,
            ["host"] = connection.Host,
            ["port"] = connection.Port,
            ["username"] = connection.Username,
            ["authType"] = connection.AuthType,
            ["groupName"] = connection.GroupName,
            ["privateKeyPath"] = connection.PrivateKeyPath,
            ["proxyJump"] = connection.ProxyJump,
            ["startupCommand"] = connection.StartupCommand,
            ["defaultDirectory"] = connection.DefaultDirectory,
            ["keepAliveInterval"] = connection.KeepAliveInterval,
            ["password"] = connection.Password,
            ["passphrase"] = connection.Passphrase,
            ["hasKnownHost"] = connection.HasKnownHost,
            ["needsPrivateKeyReview"] = connection.NeedsPrivateKeyReview,
            ["warnings"] = ToJsonArray(connection.Warnings),
            ["conflictConnectionId"] = connection.ConflictConnectionId,
            ["conflictConnectionName"] = connection.ConflictConnectionName,
            ["defaultAction"] = connection.DefaultAction
        };
    }

    private static JsonArray ToJsonArray(IEnumerable<string> values)
    {
        return new JsonArray(values.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray());
    }

    private static void Increment(JsonObject result, string key)
    {
        var current = result[key]?.GetValue<int>() ?? 0;
        result[key] = current + 1;
    }

    private static void AddWarning(JsonObject result, string warning)
    {
        if (result["warnings"] is JsonArray warnings)
        {
            warnings.Add((JsonNode?)JsonValue.Create(warning));
        }
    }

    private static string BuildImportId(int index, string name, string host, int port, string username)
    {
        return $"{index}:{name}:{host}:{port}:{username}";
    }

    private static bool IsExactHostPattern(string pattern)
    {
        return !pattern.StartsWith('!') &&
            !pattern.Contains('*', StringComparison.Ordinal) &&
            !pattern.Contains('?', StringComparison.Ordinal);
    }

    private static string TrimQuotes(string value)
    {
        var trimmed = value.Trim();
        return trimmed.Length >= 2 &&
            ((trimmed.StartsWith('"') && trimmed.EndsWith('"')) ||
             (trimmed.StartsWith('\'') && trimmed.EndsWith('\'')))
                ? trimmed[1..^1]
                : trimmed;
    }

    private static string? ReadString(JsonObject obj, string name)
    {
        return obj.TryGetPropertyValue(name, out var value) &&
            value is JsonValue jsonValue &&
            jsonValue.TryGetValue<string>(out var text)
                ? text
                : null;
    }

    [GeneratedRegex(@"^Include\s+(.+)$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex IncludeRegex();

    [GeneratedRegex(@"^Host\s+(.+)$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex HostRegex();

    [GeneratedRegex(@"^\s*([A-Za-z][A-Za-z0-9]*)\s+(.*?)\s*$", RegexOptions.CultureInvariant)]
    private static partial Regex OptionRegex();
}
