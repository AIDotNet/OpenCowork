export interface NativeMessagePackRoute {
  event: string
  runId?: string
  sessionId?: string
  seq?: number
  v?: number
  hasTerminalEvent?: boolean
}

const MAX_ROUTE_READER_DEPTH = 64

export function readNativeMessagePackRoute(
  payload: Uint8Array | Buffer
): NativeMessagePackRoute | null {
  try {
    const reader = new RouteReader(payload)
    const route = reader.readRouteMap()
    if (!route) return null
    if (route.event !== 'agent/stream') return null
    reader.ensureComplete()
    return route.event ? route : null
  } catch (error) {
    if (isMessagePackTraceEnabled()) {
      console.warn('[MessagePackRoute] failed to read route metadata', {
        error: error instanceof Error ? error.message : String(error),
        bytes: payload.byteLength
      })
    }
    return null
  }
}

function mergeRouteFields(
  target: NativeMessagePackRoute,
  source: Partial<NativeMessagePackRoute>
): void {
  target.runId ??= source.runId
  target.sessionId ??= source.sessionId
  target.seq ??= source.seq
  target.v ??= source.v
  target.hasTerminalEvent ||= source.hasTerminalEvent === true
}

function isMessagePackTraceEnabled(): boolean {
  const value = process.env.OPEN_COWORK_MSGPACK_TRACE?.trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes' || value === 'on'
}

class RouteReader {
  private offset = 0

  constructor(private readonly data: Uint8Array) {}

  ensureComplete(): void {
    if (this.offset !== this.data.byteLength) {
      throw new Error('MessagePack route payload contains trailing bytes')
    }
  }

  readRouteMap(): NativeMessagePackRoute | null {
    const length = this.readMapLength(this.readByte())
    if (length === 0) return null

    const firstKey = this.readMapKey()
    if (firstKey !== 'event') return null

    const route: NativeMessagePackRoute = { event: this.readStringValue() }
    if (route.event !== 'agent/stream') return route

    for (let index = 1; index < length; index++) {
      const key = this.readMapKey()
      switch (key) {
        case 'runId':
          route.runId = this.readStringValue()
          break
        case 'sessionId':
          route.sessionId = this.readStringValue()
          break
        case 'seq':
          route.seq = this.readNumberValue()
          break
        case 'v':
          route.v = this.readNumberValue()
          break
        case 'params':
          mergeRouteFields(route, this.readNestedRouteFields())
          break
        case 'events':
          route.hasTerminalEvent = this.readEventsTerminalFlag()
          break
        default:
          this.skipValue()
          break
      }
    }

    return route
  }

  private readNestedRouteFields(): Partial<NativeMessagePackRoute> {
    const code = this.readByte()
    const length = this.tryReadMapLength(code)
    if (length === null) {
      this.skipValueFromCode(code)
      return {}
    }

    const route: Partial<NativeMessagePackRoute> = {}
    for (let index = 0; index < length; index++) {
      const key = this.readMapKey()
      switch (key) {
        case 'runId':
          route.runId = this.readStringValue()
          break
        case 'sessionId':
          route.sessionId = this.readStringValue()
          break
        case 'seq':
          route.seq = this.readNumberValue()
          break
        case 'v':
          route.v = this.readNumberValue()
          break
        case 'events':
          route.hasTerminalEvent = this.readEventsTerminalFlag()
          break
        default:
          this.skipValue()
          break
      }
    }
    return route
  }

  private readEventsTerminalFlag(): boolean {
    const code = this.readByte()
    const length = this.tryReadArrayLength(code)
    if (length === null) {
      this.skipValueFromCode(code)
      return false
    }

    let terminal = false
    for (let index = 0; index < length; index++) {
      terminal ||= this.readEventTerminalFlag()
    }
    return terminal
  }

  private readEventTerminalFlag(): boolean {
    const code = this.readByte()
    const length = this.tryReadMapLength(code)
    if (length === null) {
      this.skipValueFromCode(code)
      return false
    }

    let terminal = false
    for (let index = 0; index < length; index++) {
      const key = this.readMapKey()
      if (key === 'type') {
        const type = this.readStringValue()
        terminal ||= type === 'loop_end' || type === 'error'
      } else {
        this.skipValue()
      }
    }
    return terminal
  }

  private readMapKey(): string {
    const code = this.readByte()
    if (this.isStringCode(code)) return this.readStringFromCode(code)
    this.skipValueFromCode(code)
    return ''
  }

  private readStringValue(): string {
    const code = this.readByte()
    if (!this.isStringCode(code)) {
      this.skipValueFromCode(code)
      return ''
    }
    return this.readStringFromCode(code)
  }

  private readNumberValue(): number {
    const code = this.readByte()
    if (code <= 0x7f) return code
    if (code >= 0xe0) return code - 0x100

    switch (code) {
      case 0xcc:
        return this.readByte()
      case 0xcd:
        return this.readUInt16()
      case 0xce:
        return this.readUInt32()
      case 0xcf:
        return Number(this.readUInt64())
      case 0xd0:
        return this.readInt8()
      case 0xd1:
        return this.readInt16()
      case 0xd2:
        return this.readInt32()
      case 0xd3:
        return Number(this.readInt64())
      case 0xca:
        return this.readFloat32()
      case 0xcb:
        return this.readFloat64()
      default:
        this.skipValueFromCode(code)
        return 0
    }
  }

  private skipValue(depth = 0): void {
    this.skipValueFromCode(this.readByte(), depth)
  }

