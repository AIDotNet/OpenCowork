using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Xml;

internal static class FileDocumentTools
{
    private const long DefaultMaxDocumentReadBytes = 10 * 1024 * 1024;

    public static async Task<WorkerResponse> ReadDocumentAsync(JsonElement parameters)
    {
        try
        {
            var filePath = RequirePath(parameters);
            var maxFileReadBytes = JsonHelpers.GetLong(parameters, "maxFileReadBytes", DefaultMaxDocumentReadBytes);
            var result = await ReadDocumentAsync(filePath, maxFileReadBytes, CancellationToken.None);
            return WorkerResponse.Json(result, WorkerJsonContext.Default.DocumentReadResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new DocumentReadResult(null, null, ex.Message),
                WorkerJsonContext.Default.DocumentReadResult);
        }
    }

    public static async Task<DocumentReadResult> ReadDocumentAsync(
        string filePath,
        long maxFileReadBytes,
        CancellationToken cancellationToken)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(filePath))
            {
                throw new InvalidOperationException("Missing path");
            }

            EnsureFileSize(filePath, maxFileReadBytes);
            var extension = Path.GetExtension(filePath);
            var content = string.Equals(extension, ".docx", StringComparison.OrdinalIgnoreCase)
                ? ReadDocxText(filePath)
                : await File.ReadAllTextAsync(filePath, Encoding.UTF8, cancellationToken);

            return new DocumentReadResult(content, Path.GetFileName(filePath), null);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return new DocumentReadResult(null, null, ex.Message);
        }
    }

    private static string ReadDocxText(string filePath)
    {
        using var archive = ZipFile.OpenRead(filePath);
        var builder = new StringBuilder();
        AppendDocxPartText(archive, "word/document.xml", builder);

        foreach (var entry in archive.Entries.OrderBy(static entry => entry.FullName, StringComparer.Ordinal))
        {
            if (!IsHeaderFooterEntry(entry.FullName))
            {
                continue;
            }

            if (builder.Length > 0)
            {
                AppendParagraphBreak(builder);
            }
            AppendDocxPartText(entry, builder);
        }

        return NormalizeExtractedText(builder.ToString());
    }

    private static void AppendDocxPartText(ZipArchive archive, string entryName, StringBuilder builder)
    {
        var entry = archive.GetEntry(entryName) ??
            throw new InvalidOperationException($"DOCX is missing {entryName}");
        AppendDocxPartText(entry, builder);
    }

    private static void AppendDocxPartText(ZipArchiveEntry entry, StringBuilder builder)
    {
        using var stream = entry.Open();
        using var reader = XmlReader.Create(
            stream,
            new XmlReaderSettings
            {
                DtdProcessing = DtdProcessing.Prohibit,
                IgnoreComments = true,
                IgnoreProcessingInstructions = true
            });

        while (reader.Read())
        {
            if (reader.NodeType != XmlNodeType.Element)
            {
                continue;
            }

            switch (reader.LocalName)
            {
                case "t":
                    builder.Append(reader.ReadElementContentAsString());
                    break;
                case "tab":
                    builder.Append('\t');
                    break;
                case "br":
                case "cr":
                    builder.Append('\n');
                    break;
                case "p":
                    if (builder.Length > 0 && builder[builder.Length - 1] != '\n')
                    {
                        AppendParagraphBreak(builder);
                    }
                    break;
            }
        }
    }

    private static bool IsHeaderFooterEntry(string entryName)
    {
        return entryName.StartsWith("word/header", StringComparison.OrdinalIgnoreCase) ||
            entryName.StartsWith("word/footer", StringComparison.OrdinalIgnoreCase);
    }

    private static void AppendParagraphBreak(StringBuilder builder)
    {
        if (builder.Length == 0)
        {
            return;
        }
        if (builder[builder.Length - 1] != '\n')
        {
            builder.Append('\n');
        }
    }

    private static string NormalizeExtractedText(string value)
    {
        return value
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace('\r', '\n')
            .Trim();
    }

    private static void EnsureFileSize(string filePath, long limit)
    {
        var info = new FileInfo(filePath);
        if (!info.Exists)
        {
            throw new FileNotFoundException($"File not found: {filePath}", filePath);
        }
        if (info.Length > limit)
        {
            throw new InvalidOperationException($"File too large ({info.Length / 1024d / 1024d:0.0} MB, limit {limit / 1024d / 1024d:0} MB): {filePath}");
        }
    }

    private static string RequirePath(JsonElement parameters)
    {
        return JsonHelpers.GetString(parameters, "path") is { Length: > 0 } filePath
            ? filePath
            : throw new InvalidOperationException("Missing path");
    }
}
