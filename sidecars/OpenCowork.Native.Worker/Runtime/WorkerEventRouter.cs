using System;

/// <summary>
/// Routes a durable event to one named consumer's stream.
/// </summary>
/// <remarks>
/// The shared <see cref="WorkerTransportHub"/> publisher is address-free: it was
/// built when a worker had exactly one attached host, so it can only broadcast.
/// The durable outbox is per consumer — each has its own cursor and its own
/// unacknowledged window — so the pump must deliver to one specific lane, and
/// broadcasting would acknowledge frames on behalf of consumers that never saw
/// them. This lives locally rather than in the submodule so the transport change
/// does not fork the shared runtime contract.
/// </remarks>
internal static class WorkerEventRouter
{
    private static Func<string, WorkerMessagePackEvent, bool>? consumerPublisher;

    public static void SetConsumerPublisher(Func<string, WorkerMessagePackEvent, bool> publisher)
    {
        consumerPublisher = publisher;
    }

    public static void ClearConsumerPublisher()
    {
        consumerPublisher = null;
    }

    /// <summary>
    /// Attempts delivery to one consumer. False means the consumer is not attached
    /// or its queue is saturated; the caller must leave the event unacknowledged so
    /// replay can pick it up.
    /// </summary>
    public static bool TryPublishToConsumer(string consumerId, WorkerMessagePackEvent payload)
    {
        var publisher = consumerPublisher;
        return publisher is not null && publisher(consumerId, payload);
    }
}
