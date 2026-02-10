import type React from 'react'

export interface ViewerProps {
  filePath: string
  content: string
  viewMode: 'preview' | 'code'
  onContentChange?: (content: string) => void
}

export interface ViewerDefinition {
  type: string
  extensions: string[]
  component: React.ComponentType<ViewerProps>
}

class ViewerRegistry {
  private viewers = new Map<string, ViewerDefinition>()

  register(def: ViewerDefinition): void {
    this.viewers.set(def.type, def)
    for (const ext of def.extensions) {
      this.viewers.set(`ext:${ext}`, def)
    }
  }

  getByType(type: string): ViewerDefinition | undefined {
    return this.viewers.get(type)
  }

  getByExtension(ext: string): ViewerDefinition | undefined {
    return this.viewers.get(`ext:${ext.toLowerCase()}`)
  }
}

export const viewerRegistry = new ViewerRegistry()
