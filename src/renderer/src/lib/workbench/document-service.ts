import type { ResourceUri } from '../../../../shared/workbench/uri'
import type { ITextDocumentContentProvider } from './workbench-types'

class DocumentService {
  private providers = new Map<string, ITextDocumentContentProvider>()

  registerDocumentProvider(provider: ITextDocumentContentProvider): { dispose: () => void } {
    this.providers.set(provider.scheme, provider)
    return {
      dispose: () => {
        this.providers.delete(provider.scheme)
      }
    }
  }

  async provideDocumentContent(uri: ResourceUri, signal?: AbortSignal): Promise<string> {
    const provider = this.providers.get(uri.scheme)
    if (!provider) {
      throw new Error(`No document content provider registered for scheme '${uri.scheme}'`)
    }
    return provider.provideTextDocumentContent(uri, signal)
  }
}

export const documentService = new DocumentService()
