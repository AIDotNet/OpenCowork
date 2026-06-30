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
        new OpenAIImagesModule(),
        new OpenAIAudioModule(),
        new WebModule(),
        new McpConfigModule(),
        new UserContentModule(),
        new ShellModule(),
        new TerminalModule(),
        new SshModule()
    ];
}
