internal sealed class SyncModule : IWorkerModule
{
    public string Name => "sync";

    public void Register(WorkerModuleContext context)
    {
        context.RegisterJob("sync/files-capture", SyncFileStore.CaptureAsync, lanePolicy: "project");
        context.RegisterJob("sync/files-apply", SyncFileStore.ApplyAsync, lanePolicy: "project");
        context.RegisterJob("sync/files-delete", SyncFileStore.DeleteAsync, lanePolicy: "project");
    }
}
