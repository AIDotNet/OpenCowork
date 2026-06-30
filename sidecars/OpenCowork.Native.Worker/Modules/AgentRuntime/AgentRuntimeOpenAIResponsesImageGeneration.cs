using System.Text;
using System.Text.Json;

internal static partial class AgentRuntimeOpenAIResponsesProvider
{
    private static async Task TryEmitImageGenerationStartedAsync(
        JsonElement item,
        ResponsesParseState parseState,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context)
    {
        var itemId = GetImageGenerationItemId(item);
        if (!string.IsNullOrWhiteSpace(itemId) &&
            !parseState.EmittedImageGenerationStartIds.Add(itemId))
        {
            return;
        }
        parseState.ImageGenerationStarted = true;
        await AgentRuntimeTools.EmitAsync(
            state,
            context,
            new AgentRuntimeStreamEvent("image_generation_started"));
    }

    private static async Task ProcessPartialImageAsync(
        JsonElement item,
        ResponsesParseState parseState,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context,
        long startedAt)
    {
        await TryEmitImageGenerationStartedAsync(item, parseState, state, context);
        var rawImage = JsonHelpers.GetString(item, "partial_image_b64");
        if (string.IsNullOrWhiteSpace(rawImage))
        {
            return;
        }

        MarkFirstToken(parseState, startedAt);
        var outputFormat = JsonHelpers.GetString(item, "output_format") ??
            GetConfiguredImageOutputFormat(state.Parameters);
        var imageBlock = AgentRuntimeProviderSupport.CreateImageBlockElement(rawImage, outputFormat);
        await AgentRuntimeTools.EmitAsync(
            state,
            context,
            new AgentRuntimeStreamEvent(
                "image_generation_partial",
                ImageBlock: imageBlock,
                PartialImageIndex: JsonHelpers.GetIntNullable(item, "partial_image_index")));
    }

    private static async Task ProcessImageGenerationDoneAsync(
        JsonElement item,
        ResponsesParseState parseState,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context,
        long startedAt)
    {
        await TryEmitImageGenerationStartedAsync(item, parseState, state, context);
        var itemId = GetImageGenerationItemId(item);
        if (!string.IsNullOrWhiteSpace(itemId) &&
            parseState.EmittedImageOutputItemIds.Contains(itemId))
        {
            return;
        }

        var outputFormat = JsonHelpers.GetString(item, "output_format") ??
            GetConfiguredImageOutputFormat(state.Parameters);
        var emittedImage = false;
        foreach (var rawImage in CollectImageBase64Values(
            item.TryGetProperty("result", out var result) ? result : default))
        {
            MarkFirstToken(parseState, startedAt);
            emittedImage = true;
            parseState.ImageGenerationStarted = false;
            await AgentRuntimeTools.EmitAsync(
                state,
                context,
                new AgentRuntimeStreamEvent(
                    "image_generated",
                    ImageBlock: AgentRuntimeProviderSupport.CreateImageBlockElement(rawImage, outputFormat)));
        }

        if (emittedImage)
        {
            if (!string.IsNullOrWhiteSpace(itemId))
            {
                parseState.EmittedImageOutputItemIds.Add(itemId);
            }
            return;
        }

        var errorMessage = GetImageGenerationErrorMessage(item);
        if (!string.IsNullOrWhiteSpace(errorMessage))
        {
            if (!string.IsNullOrWhiteSpace(itemId))
            {
                parseState.EmittedImageOutputItemIds.Add(itemId);
            }
            parseState.ImageGenerationStarted = false;
            await AgentRuntimeTools.EmitAsync(
                state,
                context,
                new AgentRuntimeStreamEvent(
                    "image_error",
                    ImageError: new AgentRuntimeImageError("api_error", errorMessage)));
        }
    }

    private static async Task TryEmitTerminalImageErrorAsync(
        JsonElement payload,
        ResponsesParseState parseState,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context,
        long startedAt)
    {
        if (!parseState.ImageGenerationStarted)
        {
            return;
        }
        MarkFirstToken(parseState, startedAt);
        parseState.ImageGenerationStarted = false;
        await AgentRuntimeTools.EmitAsync(
            state,
            context,
            new AgentRuntimeStreamEvent(
                "image_error",
                ImageError: new AgentRuntimeImageError(
                    "api_error",
                    GetImageGenerationErrorMessage(payload) ?? "Image generation failed")));
    }


    private static string? GetImageGenerationItemId(JsonElement item)
    {
        return JsonHelpers.GetString(item, "id") ??
            JsonHelpers.GetString(item, "item_id") ??
            JsonHelpers.GetString(item, "call_id");
    }

    private static IEnumerable<string> CollectImageBase64Values(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.String)
        {
            var text = value.GetString();
            if (!string.IsNullOrWhiteSpace(text))
            {
                yield return text;
            }
            yield break;
        }

