Create or improve one user-defined agent definition for OpenCoWork under the current user's agent directory.

Target location

- The file must live under the current user's home directory at `~/.open-cowork/agents`.
- Resolve that to the real home path on the current machine before writing. On Windows, that typically means a path like `C:\Users\<user>\.open-cowork\agents\<name>.md`.
- Create or update exactly one `.md` file.
- The filename must be kebab-case and should match the agent `name` field, for example `security-auditor.md`.

Primary goal

Create an agent definition that matches the existing OpenCoWork sub-agent style: Markdown with YAML frontmatter followed by a clear system prompt body.

Use English by default for the generated agent file.

Execution requirements

- First gather enough information before writing the file.
- Treat any user text that follows the command as the requested agent purpose, responsibilities, constraints, or special behavior.
- If the requested role is underspecified or ambiguous, ask targeted follow-up questions before creating or updating the file.
- Infer a kebab-case agent name from the requested purpose unless the user provides one explicitly.
- Check whether `~/.open-cowork/agents/<name>.md` already exists.
- If it exists, improve the existing file carefully instead of blindly replacing it.
- You do not need to compare against other agent files unless it is helpful, but the final format must remain compatible with the current OpenCoWork agent loader.

Required file structure

Always generate a Markdown file with YAML frontmatter and a prompt body.

Use this structure:

```md
---
name: your-agent-name
description: Short, specific description of what the agent does.
icon: lucide-icon-name
allowedTools: Read, Write, Edit, Glob, Grep, LS, Bash, AskUserQuestion
maxIterations: 0
---

You are ...
```

The frontmatter must explicitly include all of these fields:

- `name`
- `description`
- `icon`
- `allowedTools`
- `maxIterations`

Default field rules

- `name`: kebab-case
- `description`: concise and specific
- `icon`: choose the most suitable Lucide icon name
- `allowedTools`: `Read, Write, Edit, Glob, Grep, LS, Bash, AskUserQuestion`
- `maxIterations`: `0` unless there is a clear reason to set a limit

Body requirements

Write the prompt body in the style of the existing sub-agents used by OpenCoWork.
The body should usually include:

- A clear role definition
- When the agent should be used
- A practical workflow or checklist
- Domain-specific evaluation points or guardrails
- The expected output format
- Important constraints and quality standards

Quality rules

- Keep the agent practical and specialized.
- Avoid vague, generic prompts.
- Match the current repository's sub-agent tone and structure.
- Do not create multiple files in one run unless the user explicitly asks.
- If updating an existing file, preserve good existing content and improve weak or missing parts.

Final response requirements

After writing the file, briefly state:

- The created or updated file path
- The chosen agent name
- A short summary of the agent's intended purpose
