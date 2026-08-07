# OpenCowork CLI architecture

Status: implementation baseline and target architecture, 2026-08-07.

The CLI is a terminal renderer for OpenCowork. It is not a second agent implementation.
`OpenCowork.Native.Worker` remains the only agent loop, provider transport, tool dispatcher,
permission-policy evaluator, context compressor, sub-agent runtime, and durable data backend.

This document separates three kinds of information:

- **Public fact** — documented by Anthropic or visible in a published package.
- **Black-box observation** — captured by running a locally installed Claude Code build in an
  isolated configuration directory without signing in or making a model request.
- **OpenCowork design** — our clean-room implementation choice. It is not a claim about Claude
  Code internals.

## 1. Reference research

### 1.1 Public facts

The official Claude Code documentation describes two terminal rendering modes:

- The normal/classic interactive mode uses terminal scrollback.
- Fullscreen mode uses the terminal alternate-screen buffer, keeps the prompt at the bottom,
  mounts only visible messages, and adds mouse-oriented interactions such as scrolling and
  clicking expandable tool results. Anthropic calls fullscreen a research preview.
- `/tui fullscreen` and `/tui default` select those modes.

The current npm package is a small platform-distribution wrapper whose optional dependencies
contain native executables. Older published npm artifacts contained a bundled JavaScript CLI,
React 18, and `yoga.wasm`. That is evidence for a React/Yoga terminal-layout lineage, not a
license to copy implementation code.

Official references:

- <https://code.claude.com/docs/en/interactive-mode.md>
- <https://code.claude.com/docs/en/fullscreen.md>
- <https://code.claude.com/docs/en/commands.md>
- <https://code.claude.com/docs/en/permissions.md>
- <https://code.claude.com/docs/en/cli-reference.md>
- <https://code.claude.com/docs/en/keybindings.md>
- <https://code.claude.com/docs/en/settings.md>
- <https://code.claude.com/docs/en/tools-reference.md>
- <https://code.claude.com/docs/llms.txt>

### 1.2 Black-box observations

An isolated local run of Claude Code 2.1.177 was used to record terminal behavior only. No user
configuration, credentials, hidden source, or model traffic was involved. At an 80-column PTY,
the following states were observed:

- First-run theme selection, security notice, and workspace-trust screens.
- A rounded welcome panel with identity/model/cwd on the left and tips/changelog on the right.
- A prompt between two full-width horizontal rules, with shortcut and effort information below.
- `?` shortcut help, `/` command completion, `/add-dir`, permission confirmation, tool result
  indentation with `⎿`, and the two-step Ctrl-C exit warning.
- Incremental assistant and tool updates without replacing completed terminal scrollback.

OpenCowork reproduces those interaction principles and spacing relationships under its own name
and colors. It must never present itself as Anthropic or Claude Code.

## 2. Non-negotiable runtime boundary

```text
┌──────────────────────────── OpenCowork CLI ────────────────────────────┐
│ keyboard decoder · editor · overlays · transcript · terminal renderer │
│                 WorkerEventProjector (wire → UI state)                │
└───────────────────────────────┬────────────────────────────────────────┘
                                │ length-prefixed MessagePack
                                │ request / response / event
┌───────────────────────────────▼────────────────────────────────────────┐
│                    OpenCowork.Native.Worker                            │
│ provider calls · agent loop · tools · permissions · MCP · skills      │
│ sub-agents · compression · hooks · DB · filesystem/process execution  │
└────────────────────────────────────────────────────────────────────────┘
```

The CLI may:

- Resolve and supervise the worker executable.
- Read the same persisted OpenCowork settings needed to open a session.
- Send versioned worker requests.
- Validate envelope sequence/run/session identity.
- Project canonical events into terminal-specific view state.
- Collect user input for approval or other reverse requests and return the response.
- Persist terminal-only preferences such as renderer choice and key bindings in the future.

The CLI must not:

- Implement its own model/provider HTTP clients.
- Execute agent tools directly.
- Reimplement the iterative agent loop, retry policy, permission-policy matching, context
  compression, MCP execution, skill execution, or sub-agent scheduler.
- Treat a terminal component event schema as the canonical runtime protocol.
- Store a second set of provider credentials.

There is no alternate, fallback, fixture, or shell Agent Runtime in the CLI. Every interactive
turn is accepted and executed by `OpenCowork.Native.Worker`.

