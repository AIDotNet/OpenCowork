internal sealed class SettingsModule : IWorkerModule
{
    public string Name => "settings";

    public void Register(WorkerModuleContext context)
    {
        context.Register("settings/read", SettingsStore.Read);
        context.Register("settings/write", SettingsStore.Write);
        context.Register("settings/get", SettingsStore.Get);
        context.Register("settings/set", SettingsStore.Set);
        context.Register("settings/delete", SettingsStore.Delete);
    }
}
