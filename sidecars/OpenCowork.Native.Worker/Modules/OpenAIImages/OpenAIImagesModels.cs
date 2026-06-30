internal sealed record NativeOpenAIImagesResult(NativeGeneratedImage[] Images);

internal sealed record NativeGeneratedImage(string SourceType, string Data, string MediaType);
