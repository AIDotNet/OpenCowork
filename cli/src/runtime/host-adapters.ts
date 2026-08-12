import type { JsonRecord } from './provider-catalog.js'
import type { WorkerToolDefinition } from './worker-session.js'

/**
 * Host adapters are the CLI's answer surface for Worker reverse requests (ARCHITECTURE.md
 * §7). Each adapter owns one capability area: the reverse methods it serves, the extra
 * tool definitions it contributes to a turn, and how its still-pending requests are
 * settled when the turn ends or the Worker cancels them. Reverse methods without a
 * registered adapter fail explicitly instead of hanging the Worker.
 */
export interface HostAdapter {
  /** Stable adapter name for diagnostics. */
  readonly name: string
  /** Reverse-request methods this adapter serves (may be empty for tool-only adapters). */
  readonly methods: readonly string[]
  /** Extra tool definitions advertised for each agent turn. */
  loadToolDefinitions?(signal?: AbortSignal): Promise<WorkerToolDefinition[]>
  /** Handle a reverse request. The adapter records the pending entry itself. */
  handleRequest?(id: string, method: string, params: JsonRecord): void
  /**
   * Completion payload for requests still pending when the CLI turn ends. Returning
   * undefined leaves the entry untouched (for adapters that always complete inline).
   */
  turnEndCompletion?(method: string): { result?: unknown; error?: string } | undefined
  /** Notify the UI that the Worker cancelled a pending request. */
  handleCancel?(id: string, method: string): void
}

export class HostAdapterRegistry {
  private readonly adapters: HostAdapter[] = []
  private readonly byMethod = new Map<string, HostAdapter>()

  register(adapter: HostAdapter): void {
    this.adapters.push(adapter)
    for (const method of adapter.methods) {
      if (this.byMethod.has(method)) {
        throw new Error(`Reverse method ${method} is already registered`)
      }
      this.byMethod.set(method, adapter)
    }
  }

  resolve(method: string): HostAdapter | undefined {
    return this.byMethod.get(method)
  }

  supportedMethods(): string[] {
    return Array.from(this.byMethod.keys())
  }

  /** Tool capability declaration derived from the registry, in registration order. */
  async loadToolDefinitions(signal?: AbortSignal): Promise<WorkerToolDefinition[]> {
    const definitions: WorkerToolDefinition[] = []
    for (const adapter of this.adapters) {
      if (!adapter.loadToolDefinitions) continue
      definitions.push(...(await adapter.loadToolDefinitions(signal)))
    }
    return definitions
  }
}
