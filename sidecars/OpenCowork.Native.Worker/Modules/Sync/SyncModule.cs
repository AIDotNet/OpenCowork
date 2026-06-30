internal sealed class SyncModule : IWorkerModule
{
    public string Name => "sync";

    public void Register(WorkerModuleContext context)
    {
        context.Register("sync/files-capture", SyncFileStore.CaptureAsync);
        context.Register("sync/files-apply", SyncFileStore.ApplyAsync);
        context.Register("sync/files-delete", SyncFileStore.DeleteAsync);
    }
}
