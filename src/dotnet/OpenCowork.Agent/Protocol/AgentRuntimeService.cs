using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using OpenCowork.Agent.Engine;
using OpenCowork.Agent.Providers;
using OpenCowork.Agent.Tools.Fs;

namespace OpenCowork.Agent.Protocol;

public sealed class AgentRuntimeService
{
    private readonly StdioJsonRpcTransport _transport;
    private readonly Func<string, object?, CancellationToken, TimeSpan?, Task<JsonElement?>> _sendRequestAsync;
    private readonly LlmHttpClientFactory _httpClientFactory = new();
    private readonly ToolRegistry _toolRegistry = new();
    private readonly ConcurrentDictionary<string, CancellationTokenSource> _activeRuns = new();
    private readonly ConcurrentDictionary<string, DateTimeOffset> _readFileHistory = new(StringComparer.OrdinalIgnoreCase);

    private static readonly string[] SupportedCapabilities =
    [
        "agent.run",
        "agent.cancel",
        "streaming",
        "tools",
        "tool.Read",
        "tool.Write",
        "tool.Edit",
        "tool.PatchEdit",
        "tool.Bash",
        "tool.Delete",
        "tool.Move",
        "tool.LS",
        "tool.Glob",
        "tool.Grep",
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
        "tool.OpenPreview",
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
        RegisterBuiltinTools();
    }

    public IReadOnlyList<string> GetCapabilities() => SupportedCapabilities;

    public bool SupportsCapability(string capability) =>
        SupportedCapabilities.Contains(capability, StringComparer.OrdinalIgnoreCase);

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
                var provider = CreateProvider(input.Provider);
                Console.Error.WriteLine($"[{DateTimeOffset.Now:HH:mm:ss.fff}] [AgentRuntime] provider created runId={runId} provider={input.Provider.Type}");

                var toolContext = new ToolContext
                {
                    SessionId = input.SessionId ?? runId,
                    WorkingFolder = input.WorkingFolder ?? Environment.CurrentDirectory,
                    CurrentToolUseId = null,
                    AgentRunId = runId,
                    ElectronInvokeAsync = CreateElectronInvokeHandler(runCts.Token),
                    RendererToolInvokeAsync = CreateRendererToolInvokeHandler(runId, runCts.Token),
                    RendererToolRequiresApprovalAsync = CreateRendererToolRequiresApprovalHandler(runId, runCts.Token),
                    ReadFileHistory = _readFileHistory
                };

                var loopConfig = new AgentLoopRunConfig
                {
                    Provider = provider,
                    ProviderConfig = input.Provider,
                    Tools = input.Tools,
                    ToolRegistry = _toolRegistry,
                    ToolContext = toolContext,
                    MaxIterations = input.MaxIterations,
                    ForceApproval = input.ForceApproval,
                    Compression = input.Compression,
                    EnableParallelToolExecution = true
                };

                var approvalHandler = CreateApprovalHandler(runId, toolContext.SessionId, runCts.Token);
                Console.Error.WriteLine($"[{DateTimeOffset.Now:HH:mm:ss.fff}] [AgentRuntime] entering agent loop runId={runId}");

