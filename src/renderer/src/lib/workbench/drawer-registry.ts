import type { IAuxiliaryDrawerProvider } from './workbench-types'

class DrawerRegistry {
  private drawers = new Map<string, IAuxiliaryDrawerProvider>()

  registerDrawer(provider: IAuxiliaryDrawerProvider): { dispose: () => void } {
    this.drawers.set(provider.typeId, provider)
    return {
      dispose: () => {
        this.drawers.delete(provider.typeId)
      }
    }
  }

  getDrawer(typeId: string): IAuxiliaryDrawerProvider | undefined {
    return this.drawers.get(typeId)
  }

  getAllDrawers(): IAuxiliaryDrawerProvider[] {
    return Array.from(this.drawers.values())
  }
}

export const drawerRegistry = new DrawerRegistry()
