internal sealed class FileModule : IWorkerModule
{
    public string Name => "file";

    public void Register(WorkerModuleContext context)
    {
        context.Register("fs/read-file", FileTools.ReadFileAsync);
        context.Register("fs/read-document", FileDocumentTools.ReadDocumentAsync);
        context.Register("fs/read-file-binary", FileTools.ReadBinaryFileAsync);
        context.Register("fs/write-file", FileTools.WriteFileAsync);
        context.Register("fs/write-file-binary", FileTools.WriteBinaryFileAsync);
        context.Register("fs/stat-path", FileTools.StatPath);
        context.Register("fs/mkdir", FileTools.MakeDirectory);
        context.Register("fs/delete", FileTools.DeletePath);
        context.Register("fs/move", FileTools.MovePath);
        context.Register("fs/read-text-file-lines", FileTools.ReadTextFileLinesAsync);
        context.Register("fs/list-dir", FileTools.ListDirectory);
        context.Register("fs/glob", FileTools.Glob);
        context.Register("fs/search-files", FileTools.SearchFiles);
        context.Register("fs/grep", FileTools.GrepAsync);
    }
}
