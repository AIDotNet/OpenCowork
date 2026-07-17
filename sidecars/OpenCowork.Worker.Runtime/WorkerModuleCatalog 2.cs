// Stub catalog for the SHARED runtime lib. The main worker's real WorkerModuleCatalog
// (its 21-module list) is deliberately NOT source-linked here — it references Modules/*.
// This empty Default only satisfies WorkerHostBuilder.UseDefaultModules()/WorkerHost.
// CreateDefault(); the CodeGraph worker never uses those — it calls AddModule(new
// CodeGraphModule()) explicitly. Each hosting binary supplies its own module set.
internal static class WorkerModuleCatalog
{
    internal static IReadOnlyList<IWorkerModule> Default { get; } = new List<IWorkerModule>();
}
