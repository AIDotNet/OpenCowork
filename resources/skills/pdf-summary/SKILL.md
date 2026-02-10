---
name: pdf-summary
description: Summarize PDF documents by extracting text with Python (pymupdf) and generating structured summaries. Use when the user wants a summary, overview, or key points from a PDF file.
compatibility: Requires Python 3 and pymupdf (pip install pymupdf)
---

# PDF Summary

Extract text from PDF files and produce structured summaries.

## When to use this skill

- User asks to summarize a PDF document
- User wants key points or an executive overview of a PDF
- User needs a chapter-by-chapter breakdown of a long PDF

## Steps

1. Ensure `pymupdf` is installed. If not:
   ```bash
   pip install pymupdf
   ```

2. Extract text from the PDF using the bundled script (installed at `~/.open-cowork/skills/`).

   **On Linux/macOS (bash):**
   ```bash
   python ~/.open-cowork/skills/pdf-summary/scripts/extract_text.py "INPUT_FILE_PATH"
   ```

   **On Windows (PowerShell) — you MUST use the expanded absolute path, NOT `$Env:USERPROFILE` inside quotes:**
   ```powershell
   python "$HOME\.open-cowork\skills\pdf-summary\scripts\extract_text.py" "INPUT_FILE_PATH"
   ```
   Or use the fully resolved path directly, e.g.:
   ```powershell
   python "C:\Users\USERNAME\.open-cowork\skills\pdf-summary\scripts\extract_text.py" "INPUT_FILE_PATH"
   ```
   **IMPORTANT:** Replace `USERNAME` with the actual Windows username. You can discover it via `$Env:USERPROFILE` or `whoami` first, then construct the full path as a plain string.

   The script prints extracted text directly to stdout (page-separated). You do NOT need to read a separate file — just use the shell output.
   Options: `--quiet` (no page markers), `--save` (also write a .txt file), `--password <pwd>` (encrypted PDF).

3. Produce a summary based on the extracted text in this structure:
   - **Document**: title or filename
   - **Pages**: total count
   - **Executive Summary**: 2–3 sentence overview
   - **Key Points**: 5–10 bullet items
   - **Detailed Sections**: section-by-section breakdown (if requested)

## Edge cases

- **Scanned/image-only PDFs**: If extracted text is empty or garbled, inform the user that OCR is required and suggest `pip install pytesseract`.
- **Very large PDFs (100+ pages)**: Extract text first, then summarize in chunks rather than loading the entire text at once.
- **Password-protected PDFs**: `pymupdf` supports passwords — pass it via `fitz.open(path, password="xxx")`. Ask the user for the password if needed.

## Scripts

- [extract_text.py](scripts/extract_text.py) — Extract all pages as plain text