        if (value.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in value.EnumerateArray())
            {
                foreach (var nested in CollectImageBase64Values(item))
                {
                    yield return nested;
                }
            }
            yield break;
        }

        if (value.ValueKind != JsonValueKind.Object)
        {
            yield break;
        }

        foreach (var propertyName in new[] { "b64_json", "image_base64", "data", "result" })
        {
            if (!value.TryGetProperty(propertyName, out var property))
            {
                continue;
            }
            var extracted = CollectImageBase64Values(property).ToList();
            if (extracted.Count == 0)
            {
                continue;
            }
            foreach (var item in extracted)
            {
                yield return item;
            }
            yield break;
        }
    }

    private static string? GetImageGenerationErrorMessage(JsonElement item)
    {
        if (item.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        if (item.TryGetProperty("error", out var error))
        {
            if (error.ValueKind == JsonValueKind.String &&
                error.GetString() is { Length: > 0 } errorText)
            {
                return errorText.Trim();
            }
            if (error.ValueKind == JsonValueKind.Object)
            {
                foreach (var propertyName in new[] { "message", "code", "type" })
                {
                    if (JsonHelpers.GetString(error, propertyName) is { Length: > 0 } value)
                    {
                        return value.Trim();
                    }
                }
            }
        }
        if (JsonHelpers.GetString(item, "message") is { Length: > 0 } message)
        {
            return message.Trim();
        }
        return JsonHelpers.GetString(item, "status") == "failed"
            ? "Image generation failed"
            : null;
    }

    private static string ExtractReasoningSummaryText(JsonElement item)
    {
        if (item.TryGetProperty("summary", out var summary))
        {
            return ExtractText(summary);
        }
        if (item.TryGetProperty("reasoning", out var reasoning) &&
            reasoning.TryGetProperty("summary", out var reasoningSummary))
        {
            return ExtractText(reasoningSummary);
        }
        return string.Empty;
    }

    private static string ExtractText(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.String)
        {
            return value.GetString() ?? string.Empty;
        }
        if (value.ValueKind != JsonValueKind.Array)
        {
            return string.Empty;
        }

        var text = new StringBuilder();
        foreach (var part in value.EnumerateArray())
        {
            if (part.ValueKind == JsonValueKind.String)
            {
                text.Append(part.GetString());
                continue;
            }
            if (JsonHelpers.GetString(part, "text") is { Length: > 0 } partText)
            {
                text.Append(partText);
            }
        }
        return text.ToString();
    }

    private static string? GetConfiguredImageOutputFormat(JsonElement parameters)
    {
        if (parameters.ValueKind != JsonValueKind.Object ||
            !parameters.TryGetProperty("provider", out var provider) ||
            provider.ValueKind != JsonValueKind.Object ||
            !provider.TryGetProperty("responsesImageGeneration", out var config) ||
            config.ValueKind != JsonValueKind.Object)
        {
            return null;
        }
        return JsonHelpers.GetString(config, "outputFormat");
    }


    private static bool ShouldEnableResponsesImageGeneration(JsonElement provider)
    {
        return !provider.TryGetProperty("responsesImageGeneration", out var config) ||
            config.ValueKind != JsonValueKind.Object ||
            JsonHelpers.GetBool(config, "enabled", true);
    }

    private static void WriteResponsesImageGenerationTool(Utf8JsonWriter writer, JsonElement provider)
    {
        var config = provider.TryGetProperty("responsesImageGeneration", out var value) &&
            value.ValueKind == JsonValueKind.Object
                ? value
                : default;
        writer.WriteStartObject();
        writer.WriteString("type", "image_generation");
        WriteOptionalString(writer, config, "action", "action");
        WriteOptionalString(writer, config, "inputFidelity", "input_fidelity");
        WriteOptionalString(writer, config, "moderation", "moderation");
        WriteOptionalString(writer, config, "outputFormat", "output_format");
        WriteOptionalString(writer, config, "quality", "quality");
        WriteOptionalString(writer, config, "size", "size");
        if (config.ValueKind == JsonValueKind.Object &&
            config.TryGetProperty("inputImageMask", out var mask) &&
            mask.ValueKind == JsonValueKind.Object)
        {
            writer.WritePropertyName("input_image_mask");
            writer.WriteStartObject();
            if (JsonHelpers.GetString(mask, "fileId") is { Length: > 0 } fileId)
            {
                writer.WriteString("file_id", fileId);
            }
            if (JsonHelpers.GetString(mask, "imageUrl") is { Length: > 0 } imageUrl)
            {
                writer.WriteString("image_url", imageUrl);
            }
            writer.WriteEndObject();
        }
        if (ReadIntInRange(config, "outputCompression", 0, 100) is { } outputCompression)
        {
            writer.WriteNumber("output_compression", outputCompression);
        }
        writer.WriteNumber("partial_images", ResolveResponsesPartialImages(provider, config));
        writer.WriteEndObject();
    }

    private static void WriteOptionalString(
        Utf8JsonWriter writer,
        JsonElement element,
        string sourceName,
        string targetName)
    {
        if (element.ValueKind == JsonValueKind.Object &&
            JsonHelpers.GetString(element, sourceName) is { Length: > 0 } value)
        {
            writer.WriteString(targetName, value);
        }
    }

    private static int ResolveResponsesPartialImages(JsonElement provider, JsonElement config)
    {
        if (provider.TryGetProperty("imageGenerationStream", out var stream) &&
            stream.ValueKind == JsonValueKind.Object)
        {
            return JsonHelpers.GetBool(stream, "enabled", false)
                ? ReadIntInRange(stream, "partialImages", 0, 3) ?? 2
                : 0;
        }
        return ReadIntInRange(config, "partialImages", 0, 3) ?? 3;
    }

    private static int? ReadIntInRange(JsonElement element, string name, int min, int max)
    {
        if (element.ValueKind != JsonValueKind.Object ||
            JsonHelpers.GetIntNullable(element, name) is not { } value)
        {
            return null;
        }
        return Math.Min(max, Math.Max(min, value));
    }

}
