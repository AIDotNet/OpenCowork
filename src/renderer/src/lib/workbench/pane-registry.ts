import type { ResourceUri } from '../../../../shared/workbench/uri'
import type { IEditorPaneDescriptor } from './workbench-types'

class PaneRegistry {
  private descriptors = new Map<string, IEditorPaneDescriptor>()

  registerPane(descriptor: IEditorPaneDescriptor): { dispose: () => void } {
    this.descriptors.set(descriptor.typeId, descriptor)
    return {
      dispose: () => {
        this.descriptors.delete(descriptor.typeId)
      }
    }
  }

  getPaneByTypeId(typeId: string): IEditorPaneDescriptor | undefined {
    return this.descriptors.get(typeId)
  }

  getPaneByUri(uri: ResourceUri): IEditorPaneDescriptor | undefined {
    const matching: IEditorPaneDescriptor[] = []
    for (const desc of this.descriptors.values()) {
      if (desc.schemes.includes(uri.scheme)) {
        matching.push(desc)
      }
    }
    matching.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    return matching[0]
  }

  getAllPanes(): IEditorPaneDescriptor[] {
    return Array.from(this.descriptors.values())
  }
}

export const paneRegistry = new PaneRegistry()
