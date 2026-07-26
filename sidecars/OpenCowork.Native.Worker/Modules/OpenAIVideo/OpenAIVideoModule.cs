internal sealed class OpenAIVideoModule : IWorkerModule
{
    public string Name => "openai-video";

    public void Register(WorkerModuleContext context)
    {
        context.Register("openai-video/generate", OpenAIVideoTools.GenerateAsync);
        context.Register("openai-video/status", OpenAIVideoTools.StatusAsync);
        context.Register("openai-video/download", OpenAIVideoTools.DownloadAsync);
    }
}
