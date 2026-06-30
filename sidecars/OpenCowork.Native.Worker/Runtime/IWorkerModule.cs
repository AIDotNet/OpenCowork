internal interface IWorkerModule
{
    string Name { get; }

    void Register(WorkerModuleContext context);
}
