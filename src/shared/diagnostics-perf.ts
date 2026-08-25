export interface DiagnosticsPerfSample {
  sampledAt: number
  cpuPercent: number | null
  memoryPercent: number | null
  memoryUsedBytes: number | null
  memoryTotalBytes: number | null
}
