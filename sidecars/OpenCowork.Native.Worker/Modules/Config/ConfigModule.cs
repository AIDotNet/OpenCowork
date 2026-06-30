internal sealed class ConfigModule : IWorkerModule
{
    public string Name => "config";

    public void Register(WorkerModuleContext context)
    {
        context.Register("config/read", ConfigStore.Read);
        context.Register("config/write", ConfigStore.Write);
        context.Register("config/get", ConfigStore.Get);
        context.Register("config/set", ConfigStore.Set);
        context.Register("config/delete", ConfigStore.Delete);
    }
}
