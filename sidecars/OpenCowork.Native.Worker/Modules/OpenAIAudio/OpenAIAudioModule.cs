internal sealed class OpenAIAudioModule : IWorkerModule
{
    public string Name => "openai-audio";

    public void Register(WorkerModuleContext context)
    {
        context.Register("openai-audio/transcribe", OpenAIAudioTools.TranscribeAsync);
        context.Register("openai-audio/speech", OpenAIAudioTools.SpeechAsync);
    }
}
