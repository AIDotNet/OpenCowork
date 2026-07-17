using System.Buffers;
using System.Text.Json;

internal static class MediaFileTools
{
    private const int DefaultChunkBytes = 256 * 1024;
    private const int MaxChunkBytes = 512 * 1024;

    public static async Task<WorkerResponse> ReadChunkAsync(
        JsonElement parameters,
        WorkerRequestContext context)
    {
        var filePath = JsonHelpers.GetString(parameters, "filePath")?.Trim();
        if (string.IsNullOrWhiteSpace(filePath))
        {
            throw new InvalidOperationException("Media chunk read requires filePath.");
        }

        filePath = MediaFileStore.EnsureAllowedPath(filePath);
        var offset = Math.Max(0, JsonHelpers.GetLong(parameters, "offset", 0));
        var requestedLength = Math.Clamp(
            JsonHelpers.GetInt(parameters, "length", DefaultChunkBytes),
            1,
            MaxChunkBytes);
        var deleteWhenDone = JsonHelpers.GetBool(parameters, "deleteWhenDone", false);

        byte[] bytes;
        long nextOffset;
        bool done;
        await using (var stream = new FileStream(
            filePath,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            DefaultChunkBytes,
            FileOptions.Asynchronous | FileOptions.SequentialScan))
        {
            if (offset > stream.Length)
            {
                throw new InvalidOperationException("Media chunk offset exceeds file length.");
            }

            stream.Position = offset;
            var length = (int)Math.Min(requestedLength, stream.Length - offset);
            bytes = GC.AllocateUninitializedArray<byte>(length);
            var total = 0;
            while (total < length)
            {
                var read = await stream.ReadAsync(bytes.AsMemory(total, length - total), context.CancellationToken);
                if (read == 0)
                {
                    break;
                }
                total += read;
            }
            if (total != bytes.Length)
            {
                Array.Resize(ref bytes, total);
            }

            nextOffset = offset + total;
            done = nextOffset >= stream.Length;
        }

        if (done && deleteWhenDone)
        {
            try
            {
                File.Delete(filePath);
            }
            catch (IOException)
            {
                // The chunk is already available; cleanup is best effort.
            }
        }

        var base64 = Convert.ToBase64String(bytes);
        return WorkerResponse.DirectMessagePack(writer =>
        {
            writer.WriteMapHeader(5);
            writer.WriteString("data");
            writer.WriteString(base64);
            writer.WriteString("offset");
            writer.WriteInt64(offset);
            writer.WriteString("nextOffset");
            writer.WriteInt64(nextOffset);
            writer.WriteString("done");
            writer.WriteBoolean(done);
            writer.WriteString("bytes");
            writer.WriteInt64(bytes.Length);
        });
    }
}

internal static class MediaFileStore
{
    private static readonly string Root = Path.GetFullPath(Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".open-cowork",
        "media"));

    public static string EnsureAllowedPath(string filePath)
    {
        var fullPath = Path.GetFullPath(filePath);
        var comparison = OperatingSystem.IsWindows()
            ? StringComparison.OrdinalIgnoreCase
            : StringComparison.Ordinal;
        var rootPrefix = Root.EndsWith(Path.DirectorySeparatorChar)
            ? Root
            : Root + Path.DirectorySeparatorChar;
        if (!fullPath.StartsWith(rootPrefix, comparison))
        {
            throw new UnauthorizedAccessException("Media file path is outside the worker media directory.");
        }
        return fullPath;
    }

    public static async Task<string> WriteBytesAsync(
        string category,
        string extension,
        ReadOnlyMemory<byte> bytes,
        CancellationToken cancellationToken)
    {
        var filePath = CreateOutputPath(category, extension);
        await File.WriteAllBytesAsync(filePath, bytes, cancellationToken);
        return filePath;
    }

    public static async Task<(string FilePath, long Bytes)> WriteHttpContentAsync(
        HttpContent content,
        string category,
        string extension,
        long maxBytes,
        CancellationToken cancellationToken)
    {
        if (content.Headers.ContentLength is long contentLength && contentLength > maxBytes)
        {
            throw new InvalidOperationException($"Media response exceeds the {maxBytes} byte limit.");
        }

        var filePath = CreateOutputPath(category, extension);
        try
        {
            await using var input = await content.ReadAsStreamAsync(cancellationToken);
            await using var output = new FileStream(
                filePath,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None,
                64 * 1024,
                FileOptions.Asynchronous | FileOptions.SequentialScan);
            var buffer = ArrayPool<byte>.Shared.Rent(64 * 1024);
            long total = 0;
            try
            {
                while (true)
                {
                    var read = await input.ReadAsync(buffer.AsMemory(), cancellationToken);
                    if (read == 0)
                    {
                        break;
                    }
                    total += read;
                    if (total > maxBytes)
                    {
                        throw new InvalidOperationException(
                            $"Media response exceeds the {maxBytes} byte limit.");
                    }
                    await output.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
                }
            }
            finally
            {
                ArrayPool<byte>.Shared.Return(buffer);
            }

            return (filePath, total);
        }
        catch
        {
            TryDelete(filePath);
            throw;
        }
    }

    public static async Task<byte[]> ReadHttpContentBytesAsync(
        HttpContent content,
        int maxBytes,
        CancellationToken cancellationToken)
    {
        if (content.Headers.ContentLength is long contentLength && contentLength > maxBytes)
        {
            throw new InvalidOperationException($"Media response exceeds the {maxBytes} byte limit.");
        }

        await using var stream = await content.ReadAsStreamAsync(cancellationToken);
        var output = new ArrayBufferWriter<byte>();
        var buffer = ArrayPool<byte>.Shared.Rent(64 * 1024);
        try
        {
            while (true)
            {
                var read = await stream.ReadAsync(buffer.AsMemory(), cancellationToken);
                if (read == 0)
                {
                    break;
                }
                if (output.WrittenCount + read > maxBytes)
                {
                    throw new InvalidOperationException(
                        $"Media response exceeds the {maxBytes} byte limit.");
                }
                buffer.AsSpan(0, read).CopyTo(output.GetSpan(read));
                output.Advance(read);
            }
            return output.WrittenMemory.ToArray();
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buffer);
        }
    }

    private static string CreateOutputPath(string category, string extension)
    {
        var safeCategory = string.Concat(category.Where(static character =>
            char.IsLetterOrDigit(character) || character is '-' or '_'));
        if (safeCategory.Length == 0)
        {
            safeCategory = "other";
        }
        if (!extension.StartsWith('.'))
        {
            extension = "." + extension;
        }

        var directory = Path.Combine(
            Root,
            safeCategory,
            DateTime.UtcNow.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture));
        Directory.CreateDirectory(directory);
        return Path.Combine(directory, $"{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}-{Guid.NewGuid():N}{extension}");
    }

    private static void TryDelete(string filePath)
    {
        try
        {
            File.Delete(filePath);
        }
        catch
        {
            // Best effort after a failed write.
        }
    }
}
