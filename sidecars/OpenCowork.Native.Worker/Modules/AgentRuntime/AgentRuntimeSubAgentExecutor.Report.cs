using System.Text;
using System.Text.Json;

internal static partial class AgentRuntimeSubAgentExecutor
{
    private const string ReportStatusSubmitted = "submitted";
    private const string ReportStatusRetrying = "retrying";
    private const string ReportStatusFallback = "fallback";
    private const string ReportStatusMissing = "missing";
    private const int FallbackToolLineLimit = 12;
    private const int FallbackErrorChars = 240;

    private const string MissingReportError = "Sub-agent finished without a final report.";

    private const string ReportNudgeText =
        "<system-remind>\n" +
        "You ended the previous turn without a final report. Your last assistant message is " +
        "returned verbatim to the parent agent.\n" +
        "Do not call any tools. Write a self-contained report now from the evidence you already " +
        "have: what you found, what failed (including tool timeouts), what is unfinished, and " +
        "the safest next step for the parent.\n" +
        "If a tool timed out or failed, say so and continue from files you already read. " +
        "Do not retry the same timed-out call.\n" +
        "</system-remind>";

    private static async Task<SubAgentResultNative> EnsureSubAgentReportAsync(
        SubAgentResultNative result,
        AgentRuntimeTools.AgentRuntimeRunState childState,
        WorkerRequestContext context,
        Func<SubAgentResultNative> rebuildResult,
        Func<string, string, Task>? emitReportStatus,
        CancellationToken cancellationToken)
    {
        if (HasClosingReport(result))
        {
            return result with { ReportStatus = ReportStatusSubmitted };
        }

        if (CanNudgeForMissingReport(result, childState, cancellationToken))
        {
            if (emitReportStatus is not null)
            {
                await emitReportStatus(ReportStatusRetrying, string.Empty);
            }

            try
            {
                var nudgeParameters = BuildReportNudgeParameters(childState.Parameters, result.Messages);
                if (nudgeParameters.HasValue)
                {
                    WorkerLog.Info(
                        $"sub-agent missing report; requesting one closing turn runId={childState.RunId}");
                    await OpenAIChatRuntime.ExecuteLoopAsync(
                        nudgeParameters.Value,
                        childState,
                        context);
                    result = rebuildResult();
                    if (HasClosingReport(result))
                    {
                        return result with { ReportStatus = ReportStatusSubmitted };
                    }
                }
            }
            catch (OperationCanceledException) when (childState.IsCancellationRequested)
            {
                childState.RequestStop("aborted");
                result = rebuildResult();
            }
            catch (Exception ex)
            {
                WorkerLog.Warn(
                    $"sub-agent report nudge failed runId={childState.RunId} " +
                    $"error={ex.GetType().Name}: {ex.Message}");
                result = rebuildResult();
            }
        }

        var fallback = SynthesizeFallbackReport(result);
        if (emitReportStatus is not null)
        {
            await emitReportStatus(ReportStatusFallback, fallback);
        }

        WorkerLog.Warn(
            $"sub-agent synthesized fallback report runId={childState.RunId} " +
            $"endReason={result.EndReason} toolCalls={result.ToolCallCount} " +
            $"reportChars={fallback.Length}");

        var endReason = result.EndReason == "completed" ? "error" : result.EndReason;
        var error = string.IsNullOrWhiteSpace(result.Error) ? MissingReportError : result.Error;
        return result with
        {
            Success = false,
            Output = fallback,
            ReportCaptured = true,
            ReportStatus = ReportStatusFallback,
            EndReason = endReason,
            Error = error
        };
    }

    private static bool HasClosingReport(SubAgentResultNative result)
    {
        if (!string.IsNullOrWhiteSpace(GetClosingAssistantText(result.Messages)))
        {
            return true;
        }

        // loop_end never arrived; the last streamed assistant text is the only closer we have.
        return result.Messages.Length == 0 && !string.IsNullOrWhiteSpace(result.Output);
    }

    private static bool CanNudgeForMissingReport(
        SubAgentResultNative result,
        AgentRuntimeTools.AgentRuntimeRunState childState,
        CancellationToken cancellationToken)
    {
        if (result.Messages.Length == 0)
        {
            return false;
        }

        if (cancellationToken.IsCancellationRequested || childState.IsCancellationRequested)
        {
            return false;
        }

        if (result.EndReason is "aborted")
        {
            return false;
        }

        return !childState.IsStopRequested ||
            string.Equals(childState.StopReason, "completed", StringComparison.Ordinal);
    }

