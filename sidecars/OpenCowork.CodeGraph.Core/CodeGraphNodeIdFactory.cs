using System.Security.Cryptography;
using System.Text;

// Node-id + content-hash formulas (Decision 17, reference/01 §4). One shared
// factory used by BOTH extraction and resolution — synthesizers reconstruct ids
// by this exact formula, so it must never drift.
//
// Load-bearing: any line shift changes a symbol's id, which is why incremental
// re-index re-resolves incoming edges by (name, kind), not by old id.
internal static class CodeGraphNodeIdFactory
{
    // id = "{kind}:" + lowerhex(sha256(utf8($"{filePath}:{kind}:{name}:{line}")))[..32]
    // line is 1-based (nodes.start_line). 32 hex chars = 128-bit truncated digest.
    // Parity note: JS crypto hex output is lowercase, so lowercasing is mandatory.
    public static string NodeId(string filePath, string kind, string name, int line)
    {
        var payload = Encoding.UTF8.GetBytes($"{filePath}:{kind}:{name}:{line}");
        Span<byte> digest = stackalloc byte[32];         // SHA-256 = 32 bytes
        SHA256.HashData(payload, digest);
        var hex = Convert.ToHexStringLower(digest);      // 64 chars, lowercase
        return $"{kind}:{hex.AsSpan(0, 32)}";            // kind prefix + first 32 hex chars
    }

    // Full lowercase hex sha256 of the file's UTF-8 bytes -> files.content_hash.
    // Change detection is by content hash, not mtime.
    public static string ContentHash(ReadOnlySpan<byte> fileBytes)
    {
        Span<byte> digest = stackalloc byte[32];
        SHA256.HashData(fileBytes, digest);
        return Convert.ToHexStringLower(digest);         // full 64-char hex
    }
}
