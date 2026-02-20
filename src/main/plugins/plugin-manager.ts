import type {
  PluginInstance,
  PluginEvent,
  MessagingPluginService,
  ServiceFactory,
  WsMessageParser,
} from './plugin-types'
import type { BasePluginService } from './base-plugin-service'

/**
 * PluginManager — manages plugin service lifecycle with a factory registry pattern.
 * Adding a new provider = register one factory function.
 */
export class PluginManager {
  private factories = new Map<string, ServiceFactory>()
  private parsers = new Map<string, WsMessageParser>()
  private services = new Map<string, MessagingPluginService>()
  private statuses = new Map<string, 'running' | 'stopped' | 'error'>()

  /** Register a service factory for a plugin type */
  registerFactory(type: string, factory: ServiceFactory): void {
    this.factories.set(type, factory)
  }

  /** Register a WS message parser for a plugin type */
  registerParser(type: string, parser: WsMessageParser): void {
    this.parsers.set(type, parser)
  }

  /** Start a plugin instance — creates service via factory, calls .start() */
  async startPlugin(
    instance: PluginInstance,
    notify: (event: PluginEvent) => void
  ): Promise<void> {
    // Stop existing service if running
    if (this.services.has(instance.id)) {
      await this.stopPlugin(instance.id)
    }

    const factory = this.factories.get(instance.type)
    if (!factory) {
      console.error(`[PluginManager] No factory registered for type: ${instance.type}`)
      this.statuses.set(instance.id, 'error')
      return
    }

    const service = factory(instance, notify)

    // Wire parser if the service extends BasePluginService
    const parser = this.parsers.get(instance.type)
    if (parser && typeof (service as BasePluginService).setParser === 'function') {
      ;(service as BasePluginService).setParser(parser)
    }

    this.services.set(instance.id, service)
    this.statuses.set(instance.id, 'stopped')

    try {
      await service.start()
      this.statuses.set(instance.id, 'running')
      console.log(`[PluginManager] Started plugin: ${instance.name} (${instance.id})`)
    } catch (err) {
      console.error(`[PluginManager] Failed to start plugin ${instance.id}:`, err)
      this.statuses.set(instance.id, 'error')
      this.services.delete(instance.id)
      throw err
    }
  }

  async stopPlugin(id: string): Promise<void> {
    const service = this.services.get(id)
    if (!service) return

    try {
      await service.stop()
      console.log(`[PluginManager] Stopped plugin: ${id}`)
    } catch (err) {
      console.error(`[PluginManager] Error stopping plugin ${id}:`, err)
    } finally {
      this.services.delete(id)
      this.statuses.set(id, 'stopped')
    }
  }

  async restartPlugin(
    instance: PluginInstance,
    notify: (event: PluginEvent) => void
  ): Promise<void> {
    await this.stopPlugin(instance.id)
    await this.startPlugin(instance, notify)
  }

  getService(id: string): MessagingPluginService | undefined {
    return this.services.get(id)
  }

  getStatus(id: string): 'running' | 'stopped' | 'error' {
    return this.statuses.get(id) ?? 'stopped'
  }

  hasFactory(type: string): boolean {
    return this.factories.has(type)
  }

  async stopAll(): Promise<void> {
    const ids = Array.from(this.services.keys())
    await Promise.allSettled(ids.map((id) => this.stopPlugin(id)))
    console.log(`[PluginManager] All plugins stopped`)
  }
}