    private static JsonElement? BuildReportNudgeParameters(
        JsonElement currentParameters,
        IReadOnlyList<JsonElement> messages)
    {
        if (currentParameters.ValueKind != JsonValueKind.Object || messages.Count == 0)
        {
            return null;
        }

        var omitted = new HashSet<string>(StringComparer.Ordinal)
        {
            "messages",
            "maxIterations",
            "providerTurnOnly",
            "requestContextTexts",
            "slashCommand",
            "systemCommand"
        };

        return CreateObject(writer =>
        {
            foreach (var property in currentParameters.EnumerateObject())
            {
                if (omitted.Contains(property.Name))
                {
                    continue;
                }
                property.WriteTo(writer);
            }

            writer.WritePropertyName("messages");
            writer.WriteStartArray();
            foreach (var message in messages)
            {
                message.WriteTo(writer);
            }
            BuildReportNudgeMessage().WriteTo(writer);
            writer.WriteEndArray();
            writer.WriteNumber("maxIterations", 1);
            writer.WriteBoolean("captureFinalMessages", true);
            writer.WriteBoolean("captureUncompressedFinalMessages", true);
            writer.WriteBoolean("subAgentRun", true);
        });
    }

    private static JsonElement BuildReportNudgeMessage()
    {
        return CreateObject(writer =>
        {
            writer.WriteString("id", $"oc_subagent_report_nudge_{Guid.NewGuid():N}");
            writer.WriteString("role", "user");
            writer.WritePropertyName("content");
            writer.WriteStartArray();
            writer.WriteStartObject();
            writer.WriteString("type", "text");
            writer.WriteString("text", ReportNudgeText);
            writer.WriteEndObject();
            writer.WriteEndArray();
            writer.WriteNumber("createdAt", NowMs());
        });
    }

    private static string GetClosingAssistantText(IReadOnlyList<JsonElement> messages)
    {
        for (var index = messages.Count - 1; index >= 0; index--)
        {
            var message = messages[index];
            if (JsonHelpers.GetString(message, "role") != "assistant")
            {
                continue;
            }

            return ExtractAssistantText(message);
        }

        return string.Empty;
    }

    private static string ExtractAssistantText(JsonElement message)
    {
        if (!message.TryGetProperty("content", out var content))
        {
            return string.Empty;
        }

        if (content.ValueKind == JsonValueKind.String)
        {
            return content.GetString()?.Trim() ?? string.Empty;
        }

        if (content.ValueKind != JsonValueKind.Array)
        {
            return string.Empty;
        }

        var builder = new StringBuilder();
        foreach (var block in content.EnumerateArray())
        {
            if (JsonHelpers.GetString(block, "type") == "text" &&
                JsonHelpers.GetString(block, "text") is { Length: > 0 } blockText)
            {
                builder.Append(blockText);
            }
        }

        return builder.ToString().Trim();
    }

    private static string SynthesizeFallbackReport(SubAgentResultNative result)
    {
        var builder = new StringBuilder();
        builder.AppendLine("The sub-agent stopped without a final report. This summary was synthesized from its transcript.");
        builder.AppendLine();
        builder.Append("Status: incomplete");
        if (!string.IsNullOrWhiteSpace(result.EndReason))
        {
            builder.Append(" (").Append(result.EndReason).Append(')');
        }
        builder.AppendLine();
        if (!string.IsNullOrWhiteSpace(result.Error))
        {
            builder.Append("Runtime error: ").Append(result.Error.Trim()).AppendLine();
        }

        builder.Append("Iterations: ").Append(result.Iterations);
        builder.Append(" · Tool calls: ").Append(result.ToolCallCount).AppendLine();

        var toolLines = CollectFallbackToolLines(result.Messages);
        if (toolLines.Count > 0)
        {
            builder.AppendLine();
            builder.AppendLine("Tool activity:");
            var shown = Math.Min(toolLines.Count, FallbackToolLineLimit);
            var hidden = toolLines.Count - shown;
            var start = Math.Max(0, toolLines.Count - shown);
            for (var index = start; index < toolLines.Count; index++)
            {
                builder.Append("- ").AppendLine(toolLines[index]);
            }
            if (hidden > 0)
            {
                builder.Append("- (").Append(hidden).Append(" earlier tool calls omitted)").AppendLine();
            }
        }

        builder.AppendLine();
        builder.Append(
            "Treat this as a partial result. Continue from the evidence above; do not assume the delegated task finished.");
        return builder.ToString().Trim();
    }

