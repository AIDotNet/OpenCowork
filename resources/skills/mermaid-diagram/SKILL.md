---
name: mermaid-diagram
description: Render Mermaid diagram code into SVG image files. Use when the user sends Mermaid code blocks (```mermaid ... ```) and wants to visualize them as images. Supports flowcharts, sequence diagrams, class diagrams, state diagrams, ER diagrams, Gantt charts, pie charts, and more.
compatibility: Requires Node.js 16+ and @mermaid-js/mermaid-cli (npm install -g @mermaid-js/mermaid-cli).
---

# Mermaid Diagram Renderer

Render Mermaid diagram definitions into SVG or PNG image files.

## When to use this skill

- User sends Mermaid code blocks (```mermaid ... ```)
- User asks to "render", "visualize", or "draw" a diagram
- User wants flowcharts, sequence diagrams, class diagrams, or other Mermaid-supported diagrams as images
- User needs diagram images for documentation or presentations

## Scripts overview

| Script | Purpose | Dependencies |
|---|---|---|
| `render_mermaid.py` | Render Mermaid diagrams to SVG/PNG | `@mermaid-js/mermaid-cli` (Node.js) |

## Steps

### 1. Install dependencies (first time only)

```bash
npm install -g @mermaid-js/mermaid-cli
```

This installs the `mmdc` (Mermaid CLI) command globally.

> **Note**: This downloads a Chromium/Puppeteer browser (~150 MB). Only needed once.

> **CRITICAL — Dependency Error Recovery**: If the script fails with "mmdc not found" or similar errors, install the dependency using the command above, then **re-run the EXACT SAME script command that failed**.

### 2. Render a Mermaid diagram from a file

Write Mermaid code to a `.mmd` file, then render:

```bash
python scripts/render_mermaid.py "INPUT.mmd" --output "OUTPUT.svg"
```

### 3. Render from inline Mermaid code

```bash
python scripts/render_mermaid.py --code "graph TD; A-->B; B-->C;" --output "diagram.svg"
```

### 4. Options

- `--output PATH` — Output file path (default: `diagram.svg`)
- `--format FORMAT` — Output format: `svg` (default), `png`, `pdf`
- `--theme THEME` — Mermaid theme: `default`, `dark`, `forest`, `neutral`
- `--width WIDTH` — Output width in pixels (default: 800)
- `--height HEIGHT` — Output height in pixels (default: 600)
- `--background COLOR` — Background color (default: `white`, use `transparent` for no background)
- `--code TEXT` — Inline Mermaid code instead of input file

### 5. Examples

```bash
# Flowchart from file
python scripts/render_mermaid.py flow.mmd --output flow.svg --theme forest

# Sequence diagram inline
python scripts/render_mermaid.py --code "sequenceDiagram; Alice->>Bob: Hello; Bob-->>Alice: Hi!" --output seq.svg

# Dark theme PNG
python scripts/render_mermaid.py diagram.mmd --output diagram.png --format png --theme dark

# Transparent background
python scripts/render_mermaid.py diagram.mmd --output diagram.svg --background transparent
```

## Supported Diagram Types

| Type | Example Start |
|---|---|
| Flowchart | `graph TD` or `flowchart LR` |
| Sequence | `sequenceDiagram` |
| Class | `classDiagram` |
| State | `stateDiagram-v2` |
| ER Diagram | `erDiagram` |
| Gantt Chart | `gantt` |
| Pie Chart | `pie` |
| Git Graph | `gitGraph` |
| Mindmap | `mindmap` |
| Timeline | `timeline` |
| Quadrant | `quadrantChart` |

## Common workflows

### Generate architecture diagram
1. Write Mermaid flowchart code describing the architecture
2. Save to `architecture.mmd`
3. `render_mermaid.py architecture.mmd --output architecture.svg --theme neutral`

### Create sequence diagram for API flow
1. Write sequence diagram code
2. `render_mermaid.py --code "sequenceDiagram; Client->>API: POST /users; API->>DB: INSERT; DB-->>API: OK; API-->>Client: 201 Created" --output api-flow.svg`

## Edge cases

- **Very large diagrams**: May render slowly or overflow. Use `--width` and `--height` to adjust.
- **Special characters**: Escape quotes in inline `--code` mode, or use file input instead.
- **Complex diagrams**: Some advanced Mermaid features may require the latest mermaid-cli version.

## Scripts

- [render_mermaid.py](scripts/render_mermaid.py) — Render Mermaid diagrams to SVG/PNG
