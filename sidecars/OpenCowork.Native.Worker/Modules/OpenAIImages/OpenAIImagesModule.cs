internal sealed class OpenAIImagesModule : IWorkerModule
{
    public string Name => "openai-images";

    public void Register(WorkerModuleContext context)
    {
        context.RegisterJob("openai-images/generate", OpenAIImagesTools.GenerateAsync);
    }
}
