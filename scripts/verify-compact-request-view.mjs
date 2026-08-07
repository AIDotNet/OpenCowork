/* eslint-disable @typescript-eslint/explicit-function-return-type */

// Dependency-free checks for the renderer's compact request-view invariants.
// Mirrors resolveActiveCompactArtifacts + applyLatestCompactRequestView in
// src/renderer/src/lib/agent/context-compression.ts and
// src/renderer/src/stores/chat-store.ts so pairing/truncation rules can be
// reviewed without booting Electron. Keep the mirrors in sync when editing.

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const isBoundary = (message) => message.role === 'system' && !!message.meta?.compactBoundary
const isSummary = (message) =>
  (message.role === 'user' && !!message.meta?.compactSummary) ||
  (message.role === 'user' &&
    typeof message.content === 'string' &&
    message.content.trimStart().startsWith('[Context Memory Compressed Summary'))
const isArtifact = (message) => isBoundary(message) || isSummary(message)

function findSummaryIndexForBoundary(messages, boundaryIndex) {
  const boundaryMeta = messages[boundaryIndex]?.meta?.compactBoundary
  const summaryId = boundaryMeta?.summaryId ?? boundaryMeta?.preservedSegment?.anchorId
  if (summaryId) {
    const byId = messages.findIndex((message) => message.id === summaryId && isSummary(message))
    if (byId >= 0) return byId
  }
  for (let index = boundaryIndex + 1; index < messages.length; index += 1) {
    if (isBoundary(messages[index])) return -1
    if (isSummary(messages[index])) return index
  }
  return -1
}

function resolveActiveCompactArtifacts(messages) {
  let active = null
  let activeScore = Number.NEGATIVE_INFINITY
  for (let boundaryIndex = 0; boundaryIndex < messages.length; boundaryIndex += 1) {
    if (!isBoundary(messages[boundaryIndex])) continue
    const summaryIndex = findSummaryIndexForBoundary(messages, boundaryIndex)
    if (summaryIndex < 0) continue
    const score = Math.max(messages[boundaryIndex].createdAt, messages[summaryIndex].createdAt)
    if (score < activeScore) continue
    activeScore = score
    active = {
      boundaryId: messages[boundaryIndex].id,
      boundaryIndex,
      summaryId: messages[summaryIndex].id,
      summaryIndex
    }
  }
  if (active) return active
  for (let summaryIndex = 0; summaryIndex < messages.length; summaryIndex += 1) {
    if (!isSummary(messages[summaryIndex])) continue
    if (messages[summaryIndex].createdAt < activeScore) continue
    activeScore = messages[summaryIndex].createdAt
    active = {
      boundaryId: null,
      boundaryIndex: -1,
      summaryId: messages[summaryIndex].id,
      summaryIndex
    }
  }
  return active
}

function applyLatestCompactRequestView(messages) {
  const activeCompact = resolveActiveCompactArtifacts(messages)
  if (!activeCompact) {
    return messages.filter((message) => !isArtifact(message))
  }
  if (activeCompact.boundaryIndex < 0) {
    const summaryMessage = messages[activeCompact.summaryIndex]
    const tail = messages
      .slice(activeCompact.summaryIndex + 1)
      .filter((message) => !isArtifact(message))
    return summaryMessage ? [summaryMessage, ...tail] : tail
  }

  const result = []
  const seenIds = new Set()
  const append = (message) => {
    if (!message || seenIds.has(message.id)) return
    if (isArtifact(message)) {
      if (isBoundary(message) && message.id !== activeCompact.boundaryId) return
      if (isSummary(message) && message.id !== activeCompact.summaryId) return
    }
    result.push(message)
    seenIds.add(message.id)
  }

  append(messages[activeCompact.boundaryIndex])
  append(messages[activeCompact.summaryIndex])

  const segment = messages[activeCompact.boundaryIndex].meta?.compactBoundary?.preservedSegment
  if (segment?.headId && segment?.tailId) {
    const headIndex = messages.findIndex((message) => message.id === segment.headId)
    if (headIndex >= 0) {
      const tailIndex = messages.findIndex(
        (message, index) => index >= headIndex && message.id === segment.tailId
      )
      if (tailIndex >= headIndex) {
        for (const message of messages.slice(headIndex, tailIndex + 1)) append(message)
      }
    }
  }

  const trailingStartIndex = Math.max(activeCompact.summaryIndex, activeCompact.boundaryIndex) + 1
  for (const message of messages.slice(Math.max(0, trailingStartIndex))) append(message)
  return result
}

function makeHistory(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `m${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message ${index}`,
    createdAt: 1_000 + index
  }))
}

const boundary = (overrides = {}) => ({
  id: 'boundary',
  role: 'system',
  content: 'Conversation compacted',
  createdAt: 5_000,
  meta: {
    compactBoundary: {
      trigger: 'manual',
      preTokens: 900,
      messagesSummarized: 40,
      summaryId: 'summary'
    }
  },
  ...overrides
})
const summary = (overrides = {}) => ({
  id: 'summary',
  role: 'user',
  content: '[Context Memory Compressed Summary]\n\nSummary text.',
  createdAt: 5_001,
  meta: { compactSummary: { messagesSummarized: 40, recentMessagesPreserved: false } },
  ...overrides
})
const followUp = { id: 'follow-up', role: 'user', content: 'next question', createdAt: 6_000 }

// Zero-preserve compaction: view is exactly boundary + summary + trailing turns.
{
  const view = applyLatestCompactRequestView([...makeHistory(40), boundary(), summary(), followUp])
  assert(
    view.map((message) => message.id).join(',') === 'boundary,summary,follow-up',
    `zero-preserve view leaked history: ${view.map((message) => message.id).join(',')}`
  )
}

// Sort-order normalization may flip the pair; summaryId pairing must survive it.
{
  const view = applyLatestCompactRequestView([...makeHistory(40), summary(), boundary(), followUp])
  assert(
    view.map((message) => message.id).join(',') === 'boundary,summary,follow-up',
    `flipped pair view leaked history: ${view.map((message) => message.id).join(',')}`
  )
}

// Legacy pairing via preservedSegment.anchorId still works and keeps the segment.
{
  const legacyBoundary = boundary({
    meta: {
      compactBoundary: {
        trigger: 'auto',
        preTokens: 900,
        messagesSummarized: 38,
        preservedSegment: { headId: 'm38', anchorId: 'summary', tailId: 'm39' }
      }
    }
  })
  const view = applyLatestCompactRequestView([
    ...makeHistory(40),
    summary(),
    legacyBoundary,
    followUp
  ])
  assert(
    view.map((message) => message.id).join(',') === 'boundary,summary,m38,m39,follow-up',
    `legacy segment view mismatch: ${view.map((message) => message.id).join(',')}`
  )
}

// Orphan summary (boundary row lost) must truncate at the summary, never send full history.
{
  const view = applyLatestCompactRequestView([...makeHistory(40), summary(), followUp])
  assert(
    view.map((message) => message.id).join(',') === 'summary,follow-up',
    `orphan summary fell back to full history: ${view.map((message) => message.id).join(',')}`
  )
}

// No compaction at all: history passes through untouched.
{
  const view = applyLatestCompactRequestView(makeHistory(5))
  assert(view.length === 5, 'plain history must pass through unchanged')
}

console.log('compact-request-view verification passed')
