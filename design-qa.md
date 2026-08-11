# CLI Plan mode and turn-status design QA

Date: 2026-08-11

## Comparison target

- Source visual truth:
  - `/tmp/claude-code-plan-reference.png` — Claude Code 2.1.177 Plan-mode status observed in a
    local PTY without submitting a model prompt.
  - `/var/folders/_6/_2r911b95k39p33yrhrynjqr0000gn/T/codex-clipboard-7AagbL.png` — user-provided
    token-flow reference crop.
- Implementation screenshots:
  - `/tmp/opencowork-plan-implementation.png`
  - `/tmp/opencowork-turn-status-implementation.png`
- Combined comparison evidence:
  - `/tmp/opencowork-plan-comparison.png`
  - `/tmp/opencowork-turn-status-comparison.png`
- Viewports: 79-column Plan review and status, 78-column turn status, plus 35-column responsive
  fixtures for both Plan and status components.
- State: Plan mode active with an awaiting-review plan; requesting and thinking turn phases with
  live token estimates.

The Plan comparison uses the same terminal state and mode label on both sides. OpenCowork keeps the
Claude Code status semantics while extending the state with an explicit review and approval
boundary. The small raster comparison substitutes a terminal-font fallback for a few Unicode
symbols; the real PTY verification displayed `⏸`, `⏵⏵`, `❯`, and the arrow keys correctly.

## Findings

No actionable P0, P1, or P2 differences remain.

- Fonts and typography: terminal-native monospace rendering remains consistent with the rest of
  OpenCowork. `PLAN MODE`, the plan title, the `Plan` section label, and the selected action establish
  a clear hierarchy. The 35-column fixture does not truncate the mode name or wrap an approval
  option onto a phantom blank line.
- Spacing and layout rhythm: the 79-column panel keeps a single bordered approval region with stable
  padding and alignment. At 35 columns, the compact subtitle and shortcut copy fit inside the border;
  every captured line reports `stringWidth <= width`.
- Colors and visual tokens: the implementation reuses OpenCowork's existing warning, accent, muted,
  selected-background, and selected-text tokens. Plan state is visually distinct without introducing
  a parallel palette.
- Image quality and asset fidelity: this terminal surface has no product imagery, logos, or custom
  image assets. The comparison artifacts are rasterized terminal captures only; the product uses the
  actual terminal glyphs.
- Copy and content: idle Plan mode uses `plan mode on (shift+tab to cycle)` to match the observed
  Claude Code behavior. The panel states `Planning first · implementation waits for your approval`
  and exposes `Shift+Tab cycle · exit Plan`, so the planning/implementation boundary and exit action
  are explicit.
- States and interactions: `/plan`, `/plan on`, `/plan off`, and `/plan toggle` are implemented.
  `Shift+Tab` follows `manual → accept edits → plan → auto → manual`. The Plan review overlay handles
  the shortcut directly, exits as soon as the mode cycles away, and preserves the plan so returning
  to Plan mode can reopen it.
- Accessibility and responsiveness: Plan review remains keyboard operable with visible selection,
  high-contrast selected text, arrow-key navigation, Enter confirmation, and an always-visible exit
  shortcut. Both 79- and 35-column fixtures pass without clipping or overflow.
- Turn-flow motion: requesting/output counters use a stable layout and monotonic eased catch-up. The
  captured output frames progressed through `0, 198, 361, 495, 604, 694, 768, 828, 877, 918, 951,
978` before reaching the formatted target, avoiding a single-frame jump.

## Focused region comparison

The focused Plan status region was compared in `/tmp/opencowork-plan-comparison.png`: both products
use a dedicated full-width Plan-mode message and advertise Shift+Tab in the line itself. The focused
turn-status comparison in `/tmp/opencowork-turn-status-comparison.png` verifies label hierarchy,
elapsed time, token direction, effort metadata, and the 35-column fallback. No additional crop was
needed because all text, selected-state styling, and terminal borders are legible at original scale.

## Patches made since the previous QA pass

- Added a persistent, responsive mode banner for non-manual idle modes.
- Added `/plan [on|off|toggle]` and Claude Code-compatible Shift+Tab cycling.
- Strengthened the Plan review hierarchy, approval boundary, and selected-row contrast.
- Made Shift+Tab work while the Plan review overlay is active and hide the overlay when leaving Plan
  without discarding the persisted plan.
- Added compact 35-column Plan copy and removed the selected-row trailing-space wrap.
- Added smooth token-count catch-up with stable-width metadata.

## Implementation checklist

- [x] Full-width idle Plan banner matches the observed shortcut semantics.
- [x] Slash command and Shift+Tab paths enter and leave Plan mode.
- [x] Active Plan review exposes and handles Shift+Tab.
- [x] 79-column and 35-column component frames stay within the viewport.
- [x] Token counters animate toward live and provider-reported usage.
- [x] Real fullscreen PTY smoke test passes without a model request.

## Open questions

None.

## Follow-up polish

No P3 polish is required for this handoff.

final result: passed
