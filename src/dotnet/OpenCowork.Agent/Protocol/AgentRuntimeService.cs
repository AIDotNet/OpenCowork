using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Channels;
using OpenCowork.Agent.Engine;
using OpenCowork.Agent.Providers;
using OpenCowork.Agent.SubAgents;
using OpenCowork.Agent.Tools.Fs;

namespace OpenCowork.Agent.Protocol;

public sealed class AgentRuntimeService
{
    private const int DefaultMaxParallelTools = 8;
    private const int MinMaxParallelTools = 1;
    private const int MaxMaxParallelTools = 16;
    private const string DefaultFallbackReportPrompt =
        "Your previous turn ended without producing any visible text. Your caller has no way to see what you did. " +
        "Now, based on everything you executed in this conversation (tool calls, findings, analysis, attempts, and " +
        "failures), write a detailed work report. The report MUST include:\n" +
        "1. What you were asked to do and your interpretation of the task.\n" +
        "2. The concrete steps you took, in order, with the key evidence you gathered from each tool call.\n" +
        "3. Your findings, conclusions, or the artifacts you produced (paste or quote the important parts directly).\n" +
        "4. Anything you could NOT finish, and the reason (blocker, missing info, unclear scope, etc.).\n" +
        "5. Concrete next steps or recommendations for the caller.\n\n" +
        "Respond in the same language the task was given in. Output the report body only — do NOT call any tools, " +
        "do NOT ask clarifying questions, do NOT add preamble like \"Here is the report\". Just the report.";

    private readonly StdioJsonRpcTransport _transport;
    private readonly Func<string, object?, CancellationToken, TimeSpan?, Task<JsonElement?>> _sendRequestAsync;
    private readonly LlmHttpClientFactory _httpClientFactory = new();
    private readonly ToolRegistry _toolRegistry = new();
    private readonly SubAgentRunner _subAgentRunner;
    private readonly ConcurrentDictionary<string, CancellationTokenSource> _activeRuns = new();
    private readonly ConcurrentDictionary<string, DateTimeOffset> _readFileHistory = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<string, Channel<StreamEvent>> _bridgedProviderStreams = new();
    private readonly ConcurrentDictionary<string, LastTaskInvocation> _lastTaskInvocationBySession = new(StringComparer.Ordinal);

    private sealed record ShellCommandExecutionResult(
        int ExitCode,
        string Stdout,
        string Stderr,
        string Shell,
        long TotalMs,
        long SpawnMs,
        bool TimedOut,
        bool Aborted);

    private sealed record LastTaskInvocation(
        string RunId,
        string Key,
        string Output,
        string ToolUseId);

    private static readonly string[] SupportedCapabilities =
    [
        "agent.run",
        "agent.cancel",
        "streaming",
        "tools",
        "tool.Read",
        "tool.Write",
        "tool.Edit",
        "tool.Bash",
        "tool.LS",
        "tool.Glob",
        "tool.Grep",
        "fs.grep",
        "tool.DesktopScreenshot",
        "tool.DesktopClick",
        "tool.DesktopType",
        "tool.DesktopScroll",
        "tool.DesktopWait",
        "tool.TaskCreate",
        "tool.TaskGet",
        "tool.TaskUpdate",
        "tool.TaskList",
        "tool.AskUserQuestion",
        "tool.EnterPlanMode",
        "tool.SavePlan",
        "tool.ExitPlanMode",
        "tool.visualize_show_widget",
        "tool.Notify",
        "tool.CronAdd",
        "tool.CronUpdate",
        "tool.CronRemove",
        "tool.CronList",
        "tool.Task",
        "tool.Skill",
        "tool.ImageGenerate",
        "desktop.input",
        "provider.anthropic",
        "provider.openai-chat",
        "provider.openai-responses",
        "provider.gemini"
    ];

    public AgentRuntimeService(
        StdioJsonRpcTransport transport,
        Func<string, object?, CancellationToken, TimeSpan?, Task<JsonElement?>> sendRequestAsync)
    {
        _transport = transport;
        _sendRequestAsync = sendRequestAsync;
        _subAgentRunner = new SubAgentRunner(_toolRegistry);
        RegisterBuiltinTools();
    }

    public IReadOnlyList<string> GetCapabilities() => SupportedCapabilities;

    public bool SupportsCapability(string capability) =>
        SupportedCapabilities.Contains(capability, StringComparer.OrdinalIgnoreCase);

    private static int NormalizeMaxParallelTools(int value)
    {
        if (value <= 0)
            return DefaultMaxParallelTools;

        return Math.Clamp(value, MinMaxParallelTools, MaxMaxParallelTools);
    }

