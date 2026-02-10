---
name: pdf-academic
description: Analyze academic and scientific PDF papers by extracting text, methodology, findings, and references using Python (pymupdf). Use when the user wants to review, summarize, or critique a research paper.
compatibility: Requires Python 3 and pymupdf (pip install pymupdf)
---

# Academic Paper Analysis

Extract and analyze academic/scientific PDF papers.

## When to use this skill

- User asks to analyze or review a research paper
- User wants methodology, findings, or conclusions extracted from a paper
- User needs the references/bibliography section listed
- User asks "what is this paper about?"

## Steps

1. Ensure `pymupdf` is installed:
   ```bash
   pip install pymupdf
   ```

2. Extract text from the paper.

   **On Linux/macOS (bash):**
   ```bash
   python ~/.open-cowork/skills/pdf-academic/scripts/extract_text.py "INPUT_FILE_PATH"
   ```

   **On Windows (PowerShell) — use the expanded absolute path:**
   ```powershell
   python "$HOME\.open-cowork\skills\pdf-academic\scripts\extract_text.py" "INPUT_FILE_PATH"
   ```
   Or use the fully resolved path, e.g.: `python "C:\Users\USERNAME\.open-cowork\skills\pdf-academic\scripts\extract_text.py" "INPUT_FILE_PATH"`

   The script prints extracted text directly to stdout. You do NOT need to read a separate file — just use the shell output.

3. Read the shell output (or use the Read tool if saved to file).

4. Produce a structured analysis:

   ```
   ## Paper Analysis

   **Title**: ...
   **Authors**: ...
   **Published**: journal/conference, year

   ### Abstract Summary
   Problem → Method → Result (1–2 sentences each)

   ### Research Question / Hypothesis
   What the authors set out to prove or investigate.

   ### Methodology
   - Study design (experimental, survey, simulation, etc.)
   - Data sources and sample size
   - Tools / frameworks used

   ### Key Findings
   - Finding 1 (with statistical significance if reported)
   - Finding 2

   ### Limitations
   Issues acknowledged by the authors or identified in review.

   ### References of Note
   Key citations relevant to understanding this work.
   ```

5. (Optional) Extract only the references section:

   **On Linux/macOS:**
   ```bash
   python ~/.open-cowork/skills/pdf-academic/scripts/extract_references.py "INPUT_FILE_PATH"
   ```
   **On Windows (PowerShell):**
   ```powershell
   python "$HOME\.open-cowork\skills\pdf-academic\scripts\extract_references.py" "INPUT_FILE_PATH"
   ```

## Edge cases

- **Multi-column layouts**: pymupdf may interleave columns. Read carefully and reconstruct logical flow.
- **Supplementary materials**: If the user mentions appendices, they may be in a separate PDF.
- **Non-English papers**: pymupdf extracts Unicode text; analysis quality depends on the language model's capabilities.

## Scripts

- [extract_text.py](scripts/extract_text.py) — Extract full paper text
- [extract_references.py](scripts/extract_references.py) — Extract References/Bibliography section
