export const IMAGE_PLUGIN_ID = 'image' as const
export const DESKTOP_CONTROL_PLUGIN_ID = 'desktop-control' as const

export const IMAGE_GENERATE_TOOL_NAME = 'ImageGenerate' as const
export const DESKTOP_SCREENSHOT_TOOL_NAME = 'DesktopScreenshot' as const
export const DESKTOP_CLICK_TOOL_NAME = 'DesktopClick' as const
export const DESKTOP_TYPE_TOOL_NAME = 'DesktopType' as const

export type AppPluginId = typeof IMAGE_PLUGIN_ID | typeof DESKTOP_CONTROL_PLUGIN_ID
export type AppPluginToolName =
  | typeof IMAGE_GENERATE_TOOL_NAME
  | typeof DESKTOP_SCREENSHOT_TOOL_NAME
  | typeof DESKTOP_CLICK_TOOL_NAME
  | typeof DESKTOP_TYPE_TOOL_NAME

export interface AppPluginDescriptor {
  id: AppPluginId
  builtin: true
  toolNames: AppPluginToolName[]
  requiresModelConfig: boolean
}

export interface AppPluginInstance {
  id: AppPluginId
  enabled: boolean
  useGlobalModel: boolean
  providerId: string | null
  modelId: string | null
}

export const APP_PLUGIN_DESCRIPTORS: AppPluginDescriptor[] = [
  {
    id: IMAGE_PLUGIN_ID,
    builtin: true,
    toolNames: [IMAGE_GENERATE_TOOL_NAME],
    requiresModelConfig: true
  },
  {
    id: DESKTOP_CONTROL_PLUGIN_ID,
    builtin: true,
    toolNames: [
      DESKTOP_SCREENSHOT_TOOL_NAME,
      DESKTOP_CLICK_TOOL_NAME,
      DESKTOP_TYPE_TOOL_NAME
    ],
    requiresModelConfig: false
  }
]
