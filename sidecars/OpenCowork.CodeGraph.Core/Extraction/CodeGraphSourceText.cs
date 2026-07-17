using System.Text;

// =============================================================================
// CodeGraphSourceText — the UTF-8 byte buffer (Decision 22).
//
// Owns the file's `byte[]`, slices it by BYTE offset, and maps a byte offset to a
// (line, column) position. This single type centralizes the byte-offset
// discipline (risk R4/R9): NO other code should ever slice source by char index —
// tree-sitter reports byte offsets, and one non-ASCII char desyncs byte vs char.
//
//   * Lines are 1-based; columns are 0-based BYTE columns (schema §, Decision 22).
//   * File bytes are already UTF-8 on disk — FromUtf8 avoids the UTF-16 round-trip.
//   * A preParse transform must PRESERVE byte length (equal-length assertion).
// =============================================================================
internal sealed class CodeGraphSourceText
{
    private readonly byte[] _utf8;

    // Lazily-computed byte offsets of each line start. _lineStarts[k] is the byte
    // index at which line (k+1) begins; _lineStarts[0] is always 0.
    private int[]? _lineStarts;

    private CodeGraphSourceText(byte[] utf8) => _utf8 = utf8;

    /// <summary>Build from a managed string (UTF-16 -> UTF-8). Prefer FromUtf8 for file bytes.</summary>
    public static CodeGraphSourceText FromString(string source) =>
        new(Encoding.UTF8.GetBytes(source));

    /// <summary>Take ownership of an existing UTF-8 buffer (no copy, no round-trip).</summary>
    public static CodeGraphSourceText FromUtf8(byte[] utf8) => new(utf8);

    /// <summary>The pinned-for-parse UTF-8 span (fed to ts_parser_parse_string).</summary>
    public ReadOnlySpan<byte> Utf8Span => _utf8;

    /// <summary>Byte length — the value passed as the parse `length` (Decision 22).</summary>
    public int ByteLength => _utf8.Length;

    /// <summary>
    /// getNodeText: reconstruct text from a byte range [startByte, endByte).
    /// NEVER slice a C# string by these offsets — they are byte indices.
    /// </summary>
    public string Slice(int startByte, int endByte)
    {
        if (startByte < 0) startByte = 0;
        if (endByte > _utf8.Length) endByte = _utf8.Length;
        if (endByte <= startByte) return string.Empty;
        return Encoding.UTF8.GetString(_utf8, startByte, endByte - startByte);
    }

    /// <summary>
    /// Map a byte offset to a (Line, Column): Line is 1-based, Column is the
    /// 0-based BYTE column within the line. Backs the byte->(line,col) map for any
    /// coordinate not carried directly by a TSPoint.
    /// </summary>
    public (int Line, int Column) LineColumnAt(int byteOffset)
    {
        if (byteOffset < 0) byteOffset = 0;
        if (byteOffset > _utf8.Length) byteOffset = _utf8.Length;

        int[] starts = LineStarts();

        // Greatest lineStart <= byteOffset (binary search).
        int lo = 0;
        int hi = starts.Length - 1;
        int line = 0;
        while (lo <= hi)
        {
            int mid = (int)(((uint)lo + (uint)hi) >> 1);
            if (starts[mid] <= byteOffset)
            {
                line = mid;
                lo = mid + 1;
            }
            else
            {
                hi = mid - 1;
            }
        }

        return (line + 1, byteOffset - starts[line]); // 1-based line, 0-based byte column
    }

    /// <summary>
    /// Apply a preParse transform (e.g. macro-blanking) that MUST return an
    /// equal-byte-length buffer — tests assert out.length === in.length so byte
    /// offsets stay valid (Decision 22 / analysis-01 R4).
    /// </summary>
    public CodeGraphSourceText WithPreParse(Func<byte[], byte[]> preParse)
    {
        byte[] next = preParse(_utf8);
        if (next.Length != _utf8.Length)
            throw new InvalidOperationException("preParse must preserve byte length (Decision 22)");
        return new CodeGraphSourceText(next);
    }

    private int[] LineStarts()
    {
        int[]? cached = _lineStarts;
        if (cached is not null) return cached;

        // One entry per line: index 0 => 0, then the byte just after each '\n'.
        List<int> starts = new() { 0 };
        for (int i = 0; i < _utf8.Length; i++)
        {
            if (_utf8[i] == (byte)'\n') starts.Add(i + 1);
        }

        int[] result = starts.ToArray();
        _lineStarts = result;
        return result;
    }
}
