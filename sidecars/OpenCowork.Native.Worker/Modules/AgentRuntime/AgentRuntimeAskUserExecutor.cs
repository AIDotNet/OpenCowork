using System.Buffers;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

internal static class AgentRuntimeAskUserExecutor
{
    private const string AskUserToolName = "AskUserQuestion";
    private const int MaxQuestions = 4;
    private const int MaxHeaderChars = 12;

    private static readonly JsonWriterOptions WriterOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    public static bool IsAskUserTool(string toolName)
    {
        return string.Equals(toolName, AskUserToolName, StringComparison.Ordinal);
    }

    public static async Task<string> ExecuteAsync(
        NativeToolCallView call,
        JsonElement parameters,
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        var questions = CoerceQuestions(GetQuestionsInput(call.Input));
        if (questions.Count == 0)
        {
            return EncodeError("At least one question is required");
        }

        var validationError = ValidateQuestions(questions);
        if (validationError is not null)
        {
            return EncodeError(validationError);
        }

        var normalizedQuestions = NormalizeQuestions(questions);
        var metadataSource = ReadMetadataSource(call.Input);
        var pluginId = JsonHelpers.GetString(parameters, "pluginId")?.Trim();
        if (!string.IsNullOrEmpty(pluginId))
        {
            return BuildPluginSessionMessage(normalizedQuestions);
        }

        var response = await RequestUserAnswersAsync(
            call.Id,
            normalizedQuestions,
            parameters,
            context,
            cancellationToken);

        if (!TryReadAnswers(response, out var answers))
        {
            return EncodeError("No answers provided");
        }

        return BuildStructuredResult(
            normalizedQuestions,
            answers,
            ReadAnnotations(response),
            metadataSource);
    }

    private static JsonElement GetQuestionsInput(JsonElement input)
    {
        if (input.ValueKind == JsonValueKind.Object &&
            input.TryGetProperty("questions", out var questions))
        {
            return questions;
        }

        return input;
    }

    private static List<AskUserQuestion> CoerceQuestions(JsonElement value)
    {
        return CoerceArrayInput(value)
            .Select(CoerceQuestion)
            .Where(question => question is not null)
            .Cast<AskUserQuestion>()
            .ToList();
    }

    private static List<JsonElement> CoerceArrayInput(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Array)
        {
            return value.EnumerateArray().Select(item => item.Clone()).ToList();
        }

        if (value.ValueKind == JsonValueKind.String)
        {
            var text = value.GetString();
            if (!string.IsNullOrWhiteSpace(text) && TryParseJsonElement(text, out var parsed))
            {
                return CoerceArrayInput(parsed);
            }
            return [];
        }

        if (value.ValueKind != JsonValueKind.Object)
        {
            return [];
        }

        if (value.TryGetProperty("items", out var items))
        {
            var nested = CoerceArrayInput(items);
            if (nested.Count > 0)
            {
                return nested;
            }
        }

        if (CoerceStringField(value, "question", "text", "prompt", "query", "message", "content") is not null ||
            value.TryGetProperty("options", out _) ||
            value.TryGetProperty("choices", out _))
        {
            return [value.Clone()];
        }

        var numericEntries = new List<(int Index, JsonElement Element)>();
        foreach (var property in value.EnumerateObject())
        {
            if (int.TryParse(property.Name, out var index))
            {
                numericEntries.Add((index, property.Value.Clone()));
            }
        }

