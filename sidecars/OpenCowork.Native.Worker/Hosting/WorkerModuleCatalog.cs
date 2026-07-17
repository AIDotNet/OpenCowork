internal static class WorkerModuleCatalog
{
    public static IReadOnlyList<IWorkerModule> Default { get; } =
    [
        new SystemModule(),
        new FileModule(),
        new GitModule(),
        new DbModule(),
        new SyncModule(),
        new SettingsModule(),
        new ConfigModule(),
        new ChannelConfigModule(),
        new SkillModule(),
        new ExtensionModule(),
        new AgentRuntimeModule(),
        new AgentChangeModule(),
        new MediaFileModule(),
        new OpenAIImagesModule(),
        new OpenAIAudioModule(),
        new SeedanceVideoModule(),
        new XaiVideoModule(),
        new WebModule(),
        new McpConfigModule(),
        new UserContentModule(),
        new ShellModule(),
        new TerminalModule(),
        new SshModule(),
        // CodeGraph (source-merged engine): codegraph/* methods. Handlers gate on
        // per-project state; registration never blocks boot (not in the required set).
        new CodeGraphModule()
    ];
}
