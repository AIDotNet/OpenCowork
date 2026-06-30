import { app } from 'electron'
import * as path from 'path'
import { getNativeWorker } from '../lib/native-worker'

export const EXTENSION_NATIVE_TIMEOUT_MS = 60_000

export function getBundledExtensionDirCandidates(): string[] {
  if (!app.isPackaged) {
    return [path.join(app.getAppPath(), 'resources', 'extensions')]
  }

  return [
    path.join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'extensions'),
    path.join(process.resourcesPath, 'resources', 'extensions')
  ]
}

export function withBundledExtensionCandidates(
  params?: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...(params ?? {}),
    bundledDirCandidates: getBundledExtensionDirCandidates()
  }
}

export async function nativeExtensionRequest<TResult>(
  method: string,
  params?: Record<string, unknown>,
  timeoutMs = EXTENSION_NATIVE_TIMEOUT_MS
): Promise<TResult> {
  return await getNativeWorker().request<TResult>(
    method,
    withBundledExtensionCandidates(params),
    timeoutMs
  )
}
