/** LRU map from inbound messageId to chatId so replyMessage can resolve a conversation. */
export class ReplyContextCache {
  private readonly chats = new Map<string, string>()

  constructor(private readonly max = 500) {}

  remember(messageId: string, chatId: string): void {
    if (!messageId || !chatId) return
    this.chats.set(messageId, chatId)
    if (this.chats.size <= this.max) return
    const oldest = this.chats.keys().next().value
    if (oldest) this.chats.delete(oldest)
  }

  getChatId(messageId: string): string | undefined {
    return this.chats.get(messageId)
  }
}
