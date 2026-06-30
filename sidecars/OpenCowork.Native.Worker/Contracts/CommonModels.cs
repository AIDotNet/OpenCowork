internal sealed record ErrorResult(string Error);
internal sealed record StatusResult(bool Ok, int Pid);
internal sealed record WorkerRoutesResult(string[] Methods);
