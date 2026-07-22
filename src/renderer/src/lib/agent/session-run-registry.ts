// Shared sessionId -> active sidecar runId map.
//
// This was a module-private Map in use-chat-actions.ts, which meant a full
// renderer reload (Vite HMR) wiped the sessionId->runId binding and left
// stop/append/cancel unable to reach the still-running worker run. It now lives
// here so the reattach path (runtime-reattach.ts) can rebuild the binding from
// the main-process runtime snapshot after a reload, while use-chat-actions keeps
// writing to the same instance during normal runs.
export const sessionSidecarRunIds = new Map<string, string>()
