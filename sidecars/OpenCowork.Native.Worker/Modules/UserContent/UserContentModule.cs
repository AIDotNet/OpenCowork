internal sealed class UserContentModule : IWorkerModule
{
    public string Name => "user-content";

    public void Register(WorkerModuleContext context)
    {
        context.Register("prompts/list", UserPromptCatalog.List);
        context.Register("prompts/ensure", UserPromptCatalog.Ensure);
        context.Register("prompts/load", UserPromptCatalog.Load);
        context.Register("commands/list", UserCommandCatalog.List);
        context.Register("commands/ensure", UserCommandCatalog.Ensure);
        context.Register("commands/load", UserCommandCatalog.Load);
        context.Register("commands/manage-list", UserCommandCatalog.ManageList);
        context.Register("commands/manage-read", UserCommandCatalog.ManageRead);
        context.Register("commands/manage-create", UserCommandCatalog.ManageCreate);
        context.Register("commands/manage-save", UserCommandCatalog.ManageSave);
        context.Register("agents/list", UserAgentCatalog.List);
        context.Register("agents/ensure", UserAgentCatalog.Ensure);
        context.Register("agents/load", UserAgentCatalog.Load);
        context.Register("agents/manage-list", UserAgentCatalog.ManageList);
        context.Register("agents/manage-read", UserAgentCatalog.ManageRead);
        context.Register("agents/manage-save", UserAgentCatalog.ManageSave);
        context.Register("souls/builtin-list", UserSoulCatalog.BuiltinList);
        context.Register("souls/market-list", UserSoulCatalog.MarketListAsync);
        context.Register("souls/categories", UserSoulCatalog.CategoriesAsync);
        context.Register("souls/download-remote", UserSoulCatalog.DownloadRemoteAsync);
        context.Register("souls/get-target-paths", UserSoulCatalog.GetTargetPaths);
        context.Register("souls/install", UserSoulCatalog.Install);
    }
}
