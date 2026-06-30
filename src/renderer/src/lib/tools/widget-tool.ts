import { toolRegistry } from '../agent/tool-registry'
import { encodeToolError } from './tool-result-format'
import type { ToolHandler } from './tool-types'

const visualizeShowWidgetHandler: ToolHandler = {
  definition: {
    name: 'visualize_show_widget',
    description:
      'Show visual content — SVG graphics, diagrams, charts, or interactive HTML widgets — that renders inline alongside your text response.\n' +
      'Use for flowcharts, architecture diagrams, dashboards, forms, calculators, data tables, games, illustrations, or any visual content.\n' +
      'The code is auto-detected: starts with <svg = SVG mode, otherwise HTML mode.\n' +
      'A global sendPrompt(text) function is available — it sends a message to chat as if the user typed it.\n' +
      'IMPORTANT: Call read_me before your first show_widget call.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description:
            'Short snake_case identifier for this visual. Must be specific and disambiguating.'
        },
        loading_messages: {
          type: 'array',
          description: '1-4 loading messages shown to the user while the visual renders.',
          minItems: 1,
          maxItems: 4,
          items: { type: 'string' }
        },
        widget_code: {
          type: 'string',
          description:
            'SVG or HTML code to render. For SVG: raw SVG code starting with <svg> tag. For HTML: raw HTML content without DOCTYPE, <html>, <head>, or <body> tags.'
        }
      },
      required: ['loading_messages', 'title', 'widget_code']
    }
  },
  execute: async () =>
    encodeToolError(
      'visualize_show_widget executes in the .NET Native Worker and is unavailable through the renderer boundary.'
    ),
  requiresApproval: () => false
}

export function registerWidgetTools(): void {
  toolRegistry.register(visualizeShowWidgetHandler)
}
