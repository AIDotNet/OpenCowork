/* eslint-disable @typescript-eslint/explicit-function-return-type */

// Small, dependency-free checks for the renderer's windowing invariants. These
// intentionally mirror the native index selection rules so changes to budgets
// and boundary handling can be reviewed without booting Electron.

function selectWindow(rows, direction, anchor, byteBudget, maxRows) {
  const candidates = rows
    .filter((row) => {
      if (direction === 'older') return row.sortOrder < anchor
      if (direction === 'newer') return row.sortOrder >= anchor
      return true
    })
    .sort((left, right) => {
      const order = direction === 'older' || direction === 'tail' ? -1 : 1
      return order * (left.sortOrder - right.sortOrder)
    })

  const selected = []
  let loadedBytes = 0
  for (const row of candidates.slice(0, maxRows)) {
    if (selected.length > 0 && loadedBytes >= byteBudget) break
    selected.push(row)
    loadedBytes += row.contentBytes
  }
  selected.sort((left, right) => left.sortOrder - right.sortOrder)
  return { selected, loadedBytes }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function mergeRanges(resident, incoming) {
  const byId = new Map(resident.map((row) => [row.id, row]))
  for (const row of incoming) byId.set(row.id, row)
  return [...byId.values()].sort((left, right) => left.sortOrder - right.sortOrder)
}

function trimResident(rows, preserve, maxRows, maxBytes, minRows) {
  const next = [...rows]
  const totalBytes = () => next.reduce((total, row) => total + row.contentBytes, 0)
  while ((next.length > maxRows || totalBytes() > maxBytes) && next.length > minRows) {
    if (preserve === 'head') next.pop()
    else next.shift()
  }
  return next
}

const rows = Array.from({ length: 30 }, (_, sortOrder) => ({
  id: `m${sortOrder}`,
  sortOrder,
  contentBytes: sortOrder === 29 ? 3 * 1024 * 1024 : 4 * 1024
}))

const tail = selectWindow(rows, 'tail', -1, 256 * 1024, 240)
assert(tail.selected.length === 1 && tail.selected[0].id === 'm29', 'tail must keep oversized row')

const older = selectWindow(rows, 'older', 29, 128 * 1024, 240)
assert(older.selected.at(-1)?.id === 'm28', 'older must stop before the anchor')
assert(older.loadedBytes <= 128 * 1024 + 4 * 1024, 'older budget should be soft, not unbounded')

const newer = selectWindow(rows, 'newer', 20, 128 * 1024, 240)
assert(newer.selected[0]?.id === 'm20', 'newer must start at the anchor')

const merged = mergeRanges(
  Array.from({ length: 10 }, (_, index) => ({
    id: `m${index + 20}`,
    sortOrder: index + 20,
    contentBytes: 1024
  })),
  Array.from({ length: 15 }, (_, index) => ({
    id: `m${index + 10}`,
    sortOrder: index + 10,
    contentBytes: 1024
  }))
)
assert(merged.length === 20, 'range merge must deduplicate its overlap')
assert(merged[0].sortOrder === 10 && merged.at(-1)?.sortOrder === 29, 'range merge lost order')

const rowTrimmed = trimResident(
  Array.from({ length: 250 }, (_, sortOrder) => ({
    id: `trim-${sortOrder}`,
    sortOrder,
    contentBytes: 1024
  })),
  'head',
  240,
  4 * 1024 * 1024,
  3
)
assert(rowTrimmed.length === 240, 'resident row cap was not enforced')
assert(rowTrimmed[0].sortOrder === 0, 'head-preserving trim removed the visible side')

const byteTrimmed = trimResident(
  Array.from({ length: 6 }, (_, sortOrder) => ({
    id: `large-${sortOrder}`,
    sortOrder,
    contentBytes: 1024 * 1024
  })),
  'tail',
  240,
  4 * 1024 * 1024,
  3
)
assert(byteTrimmed.length === 4, 'resident byte cap was not enforced')
assert(byteTrimmed.at(-1)?.sortOrder === 5, 'tail-preserving trim removed the visible side')

console.log('message-window pure checks passed')
