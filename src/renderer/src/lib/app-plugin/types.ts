export const IMAGE_PLUGIN_ID = 'image' as const
export const IMAGE_GENERATE_TOOL_NAME = 'ImageGenerate' as const

export type AppPluginId = typeof IMAGE_PLUGIN_ID

export interface AppPluginDescriptor {
  id: AppPluginId
  builtin: true
  toolName: typeof IMAGE_GENERATE_TOOL_NAME
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
    toolName: IMAGE_GENERATE_TOOL_NAME
  }
]