        return numericEntries
            .OrderBy(entry => entry.Index)
            .Select(entry => entry.Element)
            .ToList();
    }

    private static AskUserQuestion? CoerceQuestion(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.String)
        {
            var text = value.GetString();
            if (string.IsNullOrWhiteSpace(text) || !TryParseJsonElement(text, out var parsed))
            {
                return null;
            }
            value = parsed;
        }

        if (value.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        var question = CoerceStringField(value, "question", "text", "prompt", "query", "message", "content");
        var header = CoerceStringField(value, "header", "label", "title", "name", "id");
        var fallbackQuestion =
            question ??
            CoerceStringField(value, "description", "desc", "summary") ??
            (header is { Length: > 0 } ? $"{header}?" : null);

        var optionsInput = GetFirstProperty(value, "options", "choices", "answers", "items");
        var options = optionsInput.HasValue
            ? CoerceOptions(optionsInput.Value)
            : null;

        return new AskUserQuestion(
            fallbackQuestion ?? string.Empty,
            header,
            options,
            CoerceBooleanField(value, "multiSelect", "multi_select", "multiple"));
    }

    private static List<AskUserOption>? CoerceOptions(JsonElement value)
    {
        var options = CoerceArrayInput(value)
            .Select(CoerceOption)
            .Where(option => option is not null)
            .Cast<AskUserOption>()
            .ToList();
        return options.Count > 0 ? options : null;
    }

    private static AskUserOption? CoerceOption(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.String)
        {
            return new AskUserOption(value.GetString()?.Trim() ?? string.Empty, null, null);
        }

        if (value.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        return new AskUserOption(
            CoerceStringField(value, "label", "text", "value", "title", "name") ?? string.Empty,
            CoerceStringField(
                value,
                "description",
                "desc",
                "detail",
                "details",
                "impact",
                "rationale"),
            CoerceStringField(value, "preview", "example", "snippet"));
    }

    private static List<AskUserQuestion> NormalizeQuestions(IReadOnlyList<AskUserQuestion> questions)
    {
        var normalized = new List<AskUserQuestion>(questions.Count);
        for (var index = 0; index < questions.Count; index++)
        {
            var question = questions[index];
            var questionText = question.Question.Trim();
            var header = string.IsNullOrWhiteSpace(question.Header)
                ? DeriveHeader(questionText, index)
                : question.Header.Trim();
            var options = question.Options?
                .Select(option => new AskUserOption(
                    option.Label.Trim(),
                    string.IsNullOrWhiteSpace(option.Description) ? null : option.Description.Trim(),
                    string.IsNullOrWhiteSpace(option.Preview) ? null : option.Preview.Trim()))
                .ToList();

            normalized.Add(new AskUserQuestion(questionText, header, options, question.MultiSelect));
        }

        return normalized;
    }

    private static string? ValidateQuestions(IReadOnlyList<AskUserQuestion> questions)
    {
        if (questions.Count == 0)
        {
            return "At least one question is required";
        }

        if (questions.Count > MaxQuestions)
        {
            return $"Maximum {MaxQuestions} questions allowed";
        }

        var seenQuestions = new HashSet<string>(StringComparer.Ordinal);
        for (var index = 0; index < questions.Count; index++)
        {
            var item = questions[index];
            var questionText = item.Question.Trim();
            var header = string.IsNullOrWhiteSpace(item.Header)
                ? DeriveHeader(questionText, index)
                : item.Header.Trim();

            if (questionText.Length == 0)
            {
                return $"Question {index + 1} is missing question text";
            }

            if (!seenQuestions.Add(questionText))
            {
                return "Question texts must be unique";
            }

            if (header.Length == 0)
            {
                return $"Question \"{questionText}\" is missing a header";
            }

            if (HeaderLength(header) > MaxHeaderChars)
            {
                return $"Question \"{questionText}\" header must be at most {MaxHeaderChars} characters";
            }

            var options = item.Options;
            if (options is null || options.Count is < 2 or > 4)
            {
                return $"Question \"{questionText}\" must provide 2-4 options";
            }

            var seenLabels = new HashSet<string>(StringComparer.Ordinal);
            foreach (var option in options)
            {
                var label = option.Label.Trim();
                if (label.Length == 0)
                {
                    return $"Question \"{questionText}\" contains an option without a label";
                }

                if (!seenLabels.Add(label))
                {
                    return $"Option labels must be unique within question \"{questionText}\"";
                }

                var previewError = ValidatePreview(option.Preview);
                if (previewError is not null)
                {
                    return $"Option \"{label}\" in question \"{questionText}\": {previewError}";
                }
            }

            if (item.MultiSelect && options.Any(option => !string.IsNullOrWhiteSpace(option.Preview)))
            {
                return $"Question \"{questionText}\" cannot use preview with multiSelect=true";
            }
        }

        return null;
    }

    private static async Task<JsonElement> RequestUserAnswersAsync(
        string toolUseId,
        IReadOnlyList<AskUserQuestion> questions,
        JsonElement parameters,
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        var request = CreateJsonElement(writer =>
        {
            writer.WriteString("toolUseId", toolUseId);
            WriteNullableString(writer, "runId", JsonHelpers.GetString(parameters, "runId"));
            WriteNullableString(writer, "agentRunId", JsonHelpers.GetString(parameters, "runId"));
            WriteNullableString(writer, "sessionId", JsonHelpers.GetString(parameters, "sessionId"));
            writer.WritePropertyName("questions");
            WriteQuestions(writer, questions);
        });

        return await AgentRuntimeReverseRequests.RequestAsync(
            context,
            "ask-user/request",
            request,
            cancellationToken);
    }

    private static bool TryReadAnswers(JsonElement response, out JsonElement answers)
    {
        answers = default;
        if (response.ValueKind == JsonValueKind.Object &&
            response.TryGetProperty("answers", out var value) &&
            value.ValueKind == JsonValueKind.Object &&
            value.EnumerateObject().Any())
        {
            answers = value.Clone();
            return true;
        }

        return false;
    }

    private static JsonElement? ReadAnnotations(JsonElement response)
    {
        if (response.ValueKind == JsonValueKind.Object &&
            response.TryGetProperty("annotations", out var value) &&
            value.ValueKind == JsonValueKind.Object)
        {
            return value.Clone();
        }

        return null;
    }

    private static string BuildStructuredResult(
        IReadOnlyList<AskUserQuestion> questions,
        JsonElement answers,
        JsonElement? annotations,
        string? source)
    {
        return EncodeJsonObject(writer =>
        {
            writer.WritePropertyName("questions");
            WriteQuestions(writer, questions);

            writer.WritePropertyName("answers");
            writer.WriteStartObject();
            var summaryParts = new List<string>();
            for (var index = 0; index < questions.Count; index++)
            {
                var key = index.ToString(System.Globalization.CultureInfo.InvariantCulture);
                if (!answers.TryGetProperty(key, out var answer))
                {
                    continue;
                }

                var answerText = SerializeAnswer(answer);
                if (answerText.Length == 0)
                {
                    continue;
                }

                writer.WriteString(questions[index].Question, answerText);
                summaryParts.Add(BuildSummaryPart(questions[index].Question, answerText, annotations, key));
            }
            writer.WriteEndObject();

            if (annotations.HasValue && annotations.Value.EnumerateObject().Any())
            {
                writer.WritePropertyName("annotations");
                writer.WriteStartObject();
                for (var index = 0; index < questions.Count; index++)
                {
                    var key = index.ToString(System.Globalization.CultureInfo.InvariantCulture);
                    if (!annotations.Value.TryGetProperty(key, out var annotation) ||
                        annotation.ValueKind != JsonValueKind.Object)
                    {
                        continue;
                    }

                    var preview = JsonHelpers.GetString(annotation, "preview");
                    var notes = JsonHelpers.GetString(annotation, "notes")?.Trim();
                    if (string.IsNullOrEmpty(preview) && string.IsNullOrEmpty(notes))
                    {
                        continue;
                    }

                    writer.WritePropertyName(questions[index].Question);
                    writer.WriteStartObject();
                    WriteNullableString(writer, "preview", preview);
                    WriteNullableString(writer, "notes", notes);
                    writer.WriteEndObject();
                }
                writer.WriteEndObject();
            }

            writer.WriteString(
                "summary",
                summaryParts.Count > 0
                    ? $"User has answered your questions: {string.Join(", ", summaryParts)}. You can now continue with the user's answers in mind."
                    : "User has answered your questions.");
            WriteNullableString(writer, "source", source);
        });
    }

    private static string BuildSummaryPart(
        string questionText,
        string answerText,
        JsonElement? annotations,
        string key)
    {
        if (!annotations.HasValue ||
            !annotations.Value.TryGetProperty(key, out var annotation) ||
            annotation.ValueKind != JsonValueKind.Object)
        {
            return $"\"{questionText}\"=\"{answerText}\"";
        }

        var extras = new List<string>();
        if (!string.IsNullOrEmpty(JsonHelpers.GetString(annotation, "preview")))
        {
            extras.Add("selected preview attached");
        }

        var notes = JsonHelpers.GetString(annotation, "notes")?.Trim();
        if (!string.IsNullOrEmpty(notes))
        {
            extras.Add($"notes: {notes}");
        }

        return extras.Count > 0
            ? $"\"{questionText}\"=\"{answerText}\" ({string.Join("; ", extras)})"
            : $"\"{questionText}\"=\"{answerText}\"";
    }

    private static string SerializeAnswer(JsonElement answer)
    {
        if (answer.ValueKind == JsonValueKind.Array)
        {
            var values = new List<string>();
            foreach (var item in answer.EnumerateArray())
            {
                var text = ElementToString(item);
                if (text.Length > 0)
                {
                    values.Add(text);
                }
            }
            return string.Join(", ", values);
        }

        return ElementToString(answer);
    }

    private static string ElementToString(JsonElement element)
    {
        return element.ValueKind switch
        {
            JsonValueKind.String => element.GetString() ?? string.Empty,
            JsonValueKind.Number or JsonValueKind.True or JsonValueKind.False => element.GetRawText(),
            _ => string.Empty
        };
    }

    private static string BuildPluginSessionMessage(IReadOnlyList<AskUserQuestion> questions)
    {
        var builder = new StringBuilder();
        builder.AppendLine(
            "You are in a plugin session and cannot show interactive UI to the user. Instead, ask the user these questions directly in your reply message:");
        foreach (var question in questions)
        {
            builder.Append("- [");
            builder.Append(question.Header);
            builder.Append("] ");
            builder.Append(question.Question);
            if (question.Options is { Count: > 0 })
            {
                builder.Append("  [");
                builder.Append(string.Join(", ", question.Options.Select(option =>
                    string.IsNullOrWhiteSpace(option.Description)
                        ? option.Label
                        : $"{option.Label} ({option.Description})")));
                builder.Append(']');
            }
            builder.AppendLine();
        }
        builder.Append("Wait for the user to respond before proceeding.");
        return builder.ToString();
    }

    private static string? ReadMetadataSource(JsonElement input)
    {
        if (input.ValueKind == JsonValueKind.Object &&
            input.TryGetProperty("metadata", out var metadata) &&
            metadata.ValueKind == JsonValueKind.Object)
        {
            return JsonHelpers.GetString(metadata, "source")?.Trim();
        }

        return null;
    }

    private static string DeriveHeader(string question, int index)
    {
        var compact = question
            .Replace("?", string.Empty, StringComparison.Ordinal)
            .Replace("\uFF1F", string.Empty, StringComparison.Ordinal)
            .Trim();
        compact = System.Text.RegularExpressions.Regex.Replace(compact, "\\s+", " ");
        if (compact.Length == 0)
        {
            return $"Q{index + 1}";
        }

        var chars = compact.EnumerateRunes().Take(MaxHeaderChars).ToArray();
        return string.Concat(chars);
    }

    private static int HeaderLength(string header)
    {
        return header.EnumerateRunes().Count();
    }

    private static string? ValidatePreview(string? preview)
    {
        if (string.IsNullOrEmpty(preview) ||
            !System.Text.RegularExpressions.Regex.IsMatch(preview, "<\\s*[a-z!][^>]*>", System.Text.RegularExpressions.RegexOptions.IgnoreCase))
        {
            return null;
        }

        if (System.Text.RegularExpressions.Regex.IsMatch(preview, "<\\s*(html|body|!doctype)\\b", System.Text.RegularExpressions.RegexOptions.IgnoreCase))
        {
            return "preview must be an HTML fragment, not a full document";
        }

        if (System.Text.RegularExpressions.Regex.IsMatch(preview, "<\\s*(script|style)\\b", System.Text.RegularExpressions.RegexOptions.IgnoreCase))
        {
            return "preview must not contain <script> or <style> tags";
        }

        return null;
    }

    private static JsonElement? GetFirstProperty(JsonElement value, params string[] names)
    {
        foreach (var name in names)
        {
            if (value.ValueKind == JsonValueKind.Object &&
                value.TryGetProperty(name, out var property))
            {
                return property.Clone();
            }
        }

        return null;
    }

    private static string? CoerceStringField(JsonElement value, params string[] keys)
    {
        if (value.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        foreach (var key in keys)
        {
            if (value.TryGetProperty(key, out var property) &&
                property.ValueKind == JsonValueKind.String)
            {
                var text = property.GetString()?.Trim();
                if (!string.IsNullOrEmpty(text))
                {
                    return text;
                }
            }
        }

        return null;
    }

    private static bool CoerceBooleanField(JsonElement value, params string[] keys)
    {
        if (value.ValueKind != JsonValueKind.Object)
        {
            return false;
        }

        foreach (var key in keys)
        {
            if (!value.TryGetProperty(key, out var property))
            {
                continue;
            }

            if (property.ValueKind == JsonValueKind.True)
            {
                return true;
            }

            if (property.ValueKind == JsonValueKind.False)
            {
                return false;
            }

            if (property.ValueKind == JsonValueKind.String)
            {
                var normalized = property.GetString()?.Trim().ToLowerInvariant();
                if (normalized == "true")
                {
                    return true;
                }

                if (normalized == "false")
                {
                    return false;
                }
            }
        }

        return false;
    }

    private static bool TryParseJsonElement(string value, out JsonElement element)
    {
        try
        {
            using var document = JsonDocument.Parse(value);
            element = document.RootElement.Clone();
            return true;
        }
        catch (JsonException)
        {
            element = default;
            return false;
        }
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

    private static string EncodeError(string message)
    {
        return EncodeJsonObject(writer => writer.WriteString("error", message));
    }

    private static string EncodeJsonObject(Action<Utf8JsonWriter> writeProperties)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream, WriterOptions))
        {
            writer.WriteStartObject();
            writeProperties(writer);
            writer.WriteEndObject();
        }
        return Encoding.UTF8.GetString(stream.ToArray());
    }

    private static void WriteQuestions(Utf8JsonWriter writer, IReadOnlyList<AskUserQuestion> questions)
    {
        writer.WriteStartArray();
        foreach (var question in questions)
        {
            writer.WriteStartObject();
            writer.WriteString("question", question.Question);
            WriteNullableString(writer, "header", question.Header);
            writer.WriteBoolean("multiSelect", question.MultiSelect);
            if (question.Options is { Count: > 0 })
            {
                writer.WritePropertyName("options");
                writer.WriteStartArray();
                foreach (var option in question.Options)
                {
                    writer.WriteStartObject();
                    writer.WriteString("label", option.Label);
                    WriteNullableString(writer, "description", option.Description);
                    WriteNullableString(writer, "preview", option.Preview);
                    writer.WriteEndObject();
                }
                writer.WriteEndArray();
            }
            writer.WriteEndObject();
        }
        writer.WriteEndArray();
    }

    private static void WriteNullableString(Utf8JsonWriter writer, string name, string? value)
    {
        if (!string.IsNullOrEmpty(value))
        {
            writer.WriteString(name, value);
        }
    }

    private sealed record AskUserQuestion(
        string Question,
        string? Header,
        List<AskUserOption>? Options,
        bool MultiSelect);

    private sealed record AskUserOption(string Label, string? Description, string? Preview);
}
