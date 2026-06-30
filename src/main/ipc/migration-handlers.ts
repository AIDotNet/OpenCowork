import type { MigrationApplyDecision } from '../../shared/migration-types'
import { applyOpenCodeMigration } from '../migration/opencode-apply'
import { buildOpenCodeMigrationPreview } from '../migration/opencode-preview'
import { registerMessagePackHandler } from './messagepack-handler'

export function registerMigrationHandlers(): void {
  registerMessagePackHandler<string | undefined>('migration:preview', async (source) => {
    if (source && source !== 'opencode') {
      return {
        source,
        detected: false,
        warnings: [`Unsupported migration source: ${source}`],
        items: [],
        summary: { total: 0, conflicts: 0, warnings: 1, actionable: 0 },
        sourcePath: '',
        generatedAt: Date.now()
      }
    }

    return buildOpenCodeMigrationPreview()
  })

  registerMessagePackHandler<
    { source?: string; decisions?: MigrationApplyDecision[] } | undefined
  >('migration:apply', async (args) => {
    if (args?.source && args.source !== 'opencode') {
      return {
        source: args.source,
        sourcePath: '',
        backupPath: undefined,
        warnings: [`Unsupported migration source: ${args.source}`],
        results: [],
        summary: { total: 0, applied: 0, skipped: 0, failed: 1 },
        appliedAt: Date.now()
      }
    }

    return applyOpenCodeMigration(Array.isArray(args?.decisions) ? args?.decisions : [])
  })
}
