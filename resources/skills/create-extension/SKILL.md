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
   - `minimal`: sandbox JS tool returning built-in card UI.
   - `http`: declarative HTTP tool; no JS entry needed.
   - `ui`: sandbox JS tools returning table UI and custom HTML renderer UI.
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

python3 {skill_root}/scripts/create_extension.py status_dashboard \
  --path /absolute/output/dir \
  --template ui \
  --name "Status Dashboard"
```

`--path` is the parent directory where the extension folder is created. The script creates
`<path>/<extension-id>/`.

Use `--force` only when intentionally replacing an existing generated folder.

## Editing Guidance

- Keep `extension.json` as the single declaration entry.
- Match the folder name and manifest `id`.
- Prefer HTTP tools for simple API calls. Use JS tools only for logic, storage, multiple requests,
  or custom UI data shaping.
- Declare every network origin used by HTTP tools or `ctx.fetch` in `permissions.network`.
- Put secrets in `configSchema` fields with `"type": "secret"` and reference them with
  `{{config.key}}` or `ctx.config.key`.
- Set `readOnly: true` only for pure read tools. Non-GET HTTP and JS tools require approval unless
  explicitly read-only.
- For HTML renderer output, define a manifest renderer and return
  `ui: { kind: 'html', renderer: '<name>', props: {...} }`.
- Escape dynamic HTML values inside renderer files.

## Validate

```bash
python3 {skill_root}/scripts/create_extension.py my_extension \
  --path /absolute/output/dir \
  --template minimal \
  --validate-only
```

The script validates manifest shape, file existence, unique tool and renderer names, JS handler
references, and renderer basics.

