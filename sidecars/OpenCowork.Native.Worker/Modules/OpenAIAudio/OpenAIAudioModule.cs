internal sealed class OpenAIAudioModule : IWorkerModule
{
    public string Name => "openai-audio";

    public void Register(WorkerModuleContext context)
    {
        context.RegisterJob("openai-audio/transcribe", OpenAIAudioTools.TranscribeAsync);
        context.RegisterJob("openai-audio/speech", OpenAIAudioTools.SpeechAsync);
    }
}
