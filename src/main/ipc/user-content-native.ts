import { app } from 'electron'
import * as path from 'path'
import { getNativeWorker } from '../lib/native-worker'

export function getBundledResourceDirCandidates(name: string): string[] {
  if (!app.isPackaged) {
    return [path.join(app.getAppPath(), 'resources', name)]
  }

  return [
    path.join(process.resourcesPath, 'app.asar.unpacked', 'resources', name),
    path.join(process.resourcesPath, 'resources', name)
  ]
}

export async function nativeUserContentRequest<TResult>(
  method: string,
  params: Record<string, unknown> = {}
): Promise<TResult> {
  return await getNativeWorker().request<TResult>(method, params, 60_000)
}

export function ensureNativeUserContent(method: string, params: Record<string, unknown>): void {
  void nativeUserContentRequest(method, params).catch((error) => {
    console.warn(
      `[UserContent] ${method} failed: ${error instanceof Error ? error.message : String(error)}`
    )
  })
}
