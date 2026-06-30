---
name: create-extension
description: Create or modify OpenCowork Custom Extensions. Use when the user asks to build a custom extension/plugin for OpenCowork that adds Agent tools, declarative HTTP tools, sandboxed JavaScript handlers, extension configuration fields, network allowlists, or custom response UI renderers.
---

# Create Extension

Create OpenCowork V1 Custom Extensions, not Codex marketplace plugins, App plugins, or message
channel plugins.

Before creating or changing an extension, read `references/extension-v1.md`.

## Workflow

1. Confirm the extension is an OpenCowork Custom Extension: a local folder installed from
   Settings -> Extensions with an `extension.json` manifest.
2. Choose the smallest template:
   - `minimal`: declarative HTTP demo tool.
   - `http`: declarative HTTP tool for a specific endpoint.
   - `js`: sandboxed JavaScript handler tool.
3. Scaffold with the bundled script, then customize the generated files.
4. Validate the generated extension with the same script before handoff.
5. Tell the user to install the folder from Settings -> Extensions, enable it, and start a new
   chat request so dynamic tools refresh.

## Scaffold

Run from any working directory, using the absolute path to this skill's script:

```bash
python3 {skill_root}/scripts/create_extension.py my_extension --path /absolute/output/dir --template minimal
```

Useful variants:

```bash
python3 {skill_root}/scripts/create_extension.py company_search \
  --path /absolute/output/dir \
  --template http \
  --url "https://api.example.com/search?q={{input.query}}"

python3 {skill_root}/scripts/create_extension.py local_summary \
  --path /absolute/output/dir \
  --template js
```

`--path` is the parent directory where the extension folder is created. The script creates
`<path>/<extension-id>/`.

Use `--force` only when intentionally replacing an existing generated folder.

## Editing Guidance

- Keep `extension.json` as the single declaration entry.
- Match the folder name and manifest `id`.
- Use declarative HTTP tools when possible. Use JavaScript handlers when the extension needs local
  composition, storage, custom result shaping, or multiple host-mediated requests.
- Declare every network origin used by HTTP tools in `permissions.network`.
- JavaScript handlers must use `ctx.fetch` for network access; direct `fetch`, Node imports,
  Electron, filesystem, and shell access are unavailable.
- Put secrets in `configSchema` fields with `"type": "secret"` and reference them with
  `{{config.key}}`.
- Set `readOnly: true` only for pure read tools. Non-GET HTTP tools require approval unless
  explicitly read-only.

## Validate

```bash
python3 {skill_root}/scripts/create_extension.py my_extension \
  --path /absolute/output/dir \
  --template minimal \
  --validate-only
```

The script validates manifest shape, file existence, unique tool and renderer names, HTTP/JS tool
definitions, and renderer basics.
