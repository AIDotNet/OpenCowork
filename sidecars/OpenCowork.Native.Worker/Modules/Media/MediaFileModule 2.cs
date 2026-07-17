internal sealed class MediaFileModule : IWorkerModule
{
    public string Name => "media-file";

    public void Register(WorkerModuleContext context)
    {
        context.Register("media/read-file-chunk", MediaFileTools.ReadChunkAsync);
    }
}
