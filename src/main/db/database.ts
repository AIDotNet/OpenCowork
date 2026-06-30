import * as os from 'os'
import * as path from 'path'
import { getNativeWorker } from '../lib/native-worker'

const DATA_DIR = path.join(os.homedir(), '.open-cowork')

interface DbInitializeResult {
  success: boolean
  dbPath: string
  error?: string | null
}

let initializePromise: Promise<void> | null = null

export async function initializeDatabase(): Promise<void> {
  initializePromise ??= getNativeWorker()
    .request<DbInitializeResult>('db/initialize', {}, 120_000)
    .then((result) => {
      if (!result.success) {
        throw new Error(result.error || 'Native DB initialization failed')
      }
      console.log('[DB][Native] initialized', { dbPath: result.dbPath })
    })
    .catch((error) => {
      initializePromise = null
      throw error
    })

  await initializePromise
}

export function closeDb(): void {
  initializePromise = null
}

export function getDataDir(): string {
  return DATA_DIR
}
