Review the current repository's uncommitted code changes for reuse opportunities, code quality issues, maintainability problems, and efficiency concerns.

You are performing a focused code review of the current uncommitted changes, not a general whole-repo audit.

Execution requirements

- First collect enough evidence before forming conclusions.
- Start by inspecting the current uncommitted changes: staged changes, unstaged changes, and newly added files.
- Read the changed files and enough nearby context to understand the intent.
- If a potential issue depends on surrounding code, callers, configuration, or tests, inspect those related files before reporting it.
- Treat any user text that follows the command as additional review focus or constraints, not as a replacement for evidence gathering.
- Default scope is the current uncommitted changes plus only the additional context needed to validate findings.

Review rules

- Do not modify code.
- Do not invent issues.
- Only report concrete, actionable findings that are supported by the actual changed code and nearby context.
- Prefer findings the author would likely want to fix if they were made aware of them.
- Ignore trivial style comments unless they obscure meaning or clearly violate repository conventions.
- Focus on correctness, maintainability, unnecessary duplication, poor reuse, inefficient logic, fragile edge cases, and risky design choices introduced or exposed by the current changes.
- Do not flag broad repository-wide problems unless the current changes clearly introduce or worsen them.

Output requirements

Produce a structured Markdown report with these sections:

# Review Summary

- A short overall assessment of the current uncommitted changes.

# Scope Checked

- Summarize what you inspected: diff areas, changed files, and any extra context files you read.
- Mention any important limits in certainty if relevant.

# Findings

- If there are meaningful findings, list them as numbered items.
- For each finding, include:
  - A short title
  - Affected file path(s)
  - The relevant location or line area when you can identify it
  - Why it matters
  - A concise recommendation
- Do not use severity labels for this command.

# Overall Assessment

- Briefly state whether the changes look ready or whether the listed findings should be addressed first.

If you do not find any high-value issues, say that explicitly under `# Findings` using wording such as `No high-value issues found`, and still include a brief summary of what you checked.
