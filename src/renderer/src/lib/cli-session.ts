/** CLI durable sessions use this id prefix in the shared SQLite store. */
export const CLI_SESSION_ID_PREFIX = 'cli-session-'

export function isCliSessionId(sessionId: string | null | undefined): boolean {
  return Boolean(sessionId?.startsWith(CLI_SESSION_ID_PREFIX))
}
