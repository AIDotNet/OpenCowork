# OpenCowork Aggregate Extensions (V2 Fields)

Use this reference when an extension should bundle more than tools: skills, sub-agents, slash
commands, MCP servers, persistent state, or marketplace metadata. These are additive fields on
the V1 manifest — `schemaVersion` stays `1` and everything in `references/extension-v1.md` still
applies.

## Why Aggregate

A tools-only extension gives the Agent new capabilities but no workflow knowledge. An aggregate
extension ships both in one installable folder:

- `tools` teach the Agent what it can call.
- `skills` teach the Agent when and how to use those tools (workflows, gates, tone).
- `mcpServers` attach external tool servers that live inside the extension folder.
- `state` gives the extension a durable, model-readable home for saved user context.

Enable/disable/remove work at the extension level: the host syncs bundled resources into the user
content directories when the extension is enabled, and cleanly removes them when it is disabled
or uninstalled.

## Manifest Fields

All fields are optional and additive to the V1 manifest:

```json
{
  "schemaVersion": 1,
  "id": "my-extension",
  "name": "My Extension",
  "version": "1.0.0",
  "tools": [],
  "skills": "./skills/",
  "agents": "./agents/",
  "commands": "./commands/",
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["./mcp/server.mjs"],
      "cwd": "."
    }
  },
  "state": true,
  "interface": {
    "displayName": "My Extension",
    "category": "Productivity",
    "defaultPrompt": ["Help me get started"],
    "brandColor": "#FF66AD"
  }
}
```

- `skills`: folder of skill folders (each contains a `SKILL.md`), or a single skill folder with a
  `SKILL.md` at its root. Synced into the user skills directory while the extension is enabled.
- `agents`: folder of sub-agent Markdown files (frontmatter: `name`, `description`, `icon`,
  `maxIterations`). Sub-agents inherit the parent agent's current tools; legacy `allowedTools`
  and `disallowedTools` fields are accepted but not enforced. Files are synced into
  `~/.open-cowork/agents/` with an `<extensionId>--` filename prefix; the agent name comes from
  frontmatter.
- `commands`: folder of slash-command Markdown files. Synced into `~/.open-cowork/commands/`
  under their own filenames. A pre-existing user command with the same name is never
  overwritten; the sync skips it and logs a warning.
- `mcpServers`: map of server name to config. `transport` defaults to `stdio` (or
  `streamable-http` when `url` is set). Relative `cwd` resolves inside the extension folder and
  defaults to the extension root. Registered server ids look like `ext-<extensionId>-<name>`.
- `state: true`: the host creates `~/.open-cowork/state/plugins/<extensionId>/`. Use it for
  durable, model-readable context (Markdown plus an `assets/` folder). It is kept on disable and
  uninstall; only the user deletes it. Programmatic key-value state should keep using
  `ctx.storage` instead.
- `interface`: display metadata for settings, marketplaces, and composer prompt suggestions.

## Sync Rules

- Sync runs when the extension is enabled, on install, and once at app startup (re-synced when
  the manifest `version` changes). Disabling or removing the extension removes the synced
  skills, agents, and commands and unregisters its MCP servers.
- Names must not collide: a skill/agent/command that already exists and is not owned by this
  extension is skipped with a warning. Prefer unique, extension-scoped names.
- Ownership is tracked in `~/.open-cowork/extensions-sync.json`. Do not edit it by hand.

## Skill Authoring Inside Extensions

Follow the router pattern for multi-skill extensions:

- Ship one entry skill whose `description` covers the whole extension and routes to focused
  skills via relative links (`[skills/foo/SKILL.md](skills/foo/SKILL.md)`).
- Keep shared hard rules in a `references/` folder inside the skill and link them from every
  focused skill, so behavior contracts are written once.
- Put deterministic work in `scripts/` and reusable scaffolds in `templates/`; skills resolve
  them relative to the skill working directory.
- SKILL.md frontmatter requires `name` and `description`; `compatibility` and `license` are
  optional.

If the host rejects the converted extension manifest, the importer falls back to installing the
wrapper skill directly and registering the MCP servers standalone.
