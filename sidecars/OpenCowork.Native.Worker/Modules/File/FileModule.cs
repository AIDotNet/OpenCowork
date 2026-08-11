internal sealed class FileModule : IWorkerModule
{
    public string Name => "file";

    public void Register(WorkerModuleContext context)
    {
        context.Register("fs/read-file", FileTools.ReadFileAsync);
        context.RegisterJob("fs/read-document", FileDocumentTools.ReadDocumentAsync, lanePolicy: "project");
        context.RegisterJob("fs/read-file-binary", FileTools.ReadBinaryFileAsync, lanePolicy: "project");
        context.Register("fs/write-file", FileTools.WriteFileAsync);
        context.RegisterJob("fs/write-file-binary", FileTools.WriteBinaryFileAsync, lanePolicy: "project");
        context.Register("fs/stat-path", FileTools.StatPath);
        context.Register("fs/mkdir", FileTools.MakeDirectory);
        context.Register("fs/delete", FileTools.DeletePath);
        context.Register("fs/move", FileTools.MovePath);
        context.Register("fs/read-text-file-lines", FileTools.ReadTextFileLinesAsync);
        context.Register("fs/list-dir", FileTools.ListDirectory);
        context.Register("fs/glob", FileTools.Glob);
        context.Register("fs/search-files", FileTools.SearchFiles);
        context.RegisterJob("fs/grep", FileTools.GrepAsync, lanePolicy: "project");
    }
}
