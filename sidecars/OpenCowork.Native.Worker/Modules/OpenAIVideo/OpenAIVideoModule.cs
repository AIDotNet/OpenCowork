internal sealed class OpenAIVideoModule : IWorkerModule
{
    public string Name => "openai-video";

    public void Register(WorkerModuleContext context)
    {
        context.RegisterJob("openai-video/generate", OpenAIVideoTools.GenerateAsync);
        context.Register("openai-video/status", OpenAIVideoTools.StatusAsync);
        context.RegisterJob("openai-video/download", OpenAIVideoTools.DownloadAsync);
    }
}
