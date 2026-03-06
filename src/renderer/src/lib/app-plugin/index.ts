import { toolRegistry } from '@renderer/lib/agent/tool-registry'
import { useAppPluginStore } from '@renderer/stores/app-plugin-store'
import { imageGenerateTool } from './image-tool'
import { IMAGE_GENERATE_TOOL_NAME } from './types'

let imageToolRegistered = false

export function registerAppPluginTools(): void {
  if (imageToolRegistered) return
  toolRegistry.register(imageGenerateTool)
  imageToolRegistered = true
}

export function unregisterAppPluginTools(): void {
  if (!imageToolRegistered) return
  toolRegistry.unregister(IMAGE_GENERATE_TOOL_NAME)
  imageToolRegistered = false
}

export function isAppPluginToolsRegistered(): boolean {
  return imageToolRegistered
}

export function updateAppPluginToolRegistration(): void {
  const shouldRegister = useAppPluginStore.getState().isImageToolAvailable()
  if (shouldRegister) {
    registerAppPluginTools()
  } else {
    unregisterAppPluginTools()
  }
}
