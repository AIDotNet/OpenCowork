import type { ToolDefinition, ToolResultContent } from '../api/types'
import type { ToolHandler, ToolContext } from '../tools/tool-types'
import { encodeToolError } from '../tools/tool-result-format'

/**
 * Tool Registry - manages tool handlers with a pluggable registration pattern.
 * New tools are added by calling register() without modifying core code.
 */
class ToolRegistry {
  private tools = new Map<string, ToolHandler>()
  private listeners = new Set<() => void>()
  private definitionsCache: ToolDefinition[] | null = []
  private namesCache: string[] | null = []

  private invalidate(): void {
    this.definitionsCache = null
    this.namesCache = null
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener()
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  register(handler: ToolHandler): void {
    const prev = this.tools.get(handler.definition.name)
    this.tools.set(handler.definition.name, handler)
    if (prev !== handler) {
      this.invalidate()
      this.emit()
    }
  }

  unregister(name: string): void {
    if (this.tools.delete(name)) {
      this.invalidate()
      this.emit()
    }
  }

  get(name: string): ToolHandler | undefined {
    return this.tools.get(name)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  getDefinitions(): ToolDefinition[] {
    if (!this.definitionsCache) {
      this.definitionsCache = Array.from(this.tools.values()).map((t) => t.definition)
    }
    return this.definitionsCache
  }

  getNames(): string[] {
    if (!this.namesCache) {
      this.namesCache = Array.from(this.tools.keys())
    }
    return this.namesCache
  }

  async execute(
    name: string,
    input: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<ToolResultContent> {
    const handler =
      ctx.localToolHandlers?.[name] ?? ctx.inlineToolHandlers?.[name] ?? this.tools.get(name)
    if (!handler) {
      return encodeToolError(`Unknown tool: ${name}`)
    }
    try {
      return await handler.execute(input, ctx)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return encodeToolError(message)
    }
  }

  checkRequiresApproval(name: string, input: Record<string, unknown>, ctx: ToolContext): boolean {
    const handler =
      ctx.localToolHandlers?.[name] ?? ctx.inlineToolHandlers?.[name] ?? this.tools.get(name)
    if (!handler) return true // Unknown tools always require approval
    return handler.requiresApproval?.(input, ctx) ?? false
  }
}

export const toolRegistry = new ToolRegistry()
