internal sealed class SkillModule : IWorkerModule
{
    public string Name => "skills";

    public void Register(WorkerModuleContext context)
    {
        context.Register("skills/ensure-builtins", SkillCatalog.EnsureBuiltins);
        context.Register("skills/ensure-builtin", SkillCatalog.EnsureBuiltin);
        context.Register("skills/list", SkillCatalog.List);
        context.Register("skills/load", SkillCatalog.Load);
        context.Register("skills/read", SkillCatalog.Read);
        context.Register("skills/list-files", SkillCatalog.ListFiles);
        context.Register("skills/delete", SkillCatalog.Delete);
        context.Register("skills/resolve-path", SkillCatalog.ResolvePath);
        context.Register("skills/add-from-folder", SkillCatalog.AddFromFolder);
        context.Register("skills/save", SkillCatalog.Save);
        context.Register("skills/scan", SkillCatalog.Scan);
        context.Register("skills/market-list", SkillCatalog.MarketListAsync);
        context.Register("skills/download-remote", SkillCatalog.DownloadRemoteAsync);
        context.Register("skills/cleanup-temp", SkillCatalog.CleanupTemp);
    }
}
