using System.Buffers;
using System.Text.Encodings.Web;
using System.Text.Json;

internal static class AgentRuntimeTeamUiBridge
{
    private static readonly JsonWriterOptions WriterOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    public static async Task EmitSnapshotAsync(
        WorkerRequestContext context,
        JsonElement parameters,
        TeamSnapshot snapshot,
        bool openPanel,
        CancellationToken cancellationToken)
    {
        await AgentRuntimeReverseRequests.RequestAsync(
            context,
            "team/ui-update",
            CreateTeamUiRequest(parameters, writer =>
            {
                writer.WriteString("action", "snapshot");
                writer.WriteBoolean("openPanel", openPanel);
                writer.WritePropertyName("snapshot");
                AgentRuntimeTeamRuntimeStore.WriteSnapshot(writer, snapshot);
            }),
            cancellationToken);
    }

    public static async Task EmitEndAsync(
        WorkerRequestContext context,
        JsonElement parameters,
        CancellationToken cancellationToken)
    {
        await AgentRuntimeReverseRequests.RequestAsync(
            context,
            "team/ui-update",
            CreateTeamUiRequest(parameters, writer => writer.WriteString("action", "end")),
            cancellationToken);
    }

    private static JsonElement CreateTeamUiRequest(
        JsonElement parameters,
        Action<Utf8JsonWriter> writeProperties)
    {
        return CreateJsonElement(writer =>
        {
            WriteNullableString(writer, "sessionId", JsonHelpers.GetString(parameters, "sessionId"));
            writeProperties(writer);
        });
    }

    private static JsonElement CreateJsonElement(Action<Utf8JsonWriter> writeProperties)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer, WriterOptions))
        {
            writer.WriteStartObject();
            writeProperties(writer);
            writer.WriteEndObject();
        }

        using var document = JsonDocument.Parse(buffer.WrittenMemory);
        return document.RootElement.Clone();
    }

    private static void WriteNullableString(Utf8JsonWriter writer, string name, string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            writer.WriteNull(name);
        }
        else
        {
            writer.WriteString(name, value);
        }
    }
}
