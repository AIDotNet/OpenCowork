import { encodeToolError } from '../../../tools/tool-result-format'

export function nativeOnlyTeamResult(toolName: string): string {
  return encodeToolError(
    `${toolName} executes in the .NET Native Worker and is unavailable through the renderer boundary.`
  )
}
