import {
  REMOTE_CHUNK_BUFFER_LIMIT,
  REMOTE_CHUNK_LIMIT,
  REMOTE_CHUNK_TIMEOUT_MS,
  type RemoteEnvelope,
  type RemoteEnvelopeKind
} from '../../shared/remote-control'

export function splitEnvelope(
  id: string,
  kind: RemoteEnvelopeKind,
  op: string,
  mobileId: string | null | undefined,
  payloadBytes: Uint8Array
): RemoteEnvelope[] {
  const total = Math.max(1, Math.ceil(payloadBytes.byteLength / REMOTE_CHUNK_LIMIT))
  const result: RemoteEnvelope[] = []
  for (let seq = 0; seq < total; seq += 1) {
    const start = seq * REMOTE_CHUNK_LIMIT
    result.push({
      Id: id,
      Kind: kind,
      Op: op,
      MobileId: mobileId ?? null,
      Seq: seq,
      Total: total,
      Payload: payloadBytes.slice(
        start,
        Math.min(start + REMOTE_CHUNK_LIMIT, payloadBytes.byteLength)
      )
    })
  }
  return result
}

type Pending = {
  id: string
  total: number
  chunks: Map<number, Uint8Array>
  bytes: number
  createdAt: number
  timer: NodeJS.Timeout
}

export class ChunkReassembler {
  private readonly pending = new Map<string, Pending>()
  private bufferedBytes = 0

  push(env: RemoteEnvelope): Uint8Array | null {
    if (
      !Number.isSafeInteger(env.Total) ||
      !Number.isSafeInteger(env.Seq) ||
      env.Total < 1 ||
      env.Total > 100_000 ||
      env.Seq < 0 ||
      env.Seq >= env.Total
    )
      return null
    if (env.Total === 1) return new Uint8Array(env.Payload)

    let message = this.pending.get(env.Id)
    if (message && message.total !== env.Total) {
      this.remove(message)
      return null
    }
    if (!message) {
      const timer = setTimeout(() => {
        const current = this.pending.get(env.Id)
        if (current) this.remove(current)
      }, REMOTE_CHUNK_TIMEOUT_MS)
      message = {
        id: env.Id,
        total: env.Total,
        chunks: new Map(),
        bytes: 0,
        createdAt: Date.now(),
        timer
      }
      this.pending.set(env.Id, message)
    }

    if (!message.chunks.has(env.Seq)) {
      const payload = new Uint8Array(env.Payload)
      message.chunks.set(env.Seq, payload)
      message.bytes += payload.byteLength
      this.bufferedBytes += payload.byteLength
      this.evictIfNeeded()
    }

    if (this.pending.get(env.Id) !== message || message.chunks.size !== message.total) return null
    const result = new Uint8Array(message.bytes)
    let offset = 0
    for (let index = 0; index < message.total; index += 1) {
      const chunk = message.chunks.get(index)
      if (!chunk) return null
      result.set(chunk, offset)
      offset += chunk.byteLength
    }
    this.remove(message)
    return result
  }

  dispose(): void {
    for (const message of this.pending.values()) clearTimeout(message.timer)
    this.pending.clear()
    this.bufferedBytes = 0
  }

  private remove(message: Pending): void {
    if (this.pending.get(message.id) !== message) return
    clearTimeout(message.timer)
    this.pending.delete(message.id)
    this.bufferedBytes -= message.bytes
  }

  private evictIfNeeded(): void {
    while (this.bufferedBytes > REMOTE_CHUNK_BUFFER_LIMIT) {
      const oldest = Array.from(this.pending.values()).sort((a, b) => a.createdAt - b.createdAt)[0]
      if (!oldest) break
      this.remove(oldest)
    }
  }
}
