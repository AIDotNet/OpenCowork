import { handleNativeAskUserRequest } from '@renderer/lib/tools/ask-user-tool'
import { handleNativeBrowserToolRequest } from '@renderer/lib/tools/browser-native-ui'
import { handleNativePlanUiUpdate } from '@renderer/lib/tools/plan-native-ui'
import { handleNativeTeamUiUpdate } from '@renderer/lib/agent/teams/team-native-ui'
import { handleNativeSubAgentUiUpdate } from '@renderer/lib/agent/sub-agents/sub-agent-native-ui'
import { decodeIpcMessagePack, invokeMessagePack } from '@renderer/lib/ipc/messagepack-ipc-client'
import {
  SIDECAR_RENDERER_TOOL_REQUEST_MSGPACK_CHANNEL,
  SIDECAR_RENDERER_TOOL_RESPONSE_MSGPACK_CHANNEL
} from '../../../../shared/messagepack/binary-ipc'

// Native AgentRuntime owns the loop and tool execution. This bridge is only
// for renderer/UI boundaries that cannot live inside the native worker.

type RendererToolRequestPayload = { requestId: string; method: string; params: unknown }
type RendererToolResponsePayload = { requestId: string; result?: unknown; error?: string }

type RendererToolBridgeWindow = Window & {
  __openCoworkRendererToolBridgeCleanup?: () => void
}

function getBridgeWindow(): RendererToolBridgeWindow {
  return window as RendererToolBridgeWindow
}

async function sendRendererToolResponse(response: RendererToolResponsePayload): Promise<void> {
  await invokeMessagePack(SIDECAR_RENDERER_TOOL_RESPONSE_MSGPACK_CHANNEL, response)
}

async function handleRendererToolRequest(payload: RendererToolRequestPayload): Promise<void> {
  if (
    payload?.method !== 'ask-user/request' &&
    payload?.method !== 'plan/ui-update' &&
    payload?.method !== 'team/ui-update' &&
    payload?.method !== 'subagent/ui-update' &&
    payload?.method !== 'browser/tool-request'
  ) {
    return
  }
  if (!payload.requestId) return

  try {
    if (payload.method === 'ask-user/request') {
      await sendRendererToolResponse({
        requestId: payload.requestId,
        result: await handleNativeAskUserRequest(payload.params)
      })
      return
    }

    if (payload.method === 'plan/ui-update') {
      await sendRendererToolResponse({
        requestId: payload.requestId,
        result: await handleNativePlanUiUpdate(payload.params)
      })
      return
    }

    if (payload.method === 'browser/tool-request') {
      await sendRendererToolResponse({
        requestId: payload.requestId,
        result: await handleNativeBrowserToolRequest(payload.params)
      })
      return
    }

    if (payload.method === 'team/ui-update') {
      await sendRendererToolResponse({
        requestId: payload.requestId,
        result: await handleNativeTeamUiUpdate(payload.params)
      })
      return
    }

    if (payload.method === 'subagent/ui-update') {
      await sendRendererToolResponse({
        requestId: payload.requestId,
        result: await handleNativeSubAgentUiUpdate(payload.params)
      })
      return
    }
  } catch (error) {
    await sendRendererToolResponse({
      requestId: payload.requestId,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

export function attachRendererToolBridge(): void {
  const bridgeWindow = getBridgeWindow()
  bridgeWindow.__openCoworkRendererToolBridgeCleanup?.()
  bridgeWindow.__openCoworkRendererToolBridgeCleanup = undefined
  window.electron.ipcRenderer.removeAllListeners(SIDECAR_RENDERER_TOOL_REQUEST_MSGPACK_CHANNEL)

  const msgpackCleanup = window.electron.ipcRenderer.on(
    SIDECAR_RENDERER_TOOL_REQUEST_MSGPACK_CHANNEL,
    async (_event: unknown, bytes: ArrayBuffer | ArrayBufferView) => {
      await handleRendererToolRequest(decodeIpcMessagePack<RendererToolRequestPayload>(bytes))
    }
  )
  bridgeWindow.__openCoworkRendererToolBridgeCleanup = () => {
    msgpackCleanup()
  }
}
