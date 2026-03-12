import { toolRegistry } from '@renderer/lib/agent/tool-registry'
import { useAppPluginStore } from '@renderer/stores/app-plugin-store'
import { desktopClickTool } from './desktop-click-tool'
import { desktopScreenshotTool } from './desktop-screenshot-tool'
import { desktopTypeTool } from './desktop-type-tool'
import { imageGenerateTool } from './image-tool'
import {
  DESKTOP_CLICK_TOOL_NAME,
  DESKTOP_SCREENSHOT_TOOL_NAME,
  DESKTOP_TYPE_TOOL_NAME,
  IMAGE_GENERATE_TOOL_NAME
} from './types'

let imageToolRegistered = false
let desktopControlToolsRegistered = false

export function registerImagePluginTools(): void {
  if (imageToolRegistered) return
  toolRegistry.register(imageGenerateTool)
  imageToolRegistered = true
}

export function unregisterImagePluginTools(): void {
  if (!imageToolRegistered) return
  toolRegistry.unregister(IMAGE_GENERATE_TOOL_NAME)
  imageToolRegistered = false
}

export function registerDesktopControlTools(): void {
  if (desktopControlToolsRegistered) return
  toolRegistry.register(desktopScreenshotTool)
  toolRegistry.register(desktopClickTool)
  toolRegistry.register(desktopTypeTool)
  desktopControlToolsRegistered = true
}

export function unregisterDesktopControlTools(): void {
  if (!desktopControlToolsRegistered) return
  toolRegistry.unregister(DESKTOP_SCREENSHOT_TOOL_NAME)
  toolRegistry.unregister(DESKTOP_CLICK_TOOL_NAME)
  toolRegistry.unregister(DESKTOP_TYPE_TOOL_NAME)
  desktopControlToolsRegistered = false
}

export function isAppPluginToolsRegistered(): boolean {
  return imageToolRegistered || desktopControlToolsRegistered
}

export function updateAppPluginToolRegistration(): void {
  const store = useAppPluginStore.getState()

  if (store.isImageToolAvailable()) {
    registerImagePluginTools()
  } else {
    unregisterImagePluginTools()
  }

  if (store.isDesktopControlToolAvailable()) {
    registerDesktopControlTools()
  } else {
    unregisterDesktopControlTools()
  }
}
