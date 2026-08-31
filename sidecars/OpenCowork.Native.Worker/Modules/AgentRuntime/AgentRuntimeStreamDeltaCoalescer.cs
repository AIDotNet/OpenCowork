using System.Text;

/// <summary>
/// Turns snapshot-or-incremental provider chunks into a single increment.
/// Some OpenAI-compatible gateways replay the full accumulated reasoning or
/// output text in every event; appending those verbatim triples the transcript.
/// </summary>
internal static class AgentRuntimeStreamDeltaCoalescer
{
    public static string? TakeIncrement(StringBuilder accumulated, string? incoming)
    {
        if (string.IsNullOrEmpty(incoming))
        {
            return null;
        }

        if (accumulated.Length == 0)
        {
            accumulated.Append(incoming);
            return incoming;
        }

        if (incoming.Length >= accumulated.Length)
        {
            var current = accumulated.ToString();
            if (incoming.StartsWith(current, StringComparison.Ordinal))
            {
                if (incoming.Length == current.Length)
                {
                    return null;
                }

                var extra = incoming[current.Length..];
                accumulated.Append(extra);
                return extra;
            }
        }

        accumulated.Append(incoming);
        return incoming;
    }
}
