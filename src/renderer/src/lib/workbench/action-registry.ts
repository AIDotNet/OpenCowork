import type { IContextActionProvider } from './workbench-types'

class ActionRegistry {
  private providers = new Map<string, IContextActionProvider>()

  registerActionProvider(provider: IContextActionProvider): { dispose: () => void } {
    this.providers.set(provider.typeId, provider)
    return {
      dispose: () => {
        this.providers.delete(provider.typeId)
      }
    }
  }

  getActionProvider(typeId: string): IContextActionProvider | undefined {
    return this.providers.get(typeId)
  }
}

export const actionRegistry = new ActionRegistry()
