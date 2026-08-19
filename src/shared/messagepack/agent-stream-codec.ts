import { decode, decodeMulti, encode } from '@msgpack/msgpack'
import { AGENT_STREAM_PROTOCOL_VERSION, type AgentStreamEnvelope } from '../agent-stream-protocol'

export const AGENT_STREAM_MSGPACK_CHANNEL = 'agent:stream:msgpack'

type NativeAgentStreamFrame =
  | (AgentStreamEnvelope & { event?: 'agent/stream' })
  | { event?: 'agent/stream'; params?: unknown }

export function encodeAgentStreamEnvelope(envelope: AgentStreamEnvelope): Uint8Array {
  return encode({
    event: 'agent/stream',
    v: envelope.v,
    runId: envelope.runId,
    sessionId: envelope.sessionId,
    seq: envelope.seq,
    ...(envelope.live === true ? { live: true } : {}),
    events: envelope.events
  })
}

export function decodeAgentStreamEnvelope(
  bytes: ArrayBuffer | ArrayBufferView
): AgentStreamEnvelope {
  const decoded = decode(toUint8Array(bytes))
  const envelope = normalizeAgentStreamEnvelope(decoded)
  if (!envelope) {
    throw new Error('Invalid agent stream MessagePack envelope')
  }
  return envelope
}

// The main process may concatenate several envelopes into one IPC message;
// MessagePack values are self-delimiting, so decodeMulti splits them back out.
export function decodeAgentStreamEnvelopes(
  bytes: ArrayBuffer | ArrayBufferView
): AgentStreamEnvelope[] {
  const envelopes: AgentStreamEnvelope[] = []
  for (const decoded of decodeMulti(toUint8Array(bytes))) {
    const envelope = normalizeAgentStreamEnvelope(decoded)
    if (!envelope) {
      throw new Error('Invalid agent stream MessagePack envelope')
    }
    envelopes.push(envelope)
  }
  return envelopes
}

export function isAgentStreamEnvelope(value: unknown): value is AgentStreamEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    record.v === AGENT_STREAM_PROTOCOL_VERSION &&
    typeof record.runId === 'string' &&
    typeof record.sessionId === 'string' &&
    typeof record.seq === 'number' &&
    Array.isArray(record.events)
  )
}

function normalizeAgentStreamEnvelope(value: unknown): AgentStreamEnvelope | null {
  if (isAgentStreamEnvelope(value)) return value
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const frame = value as NativeAgentStreamFrame
  if (frame.event !== 'agent/stream') return null

  if ('params' in frame && isAgentStreamEnvelope(frame.params)) {
    return frame.params
  }

  const flat = frame as Record<string, unknown>
  const envelope = {
    v: flat.v,
    runId: flat.runId,
    sessionId: flat.sessionId,
    seq: flat.seq,
    events: flat.events,
    ...(flat.live === true ? { live: true } : {})
  }
  return isAgentStreamEnvelope(envelope) ? envelope : null
}

function toUint8Array(bytes: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (bytes instanceof Uint8Array) return bytes
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes)
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}
