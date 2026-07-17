internal static class WorkerTaskQuotas
{
    private static readonly SemaphoreSlim MediaSlots = new(
        ReadLimit("OPEN_COWORK_NATIVE_MAX_MEDIA_TASKS", 4, 1, 32),
        ReadLimit("OPEN_COWORK_NATIVE_MAX_MEDIA_TASKS", 4, 1, 32));

    public static async ValueTask<IDisposable> EnterMediaAsync(CancellationToken cancellationToken)
    {
        await MediaSlots.WaitAsync(cancellationToken);
        return new SemaphoreLease(MediaSlots);
    }

    private static int ReadLimit(string variableName, int defaultValue, int minimum, int maximum)
    {
        var raw = Environment.GetEnvironmentVariable(variableName);
        return int.TryParse(raw, out var value)
            ? Math.Clamp(value, minimum, maximum)
            : defaultValue;
    }

    private sealed class SemaphoreLease : IDisposable
    {
        private SemaphoreSlim? semaphore;

        public SemaphoreLease(SemaphoreSlim semaphore)
        {
            this.semaphore = semaphore;
        }

        public void Dispose()
        {
            Interlocked.Exchange(ref semaphore, null)?.Release();
        }
    }
}
