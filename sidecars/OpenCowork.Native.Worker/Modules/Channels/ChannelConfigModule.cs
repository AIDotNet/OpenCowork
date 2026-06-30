internal sealed class ChannelConfigModule : IWorkerModule
{
    public string Name => "channels";

    public void Register(WorkerModuleContext context)
    {
        context.Register("channel/config-list", ChannelConfigStore.List);
        context.Register("channel/config-write", ChannelConfigStore.Write);
        context.Register("channel/config-get", ChannelConfigStore.Get);
        context.Register("channel/config-add", ChannelConfigStore.Add);
        context.Register("channel/config-update", ChannelConfigStore.Update);
        context.Register("channel/config-remove", ChannelConfigStore.Remove);
        context.Register("channel/qq-session-load", QqSessionStore.Load);
        context.Register("channel/qq-session-save", QqSessionStore.Save);
        context.Register("channel/qq-session-clear", QqSessionStore.Clear);
    }
}
