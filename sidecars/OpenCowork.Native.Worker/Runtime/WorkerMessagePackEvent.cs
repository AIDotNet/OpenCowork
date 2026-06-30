internal readonly record struct WorkerMessagePackEvent(string EventName, ReadOnlyMemory<byte> Payload);
