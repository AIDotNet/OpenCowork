# My Coffee OpenCowork Extension

This extension wraps the Luckin Coffee MCP endpoint as OpenCowork custom tools and host-rendered
response components.

## Built-in Usage

OpenCowork ships this extension from `resources/extensions/my-coffee`. On startup it is initialized
into the local extension directory and shown in Settings -> Extensions.

1. Open OpenCowork Settings -> Extensions.
2. Paste your Luckin MCP token into `Luckin MCP Token`.
3. Use the composer `+` menu -> Custom Extensions to select `My Coffee`.

The extension is available by default, but its tools are not loaded into the Agent tool catalog
until it is selected from the `+` menu. The selection is remembered per project.

## Manual Development Install

1. Open OpenCowork Settings -> Extensions.
2. Click Install folder and choose this `resources/extensions/my-coffee` folder.
3. Paste your Luckin MCP token into `Luckin MCP Token`.
4. Enable the extension.
5. Use the composer `+` menu -> Custom Extensions to select `My Coffee`.

Create a token from <https://open.lkcoffee.com/mcp>.

## Notes

- Only self-pickup ordering is supported.
- `create_order` refuses to run unless `preview_order` was called with the same store and products.
- Coupon codes returned by `preview_order` are automatically passed to `create_order`.
- Payment output uses `payOrderQrCodeUrl`; `payOrderUrl` is removed from tool data.
- Tools return `ui.kind = "component"` with component names declared in `extension.json`.
  OpenCowork loads the matching HTML file from `components/` and passes `ui.props` through the
  `extension-props` event.
