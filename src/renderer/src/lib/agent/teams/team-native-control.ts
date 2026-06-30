const pendingShutdownRequests = new Set<string>()

export function requestTeammateShutdown(memberId: string): void {
  pendingShutdownRequests.add(memberId)
}

export function abortTeammate(_memberIdOrName: string): boolean {
  return false
}

export function abortAllTeammates(): void {
  pendingShutdownRequests.clear()
}

export function isTeammateRunning(_memberIdOrName: string): boolean {
  return false
}
