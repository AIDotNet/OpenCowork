export const DEFAULT_SUB_AGENT_MAX_TURNS = 12

export function resolveSubAgentMaxTurns(maxTurns?: number | null): number {
  if (typeof maxTurns === 'number' && Number.isFinite(maxTurns) && maxTurns >= 0) {
    return Math.floor(maxTurns)
  }
  return DEFAULT_SUB_AGENT_MAX_TURNS
}