                await foreach (var evt in AgentLoop.RunAsync(input.Messages, loopConfig, approvalHandler, runCts.Token))
                {
                    Console.Error.WriteLine($"[{DateTimeOffset.Now:HH:mm:ss.fff}] [AgentRuntime] event produced runId={runId} type={evt.Type}");
                    await SendAgentEventAsync(runId, evt, runCts.Token);
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
        RegisterRendererBridgedTool("Read", "Read a file from the filesystem", ParseSchema("""{"type":"object","properties":{"file_path":{"type":"string","description":"Absolute path or relative to the working folder"},"offset":{"type":"number","description":"Start line (1-indexed)"},"limit":{"type":"number","description":"Number of lines to read"}},"required":["file_path"]}"""));

        RegisterRendererBridgedTool("Write", "Write a file to the filesystem", ParseSchema("""
                {
                  "type": "object",
                  "properties": {
                    "file_path": { "type": "string", "description": "Absolute path or relative to the working folder" },
                    "content": { "type": "string", "description": "The content to write to the file" }
                  },
                  "required": ["file_path", "content"]
                }
                """));

        RegisterRendererBridgedTool("Edit", "Perform exact string replacements in files", ParseSchema("""{"type":"object","properties":{"file_path":{"type":"string","description":"Absolute path or relative to the working folder"},"old_string":{"type":"string","description":"The text to replace"},"new_string":{"type":"string","description":"The text to replace it with"},"replace_all":{"type":"boolean","description":"Replace all occurrences of old_string"}},"required":["file_path","old_string","new_string"]}"""));

        RegisterRendererBridgedTool("PatchEdit", "Apply a unified diff patch to an existing file", ParseSchema("""{"type":"object","properties":{"file_path":{"type":"string","description":"Absolute path or relative to the working folder"},"patch":{"type":"string","description":"Unified diff patch content for a single file"}},"required":["file_path","patch"]}"""));

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
                var command = GetString(input, "command", required: true);
                var timeoutMs = Math.Clamp(GetOptionalInt(input, "timeout") ?? 600000, 1, 3600000);
                var result = await AgentRuntimeService.ExecuteShellCommandAsync(command, ctx.WorkingFolder, timeoutMs, token);
                return new ToolResultContent
                {
                    Content = BuildJsonObject(new Dictionary<string, JsonNode?>
                    {
                        ["stdout"] = JsonValue.Create(result.Stdout),
                        ["stderr"] = JsonValue.Create(result.Stderr),
                        ["exitCode"] = JsonValue.Create(result.ExitCode)
                    }),
                    IsError = result.ExitCode != 0
                };
            },
            RequiresApproval = (_, _) => true
        });

        _toolRegistry.Register(new ToolHandler
        {
            Definition = new ToolDefinition
            {
                Name = "Delete",
                Description = "Delete a file or directory",
                InputSchema = ParseSchema("""
                {
                  "type": "object",
                  "properties": {
                    "path": { "type": "string", "description": "Absolute path or relative to the working folder" }
                  },
                  "required": ["path"]
                }
                """)
            },
            Execute = (input, ctx, _) =>
            {
                var path = ResolvePath(GetString(input, "path", required: true), ctx.WorkingFolder);
                FsOperations.Delete(path);
                return Task.FromResult(new ToolResultContent
                {
                    Content = BuildJsonObject(new Dictionary<string, JsonNode?>
                    {
                        ["success"] = JsonValue.Create(true),
                        ["path"] = JsonValue.Create(path)
                    })
                });
            },
            RequiresApproval = (input, ctx) => !IsWithinWorkingFolder(ResolvePath(GetString(input, "path", required: true), ctx.WorkingFolder), ctx.WorkingFolder)
        });

        _toolRegistry.Register(new ToolHandler
        {
            Definition = new ToolDefinition
            {
                Name = "Move",
                Description = "Move or rename a file or directory",
                InputSchema = ParseSchema("""
                {
                  "type": "object",
                  "properties": {
                    "source": { "type": "string", "description": "Source path" },
                    "destination": { "type": "string", "description": "Destination path" }
                  },
                  "required": ["source", "destination"]
                }
                """)
            },
            Execute = (input, ctx, _) =>
            {
                var source = ResolvePath(GetString(input, "source", required: true), ctx.WorkingFolder);
                var destination = ResolvePath(GetString(input, "destination", required: true), ctx.WorkingFolder);
                FsOperations.Move(source, destination);
                return Task.FromResult(new ToolResultContent
                {
                    Content = BuildJsonObject(new Dictionary<string, JsonNode?>
                    {
                        ["success"] = JsonValue.Create(true),
                        ["source"] = JsonValue.Create(source),
                        ["destination"] = JsonValue.Create(destination)
                    })
                });
            },
            RequiresApproval = (input, ctx) =>
                !IsWithinWorkingFolder(ResolvePath(GetString(input, "source", required: true), ctx.WorkingFolder), ctx.WorkingFolder) ||
                !IsWithinWorkingFolder(ResolvePath(GetString(input, "destination", required: true), ctx.WorkingFolder), ctx.WorkingFolder)
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
            Execute = (input, ctx, _) =>
            {
                var path = ResolvePath(GetOptionalString(input, "path") ?? ".", ctx.WorkingFolder);
                var ignore = GetOptionalStringArray(input, "ignore");
                var entries = FsOperations.ListDirectory(path, ignore: ignore)
                    .Select(entry => new
                    {
                        name = entry.Name,
                        type = entry.Type,
                        path = Path.Combine(path, entry.Name)
                    })
                    .ToList();
                return Task.FromResult(new ToolResultContent
                {
                    Content = BuildJsonArray(entries.Select(entry => (JsonNode)BuildJsonObject(new Dictionary<string, JsonNode?>
                    {
                        ["name"] = JsonValue.Create(entry.name),
                        ["type"] = JsonValue.Create(entry.type),
                        ["path"] = JsonValue.Create(entry.path)
                    })))
                });
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
            Execute = (input, ctx, _) =>
            {
                var directory = ResolvePath(GetOptionalString(input, "path") ?? ".", ctx.WorkingFolder);
                var pattern = GetString(input, "pattern", required: true);
                var results = GlobTool.Search(directory, pattern);
                return Task.FromResult(new ToolResultContent
                {
                    Content = BuildJsonArray(results.Select(static item => JsonValue.Create(item)))
                });
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
                var directory = ResolvePath(GetOptionalString(input, "path") ?? ".", ctx.WorkingFolder);
                var pattern = GetString(input, "pattern", required: true);
                var include = GetOptionalString(input, "include");
                var result = await GrepTool.SearchAsync(directory, pattern, new GrepOptions
                {
                    GlobPattern = include,
                    MaxResults = 200
                }, token);
                var lines = result.Matches.Select(match => $"{match.File}:{match.Line}:{match.Content}").ToList();
                return new ToolResultContent
                {
                    Content = BuildJsonArray(lines.Select(static item => JsonValue.Create(item)))
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
                        Content = JsonSerializer.Serialize(new { error = GetString(result, "error") ?? "Failed to capture desktop screenshot." }),
                        IsError = true
                    };
                }

                var data = GetString(result, "data");
                if (string.IsNullOrWhiteSpace(data))
                {
                    return new ToolResultContent
                    {
                        Content = JsonSerializer.Serialize(new { error = "Failed to capture desktop screenshot." }),
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

        RegisterRendererBridgedTool("TaskCreate", "Create a task for the current session.", ParseSchema("""{"type":"object","properties":{"subject":{"type":"string"},"description":{"type":"string"},"activeForm":{"type":"string"},"metadata":{"type":"object"}},"required":["subject","description"]}"""));
        RegisterRendererBridgedTool("TaskGet", "Retrieve a task by its ID.", ParseSchema("""{"type":"object","properties":{"taskId":{"type":"string"}},"required":["taskId"]}"""));
        RegisterRendererBridgedTool("TaskUpdate", "Update a task.", ParseSchema("""{"type":"object","properties":{"taskId":{"type":"string"},"subject":{"type":"string"},"description":{"type":"string"},"activeForm":{"type":"string"},"status":{"type":"string"},"addBlocks":{"type":"array","items":{"type":"string"}},"addBlockedBy":{"type":"array","items":{"type":"string"}},"owner":{"type":"string"},"metadata":{"type":"object"}},"required":["taskId"]}"""));
        RegisterRendererBridgedTool("TaskList", "List all tasks in the current session.", ParseSchema("""{"type":"object","properties":{}}"""));
        RegisterRendererBridgedTool("AskUserQuestion", "Ask the user questions during execution.", ParseSchema("""{"type":"object","properties":{"questions":{"type":"array"},"metadata":{"type":"object"}},"required":["questions"]}"""));
        RegisterRendererBridgedTool("EnterPlanMode", "Enter plan mode.", ParseSchema("""{"type":"object","properties":{"reason":{"type":"string"}}}"""));
        RegisterRendererBridgedTool("SavePlan", "Save the current plan content.", ParseSchema("""{"type":"object","properties":{"title":{"type":"string"},"content":{"type":"string"}},"required":["content"]}"""));
        RegisterRendererBridgedTool("ExitPlanMode", "Exit plan mode.", ParseSchema("""{"type":"object","properties":{}}"""));
        RegisterRendererBridgedTool("OpenPreview", "Open a file in the preview panel.", ParseSchema("""{"type":"object","properties":{"file_path":{"type":"string"},"view_mode":{"type":"string"}},"required":["file_path"]}"""));
        RegisterRendererBridgedTool("Notify", "Send a desktop notification to the user.", ParseSchema("""{"type":"object","properties":{"title":{"type":"string"},"body":{"type":"string"},"type":{"type":"string"},"duration":{"type":"number"}},"required":["title","body"]}"""));
        RegisterRendererBridgedTool("CronAdd", "Create a scheduled cron job.", ParseSchema("""{"type":"object","properties":{"name":{"type":"string"},"schedule":{"type":"object"},"prompt":{"type":"string"}},"required":["name","schedule","prompt"]}"""));
        RegisterRendererBridgedTool("CronUpdate", "Update an existing cron job.", ParseSchema("""{"type":"object","properties":{"jobId":{"type":"string"},"patch":{"type":"object"}},"required":["jobId","patch"]}"""));
        RegisterRendererBridgedTool("CronRemove", "Remove a scheduled cron job.", ParseSchema("""{"type":"object","properties":{"jobId":{"type":"string"}},"required":["jobId"]}"""));
        RegisterRendererBridgedTool("CronList", "List scheduled cron jobs.", ParseSchema("""{"type":"object","properties":{}}"""));
        RegisterRendererBridgedTool("Task", "Run a sub-agent task.", ParseSchema("""{"type":"object","properties":{"subagent_type":{"type":"string"},"description":{"type":"string"},"prompt":{"type":"string"},"model":{"type":"string"},"resume":{"type":"string"},"readonly":{"type":"boolean"},"attachments":{"type":"array","items":{"type":"string"}},"run_in_background":{"type":"boolean"}},"required":["subagent_type","description","prompt"]}"""));
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

    private static string ResolvePath(string rawPath, string workingFolder)
    {
        if (Path.IsPathRooted(rawPath))
            return Path.GetFullPath(rawPath);
        return Path.GetFullPath(Path.Combine(string.IsNullOrWhiteSpace(workingFolder) ? Environment.CurrentDirectory : workingFolder, rawPath));
    }

    private static string BuildEditNotFoundMessage(string content, string oldString)
    {
        var normalizedContent = FsOperations.NormalizeToLf(content);
        var normalizedOld = FsOperations.NormalizeToLf(oldString);

        if (normalizedContent.Contains(normalizedOld, StringComparison.Ordinal))
        {
            return "old_string not found in file (line endings differ; try using the exact text from Read output)";
        }

        var trailingWhitespaceMatches = FsOperations.FindNormalizedLineBlockMatches(content, oldString, indentationMode: false);
        if (trailingWhitespaceMatches.Count == 1)
        {
            return $"old_string not found in file (trailing whitespace differs near line {trailingWhitespaceMatches[0].StartLine + 1}; try using the exact text from Read output)";
        }
        if (trailingWhitespaceMatches.Count > 1)
        {
            return $"old_string not found in file (multiple matches found after trailing whitespace normalization: {trailingWhitespaceMatches.Count}; provide more surrounding context)";
        }

        var indentationMatches = FsOperations.FindNormalizedLineBlockMatches(content, oldString, indentationMode: true);
        if (indentationMatches.Count == 1)
        {
            return $"old_string not found in file (indentation differs near line {indentationMatches[0].StartLine + 1}; try using the exact text from Read output)";
        }
        if (indentationMatches.Count > 1)
        {
            return $"old_string not found in file (multiple matches found after indentation normalization: {indentationMatches.Count}; provide more surrounding context)";
        }

        var lineIndex = FindBestMatchingLineIndex(normalizedContent, normalizedOld);
        if (lineIndex >= 0)
        {
            return $"old_string not found in file (closest match near line {lineIndex + 1}; ensure indentation and surrounding context match Read output exactly)";
        }

        return "old_string not found in file";
    }

    private static int FindBestMatchingLineIndex(string content, string oldString)
    {
        var probeLine = oldString.Split('\n').Select(static line => line.Trim())
            .FirstOrDefault(static line => line.Length > 0);
        if (string.IsNullOrWhiteSpace(probeLine))
            return -1;

        var lines = content.Split('\n');
        for (var i = 0; i < lines.Length; i++)
        {
            if (lines[i].Contains(probeLine, StringComparison.Ordinal))
                return i;
        }

        return -1;
    }

    private static async Task<(int ExitCode, string Stdout, string Stderr)> ExecuteShellCommandAsync(
        string command,
        string? workingFolder,
        int timeoutMs,
        CancellationToken ct)
    {
        var isWindows = OperatingSystem.IsWindows();
        var startInfo = new System.Diagnostics.ProcessStartInfo
        {
            FileName = isWindows ? "cmd.exe" : "/bin/sh",
            Arguments = isWindows ? $"/c {command}" : $"-lc \"{command.Replace("\\", "\\\\", StringComparison.Ordinal).Replace("\"", "\\\"", StringComparison.Ordinal)}\"",
            WorkingDirectory = string.IsNullOrWhiteSpace(workingFolder) ? Environment.CurrentDirectory : workingFolder,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };

        using var process = new System.Diagnostics.Process { StartInfo = startInfo };
        process.Start();

        var stdoutTask = process.StandardOutput.ReadToEndAsync(ct);
        var stderrTask = process.StandardError.ReadToEndAsync(ct);
        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var waitTask = process.WaitForExitAsync(timeoutCts.Token);
        var delayTask = Task.Delay(timeoutMs, timeoutCts.Token);
        var completedTask = await Task.WhenAny(waitTask, delayTask);

        if (completedTask == delayTask)
        {
            try
            {
                if (!process.HasExited)
                    process.Kill(entireProcessTree: true);
            }
            catch
            {
            }

            throw new TimeoutException($"Command timed out after {timeoutMs}ms");
        }

        timeoutCts.Cancel();
        await waitTask;
        var stdout = await stdoutTask;
        var stderr = await stderrTask;
        return (process.ExitCode, stdout, stderr);
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
            Console.Error.WriteLine($"[{DateTimeOffset.Now:HH:mm:ss.fff}] [AgentRuntime] event sent runId={runId} type={evt.Type}");
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[{DateTimeOffset.Now:HH:mm:ss.fff}] [AgentRuntime] event send failed runId={runId} type={evt.Type}: {ex}");
            throw;
        }
    }

    private static JsonElement SerializeAgentEvent(AgentEvent evt)
    {
        var node = JsonSerializer.SerializeToNode(evt, evt.GetType(), AppJsonContext.Default)?.AsObject()
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

    private Func<string, IReadOnlyList<object?>?, CancellationToken, Task<JsonElement?>> CreateElectronInvokeHandler(CancellationToken runCt)
    {
        return async (channel, args, token) =>
        {
            var linked = CancellationTokenSource.CreateLinkedTokenSource(runCt, token);
            var payload = new ElectronInvokeParams
            {
                Channel = channel,
                Args = args?
                    .Select(arg => JsonSerializer.SerializeToElement(arg, arg?.GetType() ?? typeof(object), AppJsonContext.Default))
                    .ToList()
            };
            var response = await _sendRequestAsync("electron/invoke", payload, linked.Token, TimeSpan.FromMinutes(2));
            return response;
        };
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
                AgentRunId = ctx.AgentRunId ?? runId
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

    private ILlmProvider CreateProvider(ProviderConfig config) => config.Type switch
    {
        "anthropic" => new AnthropicProvider(_httpClientFactory),
        "openai-chat" => new OpenAiChatProvider(_httpClientFactory),
        "openai-responses" => new OpenAiResponsesProvider(_httpClientFactory),
        "gemini" => new GeminiProvider(_httpClientFactory),
        _ => throw new InvalidOperationException($"Unsupported provider type: {config.Type}")
    };
}
