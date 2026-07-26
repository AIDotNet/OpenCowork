export interface NativeCanvasToolRequest {
  runId: string
  projectId: string
  toolUseId: string
  toolName: string
  input: Record<string, unknown>
}

export interface NativeCanvasToolResult {
  content: string
  isError?: boolean
  error?: string
}

export type NativeCanvasToolHandler = (
  request: NativeCanvasToolRequest
) => Promise<NativeCanvasToolResult>

const handlers = new Map<string, NativeCanvasToolHandler>()

export function registerNativeCanvasToolHandler(
  runId: string,
  handler: NativeCanvasToolHandler
): () => void {
  handlers.set(runId, handler)
  return () => {
    if (handlers.get(runId) === handler) handlers.delete(runId)
  }
}

export async function handleNativeCanvasToolRequest(
  value: unknown
): Promise<NativeCanvasToolResult> {
  const request = value as Partial<NativeCanvasToolRequest>
  if (!request || typeof request !== 'object') {
    return { content: 'Invalid canvas tool request', isError: true }
  }
  if (
    typeof request.runId !== 'string' ||
    typeof request.projectId !== 'string' ||
    typeof request.toolUseId !== 'string' ||
    typeof request.toolName !== 'string'
  ) {
    return { content: 'Incomplete canvas tool request', isError: true }
  }
  const handler = handlers.get(request.runId)
  if (!handler) {
    return {
      content: 'Canvas tool handler is no longer available for this run',
      isError: true
    }
  }
  return await handler({
    runId: request.runId,
    projectId: request.projectId,
    toolUseId: request.toolUseId,
    toolName: request.toolName,
    input:
      request.input && typeof request.input === 'object' && !Array.isArray(request.input)
        ? request.input
        : {}
  })
}