    private static string NormalizeTaskPrompt(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
            return string.Empty;

        return string.Join(" ", value.Trim().Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
    }

    private static string GetNormalizedTaskPrompt(Dictionary<string, JsonElement> input, string key)
    {
        if (!input.TryGetValue(key, out var value) || value.ValueKind != JsonValueKind.String)
            return string.Empty;

        return NormalizeTaskPrompt(value.GetString());
    }

    private static string BuildTaskDedupKey(Dictionary<string, JsonElement> input)
    {
        var subType = GetOptionalString(input, "subagent_type") ?? string.Empty;
        var prompt = GetNormalizedTaskPrompt(input, "prompt");
        if (string.IsNullOrEmpty(prompt))
            prompt = GetNormalizedTaskPrompt(input, "query");
        if (string.IsNullOrEmpty(prompt))
            prompt = GetNormalizedTaskPrompt(input, "task");
        if (string.IsNullOrEmpty(prompt))
            prompt = GetNormalizedTaskPrompt(input, "target");

        return $"{subType}::{prompt}";
    }

    public async Task<AgentRunResult> StartRunAsync(AgentRunParams input, CancellationToken ct)
    {
        var runId = string.IsNullOrWhiteSpace(input.RunId)
            ? Guid.NewGuid().ToString("N")
            : input.RunId!;
        var runCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        if (!_activeRuns.TryAdd(runId, runCts))
            throw new InvalidOperationException("Failed to register run");

        Console.Error.WriteLine($"[{DateTimeOffset.Now:HH:mm:ss.fff}] [AgentRuntime] StartRunAsync accepted runId={runId} provider={input.Provider.Type} tools={input.Tools.Count}");

        _ = Task.Run(async () =>
        {
            Console.Error.WriteLine($"[{DateTimeOffset.Now:HH:mm:ss.fff}] [AgentRuntime] background task started runId={runId}");
            try
            {
                var provider = CreateProvider(input.Provider, runId);
                Console.Error.WriteLine($"[{DateTimeOffset.Now:HH:mm:ss.fff}] [AgentRuntime] provider created runId={runId} provider={input.Provider.Type}");

                var toolContext = new ToolContext
                {
                    SessionId = input.SessionId ?? runId,
                    WorkingFolder = input.WorkingFolder ?? Environment.CurrentDirectory,
                    CurrentToolUseId = null,
                    AgentRunId = runId,
                    PluginId = input.PluginId,
                    PluginChatId = input.PluginChatId,
                    PluginChatType = input.PluginChatType,
                    PluginSenderId = input.PluginSenderId,
                    PluginSenderName = input.PluginSenderName,
                    SshConnectionId = input.SshConnectionId,
                    ProviderConfig = input.Provider,
                    ElectronInvokeAsync = CreateElectronInvokeHandler(runCts.Token),
                    RendererToolInvokeAsync = CreateRendererToolInvokeHandler(runId, runCts.Token),
                    RendererToolRequiresApprovalAsync = CreateRendererToolRequiresApprovalHandler(runId, runCts.Token),
                    EmitAgentEventAsync = (evt, token) => SendAgentEventAsync(runId, evt, token),
                    ReadFileHistory = _readFileHistory
                };

                var isChatMode = string.Equals(input.SessionMode, "chat", StringComparison.OrdinalIgnoreCase);
                var maxParallelTools = NormalizeMaxParallelTools(input.MaxParallelTools);
                List<UnifiedMessage>? capturedFinalMessages = null;
                var loopConfig = new AgentLoopRunConfig
                {
                    Provider = provider,
                    ProviderConfig = input.Provider,
                    Tools = input.Tools,
                    ToolRegistry = _toolRegistry,
                    ToolContext = toolContext,
                    // Chat mode collapses to a single assistant turn regardless
                    // of the requested maxIterations.
                    MaxIterations = isChatMode ? 1 : input.MaxIterations,
                    ForceApproval = input.ForceApproval,
                    Compression = input.Compression,
                    EnableParallelToolExecution = maxParallelTools > 1,
                    MaxParallelTools = maxParallelTools,
                    SessionMode = input.SessionMode,
                    PlanMode = input.PlanMode,
                    PlanModeAllowedTools = input.PlanModeAllowedTools is { Count: > 0 }
                        ? new HashSet<string>(input.PlanModeAllowedTools, StringComparer.Ordinal)
                        : null,
                    CaptureFinalMessages = messages => capturedFinalMessages = messages
                };

                var approvalHandler = CreateApprovalHandler(runId, toolContext.SessionId, runCts.Token);
                var visibleText = new StringBuilder();
                MessageEndEvent? pendingMessageEnd = null;
                LoopEndEvent? pendingLoopEnd = null;
                Console.Error.WriteLine($"[{DateTimeOffset.Now:HH:mm:ss.fff}] [AgentRuntime] entering agent loop runId={runId}");

                await foreach (var evt in AgentLoop.RunAsync(input.Messages, loopConfig, approvalHandler, runCts.Token))
                {
                    Console.Error.WriteLine($"[{DateTimeOffset.Now:HH:mm:ss.fff}] [AgentRuntime] event produced runId={runId} {DescribeAgentEvent(evt)}");

                    if (evt is TextDeltaEvent textEvt)
                    {
                        visibleText.Append(textEvt.Text);
                    }

                    if (evt is MessageEndEvent messageEndEvt)
                    {
                        pendingMessageEnd = messageEndEvt;
                        continue;
                    }

                    if (evt is LoopEndEvent loopEndEvt)
                    {
                        pendingLoopEnd = loopEndEvt;
                        continue;
                    }

                    await SendAgentEventAsync(runId, evt, runCts.Token);
                }

                if (isChatMode
                    && visibleText.Length == 0
                    && capturedFinalMessages is { Count: > 0 }
                    && !runCts.Token.IsCancellationRequested)
                {
                    var fallback = await RunFallbackReportAsync(capturedFinalMessages, provider, input.Provider, toolContext, runCts.Token);
                    if (!string.IsNullOrWhiteSpace(fallback))
                    {
                        visibleText.Append(fallback);
                        await SendAgentEventAsync(runId, new TextDeltaEvent { Text = fallback }, runCts.Token);
                    }
                }

                if (pendingMessageEnd is not null)
                {
                    await SendAgentEventAsync(runId, pendingMessageEnd, runCts.Token);
                }

                if (pendingLoopEnd is not null)
                {
                    await SendAgentEventAsync(runId, pendingLoopEnd, runCts.Token);
                }

                Console.Error.WriteLine($"[{DateTimeOffset.Now:HH:mm:ss.fff}] [AgentRuntime] agent loop completed runId={runId}");
            }
            catch (OperationCanceledException)
            {
                Console.Error.WriteLine($"[{DateTimeOffset.Now:HH:mm:ss.fff}] [AgentRuntime] run cancelled runId={runId}");
                await SendAgentEventAsync(runId, new LoopEndEvent { Reason = "aborted" }, CancellationToken.None);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[{DateTimeOffset.Now:HH:mm:ss.fff}] [AgentRuntime] run failed runId={runId}: {ex}");
                await SendAgentEventAsync(runId, new AgentErrorEvent
                {
                    Message = BuildErrorMessage(ex),
                    ErrorType = ex.GetType().Name,
                    Details = BuildErrorDetails(ex),
                    StackTrace = ex.StackTrace
                }, CancellationToken.None);
                await SendAgentEventAsync(runId, new LoopEndEvent { Reason = "error" }, CancellationToken.None);
            }
            finally
            {
                Console.Error.WriteLine($"[{DateTimeOffset.Now:HH:mm:ss.fff}] [AgentRuntime] cleaning up runId={runId}");
                if (_activeRuns.TryRemove(runId, out var linkedCts))
                    linkedCts.Dispose();
                // Return heap memory to OS after run completes
                GC.Collect(2, GCCollectionMode.Aggressive, blocking: true, compacting: true);
                GC.WaitForPendingFinalizers();
            }
        }, CancellationToken.None);

        return new AgentRunResult { Started = true, RunId = runId };
    }

    public Task<AgentCancelResult> CancelRunAsync(AgentCancelParams input)
    {
        var cancelled = _activeRuns.TryRemove(input.RunId, out var cts);
        if (cancelled)
        {
            cts!.Cancel();
            cts.Dispose();
        }

        return Task.FromResult(new AgentCancelResult
        {
            Cancelled = cancelled,
            RunId = input.RunId
        });
    }

    private void RegisterBuiltinTools()
    {
        // ── Read (native: direct file I/O, 0 IPC) ──

        _toolRegistry.Register(new ToolHandler
        {
            Definition = new ToolDefinition
            {
                Name = "Read",
                Description = "Read a file from the filesystem",
                InputSchema = ParseSchema("""{"type":"object","properties":{"file_path":{"type":"string","description":"Absolute path or relative to the working folder"},"offset":{"type":"number","description":"Start line (1-indexed)"},"limit":{"type":"number","description":"Number of lines to read"}},"required":["file_path"]}""")
            },
            Execute = async (input, ctx, token) =>
            {
                var path = ResolvePath(GetString(input, "file_path", required: true), ctx.WorkingFolder);

                // SSH: fall back to renderer bridge (SFTP)
                if (ctx.SshConnectionId is not null)
                    return await InvokeRendererToolAsync(ctx, "Read", input, token);

                try
                {
                    var content = await FsOperations.ReadFileAsync(path,
                        GetOptionalInt(input, "offset"), GetOptionalInt(input, "limit"), token);
                    FsOperations.RecordRead(path, ctx.ReadFileHistory);
                    return new ToolResultContent { Content = content };
                }
                catch (Exception ex)
                {
                    return new ToolResultContent { Content = ex.Message, IsError = true };
                }
            },
            RequiresApproval = (_, _) => false
        });

        // ── Write (native validation + Electron IPC write for change tracking, 1 IPC) ──

        _toolRegistry.Register(new ToolHandler
        {
            Definition = new ToolDefinition
            {
                Name = "Write",
                Description = "Write a file to the filesystem",
                InputSchema = ParseSchema("""
                {
                  "type": "object",
                  "properties": {
                    "file_path": { "type": "string", "description": "Absolute path or relative to the working folder" },
                    "content": { "type": "string", "description": "The content to write to the file" }
                  },
                  "required": ["file_path", "content"]
                }
                """)
            },
            Execute = async (input, ctx, token) =>
            {
                var path = ResolvePath(GetString(input, "file_path", required: true), ctx.WorkingFolder);
                var content = GetString(input, "content", required: true);

                // SSH: fall back to renderer bridge (SFTP)
                if (ctx.SshConnectionId is not null)
                    return await InvokeRendererToolAsync(ctx, "Write", input, token);

                try
                {
                    var isNewFile = !File.Exists(path);
                    var writeArgs = new JsonObject
                    {
                        ["path"] = path,
                        ["content"] = content
                    };
                    if (ctx.AgentRunId is not null)
                    {
                        writeArgs["changeMeta"] = new JsonObject
                        {
                            ["runId"] = ctx.AgentRunId,
                            ["sessionId"] = ctx.SessionId,
                            ["toolUseId"] = ctx.CurrentToolUseId,
                            ["toolName"] = "Write"
                        };
                    }
                    await InvokeElectronAsync(ctx, "fs:write-file", new object?[] { writeArgs }, token);

                    FsOperations.RecordRead(path, ctx.ReadFileHistory);
                    return new ToolResultContent
                    {
                        Content = new JsonObject
                        {
                            ["success"] = true,
                            ["path"] = path,
                            ["op"] = isNewFile ? "create" : "modify"
                        }
                    };
                }
                catch (Exception ex)
                {
                    return new ToolResultContent { Content = ex.Message, IsError = true };
                }
            },
            RequiresApproval = (input, ctx) =>
            {
                if (ctx.SshConnectionId is not null) return false;
                var filePath = ResolvePath(GetString(input, "file_path", required: true), ctx.WorkingFolder);
                return !IsWithinWorkingFolder(filePath, ctx.WorkingFolder);
            }
        });

        // ── Edit (native read + match/replace, Electron IPC write, 1 IPC) ──

        _toolRegistry.Register(new ToolHandler
        {
            Definition = new ToolDefinition
            {
                Name = "Edit",
                Description = "Perform exact string replacements in files",
                InputSchema = ParseSchema("""{"type":"object","properties":{"file_path":{"type":"string","description":"Absolute path or relative to the working folder"},"old_string":{"type":"string","description":"The text to replace"},"new_string":{"type":"string","description":"The text to replace it with"},"replace_all":{"type":"boolean","description":"Replace all occurrences of old_string"}},"required":["file_path","old_string","new_string"]}""")
            },
            Execute = async (input, ctx, token) =>
            {
                var path = ResolvePath(GetString(input, "file_path", required: true), ctx.WorkingFolder);
                var oldStr = GetString(input, "old_string", required: true);
                var newStr = GetString(input, "new_string", required: true);
                var replaceAll = GetOptionalBool(input, "replace_all") == true;

                // SSH: fall back to renderer bridge (SFTP)
                if (ctx.SshConnectionId is not null)
                    return await InvokeRendererToolAsync(ctx, "Edit", input, token);

                try
                {
                    if (string.IsNullOrEmpty(oldStr))
                        return new ToolResultContent { Content = "old_string must be non-empty", IsError = true };

                    if (string.Equals(oldStr, newStr, StringComparison.Ordinal))
                        return new ToolResultContent { Content = "new_string must be different from old_string", IsError = true };

                    // 1. Native read — detect encoding from BOM so we can write back correctly
                    var (content, fileEncoding) = FsOperations.ReadFileRawWithEncoding(path);

                    // 2. Build EOL variants + exact match
                    var variants = FsOperations.BuildOldStringVariants(oldStr, content);
                    (string Text, string Eol)? matched = null;
                    foreach (var v in variants)
                    {
                        if (v.Text.Length > 0 && content.Contains(v.Text, StringComparison.Ordinal))
                        {
                            matched = v;
                            break;
                        }
                    }

                    if (matched is null)
                        return new ToolResultContent
                        {
                            Content = $"String to replace not found in file.\nString: {oldStr}",
                            IsError = true
                        };

                    // 3. Uniqueness check
                    var occurrences = FsOperations.CountOccurrences(content, matched.Value.Text);
                    if (!replaceAll && occurrences > 1)
                        return new ToolResultContent
                        {
                            Content = $"Found {occurrences} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: {oldStr}",
                            IsError = true
                        };

                    // 4. Replace (C# String.Replace has no $ special character issue)
                    var replacement = FsOperations.ApplyEolStyle(newStr, matched.Value.Eol);
                    var updated = replaceAll
                        ? content.Replace(matched.Value.Text, replacement, StringComparison.Ordinal)
                        : FsOperations.ReplaceFirst(content, matched.Value.Text, replacement);

                    // 5. Write back — strategy depends on file encoding
                    if (fileEncoding == "utf16le")
                    {
                        // UTF-16 LE: write directly from .NET with BOM preserved.
                        // Node's fs:write-file always writes UTF-8 so we bypass Electron here.
                        // Change tracking is skipped for UTF-16 files (they are uncommon).
                        var bom = new byte[] { 0xFF, 0xFE };
                        var body = Encoding.Unicode.GetBytes(updated);
                        var allBytes = new byte[bom.Length + body.Length];
                        bom.CopyTo(allBytes, 0);
                        body.CopyTo(allBytes, bom.Length);
                        await File.WriteAllBytesAsync(path, allBytes, token);
                    }
                    else
                    {
                        // UTF-8 / UTF-8+BOM: write via Electron IPC so change tracking works.
                        // Prepend BOM character for utf8bom files — Node.js writeFile('utf-8')
                        // will encode \uFEFF as the 3-byte sequence EF BB BF, restoring the BOM.
                        var contentToWrite = fileEncoding == "utf8bom" ? "\uFEFF" + updated : updated;
                        var writeArgs = new JsonObject
                        {
                            ["path"] = path,
                            ["content"] = contentToWrite
                        };
                        if (ctx.AgentRunId is not null)
                        {
                            writeArgs["changeMeta"] = new JsonObject
                            {
                                ["runId"] = ctx.AgentRunId,
                                ["sessionId"] = ctx.SessionId,
                                ["toolUseId"] = ctx.CurrentToolUseId,
                                ["toolName"] = "Edit"
                            };
                        }
                        var writeResult = await InvokeElectronAsync(ctx, "fs:write-file", new object?[] { writeArgs }, token);

                        if (writeResult.ValueKind == JsonValueKind.Object &&
                            writeResult.TryGetProperty("error", out var errorProp) &&
                            errorProp.ValueKind == JsonValueKind.String)
                        {
                            return new ToolResultContent { Content = $"Write failed: {errorProp.GetString()}", IsError = true };
                        }
                    }

                    // 6. Record read history
                    FsOperations.RecordRead(path, ctx.ReadFileHistory);
                    return new ToolResultContent
                    {
                        Content = replaceAll
                            ? $"The file {path} has been updated. All occurrences were successfully replaced."
                            : $"The file {path} has been updated successfully."
                    };
                }
                catch (Exception ex)
                {
                    return new ToolResultContent { Content = ex.Message, IsError = true };
                }
            },
            RequiresApproval = (input, ctx) =>
            {
                if (ctx.SshConnectionId is not null) return false;
                var filePath = ResolvePath(GetString(input, "file_path", required: true), ctx.WorkingFolder);
                return !IsWithinWorkingFolder(filePath, ctx.WorkingFolder);
            }
        });

        _toolRegistry.Register(new ToolHandler
        {
            Definition = new ToolDefinition
            {
                Name = "Bash",
                Description = "Execute a shell command",
                InputSchema = ParseSchema("""
                {
                  "type": "object",
                  "properties": {
                    "command": { "type": "string", "description": "The command to execute" },
                    "timeout": { "type": "number", "description": "Timeout in milliseconds" },
                    "description": { "type": "string", "description": "Short description of the command" }
                  },
                  "required": ["command"]
                }
                """)
            },
            Execute = async (input, ctx, token) =>
            {
                // SSH: bridge to renderer (executes via ssh:exec)
                if (ctx.SshConnectionId is not null)
                    return await InvokeRendererToolAsync(ctx, "Bash", input, token);

                var command = GetString(input, "command", required: true);
                var timeoutMs = Math.Clamp(GetOptionalInt(input, "timeout") ?? 600000, 1, 3600000);
                var result = await AgentRuntimeService.ExecuteShellCommandAsync(command, ctx.WorkingFolder, timeoutMs, token);
                return new ToolResultContent
                {
                    Content = BuildJsonObject(new Dictionary<string, JsonNode?>
                    {
                        ["stdout"] = JsonValue.Create(result.Stdout),
                        ["stderr"] = JsonValue.Create(result.Stderr),
                        ["exitCode"] = JsonValue.Create(result.ExitCode),
                        ["summary"] = BuildJsonObject(new Dictionary<string, JsonNode?>
                        {
                            ["totalMs"] = JsonValue.Create(result.TotalMs),
                            ["spawnMs"] = JsonValue.Create(result.SpawnMs),
                            ["shell"] = JsonValue.Create(result.Shell),
                            ["executionEngine"] = JsonValue.Create("sidecar"),
                            ["timedOut"] = JsonValue.Create(result.TimedOut),
                            ["aborted"] = JsonValue.Create(result.Aborted)
                        })
                    }),
                    IsError = result.ExitCode != 0
                };
            },
            RequiresApproval = (_, ctx) => ctx.SshConnectionId is null
        });

        _toolRegistry.Register(new ToolHandler
        {
            Definition = new ToolDefinition
            {
                Name = "LS",
                Description = "List files and directories in a given path",
                InputSchema = ParseSchema("""
                {
                  "type": "object",
                  "properties": {
                    "path": { "type": "string", "description": "Absolute path or relative to the working folder" },
                    "ignore": {
                      "type": "array",
                      "items": { "type": "string" },
                      "description": "Optional file or directory names to ignore"
                    }
                  },
                  "required": []
                }
                """)
            },
            Execute = async (input, ctx, token) =>
            {
                // SSH: bridge to renderer (lists via SFTP)
                if (ctx.SshConnectionId is not null)
                    return await InvokeRendererToolAsync(ctx, "LS", input, token);

                var path = ResolvePath(GetOptionalString(input, "path") ?? ".", ctx.WorkingFolder);
                var ignore = GetOptionalStringArray(input, "ignore");
                var entries = FsOperations.ListDirectory(path, showHidden: true, ignore: ignore)
                    .Select(entry => new
                    {
                        name = entry.Name,
                        type = entry.Type,
                        path = Path.Combine(path, entry.Name)
                    })
                    .ToList();
                return new ToolResultContent
                {
                    Content = BuildJsonArray(entries.Select(entry => (JsonNode)BuildJsonObject(new Dictionary<string, JsonNode?>
                    {
                        ["name"] = JsonValue.Create(entry.name),
                        ["type"] = JsonValue.Create(entry.type),
                        ["path"] = JsonValue.Create(entry.path)
                    })))
                };
            },
            RequiresApproval = (_, _) => false
        });

        _toolRegistry.Register(new ToolHandler
        {
            Definition = new ToolDefinition
            {
                Name = "Glob",
                Description = "Fast file pattern matching tool",
                InputSchema = ParseSchema("""
                {
                  "type": "object",
                  "properties": {
                    "pattern": { "type": "string", "description": "Glob pattern to match files" },
                    "path": { "type": "string", "description": "Optional search directory" }
                  },
                  "required": ["pattern"]
                }
                """)
            },
            Execute = async (input, ctx, token) =>
            {
                // SSH: bridge to renderer (globs via SFTP)
                if (ctx.SshConnectionId is not null)
                    return await InvokeRendererToolAsync(ctx, "Glob", input, token);

                var directory = ResolvePath(GetOptionalString(input, "path") ?? ".", ctx.WorkingFolder);
                var pattern = GetString(input, "pattern", required: true);
                var results = GlobTool.Search(directory, pattern);
                return new ToolResultContent
                {
                    Content = BuildJsonArray(results.Select(static item => JsonValue.Create(item)))
                };
            },
            RequiresApproval = (_, _) => false
        });

        _toolRegistry.Register(new ToolHandler
        {
            Definition = new ToolDefinition
            {
                Name = "Grep",
                Description = "Search file contents using regular expressions",
                InputSchema = ParseSchema("""
                {
                  "type": "object",
                  "properties": {
                    "pattern": { "type": "string", "description": "Regex pattern to search for" },
                    "path": { "type": "string", "description": "Directory to search in" },
                    "include": { "type": "string", "description": "File pattern filter, e.g. *.ts" }
                  },
                  "required": ["pattern"]
                }
                """)
            },
            Execute = async (input, ctx, token) =>
            {
                // SSH: bridge to renderer (greps via SSH exec)
                if (ctx.SshConnectionId is not null)
                    return await InvokeRendererToolAsync(ctx, "Grep", input, token);

                var directory = ResolvePath(GetOptionalString(input, "path") ?? ".", ctx.WorkingFolder);
                var pattern = GetString(input, "pattern", required: true);
                var include = GetOptionalString(input, "include");
                var searchStopwatch = Stopwatch.StartNew();
                var result = await GrepTool.SearchAsync(directory, pattern, new GrepOptions
                {
                    GlobPattern = include,
                    MaxResults = 200
                }, token);
                searchStopwatch.Stop();
                return new ToolResultContent
                {
                    Content = BuildJsonObject(new Dictionary<string, JsonNode?>
                    {
                        ["matches"] = BuildJsonArray(result.Matches.Select(match => (JsonNode)BuildJsonObject(new Dictionary<string, JsonNode?>
                        {
                            ["file"] = JsonValue.Create(match.File),
                            ["line"] = JsonValue.Create(match.Line),
                            ["text"] = JsonValue.Create(match.Content)
                        }))),
                        ["truncated"] = JsonValue.Create(result.Truncated),
                        ["timedOut"] = JsonValue.Create(string.Equals(result.LimitReason, "timeout", StringComparison.Ordinal)),
                        ["limitReason"] = result.LimitReason is null ? null : JsonValue.Create(result.LimitReason),
                        ["searchTime"] = JsonValue.Create(searchStopwatch.ElapsedMilliseconds)
                    })
                };
            },
            RequiresApproval = (_, _) => false
        });

        _toolRegistry.Register(new ToolHandler
        {
            Definition = new ToolDefinition
            {
                Name = "DesktopScreenshot",
                Description = "Capture a full desktop screenshot and return it to the agent.",
                InputSchema = ParseSchema("""
                {
                  "type": "object",
                  "properties": {
                    "delayMs": { "type": "number", "description": "Optional delay in milliseconds before capturing the screenshot." }
                  },
                  "additionalProperties": false
                }
                """)
            },
            Execute = async (input, ctx, token) =>
            {
                var delayMs = GetOptionalInt(input, "delayMs") ?? 0;
                if (delayMs > 0)
                    await Task.Delay(Math.Min(delayMs, 5000), token);

                var result = await InvokeElectronAsync(ctx, "desktop:screenshot:capture", [], token);
                var success = GetBoolean(result, "success");
                if (!success)
                {
                    return new ToolResultContent
                    {
                        Content = new JsonObject
                        {
                            ["error"] = GetString(result, "error") ?? "Failed to capture desktop screenshot."
                        }.ToJsonString(),
                        IsError = true
                    };
                }

                var data = GetString(result, "data");
                if (string.IsNullOrWhiteSpace(data))
                {
                    return new ToolResultContent
                    {
                        Content = new JsonObject
                        {
                            ["error"] = "Failed to capture desktop screenshot."
                        }.ToJsonString(),
                        IsError = true
                    };
                }

                return new ToolResultContent
                {
                    Content = new ContentBlock[]
                    {
                        new ImageBlock
                        {
                            Source = new ImageSource
                            {
                                Type = "base64",
                                MediaType = GetString(result, "mediaType") ?? "image/png",
                                Data = data
                            }
                        },
                        new TextBlock
                        {
                            Text = $"Captured desktop screenshot {GetString(result, "width") ?? "?"}x{GetString(result, "height") ?? "?"} across {GetString(result, "displayCount") ?? "1"} display(s)."
                        }
                    }
                };
            },
            RequiresApproval = (_, _) => true
        });

        _toolRegistry.Register(new ToolHandler
        {
            Definition = new ToolDefinition
            {
                Name = "DesktopClick",
                Description = "Move the cursor to a desktop coordinate and perform a mouse action.",
                InputSchema = ParseSchema("""
                {
                  "type": "object",
                  "properties": {
                    "x": { "type": "number" },
                    "y": { "type": "number" },
                    "button": { "type": "string", "enum": ["left", "right", "middle"] },
                    "action": { "type": "string", "enum": ["click", "double_click", "down", "up"] }
                  },
                  "required": ["x", "y"],
                  "additionalProperties": false
                }
                """)
            },
            Execute = async (input, ctx, token) =>
            {
                var payload = BuildJsonObject(new Dictionary<string, JsonNode?>
                {
                    ["x"] = JsonValue.Create(GetOptionalDouble(input, "x") ?? throw new InvalidOperationException("Missing required field: x")),
                    ["y"] = JsonValue.Create(GetOptionalDouble(input, "y") ?? throw new InvalidOperationException("Missing required field: y")),
                    ["button"] = JsonValue.Create(GetOptionalString(input, "button") ?? "left"),
                    ["action"] = JsonValue.Create(GetOptionalString(input, "action") ?? "click")
                });
                var result = await InvokeElectronAsync(ctx, "desktop:input:click", [payload], token);
                return CreateDesktopInputResult(result);
            },
            RequiresApproval = (_, _) => true
        });

        _toolRegistry.Register(new ToolHandler
        {
            Definition = new ToolDefinition
            {
                Name = "DesktopType",
                Description = "Type text, press a key, or send a hotkey on the desktop.",
                InputSchema = ParseSchema("""
                {
                  "type": "object",
                  "properties": {
                    "text": { "type": "string" },
                    "key": { "type": "string" },
                    "hotkey": { "type": "array", "items": { "type": "string" } }
                  },
                  "additionalProperties": false
                }
                """)
            },
            Execute = async (input, ctx, token) =>
            {
                var payload = new JsonObject();
                if (input.TryGetValue("text", out var text) && text.ValueKind == JsonValueKind.String)
                    payload["text"] = text.GetString();
                if (input.TryGetValue("key", out var key) && key.ValueKind == JsonValueKind.String)
                    payload["key"] = key.GetString();
                if (input.TryGetValue("hotkey", out var hotkey) && hotkey.ValueKind == JsonValueKind.Array)
                {
                    var hotkeyArray = new JsonArray();
                    foreach (var item in hotkey.EnumerateArray())
                    {
                        if (item.ValueKind == JsonValueKind.String)
                            hotkeyArray.Add(item.GetString());
                    }
                    payload["hotkey"] = hotkeyArray;
                }
                var result = await InvokeElectronAsync(ctx, "desktop:input:type", [payload], token);
                return CreateDesktopInputResult(result);
            },
            RequiresApproval = (_, _) => true
        });

        _toolRegistry.Register(new ToolHandler
        {
            Definition = new ToolDefinition
            {
                Name = "DesktopScroll",
                Description = "Scroll the desktop, optionally after moving to an anchor point.",
                InputSchema = ParseSchema("""
                {
                  "type": "object",
                  "properties": {
                    "x": { "type": "number" },
                    "y": { "type": "number" },
                    "scrollX": { "type": "number" },
                    "scrollY": { "type": "number" }
                  },
                  "additionalProperties": false
                }
                """)
            },
            Execute = async (input, ctx, token) =>
            {
                var payload = new JsonObject();
                if (GetOptionalDouble(input, "x") is { } x) payload["x"] = x;
                if (GetOptionalDouble(input, "y") is { } y) payload["y"] = y;
                if (GetOptionalDouble(input, "scrollX") is { } scrollX) payload["scrollX"] = scrollX;
                if (GetOptionalDouble(input, "scrollY") is { } scrollY) payload["scrollY"] = scrollY;
                var result = await InvokeElectronAsync(ctx, "desktop:input:scroll", [payload], token);
                return CreateDesktopInputResult(result);
            },
            RequiresApproval = (_, _) => true
        });

        _toolRegistry.Register(new ToolHandler
        {
            Definition = new ToolDefinition
            {
                Name = "DesktopWait",
                Description = "Wait briefly before the next desktop action.",
                InputSchema = ParseSchema("""
                {
                  "type": "object",
                  "properties": {
                    "durationMs": { "type": "number" }
                  },
                  "additionalProperties": false
                }
                """)
            },
            Execute = async (input, _, token) =>
            {
                var durationMs = GetOptionalInt(input, "durationMs") ?? 0;
                await Task.Delay(Math.Clamp(durationMs, 0, 10000), token);
                return new ToolResultContent
                {
                    Content = BuildJsonObject(new Dictionary<string, JsonNode?>
                    {
                        ["success"] = JsonValue.Create(true),
                        ["durationMs"] = JsonValue.Create(Math.Clamp(durationMs, 0, 10000))
                    })
                };
            },
            RequiresApproval = (_, _) => true
        });

        // NOTE: Stage 1 — the top-level agent loop now auto-bridges unknown
        // tools to the renderer via ToolRegistry.Execute's dynamic fallback,
        // so newly added JS-only tools (MCP, plugins, WebFetch, etc.) no
        // longer require a sidecar update. The static registrations below
        // are still used by SubAgentRunner (SubAgents/SubAgentRunner.cs:422
        // reads _toolRegistry.GetDefinitions() to resolve sub-agent tool
        // allowlists) and must stay until sub-agent tool resolution is
        // refactored to use the parent request's Tools list (Stage 6).
        RegisterRendererBridgedTool("TaskCreate", "Create a task for the current session.", ParseSchema("""{"type":"object","properties":{"subject":{"type":"string"},"description":{"type":"string"},"activeForm":{"type":"string"},"metadata":{"type":"object"}},"required":["subject","description"]}"""));
        RegisterRendererBridgedTool("TaskGet", "Retrieve a task by its ID.", ParseSchema("""{"type":"object","properties":{"taskId":{"type":"string"}},"required":["taskId"]}"""));
        RegisterRendererBridgedTool("TaskUpdate", "Update a task.", ParseSchema("""{"type":"object","properties":{"taskId":{"type":"string"},"subject":{"type":"string"},"description":{"type":"string"},"activeForm":{"type":"string"},"status":{"type":"string"},"addBlocks":{"type":"array","items":{"type":"string"}},"addBlockedBy":{"type":"array","items":{"type":"string"}},"owner":{"type":"string"},"metadata":{"type":"object"}},"required":["taskId"]}"""));
        RegisterRendererBridgedTool("TaskList", "List all tasks in the current session.", ParseSchema("""{"type":"object","properties":{}}"""));
        RegisterRendererBridgedTool("AskUserQuestion", "Ask the user questions during execution.", ParseSchema("""{"type":"object","properties":{"questions":{"type":"array"},"metadata":{"type":"object"}},"required":["questions"]}"""));
        RegisterRendererBridgedTool("EnterPlanMode", "Enter plan mode.", ParseSchema("""{"type":"object","properties":{"reason":{"type":"string"}}}"""));
        RegisterRendererBridgedTool("SavePlan", "Save the current plan content.", ParseSchema("""{"type":"object","properties":{"title":{"type":"string"},"content":{"type":"string"}},"required":["content"]}"""));
        RegisterRendererBridgedTool("ExitPlanMode", "Exit plan mode.", ParseSchema("""{"type":"object","properties":{}}"""));
        RegisterRendererBridgedTool("visualize_show_widget", "Show visual content — SVG graphics, diagrams, charts, or interactive HTML widgets — that renders inline alongside your text response.\nUse for flowcharts, architecture diagrams, dashboards, forms, calculators, data tables, games, illustrations, or any visual content.\nThe code is auto-detected: starts with <svg = SVG mode, otherwise HTML mode.\nA global sendPrompt(text) function is available — it sends a message to chat as if the user typed it.\nIMPORTANT: Call read_me before your first show_widget call.", ParseSchema("""
                {
                  "type": "object",
                  "properties": {
                    "title": {
                      "type": "string",
                      "description": "Short snake_case identifier for this visual. Must be specific and disambiguating."
                    },
                    "loading_messages": {
                      "type": "array",
                      "description": "1-4 loading messages shown to the user while the visual renders.",
                      "minItems": 1,
                      "maxItems": 4,
                      "items": { "type": "string" }
                    },
                    "widget_code": {
                      "type": "string",
                      "description": "SVG or HTML code to render. For SVG: raw SVG code starting with <svg> tag. For HTML: raw HTML content without DOCTYPE, <html>, <head>, or <body> tags."
                    }
                  },
                  "required": ["loading_messages", "title", "widget_code"]
                }
                """));
        RegisterRendererBridgedTool("Notify", "Send a desktop notification to the user.", ParseSchema("""{"type":"object","properties":{"title":{"type":"string"},"body":{"type":"string"},"type":{"type":"string"},"duration":{"type":"number"}},"required":["title","body"]}"""));
        RegisterRendererBridgedTool("CronAdd", "Create a scheduled cron job.", ParseSchema("""{"type":"object","properties":{"name":{"type":"string"},"schedule":{"type":"object"},"prompt":{"type":"string"}},"required":["name","schedule","prompt"]}"""));
        RegisterRendererBridgedTool("CronUpdate", "Update an existing cron job.", ParseSchema("""{"type":"object","properties":{"jobId":{"type":"string"},"patch":{"type":"object"}},"required":["jobId","patch"]}"""));
        RegisterRendererBridgedTool("CronRemove", "Remove a scheduled cron job.", ParseSchema("""{"type":"object","properties":{"jobId":{"type":"string"}},"required":["jobId"]}"""));
        RegisterRendererBridgedTool("CronList", "List scheduled cron jobs.", ParseSchema("""{"type":"object","properties":{}}"""));
        _toolRegistry.Register(new ToolHandler
        {
            Definition = new ToolDefinition
            {
                Name = "Task",
                Description = """
Launch a new agent to handle complex, multi-step tasks autonomously.

The Task tool launches specialized agents (sub-agents) that autonomously handle complex tasks. Each agent type has its own focused system prompt and tool allowlist. Use "custom" for a general-purpose sub-agent with broad tool access except Task and AskUserQuestion and a built-in default system prompt — you only supply the task via "prompt".

When using the Task tool, you MUST specify a "subagent_type" parameter to select which agent type to use.

When NOT to use the Task tool:
- If you want to read a specific file path, use the Read or Glob tool instead.
- If you are searching for a specific class definition, use the Glob tool instead.
- If you are searching for code within a specific file or set of 2-3 files, use the Read tool instead.

Usage notes:
- Always include a short description (3-5 words) summarizing what the agent will do.
- Launch multiple agents concurrently whenever possible, by sending a single assistant message with multiple Task tool_use blocks.
- When the sub-agent is done, it will return a single message back to you. The result is not visible to the user — send a concise text summary back to the user after the agent returns.
- Each sub-agent invocation is stateless and does not see the current conversation history, so write self-contained prompts.
- Clearly tell the sub-agent whether you expect it to write code or just do research.
- The sub-agent's outputs should generally be trusted.
- Set "run_in_background": true to spawn a teammate that runs independently. Your turn ends after spawning; you will be notified automatically when the teammate finishes. Background mode requires an active team (TeamCreate).
""",
                InputSchema = ParseSchema("""{"type":"object","properties":{"subagent_type":{"type":"string","description":"The sub-agent type to use. Use \"custom\" for a general-purpose sub-agent with broad tool access except Task and AskUserQuestion and a built-in default system prompt — you only supply the task via prompt."},"description":{"type":"string","description":"A short (3-5 word) description of the task"},"prompt":{"type":"string","description":"The task for the agent to perform"},"model":{"type":"string","description":"Optional model override for this agent."},"resume":{"type":"string"},"readonly":{"type":"boolean"},"attachments":{"type":"array","items":{"type":"string"}},"run_in_background":{"type":"boolean","description":"Set to true to run this agent in the background as a teammate. Requires an active team (TeamCreate)."}},"required":["subagent_type","description","prompt"]}""")
            },
            Execute = ExecuteTaskToolAsync,
            RequiresApproval = (input, _) => GetOptionalBool(input, "run_in_background") == true
        });
        RegisterRendererBridgedTool("Skill", "Load a skill by name.", ParseSchema("""{"type":"object","properties":{"SkillName":{"type":"string"}},"required":["SkillName"]}"""));
        RegisterRendererBridgedTool("ImageGenerate", "Generate images from a complete visual prompt.", ParseSchema("""{"type":"object","properties":{"prompt":{"type":"string"},"count":{"type":"number"}},"required":["prompt"]}"""));
    }

    private void RegisterRendererBridgedTool(string name, string description, JsonElement inputSchema)
    {
        _toolRegistry.Register(new ToolHandler
        {
            Definition = new ToolDefinition
            {
                Name = name,
                Description = description,
                InputSchema = inputSchema
            },
            Execute = (input, ctx, token) => InvokeRendererToolAsync(ctx, name, input, token),
            RequiresApproval = (_, _) => false
        });
    }

    private static JsonElement ParseSchema(string json)
    {
        using var doc = JsonDocument.Parse(json);
        return doc.RootElement.Clone();
    }

    private static JsonObject BuildJsonObject(IEnumerable<KeyValuePair<string, JsonNode?>> properties)
    {
        var obj = new JsonObject();
        foreach (var property in properties)
        {
            obj[property.Key] = property.Value;
        }
        return obj;
    }

    private static JsonArray BuildJsonArray(IEnumerable<JsonNode?> items)
    {
        var array = new JsonArray();
        foreach (var item in items)
        {
            array.Add(item);
        }
        return array;
    }

    private static string GetString(Dictionary<string, JsonElement> input, string key, bool required = false)
    {
        if (!input.TryGetValue(key, out var value) || value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
        {
            if (required) throw new InvalidOperationException($"Missing required field: {key}");
            return string.Empty;
        }

        var text = value.GetString();
        if (required && string.IsNullOrWhiteSpace(text))
            throw new InvalidOperationException($"Missing required field: {key}");
        return text ?? string.Empty;
    }

    private static string GetFilePath(Dictionary<string, JsonElement> input, bool required = false)
    {
        var filePath = GetOptionalString(input, "file_path");
        if (!string.IsNullOrWhiteSpace(filePath))
            return filePath;

        if (required)
            throw new InvalidOperationException("Missing required field: file_path");

        return string.Empty;
    }

    private static string? GetOptionalString(Dictionary<string, JsonElement> input, string key)
    {
        if (!input.TryGetValue(key, out var value) || value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
            return null;
        return value.GetString();
    }

    private static int? GetOptionalInt(Dictionary<string, JsonElement> input, string key)
    {
        if (!input.TryGetValue(key, out var value) || value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
            return null;
        return value.ValueKind == JsonValueKind.Number ? value.GetInt32() : null;
    }

    private static bool? GetOptionalBool(Dictionary<string, JsonElement> input, string key)
    {
        if (!input.TryGetValue(key, out var value) || value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
            return null;
        return value.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            _ => null
        };
    }

    private static double? GetOptionalDouble(Dictionary<string, JsonElement> input, string key)
    {
        if (!input.TryGetValue(key, out var value) || value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
            return null;
        return value.ValueKind == JsonValueKind.Number ? value.GetDouble() : null;
    }

    private static string[]? GetOptionalStringArray(Dictionary<string, JsonElement> input, string key)
    {
        if (!input.TryGetValue(key, out var value) || value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
            return null;
        if (value.ValueKind != JsonValueKind.Array)
            return null;

        return value.EnumerateArray()
            .Where(static item => item.ValueKind == JsonValueKind.String)
            .Select(static item => item.GetString())
            .Where(static item => !string.IsNullOrWhiteSpace(item))
            .Cast<string>()
            .ToArray();
    }

    private static string BuildDefaultCustomSubAgentSystemPrompt(string? workingFolder)
    {
        var os = OperatingSystem.IsWindows() ? "Windows"
            : OperatingSystem.IsMacOS() ? "macOS"
            : OperatingSystem.IsLinux() ? "Linux"
            : "Unknown";
        var shell = OperatingSystem.IsWindows() ? "cmd.exe" : "/bin/sh";
        var folderLine = string.IsNullOrWhiteSpace(workingFolder)
            ? string.Empty
            : $"- Working Folder: `{workingFolder}`\n  All relative paths resolve against this folder. Use it as the default cwd for terminal commands run via the Bash tool.\n";

        return $"""
You are a specialized **OpenCoWork sub-agent**, dispatched by a parent agent to autonomously complete a single focused task.
OpenCoWork is developed by the **AIDotNet** team. You run with broad tool access except the `Task` and `AskUserQuestion` tools, plus full write permissions — the parent agent is responsible for deciding what to do; you are responsible for doing it correctly and terminating cleanly.
You are stateless: you do not see earlier conversation history. Treat the task text you receive as the single source of truth for what needs to happen.

## Environment
- Execution Target: Local Machine
- Operating System: {os}
- Shell: {shell}
{folderLine}
<communication_style>
Be terse and direct. Focus on the task. Do not narrate, do not ask the parent for confirmation, do not restate what the parent already knows.
- Think before acting: understand intent, locate relevant files, plan minimal changes, then verify.
- Make no ungrounded assertions; state uncertainty explicitly when stuck.
- Do not start responses with praise or acknowledgment phrases. Start with substance.
- Do not add or remove comments or documentation unless the task asks for it.
</communication_style>

<tool_calling>
Use tools decisively. You have access to every tool the main agent has except `Task` and `AskUserQuestion`.
- Follow tool schemas exactly and provide required parameters.
- Batch independent tool calls in parallel; keep sequential only when dependent.
- Use Glob/Grep/Read before assuming project structure.
- Prefer the dedicated tool over Bash: Read for files, Edit for in-place changes, Glob for filename search, Grep for content search.
- Do not use Bash for `cat`, `head`, `tail`, `grep`, or `find` — use Read/Grep/Glob instead.
- Do not fabricate file contents or tool outputs.
</tool_calling>

<making_code_changes>
- Always read a file before editing it.
- Prefer minimal, surgical edits with Edit over rewriting with Write.
- Match the codebase's naming, formatting, and conventions.
- Ensure every change is complete: imports, types, error handling.
- Avoid over-engineering; do only what the task asks.
- Never introduce security vulnerabilities or hardcode secrets.
- Never modify files you have not read.
</making_code_changes>

<running_commands>
You can run terminal commands on the user's machine.
- Use the Bash tool to run terminal commands; never include `cd` in the command. Set `cwd` instead.
- The Bash tool name does not guarantee bash syntax; follow the shell shown in the Environment section.
- Check for existing dev servers before starting new ones.
- Never delete unrelated files, install system packages, or expose secrets in output.
</running_commands>

<session_termination>
When the task is complete you MUST call the `SubmitReport` tool exactly once to end this sub-agent session.
- Do NOT stop by simply emitting an assistant message — plain-text endings are treated as "session ran out" and trigger a fallback synthesis you cannot control.
- Do NOT call `SubmitReport` with an empty `report` argument; empty submissions are rejected.
- After calling `SubmitReport`, do NOT call any other tools.
- Even if the task turns out infeasible or nothing was found, submit a short report explaining why instead of leaving the session dangling.
- Write the report in the same language as the task.
- Structure the `report` argument with: ## Conclusion / ## Key Findings / ## Evidence / ## Risks & Unknowns / ## Next Steps
</session_termination>
""";
    }

    private static string ResolvePath(string rawPath, string workingFolder)
    {
        if (Path.IsPathRooted(rawPath))
            return Path.GetFullPath(rawPath);
        return Path.GetFullPath(Path.Combine(string.IsNullOrWhiteSpace(workingFolder) ? Environment.CurrentDirectory : workingFolder, rawPath));
    }

    private static string BuildEditNotFoundMessage(string content, string oldString)
    {
        return "old_string not found in file";
    }

    private static async Task<ShellCommandExecutionResult> ExecuteShellCommandAsync(
        string command,
        string? workingFolder,
        int timeoutMs,
        CancellationToken ct)
    {
        var isWindows = OperatingSystem.IsWindows();
        var shell = isWindows ? (Environment.GetEnvironmentVariable("ComSpec")?.Trim() ?? "cmd.exe") : "/bin/sh";
        var startInfo = new System.Diagnostics.ProcessStartInfo
        {
            FileName = shell,
            WorkingDirectory = string.IsNullOrWhiteSpace(workingFolder) ? Environment.CurrentDirectory : workingFolder,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8
        };
        if (isWindows)
        {
            startInfo.ArgumentList.Add("/d");
            startInfo.ArgumentList.Add("/s");
            startInfo.ArgumentList.Add("/c");
            startInfo.ArgumentList.Add(command);
        }
        else
        {
            startInfo.ArgumentList.Add("-c");
            startInfo.ArgumentList.Add(command);
        }
        startInfo.Environment["PYTHONIOENCODING"] = "utf-8";
        startInfo.Environment["PYTHONUTF8"] = "1";
        startInfo.Environment["PYTHONUNBUFFERED"] = "1";

        var overallStopwatch = Stopwatch.StartNew();
        using var process = new System.Diagnostics.Process { StartInfo = startInfo };
        var spawnStopwatch = Stopwatch.StartNew();
        process.Start();
        spawnStopwatch.Stop();

        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        var stderrTask = process.StandardError.ReadToEndAsync();
        using var timeoutCts = new CancellationTokenSource(timeoutMs);
        using var waitCts = CancellationTokenSource.CreateLinkedTokenSource(ct, timeoutCts.Token);

        try
        {
            await process.WaitForExitAsync(waitCts.Token);
        }
        catch (OperationCanceledException) when (timeoutCts.IsCancellationRequested)
        {
            TryKillProcessTree(process);
            await WaitForExitSafelyAsync(process).ConfigureAwait(false);
            var timeoutStdout = await stdoutTask.ConfigureAwait(false);
            var timeoutStderr = await stderrTask.ConfigureAwait(false);
            overallStopwatch.Stop();
            return new ShellCommandExecutionResult(
                124,
                timeoutStdout,
                $"{timeoutStderr}\n[Timed out after {timeoutMs}ms]".Trim(),
                shell,
                overallStopwatch.ElapsedMilliseconds,
                spawnStopwatch.ElapsedMilliseconds,
                TimedOut: true,
                Aborted: false);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            TryKillProcessTree(process);
            await WaitForExitSafelyAsync(process).ConfigureAwait(false);
            var abortedStdout = await stdoutTask.ConfigureAwait(false);
            var abortedStderr = await stderrTask.ConfigureAwait(false);
            overallStopwatch.Stop();
            return new ShellCommandExecutionResult(
                130,
                abortedStdout,
                $"{abortedStderr}\n[Aborted]".Trim(),
                shell,
                overallStopwatch.ElapsedMilliseconds,
                spawnStopwatch.ElapsedMilliseconds,
                TimedOut: false,
                Aborted: true);
        }

        var stdout = await stdoutTask.ConfigureAwait(false);
        var stderr = await stderrTask.ConfigureAwait(false);
        overallStopwatch.Stop();
        return new ShellCommandExecutionResult(
            process.ExitCode,
            stdout,
            stderr,
            shell,
            overallStopwatch.ElapsedMilliseconds,
            spawnStopwatch.ElapsedMilliseconds,
            TimedOut: false,
            Aborted: false);
    }

    private static void TryKillProcessTree(System.Diagnostics.Process process)
    {
        try
        {
            if (!process.HasExited)
                process.Kill(entireProcessTree: true);
        }
        catch
        {
        }
    }

    private static async Task WaitForExitSafelyAsync(System.Diagnostics.Process process)
    {
        try
        {
            await process.WaitForExitAsync(CancellationToken.None).ConfigureAwait(false);
        }
        catch
        {
        }
    }

    private static bool IsWithinWorkingFolder(string path, string workingFolder)
    {
        if (string.IsNullOrWhiteSpace(workingFolder)) return false;
        var root = Path.GetFullPath(workingFolder).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var full = Path.GetFullPath(path);
        return full.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
            || string.Equals(full, root, StringComparison.OrdinalIgnoreCase);
    }

    private static string BuildErrorMessage(Exception ex)
    {
        var message = string.IsNullOrWhiteSpace(ex.Message) ? ex.GetType().Name : ex.Message.Trim();
        var innerMessages = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var current = ex.InnerException;

        while (current is not null && innerMessages.Count < 3)
        {
            var currentMessage = string.IsNullOrWhiteSpace(current.Message)
                ? current.GetType().Name
                : current.Message.Trim();

            if (!string.Equals(currentMessage, message, StringComparison.Ordinal) && seen.Add(currentMessage))
                innerMessages.Add($"{current.GetType().Name}: {currentMessage}");

            current = current.InnerException;
        }

        return innerMessages.Count == 0
            ? message
            : $"{message} | {string.Join(" | ", innerMessages)}";
    }

    private static string? BuildErrorDetails(Exception ex)
    {
        var lines = new List<string>();
        var current = ex;
        var depth = 0;

        while (current is not null && depth < 5)
        {
            var message = string.IsNullOrWhiteSpace(current.Message)
                ? current.GetType().Name
                : current.Message.Trim();
            var label = depth == 0 ? "Error" : $"Inner[{depth}]";
            lines.Add($"{label}: {current.GetType().Name}: {message}");
            current = current.InnerException;
            depth++;
        }

        return lines.Count > 1 ? string.Join(Environment.NewLine, lines) : null;
    }

    private async Task SendAgentEventAsync(string runId, AgentEvent evt, CancellationToken ct)
    {
        try
        {
            await _transport.SendNotificationAsync("agent/event", new AgentEventNotification
            {
                RunId = runId,
                Event = SerializeAgentEvent(evt)
            }, ct);
            Console.Error.WriteLine($"[{DateTimeOffset.Now:HH:mm:ss.fff}] [AgentRuntime] event sent runId={runId} {DescribeAgentEvent(evt)}");
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[{DateTimeOffset.Now:HH:mm:ss.fff}] [AgentRuntime] event send failed runId={runId} {DescribeAgentEvent(evt)}: {ex}");
            throw;
        }
    }

    private static string DescribeAgentEvent(AgentEvent evt)
    {
        if (evt is RequestDebugEvent requestDebug)
        {
            var details = new List<string> { "type=request_debug" };
            if (!string.IsNullOrWhiteSpace(requestDebug.DebugInfo.Transport))
                details.Add($"transport={requestDebug.DebugInfo.Transport}");
            if (!string.IsNullOrWhiteSpace(requestDebug.DebugInfo.FallbackReason))
                details.Add($"fallbackReason={requestDebug.DebugInfo.FallbackReason}");
            if (requestDebug.DebugInfo.ReusedConnection is bool reusedConnection)
                details.Add($"reusedConnection={reusedConnection.ToString().ToLowerInvariant()}");
            if (!string.IsNullOrWhiteSpace(requestDebug.DebugInfo.WebsocketRequestKind))
                details.Add($"websocketRequestKind={requestDebug.DebugInfo.WebsocketRequestKind}");
            if (!string.IsNullOrWhiteSpace(requestDebug.DebugInfo.WebsocketIncrementalReason))
                details.Add($"websocketIncrementalReason={requestDebug.DebugInfo.WebsocketIncrementalReason}");
            if (!string.IsNullOrWhiteSpace(requestDebug.DebugInfo.PreviousResponseId))
                details.Add($"previousResponseId={requestDebug.DebugInfo.PreviousResponseId}");
            if (!string.IsNullOrWhiteSpace(requestDebug.DebugInfo.Url))
                details.Add($"url={requestDebug.DebugInfo.Url}");
            return string.Join(" ", details);
        }

        return $"type={evt.Type}";
    }

    private async Task<string?> RunFallbackReportAsync(
        List<UnifiedMessage> capturedMessages,
        ILlmProvider provider,
        ProviderConfig config,
        ToolContext toolContext,
        CancellationToken ct)
    {
        var reportRequestMessage = new UnifiedMessage
        {
            Role = "user",
            CreatedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            Content = new List<ContentBlock> { new TextBlock { Text = DefaultFallbackReportPrompt } },
            RawContent = JsonSerializer.SerializeToElement(DefaultFallbackReportPrompt, AppJsonContext.Default.String)
        };

        var replayMessages = new List<UnifiedMessage>(capturedMessages.Count + 1);
        replayMessages.AddRange(capturedMessages);
        replayMessages.Add(reportRequestMessage);

        var followUpConfig = new AgentLoopRunConfig
        {
            Provider = provider,
            ProviderConfig = config,
            Tools = new List<ToolDefinition>(),
            ToolRegistry = _toolRegistry,
            ToolContext = toolContext,
            MaxIterations = 1,
            EnableParallelToolExecution = false,
            CaptureFinalMessages = null,
            Compression = null,
            SessionMode = "chat"
        };

        var reportText = new StringBuilder();
        await foreach (var evt in AgentLoop.RunAsync(replayMessages, followUpConfig, onApproval: null, ct))
        {
            if (evt is TextDeltaEvent textEvt)
            {
                reportText.Append(textEvt.Text);
            }
        }

        var text = reportText.ToString().Trim();
        return text.Length > 0 ? text : null;
    }

    private static JsonElement SerializeAgentEvent(AgentEvent evt)
    {
        var node = JsonSerializer.SerializeToNode(evt, AppJsonContext.Default.AgentEvent)?.AsObject()
            ?? throw new InvalidOperationException($"Failed to serialize agent event {evt.GetType().Name}");

        if (!node.ContainsKey("type"))
            node["type"] = evt.Type;

        using var doc = JsonDocument.Parse(node.ToJsonString());
        return doc.RootElement.Clone();
    }

    private ApprovalHandler CreateApprovalHandler(string runId, string sessionId, CancellationToken ct)
    {
        return async toolCall =>
        {
            var response = await _sendRequestAsync("approval/request", new ApprovalRequestParams
            {
                RunId = runId,
                SessionId = sessionId,
                ToolCall = toolCall
            }, ct, TimeSpan.FromMinutes(10));

            if (response is null)
                return false;

            var parsed = JsonSerializer.Deserialize(response.Value, AppJsonContext.Default.ApprovalResponseResult);
            return parsed?.Approved == true;
        };
    }

    private async Task<ToolResultContent> ExecuteTaskToolAsync(
        Dictionary<string, JsonElement> input,
        ToolContext ctx,
        CancellationToken ct)
    {
        if (GetOptionalBool(input, "run_in_background") == true)
        {
            return await InvokeRendererToolAsync(ctx, "Task", input, ct);
        }

        var subAgentName = GetString(input, "subagent_type", required: true);
        var isCustom = string.Equals(subAgentName, "custom", StringComparison.Ordinal);
        SubAgentDefinition? definition;
        if (isCustom)
        {
            definition = new SubAgentDefinition
            {
                Name = "custom",
                Description = GetOptionalString(input, "description") ?? "Custom sub-agent",
                SystemPrompt = BuildDefaultCustomSubAgentSystemPrompt(ctx.WorkingFolder),
                Tools = new List<string> { "*" },
                DisallowedTools = new List<string> { "Task", "AskUserQuestion" },
                MaxTurns = SubAgentDefinition.DefaultMaxTurns,
                Model = GetOptionalString(input, "model")
            };
        }
        else
        {
            definition = await GetSubAgentDefinitionAsync(ctx, subAgentName, ct);
            if (definition is null)
            {
                return new ToolResultContent
                {
                    Content = BuildJsonObject(new Dictionary<string, JsonNode?>
                    {
                        ["error"] = JsonValue.Create($"Unknown subagent_type \"{subAgentName}\".")
                    })
                };
            }
        }

        if (ctx.ProviderConfig is null)
            throw new InvalidOperationException("Provider config is unavailable for sub-agent execution.");

        var runScopeId = ctx.AgentRunId ?? ctx.SessionId;
        var currentToolUseId = ctx.CurrentToolUseId ?? string.Empty;
        var dedupKey = BuildTaskDedupKey(input);
        if (_lastTaskInvocationBySession.TryGetValue(ctx.SessionId, out var lastInvocation)
            && string.Equals(lastInvocation.RunId, runScopeId, StringComparison.Ordinal)
            && string.Equals(lastInvocation.Key, dedupKey, StringComparison.Ordinal)
            && !string.Equals(lastInvocation.ToolUseId, currentToolUseId, StringComparison.Ordinal))
        {
            return new ToolResultContent
            {
                Content = BuildJsonObject(new Dictionary<string, JsonNode?>
                {
                    ["error"] = JsonValue.Create(
                        $"Duplicate Task call blocked: the previous Task invocation to \"{subAgentName}\" used an identical prompt and already returned a report. " +
                        "Do NOT re-launch the same sub-agent with the same prompt. Use the previous report below to continue your work, or call Task with a different sub-agent " +
                        "or a materially different prompt if you need new information."),
                    ["previous_report"] = JsonValue.Create(lastInvocation.Output)
                })
            };
        }

        var provider = CreateProvider(ctx.ProviderConfig, ctx.AgentRunId ?? ctx.SessionId);
        // Custom sub-agents are defined inline by the parent agent and
        // auto-approve every tool call they are still allowed to make.
        ApprovalHandler approvalHandler = isCustom
            ? (_ => Task.FromResult(true))
            : CreateApprovalHandler(ctx.AgentRunId ?? ctx.SessionId, ctx.SessionId, ct);
        var result = await _subAgentRunner.RunAsync(definition, input, provider, ctx.ProviderConfig, ctx, approvalHandler, ct);

        if (!result.Result.Success)
        {
            return new ToolResultContent
            {
                Content = BuildJsonObject(new Dictionary<string, JsonNode?>
                {
                    ["error"] = JsonValue.Create(result.Result.Error ?? "Sub-agent failed"),
                    ["result"] = string.IsNullOrWhiteSpace(result.Result.Output)
                        ? null
                        : JsonValue.Create(result.Result.Output)
                })
            };
        }

        _lastTaskInvocationBySession[ctx.SessionId] = new LastTaskInvocation(
            runScopeId,
            dedupKey,
            result.Result.Output,
            currentToolUseId);

        return new ToolResultContent
        {
            Content = result.Result.Output
        };
    }

    private async Task<SubAgentDefinition?> GetSubAgentDefinitionAsync(
        ToolContext ctx,
        string name,
        CancellationToken ct)
    {
        if (_subAgentRunner.Get(name) is { } cached)
            return cached;

        var response = await InvokeElectronAsync(ctx, "agents:list", Array.Empty<object?>(), ct);
        if (response.ValueKind != JsonValueKind.Array)
            return null;

        foreach (var item in response.EnumerateArray())
        {
            var definition = ParseSubAgentDefinition(item);
            if (definition is null)
                continue;
            _subAgentRunner.Register(definition);
        }

        return _subAgentRunner.Get(name);
    }

    private static SubAgentDefinition? ParseSubAgentDefinition(JsonElement element)
    {
        if (!element.TryGetProperty("name", out var nameValue) || nameValue.ValueKind != JsonValueKind.String)
            return null;
        if (!element.TryGetProperty("systemPrompt", out var systemPromptValue) || systemPromptValue.ValueKind != JsonValueKind.String)
            return null;

        var tools = GetOptionalStringArray(element, "tools")
            ?? GetOptionalStringArray(element, "allowedTools")
            ?? new[] { "Read", "Glob", "Grep", "LS", "Bash" };
        var maxTurns = GetOptionalInt(element, "maxTurns") ?? GetOptionalInt(element, "maxIterations") ?? 0;

        return new SubAgentDefinition
        {
            Name = nameValue.GetString()!,
            Description = GetString(element, "description"),
            SystemPrompt = systemPromptValue.GetString(),
            Tools = tools.ToList(),
            DisallowedTools = (GetOptionalStringArray(element, "disallowedTools") ?? Array.Empty<string>()).ToList(),
            MaxTurns = SubAgentDefinition.ResolveMaxTurns(maxTurns),
            InitialPrompt = GetString(element, "initialPrompt"),
            Model = GetString(element, "model"),
            Temperature = GetOptionalDouble(element, "temperature")
        };
    }

    private Func<string, IReadOnlyList<object?>?, CancellationToken, Task<JsonElement?>> CreateElectronInvokeHandler(CancellationToken runCt)
    {
        return async (channel, args, token) =>
        {
            var linked = CancellationTokenSource.CreateLinkedTokenSource(runCt, token);
            var payload = new ElectronInvokeParams
            {
                Channel = channel,
                Args = args?.Select(ArgToJsonElement).ToList()
            };
            var response = await _sendRequestAsync("electron/invoke", payload, linked.Token, TimeSpan.FromMinutes(2));
            return response;
        };
    }

    /// <summary>
    /// Convert an arbitrary invoke argument to a JsonElement without going through
    /// reflection-based serialization (disabled in this app). JsonNode/JsonElement
    /// pass through directly; primitives use their registered JsonTypeInfo; unknown
    /// types are rendered as strings.
    /// </summary>
    private static JsonElement ArgToJsonElement(object? arg)
    {
        switch (arg)
        {
            case null:
                return JsonSerializer.SerializeToElement<string?>(null, AppJsonContext.Default.String);
            case JsonElement element:
                return element.Clone();
            case JsonNode node:
            {
                using var doc = JsonDocument.Parse(node.ToJsonString());
                return doc.RootElement.Clone();
            }
            case string text:
                return JsonSerializer.SerializeToElement(text, AppJsonContext.Default.String);
            case bool boolean:
                return JsonSerializer.SerializeToElement(boolean, AppJsonContext.Default.Boolean);
            case int int32:
                return JsonSerializer.SerializeToElement(int32, AppJsonContext.Default.Int32);
            case long int64:
                return JsonSerializer.SerializeToElement(int64, AppJsonContext.Default.Int64);
            case double float64:
                return JsonSerializer.SerializeToElement(float64, AppJsonContext.Default.Double);
            case Dictionary<string, JsonElement> dict:
                return JsonSerializer.SerializeToElement(dict, AppJsonContext.Default.DictionaryStringJsonElement);
            case Dictionary<string, object?> dictObj:
                return JsonSerializer.SerializeToElement(dictObj, AppJsonContext.Default.DictionaryStringObject);
            default:
                return JsonSerializer.SerializeToElement(
                    arg.ToString() ?? string.Empty,
                    AppJsonContext.Default.String);
        }
    }

    private Func<string, Dictionary<string, JsonElement>, ToolContext, CancellationToken, Task<JsonElement?>> CreateRendererToolInvokeHandler(string runId, CancellationToken runCt)
    {
        return async (toolName, input, ctx, token) =>
        {
            var linked = CancellationTokenSource.CreateLinkedTokenSource(runCt, token);
            var payload = new RendererToolRequestParams
            {
                ToolName = toolName,
                Input = input,
                SessionId = ctx.SessionId,
                WorkingFolder = ctx.WorkingFolder,
                CurrentToolUseId = ctx.CurrentToolUseId,
                AgentRunId = ctx.AgentRunId ?? runId,
                PluginId = ctx.PluginId,
                PluginChatId = ctx.PluginChatId,
                PluginChatType = ctx.PluginChatType,
                PluginSenderId = ctx.PluginSenderId,
                PluginSenderName = ctx.PluginSenderName,
                SshConnectionId = ctx.SshConnectionId
            };
            return await _sendRequestAsync("renderer/tool-request", payload, linked.Token, TimeSpan.FromMinutes(10));
        };
    }

    private Func<string, Dictionary<string, JsonElement>, ToolContext, CancellationToken, Task<bool>> CreateRendererToolRequiresApprovalHandler(string runId, CancellationToken runCt)
    {
        return async (toolName, input, ctx, token) =>
        {
            var response = await CreateRendererToolInvokeHandler(runId, runCt)(toolName + "#requiresApproval", input, ctx, token);
            if (response is null)
                return true;

            if (response.Value.ValueKind == JsonValueKind.True)
                return true;
            if (response.Value.ValueKind == JsonValueKind.False)
                return false;
            if (response.Value.ValueKind == JsonValueKind.Object && response.Value.TryGetProperty("requiresApproval", out var requiresApproval))
                return requiresApproval.ValueKind == JsonValueKind.True;

            return true;
        };
    }

    private static async Task<JsonElement> InvokeElectronAsync(ToolContext ctx, string channel, IReadOnlyList<object?> args, CancellationToken ct)
    {
        if (ctx.ElectronInvokeAsync is null)
            throw new InvalidOperationException("Electron invoke bridge is unavailable.");

        var response = await ctx.ElectronInvokeAsync(channel, args, ct);
        if (response is null)
            throw new InvalidOperationException($"Electron invoke returned no result for {channel}.");

        return response.Value;
    }

    private static async Task<ToolResultContent> InvokeRendererToolAsync(ToolContext ctx, string toolName, Dictionary<string, JsonElement> input, CancellationToken ct)
    {
        if (ctx.RendererToolInvokeAsync is null)
            throw new InvalidOperationException("Renderer tool bridge is unavailable.");

        var response = await ctx.RendererToolInvokeAsync(toolName, input, ctx, ct);
        if (response is null)
            throw new InvalidOperationException($"Renderer tool invoke returned no result for {toolName}.");

        var parsed = JsonSerializer.Deserialize(response.Value, AppJsonContext.Default.RendererToolResponseResult);
        if (parsed is null)
            throw new InvalidOperationException($"Renderer tool invoke returned invalid result for {toolName}.");

        return new ToolResultContent
        {
            Content = parsed.Content?.Clone() ?? JsonSerializer.SerializeToElement(string.Empty, AppJsonContext.Default.JsonElement),
            IsError = parsed.IsError || !string.IsNullOrWhiteSpace(parsed.Error)
        };
    }

    private static ToolResultContent CreateDesktopInputResult(JsonElement result)
    {
        if (!GetBoolean(result, "success"))
        {
            return new ToolResultContent
            {
                Content = BuildJsonObject(new Dictionary<string, JsonNode?>
                {
                    ["error"] = JsonValue.Create(GetString(result, "error") ?? "Desktop operation failed.")
                }),
                IsError = true
            };
        }

        return new ToolResultContent
        {
            Content = JsonNode.Parse(result.GetRawText()) ?? JsonValue.Create(string.Empty)
        };
    }

    private static bool GetBoolean(JsonElement element, string propertyName)
    {
        if (!element.TryGetProperty(propertyName, out var value))
            return false;
        return value.ValueKind == JsonValueKind.True || (value.ValueKind == JsonValueKind.False ? false : value.GetBoolean());
    }

    private static string? GetString(JsonElement element, string propertyName)
    {
        if (!element.TryGetProperty(propertyName, out var value))
            return null;
        return value.ValueKind switch
        {
            JsonValueKind.String => value.GetString(),
            JsonValueKind.Number => value.GetRawText(),
            JsonValueKind.True => "true",
            JsonValueKind.False => "false",
            _ => null
        };
    }

    private static int? GetOptionalInt(JsonElement element, string propertyName)
    {
        if (!element.TryGetProperty(propertyName, out var value))
            return null;
        return value.ValueKind == JsonValueKind.Number ? value.GetInt32() : null;
    }

    private static double? GetOptionalDouble(JsonElement element, string propertyName)
    {
        if (!element.TryGetProperty(propertyName, out var value))
            return null;
        return value.ValueKind == JsonValueKind.Number ? value.GetDouble() : null;
    }

    private static string[]? GetOptionalStringArray(JsonElement element, string propertyName)
    {
        if (!element.TryGetProperty(propertyName, out var value) || value.ValueKind != JsonValueKind.Array)
            return null;

        return value.EnumerateArray()
            .Where(static item => item.ValueKind == JsonValueKind.String)
            .Select(static item => item.GetString())
            .Where(static item => !string.IsNullOrWhiteSpace(item))
            .Cast<string>()
            .ToArray();
    }

    private ILlmProvider CreateProvider(ProviderConfig config, string runId)
    {
        if (string.Equals(config.Mode, "bridged", StringComparison.OrdinalIgnoreCase))
            return new BridgedProvider(CreateBridgedProviderInvoker(runId));

        return config.Type switch
        {
            "anthropic" => new AnthropicProvider(_httpClientFactory),
            "openai-chat" => new OpenAiChatProvider(_httpClientFactory),
            "openai-responses" => new OpenAiResponsesProvider(_httpClientFactory),
            "gemini" => new GeminiProvider(_httpClientFactory),
            _ => new BridgedProvider(CreateBridgedProviderInvoker(runId))
        };
    }

    private Func<ProviderConfig, List<UnifiedMessage>, List<ToolDefinition>, CancellationToken, IAsyncEnumerable<StreamEvent>>
        CreateBridgedProviderInvoker(string runId)
    {
        return (config, messages, tools, ct) => InvokeBridgedProviderAsync(runId, config, messages, tools, ct);
    }

    private async IAsyncEnumerable<StreamEvent> InvokeBridgedProviderAsync(
        string runId,
        ProviderConfig config,
        List<UnifiedMessage> messages,
        List<ToolDefinition> tools,
        [EnumeratorCancellation] CancellationToken ct)
    {
        var streamId = Guid.NewGuid().ToString("N");
        var channel = Channel.CreateBounded<StreamEvent>(new BoundedChannelOptions(256)
        {
            FullMode = BoundedChannelFullMode.Wait,
            SingleReader = true,
            SingleWriter = false
        });

        _bridgedProviderStreams[streamId] = channel;

        var startParams = new BridgedProviderStreamStartParams
        {
            StreamId = streamId,
            ProviderType = config.Type,
            ProviderConfig = config,
            Messages = messages,
            Tools = tools,
            AgentRunId = runId
        };

        var startTask = _sendRequestAsync(
            "renderer/provider-stream-start",
            startParams,
            ct,
            TimeSpan.FromMinutes(10));

        // Start acknowledgement only confirms that the renderer accepted the stream setup.
        // Normal completion must come from an explicit provider/stream-event with Done=true;
        // otherwise long-running bridged streams can be cut off as soon as the start request returns.
        _ = startTask.ContinueWith(t =>
        {
            if (t.IsFaulted)
            {
                var inner = t.Exception?.GetBaseException();
                channel.Writer.TryComplete(inner);
            }
        }, TaskScheduler.Default);

        try
        {
            await foreach (var ev in channel.Reader.ReadAllAsync(ct))
            {
                yield return ev;
            }
        }
        finally
        {
            _bridgedProviderStreams.TryRemove(streamId, out _);
            try { await startTask.ConfigureAwait(false); } catch { /* already surfaced via channel or ct */ }
        }
    }

    /// <summary>
    /// Called by MessageRouter when a "provider/stream-event" notification arrives.
    /// Routes the event to the waiting bridged provider's channel by streamId.
    /// </summary>
    public Task HandleBridgedProviderStreamEventAsync(JsonElement? @params, CancellationToken ct)
    {
        if (!@params.HasValue)
            return Task.CompletedTask;

        var parsed = JsonSerializer.Deserialize(@params.Value, AppJsonContext.Default.BridgedProviderStreamEventParams);
        if (parsed is null || string.IsNullOrWhiteSpace(parsed.StreamId))
            return Task.CompletedTask;

        if (!_bridgedProviderStreams.TryGetValue(parsed.StreamId, out var channel))
            return Task.CompletedTask;

        if (parsed.Done)
        {
            if (!string.IsNullOrWhiteSpace(parsed.Error))
                channel.Writer.TryComplete(new InvalidOperationException(parsed.Error));
            else
                channel.Writer.TryComplete();
            return Task.CompletedTask;
        }

        if (parsed.Event is not null)
        {
            // Use TryWrite to avoid blocking the message pump; bounded channel will
            // drop-then-wait only under extreme backpressure, which we don't expect
            // for SSE-rate events.
            if (!channel.Writer.TryWrite(parsed.Event))
            {
                return channel.Writer.WriteAsync(parsed.Event, ct).AsTask();
            }
        }

        return Task.CompletedTask;
    }
}
