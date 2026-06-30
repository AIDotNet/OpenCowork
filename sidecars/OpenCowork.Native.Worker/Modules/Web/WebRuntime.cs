using System.Text;
using System.Text.Json;

internal static class WebRuntime
{
    public static async Task<WorkerResponse> SearchAsync(
        JsonElement parameters,
        WorkerRequestContext context)
    {
        using var runtimeParameters = BuildSearchRuntimeParameters(parameters);
        var result = await AgentRuntimeWebSearchExecutor.ExecuteAsync(
            new NativeToolCallView("web-search", "WebSearch", parameters),
            runtimeParameters.RootElement,
            context.CancellationToken);
        return WorkerResponse.RawJson(result);
    }

    public static async Task<WorkerResponse> FetchAsync(
        JsonElement parameters,
        WorkerRequestContext context)
    {
        var result = await AgentRuntimeWebFetchExecutor.ExecuteAsync(
            new NativeToolCallView("web-fetch", "WebFetch", parameters),
            context.CancellationToken);
        return WorkerResponse.RawJson(result);
    }

    private static JsonDocument BuildSearchRuntimeParameters(JsonElement input)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            writer.WritePropertyName("webSearch");
            writer.WriteStartObject();
            writer.WriteBoolean("enabled", true);
            writer.WriteString("provider", JsonHelpers.GetString(input, "provider") ?? string.Empty);
            WriteOptionalString(writer, "apiKey", JsonHelpers.GetString(input, "apiKey"));
            WriteOptionalNumber(writer, "maxResults", JsonHelpers.GetIntNullable(input, "maxResults"));
            WriteOptionalNumber(writer, "timeout", JsonHelpers.GetIntNullable(input, "timeout"));
            writer.WriteEndObject();
            writer.WriteEndObject();
        }

        return JsonDocument.Parse(stream.ToArray());
    }

    private static void WriteOptionalString(Utf8JsonWriter writer, string name, string? value)
    {
        if (!string.IsNullOrWhiteSpace(value))
        {
            writer.WriteString(name, value);
        }
    }

    private static void WriteOptionalNumber(Utf8JsonWriter writer, string name, int? value)
    {
        if (value is not null)
        {
            writer.WriteNumber(name, value.Value);
        }
    }
}
