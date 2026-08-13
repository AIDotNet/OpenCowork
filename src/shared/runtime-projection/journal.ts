import type { RuntimeEventEnvelope } from '../runtime-contracts/generated/contracts'

export const RUNTIME_JOURNAL_MAX_PATCHES = 2000
export const RUNTIME_JOURNAL_MAX_BYTES = 8 * 1024 * 1024
export const RUNTIME_OVERLAY_RETENTION_MS = 30_000

export type JournalLookup =
  | { mode: 'patches'; patches: RuntimeEventEnvelope[] }
  | { mode: 'overflow' }

export class RuntimePatchJournal {
  private patches: Array<{ envelope: RuntimeEventEnvelope; bytes: number }> = []
  private byteLength = 0
  private overflowed = false
  private readonly maxPatches: number
  private readonly maxBytes: number

  constructor(maxPatches = RUNTIME_JOURNAL_MAX_PATCHES, maxBytes = RUNTIME_JOURNAL_MAX_BYTES) {
    this.maxPatches = maxPatches
    this.maxBytes = maxBytes
  }

  get headRevision(): number {
    return this.patches.at(-1)?.envelope.projectionRevision ?? 0
  }

  get minRevision(): number {
    return this.patches[0]?.envelope.projectionRevision ?? 0
  }

  get didOverflow(): boolean {
    return this.overflowed
  }

  get size(): number {
    return this.patches.length
  }

  clear(): void {
    this.patches = []
    this.byteLength = 0
    this.overflowed = false
  }

  append(envelope: RuntimeEventEnvelope, bytes: number): void {
    const length = Math.max(0, bytes)
    this.patches.push({ envelope, bytes: length })
    this.byteLength += length
    while (this.patches.length > this.maxPatches || this.byteLength > this.maxBytes) {
      const dropped = this.patches.shift()
      if (!dropped) break
      this.byteLength -= dropped.bytes
      this.overflowed = true
    }
  }

  patchesSince(knownRevision: number): JournalLookup {
    if (this.patches.length === 0) {
      return knownRevision <= 0 ? { mode: 'patches', patches: [] } : { mode: 'overflow' }
    }

    const needed = knownRevision + 1
    if (needed < this.minRevision) return { mode: 'overflow' }

    const patches = this.patches
      .filter((item) => item.envelope.projectionRevision > knownRevision)
      .map((item) => item.envelope)

    if (patches.length === 0) return { mode: 'patches', patches: [] }
    if (patches[0].projectionRevision !== needed) return { mode: 'overflow' }
    return { mode: 'patches', patches }
  }
}