## 3. Current package layout

```text
cli/
├── src/
│   ├── index.tsx                         Commander entry and Ink lifecycle
│   ├── app.tsx                           terminal application state machine
│   ├── commands.ts                       UI-facing slash-command registry
│   ├── types.ts                          terminal view model and UiEvent contract
│   ├── runtime/
│   │   ├── native-worker-client.ts       Electron-neutral IPC transport/supervision
│   │   ├── open-cowork-worker-runtime.ts canonical event projector and reverse requests
│   │   ├── provider-catalog.ts            shared provider/channel/model discovery
│   │   ├── capability-snapshot.ts         v2 native-tool authorization snapshot
│   │   └── worker-session.ts              shared-config → worker run-request adapter
│   ├── terminal/terminal-screen.ts       title and alternate-screen lifecycle
│   ├── hooks/use-terminal-size.ts        resize subscription
│   ├── lib/text.ts                       Unicode width/grapheme/editor helpers
│   └── components/                       welcome, prompt, transcript, menus, overlays
├── ARCHITECTURE.md
├── README.md
├── package.json
└── tsconfig.json
```

An older duplicate entry file (`src/index 2.ts`) and its stale build output were removed; the
source tree and TypeScript build no longer reference it.

## 4. Worker transport

### 4.1 Executable resolution

Resolution order is deliberately explicit:

1. `--worker <path>`.
2. `OPEN_COWORK_NATIVE_WORKER_PATH`.
3. A worker bundled next to the installed CLI.
4. Repository `resources/native-worker`.
5. RID-specific NativeAOT/publish output under `sidecars/OpenCowork.Native.Worker`.
6. Development Release/Debug output.

The production npm layout should follow Claude Code's platform-package strategy: a small common
CLI package plus optional `darwin-arm64`, `darwin-x64`, `linux-*`, and `win-*` worker packages.
That packaging work is not part of the current source-tree prototype.

### 4.2 Endpoint and framing

- macOS/Linux: a unique Unix-domain socket under `/tmp`.
- Windows: a unique named pipe.
- Worker launch: `OpenCowork.Native.Worker --ipc <endpoint>`.
- Every frame begins with a four-byte unsigned big-endian payload length.
- The payload is MessagePack.
- The maximum accepted payload is 256 MiB, matching the desktop supervisor.

Request and response shapes:

```ts
type Request = { id: number; method: string; params: unknown }
type Response = { id: number; result?: unknown; error?: string }
type Event = { event: string; params?: unknown }
```

The optimized `agent/stream` frame is flat:

```ts
type AgentStreamEnvelope = {
  event: 'agent/stream'
  v: 1
  runId: string
  sessionId: string
  seq: number
  events: AgentStreamEvent[]
}
```

Startup gates on:

1. `worker/hello` protocol version.
2. `worker/routes` containing `initialize`, `agent/run`, `agent/cancel`, and
   `agent/reverse-response`.
3. `initialize` returning the native Agent Runtime identity and compatibility data.

A 15-second heartbeat checks `worker/ping`. The client cancels timed-out or aborted request IDs,
captures a bounded stderr tail, cleans up only its exact socket path, and terminates its child on
exit. A worker crash fails the current terminal turn; a later turn may start a fresh worker.

The desktop manager currently has more elaborate supervised restart/replay behavior. Long term,
framing, resolution, heartbeat, crash logging, and restart policy should be extracted from
`src/main/lib/native-worker.ts` into one Electron-neutral shared package so both clients use the
same tested implementation.

## 5. Session bootstrap

The runtime itself stays in the worker, but a UI client still needs a session-open contract. Today
the Electron Renderer builds a large `agent/run` request from Zustand stores, tool definitions,
dynamic MCP/extension catalogs, and a v2 capability snapshot. That builder is not yet host-neutral.

The current CLI adapter performs a bounded formal bootstrap:

- Reads providers from the existing `~/.open-cowork/ai-provider/index.json` and per-provider
  files, including the legacy fallback format.
- Reads normal settings from `~/.open-cowork/settings.json`.
- Filters providers with the same desktop selection rules: enabled, authenticated, and containing
  enabled chat models. It selects the same active provider/model or an explicit provider+model
  session override.
- Exposes the resulting safe metadata through a searchable `/model` catalog without exposing
  credentials to React components. The catalog is re-read whenever the overlay opens, so desktop
  provider/channel changes become visible without restarting the CLI.
