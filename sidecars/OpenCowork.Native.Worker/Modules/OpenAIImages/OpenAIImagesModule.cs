internal sealed class OpenAIImagesModule : IWorkerModule
{
    public string Name => "openai-images";

    public void Register(WorkerModuleContext context)
    {
        context.Register("openai-images/generate", OpenAIImagesTools.GenerateAsync);
    }
}
