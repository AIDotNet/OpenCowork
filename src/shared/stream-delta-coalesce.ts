/**
 * Stream text is supposed to be incremental. Gateways and overlapping
 * consumers sometimes replay a snapshot or the same chunk. These helpers
 * keep the visible transcript from repeating when that happens.
 */

export function coalesceStreamAppend(existing: string, incoming: string): string {
  if (!incoming) return existing
  if (!existing) return incoming
  if (incoming === existing) return existing
  if (incoming.length > existing.length && incoming.startsWith(existing)) return incoming
  return existing + incoming
}

/**
 * A live stream plus reattach plus a sync echo delivers the same chunk three
 * times in one animation frame. Keep a single copy of that run. Two identical
 * tokens in a row stay — Chinese often emits 的的 as two real increments.
 */
export function collapseFanoutRepeatedChunks<T>(
  items: readonly T[],
  chunk: (item: T) => string,
  minRepeats = 3
): T[] {
  if (items.length < minRepeats) return items.slice()

  const result: T[] = []
  let index = 0
  while (index < items.length) {
    const current = chunk(items[index])
    let run = 1
    while (index + run < items.length && chunk(items[index + run]) === current) {
      run += 1
    }
    if (run >= minRepeats) {
      result.push(items[index])
      index += run
      continue
    }
    for (let offset = 0; offset < run; offset += 1) {
      result.push(items[index + offset])
    }
    index += run
  }
  return result
}