- Sends provider options, permission policy, parallelism, context compression, cwd, session ID,
  and conversation history to `agent/run`.
- Advertises only tool definitions whose execution is already native in the worker and whose host
  callbacks are available in this CLI baseline: Read, Write, Edit, NotebookEdit, LS, Glob, Grep,
  Bash, synchronous Task delegation, and persistent Task state tools.
- Sends Agent Runtime protocol v2 with a Capability Snapshot v2. Each native tool has a stable
  identity, normalized JSON Schema, definition hash, side-effect class, parallel class, approval
  mode, recovery policy, and provider-visible membership. Startup rejects workers missing v2
  snapshot and strict-tool-validation features.
- Does not authorize dynamic tools that require unavailable terminal host adapters.

This is intentionally a compatibility stage, not the final bootstrap architecture. The target
contract is a UI-neutral worker/session host API:

```text
agent/session-open
  input: cwd, session/project selector, mode, model override, permission override
  output: sessionId, effective model, available UI commands, capability summary

agent/session-send
  input: sessionId, user message, optional attachments
  output: runId (events continue over agent/stream)

agent/session-close
  input: sessionId
```

The final shared bootstrap host must have exactly one implementation of:

- Provider and credential resolution.
- System prompt, memory, user rules, AGENTS.md, and mode prompt assembly.
- Stable and dynamic tool manifests.
- Skills, agents, MCP, extensions, browser, desktop, CodeGraph, and plugin capabilities.
- Capability Snapshot v2 construction and hashes. The CLI currently has a deliberately bounded
  native-core builder; it must converge with the desktop builder before dynamic catalogs are
  enabled.
- Compression and sub-agent provider selection.

It may live inside Native Worker or in an Electron-neutral Node host package, but both Electron and
CLI must call the same implementation. Moving only half the builder would create configuration
drift and is not acceptable.

## 6. Canonical stream projection

`src/shared/agent-stream-protocol.ts` remains the canonical protocol. The terminal's `UiEvent`
union is a projection contract, not a competing Agent Runtime protocol.

```text
AgentStreamEnvelope
  → protocol/run/session validation
  → monotonic sequence validation
  → event projector
  → UiEvent queue
  → React state reducer
  → Ink/Yoga terminal frame
```

Important mappings:

| Worker event                           | Terminal projection                                                        |
| -------------------------------------- | -------------------------------------------------------------------------- |
| `iteration_start`                      | Start a new potential assistant segment                                    |
| `thinking_delta`                       | Hidden-by-default thinking detail on the active assistant message          |
| `text_delta`                           | Stream text into the current assistant segment                             |
| `message_end`                          | Commit the assistant segment                                               |
| `tool_use_generated`                   | Create a running tool row with summarized input                            |
| `tool_call_start/update`               | Upsert the tool row                                                        |
| `tool_call_result`                     | Complete/error row, show `⎿` summary, optionally derive Task state         |
| `request_retry`                        | Warning with attempt, delay, and reason                                    |
| `context_compression_start/compressed` | Context lifecycle notices                                                  |
| `web_search`                           | Searching/completed activity row                                           |
| image events                           | Image-generation activity/result row                                       |
| sub-agent events                       | Task/sub-agent activity row and completion summary                         |
| `error`                                | Error notice; wait for terminal `loop_end` when available                  |
| `loop_end`                             | Replace canonical history when included; release input and finish the turn |

An envelope with a duplicate/old sequence is ignored. A forward gap is rendered as a warning and
processing continues, because freezing the terminal would be worse than displaying potentially
incomplete detail. Run and session IDs are always filtered before projection.

## 7. Reverse requests and permissions

The worker emits:

```ts
{
  event: 'agent/reverse-request',
  params: { id: string; method: string; params: unknown }
}
```

For `approval/request`, the CLI:

1. Correlates the worker reverse-request ID, run ID, session ID, tool name, and sanitized input.
2. Suspends normal prompt input and opens the permission overlay.
3. Offers allow once, allow for this CLI session, or deny.
4. Returns `agent/reverse-response { id, result: { approved, reason? } }`.
5. Maintains only an in-memory session allow set; durable rules remain owned by OpenCowork
   settings and evaluated by Native Worker.