  private skipValueFromCode(code: number, depth = 0): void {
    if (depth > MAX_ROUTE_READER_DEPTH) {
      throw new Error('MessagePack route payload is too deeply nested')
    }

    if (code <= 0x7f || code >= 0xe0 || code === 0xc0 || code === 0xc2 || code === 0xc3) {
      return
    }
    if ((code & 0xe0) === 0xa0) {
      this.skipBytes(code & 0x1f)
      return
    }
    if ((code & 0xf0) === 0x90) {
      this.skipArray(code & 0x0f, depth)
      return
    }
    if ((code & 0xf0) === 0x80) {
      this.skipMap(code & 0x0f, depth)
      return
    }

    switch (code) {
      case 0xc4:
      case 0xd9:
        this.skipBytes(this.readByte())
        return
      case 0xc5:
      case 0xda:
        this.skipBytes(this.readUInt16())
        return
      case 0xc6:
      case 0xdb:
        this.skipBytes(this.readUInt32())
        return
      case 0xc7:
        this.skipBytes(1 + this.readByte())
        return
      case 0xc8:
        this.skipBytes(1 + this.readUInt16())
        return
      case 0xc9:
        this.skipBytes(1 + this.readUInt32())
        return
      case 0xca:
        this.skipBytes(4)
        return
      case 0xcb:
      case 0xcf:
      case 0xd3:
        this.skipBytes(8)
        return
      case 0xcc:
      case 0xd0:
        this.skipBytes(1)
        return
      case 0xcd:
      case 0xd1:
        this.skipBytes(2)
        return
      case 0xce:
      case 0xd2:
        this.skipBytes(4)
        return
      case 0xd4:
        this.skipBytes(2)
        return
      case 0xd5:
        this.skipBytes(3)
        return
      case 0xd6:
        this.skipBytes(5)
        return
      case 0xd7:
        this.skipBytes(9)
        return
      case 0xd8:
        this.skipBytes(17)
        return
      case 0xdc:
        this.skipArray(this.readUInt16(), depth)
        return
      case 0xdd:
        this.skipArray(this.readUInt32(), depth)
        return
      case 0xde:
        this.skipMap(this.readUInt16(), depth)
        return
      case 0xdf:
        this.skipMap(this.readUInt32(), depth)
        return
      default:
        throw new Error(`Unsupported MessagePack route code: 0x${code.toString(16)}`)
    }
  }

  private skipArray(length: number, depth: number): void {
    for (let index = 0; index < length; index++) {
      this.skipValue(depth + 1)
    }
  }

  private skipMap(length: number, depth: number): void {
    for (let index = 0; index < length; index++) {
      this.skipValue(depth + 1)
      this.skipValue(depth + 1)
    }
  }

  private readStringFromCode(code: number): string {
    if ((code & 0xe0) === 0xa0) return this.readUtf8String(code & 0x1f)
    switch (code) {
      case 0xd9:
        return this.readUtf8String(this.readByte())
      case 0xda:
        return this.readUtf8String(this.readUInt16())
      case 0xdb:
        return this.readUtf8String(this.readUInt32())
      default:
        throw new Error(`Expected MessagePack string, got 0x${code.toString(16)}`)
    }
  }

  private isStringCode(code: number): boolean {
    return (code & 0xe0) === 0xa0 || code === 0xd9 || code === 0xda || code === 0xdb
  }

  private readMapLength(code: number): number {
    const length = this.tryReadMapLength(code)
    if (length === null) {
      throw new Error(`Expected MessagePack map, got 0x${code.toString(16)}`)
    }
    return length
  }

  private tryReadMapLength(code: number): number | null {
    if ((code & 0xf0) === 0x80) return code & 0x0f
    if (code === 0xde) return this.readUInt16()
    if (code === 0xdf) return this.readUInt32()
    return null
  }

  private tryReadArrayLength(code: number): number | null {
    if ((code & 0xf0) === 0x90) return code & 0x0f
    if (code === 0xdc) return this.readUInt16()
    if (code === 0xdd) return this.readUInt32()
    return null
  }

  private readUtf8String(length: number): string {
    const start = this.offset
    this.skipBytes(length)
    return new TextDecoder().decode(this.data.subarray(start, start + length))
  }

  private readByte(): number {
    if (this.offset >= this.data.byteLength) {
      throw new Error('MessagePack route payload ended early')
    }
    return this.data[this.offset++]
  }

  private readInt8(): number {
    return this.readDataView(1).getInt8(0)
  }

  private readUInt16(): number {
    return this.readDataView(2).getUint16(0, false)
  }

  private readInt16(): number {
    return this.readDataView(2).getInt16(0, false)
  }

  private readUInt32(): number {
    return this.readDataView(4).getUint32(0, false)
  }

  private readInt32(): number {
    return this.readDataView(4).getInt32(0, false)
  }

  private readUInt64(): bigint {
    return this.readDataView(8).getBigUint64(0, false)
  }

  private readInt64(): bigint {
    return this.readDataView(8).getBigInt64(0, false)
  }

  private readFloat32(): number {
    return this.readDataView(4).getFloat32(0, false)
  }

  private readFloat64(): number {
    return this.readDataView(8).getFloat64(0, false)
  }

  private readDataView(length: number): DataView {
    const start = this.offset
    this.skipBytes(length)
    return new DataView(this.data.buffer, this.data.byteOffset + start, length)
  }

  private skipBytes(length: number): void {
    if (length < 0 || this.data.byteLength - this.offset < length) {
      throw new Error('MessagePack route payload ended early')
    }
    this.offset += length
  }
}
