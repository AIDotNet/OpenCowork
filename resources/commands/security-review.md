Perform a security review of the current repository's uncommitted changes.

You are performing a focused security review of the current uncommitted changes, not a broad full-repo penetration test.

Execution requirements

- First collect enough evidence before making security claims.
- Start by inspecting the current uncommitted changes: staged changes, unstaged changes, and newly added files.
- Read the changed files and enough nearby context to validate whether a potential risk is real.
- If needed, inspect related authentication, authorization, configuration, environment, dependency, or data-handling code before reporting an issue.
- Treat any user text that follows the command as additional focus, constraints, or threat-model guidance.
- Default scope is the current uncommitted changes plus only the extra repository context required to support reliable findings.

Security review rules

- Do not modify code.
- Do not invent vulnerabilities.
- Only report findings that are supported by evidence in the changed code or directly relevant nearby context.
- Cover code-level issues as well as dependency, supply-chain, configuration, secrets, and sensitive-data exposure risks when they are implicated by the current changes.
- Consider common categories such as injection, auth/authz mistakes, insecure defaults, secrets exposure, unsafe file access, command execution, SSRF, XSS, CSRF, deserialization, crypto misuse, dependency risk, and accidental disclosure of sensitive data.
- Do not flag speculative issues without explaining the concrete condition that makes them plausible.
- Prefer findings the author would likely want to fix before shipping.

Severity model

Use only these levels:

- High
- Medium
- Low

Output requirements

Produce a structured Markdown report with these sections:

# Security Review Summary

- A short overall assessment of the security posture of the current uncommitted changes.

# Scope Checked

- Summarize the changed areas and any additional files or configuration you inspected.
- Mention any important review limits if relevant.

# Findings

- Group findings under `## High`, `## Medium`, and `## Low`.
- Under each severity, list only the applicable findings.
- For each finding, include:
  - A short title
  - Affected file path(s)
  - The relevant location or line area when you can identify it
  - Why it is risky
  - The condition or attack scenario required for impact
  - Concrete evidence from the code or config
  - A practical remediation recommendation

# Overall Assessment

- Briefly state whether the current changes appear safe to proceed with or whether the listed findings should be addressed first.

If you do not find any high-value security issues, say that explicitly under `# Findings` using wording such as `No high-value security issues found`, and still summarize what you checked.