Ctrl-C or Esc during a run calls `agent/cancel { runId }`; the UI remains in running state until
the worker emits `loop_end`, preventing a new turn from racing the old one.

Unknown reverse-request methods are failed explicitly instead of hanging the agent. Dynamic tools
requiring browser, desktop, MCP, extension JavaScript, notifications, channel plugins, hooks, or
team UI must not be advertised until their host adapters are registered. AskUser, Plan and CodeGraph
are registered because this CLI now has the corresponding host adapters. The target architecture
uses a reverse-request registry:

```ts
interface HostAdapter {
  method: string
  available(context: HostContext): boolean
  execute(params: unknown, signal: AbortSignal): Promise<unknown>
}
```

Capability advertisement is derived from installed adapters, so a worker can never call a host
method that the terminal cannot answer.

Native synchronous sub-agents are already available through the worker-owned `Task` executor.
The CLI reads only safe name/description metadata from the same `~/.open-cowork/agents/` directory
for its searchable agents panel. The worker independently parses the selected definition, creates
the child run, enforces leaf-only delegation, inherits parent tools and permissions, and emits
`sub_agent_*` events. The projector keeps child thinking, text, inner tool activity, report, and
completion attached to the parent Task block. No child agent loop runs in Node or React.

### 7.1 AskUserQuestion host adapter

`AskUserQuestion` is a Worker-owned tool. The Worker validates one to four questions, two to four
options per question, the twelve-rune header limit, and preview restrictions before emitting:

```text
ask-user/request
  → CLI AskUser overlay
  → agent/reverse-response { answers: { "0": string|string[] }, annotations? }
```

The overlay owns focus until every question has an answer. Single-select uses Enter, multi-select
uses Space plus Enter, and the terminal adds an `Other` text editor without modifying the Worker
question definition. Optional notes and the selected single-choice preview are keyed by question
index. Preview data is displayed as terminal text only; no HTML or script is executed. Ctrl-C
cancels the active turn, while Esc returns to the current question instead of silently resolving a
Worker request with an empty answer.

### 7.2 Plan host adapter

The Worker is the source of truth for plan files and SQLite rows. `EnterPlanMode` creates or resumes
`.plan/{planId}.md`, and `ExitPlanMode` reads that file, persists `awaiting_review`, and emits a
`plan/ui-update` reverse request. The CLI acknowledges that request immediately and projects the
snapshot into a review panel:

```text
plan/ui-update
  → drafting / awaiting review panel
  → approve: db/plans-update implementing + next turn planExecution
  → revise: db/plans-update rejected + next turn planRevision
```

The review panel uses the same terminal token system as permissions, caps visible plan lines, and
supports PgUp/PgDn, file-path disclosure through Ctrl-G, auto-accept-edits, manual approval, and
feedback-driven revision. The next `agent/run` carries the file path or revision context; the Worker
injects the canonical execution/revision instruction and continues the same agent loop. No plan
content is written by the CLI.

### 7.3 CodeGraph host adapter

CodeGraph is opt-in through the shared desktop setting `codegraphEnabled`. At the beginning of each
turn the CLI requests `codegraph/tools-list` from the Native Worker. With the full-surface setting
off, only the Worker-reported `codegraph_explore` definition is advertised; with it on, the returned
surface is forwarded verbatim. Every definition enters both `agent/run.tools` and Capability
Snapshot v2 with a stable `codegraph:native:*` identity.

When the Worker emits `codegraph:tool`, the CLI validates the advertised name, injects the active
working folder as `projectPath`, and calls `codegraph/{tool}` on the same Worker connection. The
120-second bounded request returns CodeGraph's success-shaped `not_indexed`/disabled guidance
without making the Agent loop fail for an expected index state. `/codegraph` reports the shared
setting, indexed state and current tool surface; indexing and graph computation stay entirely in
the Worker.

## 8. Terminal application state machine

```text
                       ┌──────────────┐
                       │   welcome    │
                       └──────┬───────┘
                              │ submit
                       ┌──────▼───────┐
               cancel  │   running    │  stream/tool updates
             ┌────────►│              │◄─────────────────┐
             │         └──┬───────┬───┘                  │
             │ approval   │       │ loop_end             │
      ┌──────┴──────┐     │       ▼                      │
      │ permission  │─────┘  ┌──────────────┐            │
      │   overlay   │ answer │     idle     │────────────┘
      └─────────────┘        └──────────────┘  submit

idle overlays: command menu · shortcuts · model picker · agents panel · task panel
```

