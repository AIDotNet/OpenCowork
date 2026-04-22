using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace OpenCowork.Agent.Providers;

internal static class OpenAiResponsesWebSocketProtocol
{
    public const string OpenAiBetaHeaderName = "OpenAI-Beta";
    public const string OpenAiResponsesWebSocketBetaValue = "responses_websockets=2026-02-06";

    internal sealed record PreparedRequest(
        string RequestKind,
        byte[] PayloadBytes,
        JsonObject FullRequest,
        string? PreviousResponseId,
        string IncrementalReason);

    internal sealed record CompletionState(string? ResponseId, JsonArray OutputItems);

    public static Dictionary<string, string> BuildHandshakeHeaders(
        IReadOnlyDictionary<string, string> headers)
    {
        var websocketHeaders = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var (key, value) in headers)
            websocketHeaders[key] = value;
        if (!websocketHeaders.ContainsKey(OpenAiBetaHeaderName))
            websocketHeaders[OpenAiBetaHeaderName] = OpenAiResponsesWebSocketBetaValue;
        return websocketHeaders;
    }

    public static JsonObject NormalizeRequestBody(byte[] httpBodyBytes)
    {
        var rootNode = JsonNode.Parse(Encoding.UTF8.GetString(httpBodyBytes)) as JsonObject ?? new JsonObject();
        rootNode.Remove("stream");
        rootNode.Remove("background");
        return rootNode;
    }

    public static PreparedRequest PrepareRequest(
        byte[] httpBodyBytes,
        JsonObject? lastFullRequest,
        string? lastCompletedResponseId,
        JsonArray? lastResponseOutputItems,
        bool warmup)
    {
        var fullRequest = NormalizeRequestBody(httpBodyBytes);
        if (warmup)
        {
            var warmupPayload = CloneObject(fullRequest);
            warmupPayload["generate"] = false;
            return new PreparedRequest(
                "warmup",
                EncodeCreatePayload(warmupPayload),
                fullRequest,
                null,
                "warmup");
        }

        if (lastFullRequest is null)
        {
            return new PreparedRequest(
                "full",
                EncodeCreatePayload(fullRequest),
                fullRequest,
                null,
                "no_prior_request");
        }

        if (string.IsNullOrWhiteSpace(lastCompletedResponseId))
        {
            return new PreparedRequest(
                "full",
                EncodeCreatePayload(fullRequest),
                fullRequest,
                null,
                "missing_previous_response_id");
        }

        var previousWithoutInput = StripInputForComparison(lastFullRequest);
        var currentWithoutInput = StripInputForComparison(fullRequest);
        if (!DeepEquals(previousWithoutInput, currentWithoutInput))
        {
            return new PreparedRequest(
                "full",
                EncodeCreatePayload(fullRequest),
                fullRequest,
                null,
                "request_shape_changed");
        }

        var baselineInput = new JsonArray();
        if (lastFullRequest["input"] is JsonArray previousInput)
        {
            foreach (var item in previousInput)
                baselineInput.Add(item?.DeepClone());
        }
        if (lastResponseOutputItems is not null)
        {
            foreach (var item in NormalizeOutputItemsForReplayInput(lastResponseOutputItems))
                baselineInput.Add(item?.DeepClone());
        }

        var currentInput = fullRequest["input"] as JsonArray ?? new JsonArray();
        if (currentInput.Count >= baselineInput.Count
            && Enumerable.Range(0, baselineInput.Count).All(index => DeepEquals(baselineInput[index], currentInput[index])))
        {
            var incrementalPayload = CloneObject(fullRequest);
            var deltaInput = new JsonArray();
            for (var index = baselineInput.Count; index < currentInput.Count; index++)
                deltaInput.Add(currentInput[index]?.DeepClone());
            incrementalPayload["previous_response_id"] = lastCompletedResponseId;
            incrementalPayload["input"] = deltaInput;
            return new PreparedRequest(
                "incremental",
                EncodeCreatePayload(incrementalPayload),
                fullRequest,
                lastCompletedResponseId,
                "matched");
        }

        return new PreparedRequest(
            "full",
            EncodeCreatePayload(fullRequest),
            fullRequest,
            null,
            "input_prefix_mismatch");
    }

    public static bool IsConnectionLimitReached(JsonElement root)
        => GetStringOrDefault(root, "code") == "websocket_connection_limit_reached"
            || (root.TryGetProperty("error", out var error)
                && GetStringOrDefault(error, "code") == "websocket_connection_limit_reached");

    public static bool IsFirstModelEvent(JsonElement root)
    {
        var eventType = GetStringOrDefault(root, "type");
        return eventType switch
        {
            "response.output_text.delta" => true,
            "response.reasoning_summary_text.delta" => true,
            "response.reasoning_summary_text.done" => true,
            "response.function_call_arguments.delta" => true,
            "response.function_call_arguments.done" => true,
            "response.image_generation_call.partial_image" => true,
            "response.output_item.added" or "response.output_item.done" => root.TryGetProperty("item", out var item)
                && (GetStringOrDefault(item, "type") == "function_call"
                    || GetStringOrDefault(item, "type") == "computer_call"
                    || GetStringOrDefault(item, "type") == "reasoning"
                    || GetStringOrDefault(item, "type") == "image_generation_call"),
            _ => false
        };
    }

    public static string GetFailureReason(JsonElement root, string fallback)
    {
        var candidates = new List<string?>();
        if (root.TryGetProperty("error", out var error))
        {
            candidates.Add(GetStringOrDefault(error, "code"));
            candidates.Add(GetStringOrDefault(error, "message"));
            candidates.Add(GetStringOrDefault(error, "type"));
        }
        candidates.Add(GetStringOrDefault(root, "code"));
        candidates.Add(GetStringOrDefault(root, "message"));
        candidates.Add(GetStringOrDefault(root, "type"));

        foreach (var candidate in candidates)
        {
            if (!string.IsNullOrWhiteSpace(candidate))
                return candidate;
        }
        return fallback;
    }

    public static CompletionState? ExtractCompletionState(JsonElement root)
    {
        if (GetStringOrDefault(root, "type") != "response.completed")
            return null;
        if (!root.TryGetProperty("response", out var response) || response.ValueKind != JsonValueKind.Object)
            return null;

        var responseId = GetStringOrDefault(response, "id");
        var outputItems = new JsonArray();
        if (response.TryGetProperty("output", out var output) && output.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in output.EnumerateArray())
            {
                outputItems.Add(JsonNode.Parse(item.GetRawText()));
            }
        }

        return new CompletionState(
            string.IsNullOrWhiteSpace(responseId) ? null : responseId,
            outputItems);
    }

    private static byte[] EncodeCreatePayload(JsonObject payloadObject)
    {
        var payload = new JsonObject
        {
            ["type"] = "response.create"
        };
        foreach (var kvp in payloadObject)
            payload[kvp.Key] = kvp.Value?.DeepClone();
        return Encoding.UTF8.GetBytes(payload.ToJsonString());
    }

    public static byte[] BuildCreatePayload(JsonObject payloadObject)
        => EncodeCreatePayload(CloneObject(payloadObject));

    private static JsonObject StripInputForComparison(JsonObject value)
    {
        var cloned = CloneObject(value);
        cloned.Remove("input");
        return cloned;
    }

    public static JsonArray NormalizeOutputItemsForReplayInput(JsonArray outputItems)
    {
        var normalized = new JsonArray();
        foreach (var item in outputItems)
        {
            var normalizedItem = NormalizeOutputItemForReplayInput(item);
            if (normalizedItem is not null)
                normalized.Add(normalizedItem);
        }
        return normalized;
    }

    private static JsonObject? NormalizeOutputItemForReplayInput(JsonNode? item)
    {
        if (item is not JsonObject record)
            return null;

        return GetString(record, "type") switch
        {
            "message" => NormalizeMessageOutputItem(record),
            "reasoning" => NormalizeReasoningOutputItem(record),
            "function_call" => NormalizeFunctionCallOutputItem(record),
            "image_generation_call" => NormalizeImageGenerationOutputItem(record),
            _ => null
        };
    }

    private static JsonObject? NormalizeMessageOutputItem(JsonObject item)
    {
        var role = GetString(item, "role");
        if (string.IsNullOrWhiteSpace(role))
            return null;

        var content = NormalizeMessageContentForReplay(item["content"], role);
        if (content is null)
            return null;

        return new JsonObject
        {
            ["type"] = "message",
            ["role"] = role,
            ["content"] = content
        };
    }

    private static JsonNode? NormalizeMessageContentForReplay(JsonNode? content, string role)
    {
        if (TryGetString(content, out var contentString))
            return string.IsNullOrEmpty(contentString) ? null : JsonValue.Create(contentString);

        if (content is not JsonArray contentArray)
            return null;

        var textParts = new List<string>();
        var userParts = new JsonArray();

        foreach (var partNode in contentArray)
        {
            if (TryGetString(partNode, out var stringPart))
            {
                textParts.Add(stringPart);
                userParts.Add(new JsonObject
                {
                    ["type"] = "input_text",
                    ["text"] = stringPart
                });
                continue;
            }

            if (partNode is not JsonObject part)
                continue;

            var partType = GetString(part, "type");
            if ((partType == "output_text" || partType == "input_text")
                && !string.IsNullOrEmpty(GetString(part, "text")))
            {
                var text = GetString(part, "text");
                textParts.Add(text);
                userParts.Add(new JsonObject
                {
                    ["type"] = "input_text",
                    ["text"] = text
                });
                continue;
            }

            if (partType == "input_image" && !string.IsNullOrEmpty(GetString(part, "image_url")))
            {
                userParts.Add(new JsonObject
                {
                    ["type"] = "input_image",
                    ["image_url"] = GetString(part, "image_url")
                });
            }
        }

        if (string.Equals(role, "user", StringComparison.OrdinalIgnoreCase) && userParts.Count > 0)
            return userParts;

        var combinedText = string.Concat(textParts);
        return string.IsNullOrEmpty(combinedText) ? null : JsonValue.Create(combinedText);
    }

    private static JsonObject? NormalizeReasoningOutputItem(JsonObject item)
    {
        var encryptedContent = GetString(item, "encrypted_content");
        if (string.IsNullOrWhiteSpace(encryptedContent) && item["reasoning"] is JsonObject reasoningObject)
            encryptedContent = GetString(reasoningObject, "encrypted_content");
        if (string.IsNullOrWhiteSpace(encryptedContent))
            return null;

        return new JsonObject
        {
            ["type"] = "reasoning",
            ["summary"] = NormalizeReasoningSummaryForReplay(item["summary"] ?? GetObjectProperty(item["reasoning"], "summary")),
            ["encrypted_content"] = encryptedContent
        };
    }

    private static JsonArray NormalizeReasoningSummaryForReplay(JsonNode? summary)
    {
        var normalized = new JsonArray();
        if (TryGetString(summary, out var summaryString))
        {
            if (!string.IsNullOrEmpty(summaryString))
            {
                normalized.Add(new JsonObject
                {
                    ["type"] = "summary_text",
                    ["text"] = summaryString
                });
            }
            return normalized;
        }

        if (summary is not JsonArray summaryArray)
            return normalized;

        foreach (var partNode in summaryArray)
        {
            if (TryGetString(partNode, out var stringPart))
            {
                if (!string.IsNullOrEmpty(stringPart))
                {
                    normalized.Add(new JsonObject
                    {
                        ["type"] = "summary_text",
                        ["text"] = stringPart
                    });
                }
                continue;
            }

            if (partNode is not JsonObject part)
                continue;

            var text = GetString(part, "text");
            if (string.IsNullOrEmpty(text))
                continue;

            normalized.Add(new JsonObject
            {
                ["type"] = "summary_text",
                ["text"] = text
            });
        }

        return normalized;
    }

    private static JsonObject? NormalizeFunctionCallOutputItem(JsonObject item)
    {
        var callId = GetString(item, "call_id");
        var name = GetString(item, "name");
        if (string.IsNullOrWhiteSpace(callId) || string.IsNullOrWhiteSpace(name))
            return null;

        return new JsonObject
        {
            ["type"] = "function_call",
            ["call_id"] = callId,
            ["name"] = name,
            ["arguments"] = StringifyReplayValue(item["arguments"]),
            ["status"] = "completed"
        };
    }

    private static JsonObject? NormalizeImageGenerationOutputItem(JsonObject item)
    {
        var results = new JsonArray();
        if (item["result"] is JsonArray resultArray)
        {
            foreach (var result in resultArray)
            {
                if (TryGetString(result, out var base64) && !string.IsNullOrEmpty(base64))
                    results.Add(base64);
            }
        }
        else if (TryGetString(item["result"], out var singleResult) && !string.IsNullOrEmpty(singleResult))
        {
            results.Add(singleResult);
        }

        if (results.Count == 0)
            return null;

        var normalized = new JsonObject
        {
            ["type"] = "image_generation_call",
            ["result"] = results.Count == 1 ? results[0]?.DeepClone() : results.DeepClone()
        };
        var outputFormat = GetString(item, "output_format");
        if (!string.IsNullOrWhiteSpace(outputFormat))
            normalized["output_format"] = outputFormat;
        return normalized;
    }

    private static string StringifyReplayValue(JsonNode? value)
    {
        if (TryGetString(value, out var stringValue))
            return stringValue;
        return value?.ToJsonString() ?? string.Empty;
    }

    private static JsonObject CloneObject(JsonObject value)
        => JsonNode.Parse(value.ToJsonString()) as JsonObject ?? new JsonObject();

    private static bool DeepEquals(JsonNode? left, JsonNode? right)
    {
        if (left is null || right is null)
            return left is null && right is null;

        if (left is JsonValue leftValue && right is JsonValue rightValue)
        {
            return leftValue.ToJsonString() == rightValue.ToJsonString();
        }

        if (left is JsonArray leftArray && right is JsonArray rightArray)
        {
            if (leftArray.Count != rightArray.Count)
                return false;
            for (var index = 0; index < leftArray.Count; index++)
            {
                if (!DeepEquals(leftArray[index], rightArray[index]))
                    return false;
            }
            return true;
        }

        if (left is JsonObject leftObject && right is JsonObject rightObject)
        {
            var leftKeys = leftObject.Select(static pair => pair.Key).OrderBy(static key => key).ToArray();
            var rightKeys = rightObject.Select(static pair => pair.Key).OrderBy(static key => key).ToArray();
            if (!leftKeys.SequenceEqual(rightKeys))
                return false;

            foreach (var key in leftKeys)
            {
                if (!DeepEquals(leftObject[key], rightObject[key]))
                    return false;
            }
            return true;
        }

        return left.ToJsonString() == right.ToJsonString();
    }

    private static string GetStringOrDefault(JsonElement element, string propertyName)
    {
        if (element.ValueKind == JsonValueKind.Object
            && element.TryGetProperty(propertyName, out var property)
            && property.ValueKind == JsonValueKind.String)
        {
            return property.GetString() ?? string.Empty;
        }

        return string.Empty;
    }

    private static JsonNode? GetObjectProperty(JsonNode? node, string propertyName)
        => node is JsonObject obj ? obj[propertyName] : null;

    private static string GetString(JsonObject obj, string propertyName)
        => TryGetString(obj[propertyName], out var value) ? value : string.Empty;

    private static bool TryGetString(JsonNode? node, out string value)
    {
        if (node is JsonValue jsonValue)
        {
            try
            {
                value = jsonValue.GetValue<string>();
                return true;
            }
            catch
            {
                // ignored
            }
        }

        value = string.Empty;
        return false;
    }
}
