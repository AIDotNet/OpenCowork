using System.Text.Json;

internal readonly struct WorkerModuleContext
{
    private readonly WorkerDispatcher dispatcher;

    public WorkerModuleContext(WorkerDispatcher dispatcher)
    {
        this.dispatcher = dispatcher;
    }

    public void Register(string method, Func<JsonElement, Task<WorkerResponse>> handler)
    {
        dispatcher.Register(method, handler);
    }

    public void Register(string method, Func<JsonElement, WorkerResponse> handler)
    {
        dispatcher.Register(method, handler);
    }

    public void Register(string method, Func<JsonElement, WorkerRequestContext, Task<WorkerResponse>> handler)
    {
        dispatcher.Register(method, handler);
    }

    public void Register(string method, Func<JsonElement, WorkerRequestContext, WorkerResponse> handler)
    {
        dispatcher.Register(method, handler);
    }

    public string[] GetRegisteredMethods()
    {
        return dispatcher.GetRegisteredMethods();
    }
}
