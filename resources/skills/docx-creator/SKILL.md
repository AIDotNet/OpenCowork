---
name: docx-creator
description: Create, read, and edit Word documents (.docx) using Python. Use when the user needs to generate professional documents, extract text from Word files, modify existing documents, or convert content to .docx format. Supports headings, tables, lists, images, styles, and tracked changes.
compatibility: Requires Python 3 and python-docx (pip install python-docx).
---

# DOCX Creator

Create, read, and edit Microsoft Word documents (.docx) using Python.

## When to use this skill

- User asks to create a Word document / .docx file
- User wants to extract text from a .docx file
- User needs to modify or update an existing Word document
- User wants to generate reports, proposals, or professional documents
- User needs tables, formatted headings, or structured content in Word format

## Scripts overview

| Script | Purpose | Dependencies |
|---|---|---|
| `docx_tool.py` | Create, read, and edit .docx files | `python-docx` |

## Steps

### 1. Install dependencies (first time only)

```bash
pip install python-docx
```

> **CRITICAL — Dependency Error Recovery**: If the script fails with an `ImportError`, install the missing dependency using the command above, then **re-run the EXACT SAME script command that failed**.

### 2. Create a new document from Markdown

Convert Markdown-formatted text into a professional Word document:

```bash
python scripts/docx_tool.py create "OUTPUT_PATH.docx" --from-markdown "INPUT.md"
```

Or create from inline content:
```bash
python scripts/docx_tool.py create "OUTPUT_PATH.docx" --title "Document Title" --content "Body text here"
```

Options:
- `--title TITLE` — Document title (added as Heading 1)
- `--author AUTHOR` — Document author metadata
- `--from-markdown PATH` — Create from a Markdown file (converts headings, lists, bold, italic, code, tables)
- `--content TEXT` — Inline body text
- `--template PATH` — Use an existing .docx as template for styles

### 3. Read / extract text from a document

```bash
python scripts/docx_tool.py read "INPUT.docx"
```

Options:
- `--format text` — Plain text output (default)
- `--format markdown` — Convert to Markdown
- `--format json` — Structured JSON with paragraph styles
- `--save OUTPUT_PATH` — Save output to file

### 4. Add content to an existing document

```bash
python scripts/docx_tool.py append "EXISTING.docx" --heading "New Section" --level 2
python scripts/docx_tool.py append "EXISTING.docx" --paragraph "Additional text content"
python scripts/docx_tool.py append "EXISTING.docx" --table "col1,col2,col3" --rows "a,b,c|d,e,f"
```

### 5. Add a table from CSV data

```bash
python scripts/docx_tool.py table "OUTPUT.docx" --from-csv "DATA.csv" --title "Data Table"
```

## Common workflows

### Generate a report
1. Prepare content in Markdown format
2. `docx_tool.py create "report.docx" --from-markdown "report.md" --title "Monthly Report" --author "Team"`

### Extract and process document text
1. `docx_tool.py read "input.docx" --format markdown --save "content.md"`
2. Process the Markdown file as needed

### Add data table to existing document
1. `docx_tool.py table "report.docx" --from-csv "data.csv" --title "Sales Data"`

## Edge cases

- **Complex formatting**: python-docx handles most common formatting. Very complex layouts may need manual adjustment.
- **Images**: Use `--image PATH` flag when appending to add inline images.
- **Large documents**: Documents are processed in memory. Very large docs (100MB+) may need chunked processing.
- **Password-protected docs**: Not supported by python-docx. Inform the user.
- **Markdown tables**: Basic pipe tables are converted. Complex nested tables may need simplification.

## Scripts

- [docx_tool.py](scripts/docx_tool.py) — Create, read, and edit Word documents