Priority is deterministic:

1. AskUser or Plan review/revision overlay.
2. Permission/reverse-request overlay.
3. Model picker or Agents panel.
4. Command completion or shortcut help.
5. Normal editor input.

Only the top active layer consumes keys. Runtime events may continue updating the transcript
behind an approval overlay, but ordinary prompt submission stays disabled.

## 9. Classic and fullscreen renderers

### 9.1 Classic

- Completed user, assistant, tool, and system messages move into Ink `<Static>` output.
- Static messages become real terminal scrollback and are not repainted by spinner frames.
- Only the mutable suffix—streaming assistant, running tool, tasks, overlays, prompt, and
  status—is redrawn with cursor-relative ANSI operations.
- `/clear` explicitly clears terminal scrollback and resets view state.
- The prompt follows the transcript rather than being physically pinned to the terminal bottom.

This static/mutable split is necessary. Merely omitting alternate-screen mode while rendering the
entire transcript dynamically causes Ink to clear and repaint the whole terminal when content is
taller than the viewport, which is not classic behavior.

### 9.2 Fullscreen

- `TerminalScreen` enters DEC alternate screen `?1049h` before Ink renders and leaves with
  `?1049l` in a `finally` block.
- The root is constrained to terminal height, the transcript grows above it, and the prompt/status
  remain at the bottom.
- The current baseline retains only a calculated tail of messages in the mounted tree.

Target fullscreen virtualization uses measured message heights rather than message count:

```text
viewport rows
  - prompt/overlay height
  - status height
  - task panel height
  = transcript row budget
```

Walk backward through cached message heights until the row budget is filled, with overscan above.
Cache keys include message revision, terminal width, detail mode, theme/Unicode capability, and
markdown renderer version. Resize invalidates width-sensitive measurements.

Target fullscreen parity still needs:

- Mouse wheel and scrollbar position.
- Click-to-expand tool output and hover state.
- Terminal-native selection/copy behavior.
- Scroll lock while reading history and an unread-output marker.
- PageUp/PageDown, Home/End, and configurable keymap actions.

## 10. Prompt editor

The editor stores an array of Unicode grapheme clusters rather than indexing UTF-16 code units.
That prevents cursor/backspace corruption for CJK characters, emoji, variation selectors, and
combining marks. Display width is separately calculated with `string-width`.

Implemented editing behavior:

- Left/right, history up/down, Ctrl-A/E.
- Ctrl-K/U/W kill operations and Ctrl-Y yank.
- Ctrl-\_ undo snapshot.
- Alt-B/F word movement.
- Ctrl-S stash/restore.
- Shift-Enter and backslash-Enter multiline insertion.
- Tab/Enter command completion.
- Shift-Tab permission-mode cycling.
- Alt/Option-P model overlay.
- Left Arrow on an empty prompt opens the searchable Native Worker agents panel.
- Ctrl-O detail toggle and Ctrl-T task toggle.
- Esc closes menus; Esc during a run cancels; double Esc clears or reports unavailable rewind.
- Ctrl-C cancels a run, clears non-empty input, then requires a second Ctrl-C to exit.
- A visible `▏` cursor is rendered explicitly so non-color PTY recordings do not make text after
  an inverse-video cursor appear missing.

Target editor work includes bracketed-paste mode, terminal Kitty keyboard protocol negotiation,
selection-aware editing, configurable keybindings, `@` path completion, `!` shell mode, shell
history search, attachment/image paste, and durable prompt history.

## 11. Commands and overlays

The command registry is a view-model registry with future sources:

```text
core local commands
  + worker session commands
  + installed skills/agents
  + connected MCP/extension/plugin commands
  → deduplicated searchable command menu
```

The current local handlers are `/clear` (also available as `/new`), `/help`, `/model`, `/permissions`, `/tasks`, `/plan`,
`/codegraph`, `/effort`, `/status`, `/theme`, `/tui`, and `/exit`. Some are informational until their dedicated
settings UI exists. Other Claude-like names remain visible as parity targets; selecting a known but
unwired command yields a warning and never silently sends it to the model.

