internal sealed class ExtensionModule : IWorkerModule
{
    public string Name => "extensions";

    public void Register(WorkerModuleContext context)
    {
        context.Register("extension/list", ExtensionManifestStore.List);
        context.Register("extension/install-from-folder", ExtensionManifestStore.InstallFromFolder);
        context.Register("extension/update", ExtensionManifestStore.Update);
        context.Register("extension/remove", ExtensionManifestStore.Remove);
        context.Register("extension/resolve-path", ExtensionManifestStore.ResolvePath);
        context.Register("extension/read-asset", ExtensionManifestStore.ReadAsset);
        context.Register("extension/storage-get", ExtensionManifestStore.StorageGet);
        context.Register("extension/storage-set", ExtensionManifestStore.StorageSet);
        context.Register("extension/storage-delete", ExtensionManifestStore.StorageDelete);
        context.Register("extension/execute-tool", ExtensionHttpToolExecutor.ExecuteWorkerAsync);
    }
}