    private static List<string> CollectFallbackToolLines(IReadOnlyList<JsonElement> messages)
    {
        var names = new Dictionary<string, string>(StringComparer.Ordinal);
        var lines = new List<string>();
        foreach (var message in messages)
        {
            if (!message.TryGetProperty("content", out var content) ||
                content.ValueKind != JsonValueKind.Array)
            {
                continue;
            }

            foreach (var block in content.EnumerateArray())
            {
                var type = JsonHelpers.GetString(block, "type");
                if (type == "tool_use")
                {
                    var id = JsonHelpers.GetString(block, "id");
                    var toolName = JsonHelpers.GetString(block, "name");
                    if (!string.IsNullOrWhiteSpace(id) && !string.IsNullOrWhiteSpace(toolName))
                    {
                        names[id] = toolName;
                    }
                    continue;
                }

                if (type != "tool_result")
                {
                    continue;
                }

                var toolUseId = JsonHelpers.GetString(block, "toolUseId") ??
                    JsonHelpers.GetString(block, "tool_use_id");
                var resultName = !string.IsNullOrWhiteSpace(toolUseId) && names.TryGetValue(toolUseId, out var mapped)
                    ? mapped
                    : "tool";
                var failed = block.TryGetProperty("isError", out var isError) &&
                    isError.ValueKind == JsonValueKind.True;
                var detail = failed ? CompactFallbackDetail(ReadToolResultText(block)) : string.Empty;
                lines.Add(failed && detail.Length > 0
                    ? $"{resultName}: error — {detail}"
                    : failed
                        ? $"{resultName}: error"
                        : $"{resultName}: completed");
            }
        }

        return lines;
    }

    private static string ReadToolResultText(JsonElement block)
    {
        if (!block.TryGetProperty("content", out var content))
        {
            return string.Empty;
        }

        if (content.ValueKind == JsonValueKind.String)
        {
            return content.GetString() ?? string.Empty;
        }

        if (content.ValueKind == JsonValueKind.Array)
        {
            var builder = new StringBuilder();
            foreach (var item in content.EnumerateArray())
            {
                if (JsonHelpers.GetString(item, "type") == "text")
                {
                    builder.Append(JsonHelpers.GetString(item, "text"));
                }
            }
            return builder.ToString();
        }

        return content.ValueKind == JsonValueKind.Object &&
            content.TryGetProperty("error", out var error) &&
            error.ValueKind == JsonValueKind.String
            ? error.GetString() ?? string.Empty
            : content.GetRawText();
    }

    private static string CompactFallbackDetail(string value)
    {
        var trimmed = value.Replace('\r', ' ').Replace('\n', ' ').Trim();
        if (trimmed.StartsWith("{", StringComparison.Ordinal) &&
            trimmed.Contains("\"error\"", StringComparison.Ordinal))
        {
            try
            {
                using var document = JsonDocument.Parse(trimmed);
                if (document.RootElement.TryGetProperty("error", out var error) &&
                    error.ValueKind == JsonValueKind.String)
                {
                    trimmed = error.GetString()?.Trim() ?? trimmed;
                }
            }
            catch (JsonException)
            {
            }
        }

        if (trimmed.StartsWith("<system-remind", StringComparison.OrdinalIgnoreCase))
        {
            trimmed = trimmed
                .Replace("<system-remind>", string.Empty, StringComparison.OrdinalIgnoreCase)
                .Replace("</system-remind>", string.Empty, StringComparison.OrdinalIgnoreCase)
                .Replace("<system-reminder>", string.Empty, StringComparison.OrdinalIgnoreCase)
                .Replace("</system-reminder>", string.Empty, StringComparison.OrdinalIgnoreCase)
                .Trim();
        }

        return trimmed.Length <= FallbackErrorChars
            ? trimmed
            : string.Concat(trimmed.AsSpan(0, FallbackErrorChars - 1), "…");
    }

    private static string WrapParentTaskErrorContent(SubAgentResultNative result)
    {
        var output = result.Output.Trim();
        if (output.Contains("<system-remind", StringComparison.OrdinalIgnoreCase) ||
            output.StartsWith("{", StringComparison.Ordinal))
        {
            return output;
        }

        return result.ReportStatus == ReportStatusFallback
            ? "<system-remind>\n" + output + "\n</system-remind>"
            : output;
    }

    private static string ResolveEmittedReportStatus(SubAgentResultNative result)
    {
        if (!string.IsNullOrWhiteSpace(result.ReportStatus) &&
            result.ReportStatus is not ReportStatusMissing)
        {
            return result.ReportStatus;
        }

        return result.ReportCaptured ? ReportStatusSubmitted : ReportStatusMissing;
    }
}