`/model` is backed by the same split provider store as the desktop app. It groups enabled chat
models by authenticated provider/channel, marks the current session selection, accepts live text
search over provider name, provider type, built-in ID, model name, and model ID, and refreshes the
catalog on every open. A confirmed selection updates both `providerId` and `modelId` in the current
session and persists the same active IDs to the shared provider-store index; sending only a display
label is forbidden because model IDs may collide across providers.

Every overlay needs:

- A stable focus owner and explicit input priority.
- Up/down (and where suitable left/right), Enter, Esc, number shortcuts, and a screen-reader label.
- Width-aware truncation with no accidental wrapping of selection rows.
- A small-terminal fallback that becomes a single-column or paged view.
- Snapshot fixtures at 40, 60, 80, 100, 120, and 160 columns.

## 12. Session history and persistence

Each CLI process owns a generated terminal session ID and creates the corresponding `sessions` row
through `db/sessions-create` before the first `agent/run`. Every submitted turn gets a unique run ID.
`captureFinalMessages: true` asks Native Worker to return canonical final messages on `loop_end`;
the next turn sends that history back to the same worker runtime. Context compression results can
replace the stored history without the terminal inventing its own summary.

The CLI currently does not resume a prior desktop conversation, but the created row is visible to
Electron and gives plans/tasks a valid foreign-key owner. Future session commands must use the
existing worker/SQLite APIs so Electron and CLI see the same history, titles, projects, tasks, goals,
token usage, and checkpoints. Required behaviors:

- `--continue` / `--resume <session>` with ambiguity UI.
- Atomic message append and run metadata.
- Attach to a still-running session after terminal restart.
- Durable outstanding approval snapshots.
- Conversation branch and rewind/checkpoint semantics.
- Per-session mode/model/permission prompt snapshots.

## 13. Terminal capabilities and accessibility

Startup should eventually negotiate a `TerminalCapabilities` value:

```ts
interface TerminalCapabilities {
  colorDepth: 1 | 4 | 8 | 24
  unicode: boolean
  hyperlinks: boolean
  mouse: boolean
  bracketedPaste: boolean
  kittyKeyboard: boolean
  synchronizedOutput: boolean
  screenReader: boolean
}
```

Rules:

- Respect `NO_COLOR`, `TERM=dumb`, CI, and redirected output.
- Never rely on color alone for status; use `✔`, `●`, `○`, `⚠`, and text.
- Provide ASCII fallbacks for border/spinner/cursor glyphs.
- Disable high-frequency animation in reduced-motion/screen-reader mode.
- Offer `--print`/JSON stream modes for automation rather than emitting ANSI to pipes.
- Sanitize untrusted model/tool text so control sequences cannot alter the terminal title,
  clipboard, hyperlinks, or cursor state.

The current renderer requires a TTY except for `--doctor`. Non-interactive print/JSON modes are
planned, not implemented.

## 14. Security boundaries

- Provider secrets are read only from the existing OpenCowork data directory and passed through
  IPC to Native Worker. They are never displayed by `--doctor`, transcript events, or diagnostics.
- Tool input is shown for informed approval, but a production sanitizer must redact fields marked
  sensitive by Capability Snapshot manifests.
- The worker owns path validation, read-before-write invariants, shell timeouts, deny/allow rules,
  and actual execution.
- `auto` maps to worker `fullAccess`; selecting it must remain an explicit user action.
- CLI host adapters must be allowlisted by method and reject unknown reverse requests.
- Socket paths contain process ID plus cryptographic randomness and are removed only by exact path.
- Length limits, sequence checks, protocol gates, and bounded stderr tails prevent unbounded or
  mismatched transport behavior.
- No file under `~/.open-cowork` is committed to the repository.

## 15. Performance budgets

Targets for an interactive local terminal:

| Metric                              | Target                                                  |
| ----------------------------------- | ------------------------------------------------------- |
| Keypress-to-frame p95               | under 16 ms                                             |
| Stream-delta-to-frame p95           | under 33 ms                                             |
| Resize reflow p95 at 1,000 messages | under 50 ms                                             |
| Idle CPU                            | effectively 0%; no spinner when nothing is active       |
| Fullscreen mounted messages         | viewport + bounded overscan                             |
| Classic repaint area                | mutable suffix only                                     |
| Worker frame memory                 | bounded by 256 MiB hard gate; normal events far smaller |

High-rate `text_delta`, `thinking_delta`, and `tool_use_args_delta` events should be coalesced per
render frame. UI rendering must never block the socket parser; the projector queue provides that
boundary. Long tool output remains collapsed and is line/byte bounded before terminal layout.

