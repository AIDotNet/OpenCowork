# OpenCowork Custom Extension V1

Use this reference when creating or modifying OpenCowork Custom Extensions.

## Extension Shape

An extension is a local folder installed from Settings -> Extensions. The app copies it to:

```text
~/.open-cowork/extensions/<extensionId>/
```

Required:

```text
my_extension/
  extension.json
```

Optional:

```text
my_extension/
  index.js
  renderer.html
```

Installed extensions start disabled. The user must enable the extension in Settings before tools
appear in chat. Tool names are registered as:

```text
extension__<extensionId>__<toolName>
```

## Manifest

`extension.json` fields:

- `schemaVersion`: required, must be `1`.
- `id`: required, 2-64 chars, lowercase letters, numbers, `_`, or `-`; must match folder name.
- `name`: required display name.
- `version`: required version string.
- `description`: optional settings text.
- `entry`: required when any JS tool is present.
- `configSchema`: optional array of `{ key, label, type, required }`; `type` is `text` or `secret`.
- `permissions.network`: required for HTTP tools or JS `ctx.fetch`; entries are origins or URL
  prefixes, with `*` allowed but discouraged.
- `tools`: required non-empty array.

Tool fields:

- `name`: required, starts with a letter, then letters, numbers, `_`, or `-`, up to 64 chars.
- `description`: required for useful Agent selection.
- `inputSchema`: JSON-schema-like object. Use `type: "object"` with `properties` and `required`.
- `kind`: `http` or `js`.
- `readOnly`: optional approval override. Pure reads should set `true`; mutating tools should omit
  it or set `false`.

HTTP tool fields:

```json
{
  "kind": "http",
  "http": {
    "method": "GET",
    "url": "{{config.baseUrl}}/search?q={{input.query}}",
    "headers": {
      "Authorization": "Bearer {{config.apiKey}}"
    }
  }
}
```

JS tool fields:

```json
{
  "kind": "js",
  "handler": "showSummary"
}
```

## Interpolation

HTTP `url`, `headers`, and `body` support:

```text
{{input.foo}}
{{input.user.id}}
{{config.baseUrl}}
```

Interpolation returns an empty string for missing values. Non-string values are JSON stringified.

## Network Rules

All network calls go through the host:

- HTTP tools call the native host HTTP path.
- JS tools must use `ctx.fetch(request)`.
- Direct `fetch`, `XMLHttpRequest`, `WebSocket`, and `EventSource` are disabled in the JS sandbox.
- Requests are denied unless `permissions.network` allows the target URL and redirects.

Prefer exact origins or URL prefixes:

```json
{
  "permissions": {
    "network": ["https://api.example.com"]
  }
}
```

## Tool Results

HTTP tools return a structured extension result containing status, headers, and the response body.
If the body is valid JSON, it is exposed as parsed JSON; otherwise it is returned as text.

JS handlers may return plain values or structured objects:

```js
return {
  text: 'Human-readable summary',
  data: { raw: true },
  ui: { kind: 'card', title: 'Done', body: 'Result body' }
}
```

`index.js` must set `globalThis.openCoworkExtension`:

```js
globalThis.openCoworkExtension = {
  handlers: {
    async showSummary(input, ctx) {
      const previous = await ctx.storage.get('last_query')
      await ctx.storage.set('last_query', input.query || '')
      return { text: 'Summary ready', data: { previous } }
    }
  }
}
```

Available JS context:

- `ctx.config`: merged text and secret config values.
- `ctx.fetch(request)`: host-mediated fetch with network allowlist enforcement.
- `ctx.storage.get(key)`, `ctx.storage.set(key, value)`, `ctx.storage.delete(key)`.

## Install And Debug

1. Open Settings -> Extensions.
2. Click Install folder.
3. Select the folder containing `extension.json`.
4. Enable the extension.
5. Start a new chat request so dynamic tools refresh.

If a tool does not appear, check that the extension is enabled and the tool request happens after
the extension was enabled. If network fails, check `permissions.network`. If JS fails, confirm the
manifest `entry`, tool `handler`, and `globalThis.openCoworkExtension.handlers` names match.

V1 does not support zip or remote install, React component packages, custom message providers, or
direct filesystem/shell/Electron access.
