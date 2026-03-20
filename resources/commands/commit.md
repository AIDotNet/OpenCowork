Draft Conventional Commits style messages and commit the current repository's uncommitted changes, grouped by logical classification.

Execution requirements

- First collect enough evidence before writing commit messages.
- Inspect the current uncommitted changes: staged changes, unstaged changes, and newly added files.
- Read enough of the changed files to understand the purpose of the changes instead of relying only on filenames.
- If helpful, inspect recent commit history for repository-specific wording patterns, but the final messages should follow Conventional Commits style.
- Treat any user text that follows the command as additional emphasis or constraints for the draft.
- Default scope is all current uncommitted changes.
- **Group changes by logical classification**: analyze the changes and split them into groups by type (e.g., `docs`, `feat`, `fix`, `refactor`, `style`, `chore`). Each group becomes a separate commit.
- For each group: stage only the relevant files with `git add <paths>`, then run `git commit` with the message for that group. Execute commits in a sensible order (e.g., refactor before feat, docs last).
- For commits created by this command, use `token@routin.ai` as the committer email (set per command, e.g. `git -c user.email=token@routin.ai commit ...`; do not change global git config).

Commit drafting rules

- Infer the most appropriate Conventional Commits type from the actual changes, such as `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `build`, `ci`, `chore`, or `style`.
- Include a `scope` only when it can be inferred clearly and usefully from the changed area. If the scope is unclear, omit it.
- Keep the subject concise, imperative, and specific.
- Add a short body only when it helps clarify the change.
- Do not generate multiple alternatives per group unless the user explicitly asks for them.

Output requirements

Produce the result in this structure (then execute the commits as described in Execution requirements):

# Change Summary

- One sentence per commit group summarizing the purpose of that group.

# Commits (one per logical group)

For each group, output:

## Commit N: [type] subject

- **Files**: list of paths to stage for this commit
- **Optional Body**: 1-3 bullet points or short paragraph, or `No body needed`

If there are no uncommitted changes, clearly say that there is nothing to commit and do not run `git commit`.
