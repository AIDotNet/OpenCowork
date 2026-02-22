---
name: md-to-office
description: Convert Markdown files into Word (.docx), PowerPoint (.pptx), and PDF formats using Pandoc. Use when the user wants to convert documentation, notes, or reports from Markdown into professional office formats with optional template-based branding.
compatibility: Requires Pandoc installed on system. For PDF output, also needs a LaTeX distribution (e.g., TeX Live, MiKTeX) or wkhtmltopdf.
---

# Markdown to Office Converter

Convert Markdown into Word (.docx), PowerPoint (.pptx), PDF, and other formats using Pandoc.

## When to use this skill

- User asks to convert Markdown to Word, PowerPoint, or PDF
- User wants to generate a professional report from Markdown notes
- User needs presentation slides from a Markdown outline
- User wants branded documents using a custom template
- User needs batch conversion of multiple Markdown files

## Scripts overview

| Script | Purpose | Dependencies |
|---|---|---|
| `md_convert.py` | Convert Markdown to docx/pptx/pdf via Pandoc | Pandoc (system), optional: LaTeX |

## Steps

### 1. Install Pandoc (first time only)

- **Windows**: `winget install --id JohnMacFarlane.Pandoc` or download from https://pandoc.org/installing.html
- **macOS**: `brew install pandoc`
- **Linux**: `sudo apt install pandoc` or `sudo dnf install pandoc`

For PDF output (optional):
- **Windows**: Install MiKTeX from https://miktex.org/
- **macOS**: `brew install --cask mactex-no-gui`
- **Linux**: `sudo apt install texlive-xetex`

> **CRITICAL — Dependency Error Recovery**: If the script fails with "pandoc not found", install Pandoc using the commands above, then **re-run the EXACT SAME script command that failed**.

### 2. Convert Markdown to Word (.docx)

```bash
python scripts/md_convert.py "INPUT.md" --to docx --output "OUTPUT.docx"
```

Options:
- `--template PATH` — Use a reference .docx for styling/branding
- `--toc` — Add table of contents
- `--toc-depth N` — TOC depth (default: 3)
- `--metadata "title=My Report"` — Set document metadata

### 3. Convert Markdown to PowerPoint (.pptx)

```bash
python scripts/md_convert.py "INPUT.md" --to pptx --output "OUTPUT.pptx"
```

Slide rules:
- `# Heading 1` → New section slide
- `## Heading 2` → New content slide title
- Bullet points → Slide body content
- `---` → Manual slide break

Options:
- `--template PATH` — Use a reference .pptx for slide master/branding

### 4. Convert Markdown to PDF

```bash
python scripts/md_convert.py "INPUT.md" --to pdf --output "OUTPUT.pdf"
```

Options:
- `--pdf-engine ENGINE` — PDF engine: `xelatex` (default, best for CJK), `pdflatex`, `wkhtmltopdf`
- `--margin "2cm"` — Set page margins
- `--font "Noto Sans CJK SC"` — Set main font (important for CJK text)

### 5. Batch convert

```bash
python scripts/md_convert.py --batch "docs/" --to docx --output-dir "output/"
```

Converts all .md files in a directory.

## Common workflows

### Professional report from Markdown
```bash
python scripts/md_convert.py report.md --to docx --toc --template company_template.docx --output report.docx
```

### Slide deck from outline
```bash
python scripts/md_convert.py slides.md --to pptx --template brand_template.pptx --output presentation.pptx
```

### PDF documentation with CJK support
```bash
python scripts/md_convert.py docs.md --to pdf --pdf-engine xelatex --font "Noto Sans CJK SC" --output docs.pdf
```

## Edge cases

- **CJK text in PDF**: Must use `xelatex` engine with a CJK-compatible font
- **Images**: Use relative paths in Markdown; images must be accessible at conversion time
- **Complex tables**: Pandoc handles pipe tables well; very complex layouts may need adjustment
- **Large documents**: Pandoc handles large files efficiently; very image-heavy docs may be slow

## Scripts

- [md_convert.py](scripts/md_convert.py) — Convert Markdown to office formats via Pandoc
