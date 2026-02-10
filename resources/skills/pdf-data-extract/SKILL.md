---
name: pdf-data-extract
description: Extract structured data, tables, and form fields from PDF files using Python (pymupdf, tabula-py). Use when the user needs tables, form data, or specific fields extracted from a PDF into JSON, CSV, or Markdown format.
compatibility: Requires Python 3, pymupdf, and optionally tabula-py with Java Runtime
---

# PDF Data Extraction

Extract tables, form fields, and structured data from PDF files.

## When to use this skill

- User wants to extract tables from a PDF
- User needs form field values from a fillable PDF
- User asks to convert PDF data into JSON, CSV, or Markdown

## Steps

### Extract tables

1. Ensure dependencies are installed:
   ```bash
   pip install pymupdf tabula-py pandas
   ```
   > `tabula-py` requires Java Runtime (JRE). If unavailable, fall back to raw text extraction.

2. Run the table extraction script.

   **On Linux/macOS (bash):**
   ```bash
   python ~/.open-cowork/skills/pdf-data-extract/scripts/extract_tables.py "INPUT_FILE_PATH"
   ```
   **On Windows (PowerShell) — use the expanded absolute path:**
   ```powershell
   python "$HOME\.open-cowork\skills\pdf-data-extract\scripts\extract_tables.py" "INPUT_FILE_PATH"
   ```

   For CSV output instead of Markdown, add `--csv`:
   ```bash
   python ~/.open-cowork/skills/pdf-data-extract/scripts/extract_tables.py "INPUT_FILE_PATH" --csv
   ```

### Extract form fields

For fillable PDF forms:

**On Linux/macOS (bash):**
```bash
python ~/.open-cowork/skills/pdf-data-extract/scripts/extract_form_fields.py "INPUT_FILE_PATH"
```
**On Windows (PowerShell):**
```powershell
python "$HOME\.open-cowork\skills\pdf-data-extract\scripts\extract_form_fields.py" "INPUT_FILE_PATH"
```
For JSON output, add `--json`:
```bash
python ~/.open-cowork/skills/pdf-data-extract/scripts/extract_form_fields.py "INPUT_FILE_PATH" --json
```

### Fallback: raw text extraction

If tabula is unavailable or the data is not in table format:

**On Linux/macOS:**
```bash
python ~/.open-cowork/skills/pdf-data-extract/scripts/extract_text.py "INPUT_FILE_PATH"
```
**On Windows (PowerShell):**
```powershell
python "$HOME\.open-cowork\skills\pdf-data-extract\scripts\extract_text.py" "INPUT_FILE_PATH"
```
Then parse the text output to identify patterns (key-value pairs, repeated structures) and convert to the requested format.

### Output formatting

Present extracted data in the user's requested format:
- **JSON**: array of objects in a fenced code block
- **CSV**: comma-separated values in a fenced code block
- **Markdown table**: pipe-delimited table

## Edge cases

- **No tables found**: Fall back to text extraction and manual parsing.
- **Merged cells or complex layouts**: tabula may produce messy output — clean up column alignment manually.
- **Ambiguous values**: Output `null` or `[unclear]` instead of guessing.
- **Java not installed**: Skip tabula, use pymupdf text extraction as fallback.

## Scripts

- [extract_tables.py](scripts/extract_tables.py) — Extract tables via tabula-py
- [extract_form_fields.py](scripts/extract_form_fields.py) — Extract fillable form fields
- [extract_text.py](scripts/extract_text.py) — Raw text extraction fallback