## 16. Verification strategy

There is no repository test suite, so validation has four layers.

### 16.1 Static

- `npm run typecheck`
- `npm run build`
- Root lint/typecheck once shared files are introduced.

### 16.2 Transport without model traffic

- `opencowork --doctor`
- Assert executable path, IPC handshake version, Agent Runtime v2 identity/features, required
  routes, and shared configured provider/model.
- Confirm the worker child and socket exit cleanly.

### 16.3 PTY golden states

Capture ANSI output and a normalized screen buffer for:

- Empty welcome at width matrix.
- Command menu, filtered menu, shortcut panel, model picker, and permission prompt.
- CJK/emoji input, paste burst, multiline input, history, stash, and undo.
- Streaming assistant, thinking detail, running/success/error tools, retry, compression, tasks,
  sub-agents, image/web-search activity, cancel, and errors.
- Classic scrollback commitment and `/clear`.
- Fullscreen alternate-screen enter/exit on normal exit, Ctrl-C, exception, and SIGTERM.

### 16.4 Worker integration

Use a deterministic local provider through Native Worker—not a second CLI runtime—to generate
known text/tool/approval sequences. Verify request IDs, envelope sequence, cancellation, reverse
responses, final history, and a second conversational turn. Test at least two real provider types
before release, in line with the repository runtime guidelines.

## 17. Delivery status

| Area                                                         | Status                                                      |
| ------------------------------------------------------------ | ----------------------------------------------------------- |
| Responsive welcome/prompt/status                             | Implemented baseline                                        |
| Command menu and shortcut overlay                            | Implemented baseline                                        |
| Unicode grapheme editor and common keybindings               | Implemented baseline                                        |
| Permission/task overlays                                     | Implemented baseline                                        |
| Searchable provider-grouped model overlay                    | Implemented from shared desktop store                       |
| Classic static scrollback renderer                           | Implemented baseline                                        |
| Fullscreen alternate-screen lifecycle and message tail       | Implemented baseline                                        |
| Native Worker framing, handshake, heartbeat, cancellation    | Implemented baseline                                        |
| Canonical stream projection                                  | Implemented for primary events; expand with protocol growth |
| Worker approval reverse request                              | Implemented                                                 |
| Shared provider/channel/settings selection                   | Implemented bounded adapter                                 |
| Native core code, Task sub-agents, and persistent Task tools | Implemented v2 catalog                                      |
| Capability Snapshot v2 native-core bootstrap                 | Implemented; dynamic shared builder still pending           |
| AskUser/Plan/CodeGraph host adapters                         | Implemented through Worker reverse requests                 |
| Team/browser/desktop/MCP/extension host adapters             | Not yet                                                     |
| Desktop/CLI durable shared sessions and resume               | Not yet                                                     |
| Height-based fullscreen virtualization and mouse             | Not yet                                                     |
| Non-interactive print/JSON output                            | Not yet                                                     |
| Platform worker npm packages/installers                      | Not yet                                                     |

The baseline is therefore a functional Native Worker-backed terminal client and a faithful UI
foundation, not a claim that every current Claude Code feature has already been cloned.

## 18. Recommended implementation order

1. Extract the Electron-neutral native worker client so Electron and CLI share transport tests.
2. Define `agent/session-open/send/close` or an equivalent shared host bootstrap and move provider,
   prompt, tool-manifest, permission, skills, MCP, and sub-agent catalog assembly behind it.
3. Replace the bounded CLI snapshot builder with that single shared Capability Snapshot v2 builder.
4. Add a host-adapter registry and only advertise tools whose reverse methods are available.
5. Move session/message/project persistence behind worker routes; add resume/continue/branch.
6. Add durable approvals, checkpoint/rewind, resume/continue/branch, and a shared host-adapter registry for the remaining UI-bound tools.
7. Add height-based fullscreen virtualization, scroll state, mouse, and selection behavior.
8. Add terminal capability negotiation, sanitized markdown, images/links, accessibility, and
   non-interactive output.
9. Build PTY golden tests and deterministic Native Worker integration fixtures.
10. Package platform-specific worker binaries and add update/doctor/repair flows.

That ordering keeps the central invariant intact: UI parity can evolve quickly, but there is only
one OpenCowork Agent Runtime.
