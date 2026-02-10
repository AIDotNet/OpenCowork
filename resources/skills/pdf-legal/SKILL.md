---
name: pdf-legal
description: Analyze legal documents, contracts, and agreements by extracting text and searching for specific clauses using Python (pymupdf). Use when the user wants to review a contract, identify obligations, or flag risks in a legal PDF.
compatibility: Requires Python 3 and pymupdf (pip install pymupdf)
---

# Legal Document Analysis

Extract and analyze legal documents, contracts, and agreements.

> **Disclaimer**: This is AI-generated analysis for informational purposes only, not legal advice.

## When to use this skill

- User asks to review a contract or legal agreement
- User wants to find specific clauses (termination, confidentiality, non-compete)
- User needs obligations, deadlines, or payment terms extracted
- User asks about risks or ambiguous language in a legal document

## Steps

1. Ensure `pymupdf` is installed:
   ```bash
   pip install pymupdf
   ```

2. Extract text from the legal document.

   **On Linux/macOS (bash):**
   ```bash
   python ~/.open-cowork/skills/pdf-legal/scripts/extract_text.py "INPUT_FILE_PATH"
   ```
   **On Windows (PowerShell) — use the expanded absolute path:**
   ```powershell
   python "$HOME\.open-cowork\skills\pdf-legal\scripts\extract_text.py" "INPUT_FILE_PATH"
   ```

   The script prints extracted text directly to stdout.

3. Read the shell output (or use the Read tool if saved to file).

4. Produce a structured legal review:

   ```
   ## Legal Document Review

   **Document Type**: Contract / NDA / Terms of Service / ...
   **Parties**: Party A, Party B
   **Effective Date**: ...
   **Governing Law**: ...

   ### Key Clauses

   #### Obligations
   - Party A must ...
   - Party B must ...

   #### Termination
   - Conditions for termination
   - Notice period required

   #### Confidentiality
   - Scope and duration

   #### Liability & Indemnification
   - Caps and triggers

   #### Payment Terms
   - Amounts, schedules, penalties

   ### Risk Flags
   - [Page X] Ambiguous language in clause Y: "..."
   - [Page X] One-sided indemnification favoring Party A

   ### Plain English Summary
   3–5 sentence summary of practical implications.
   ```

5. (Optional) Search for specific clauses by keyword:

   **On Linux/macOS:**
   ```bash
   python ~/.open-cowork/skills/pdf-legal/scripts/search_clauses.py "INPUT_FILE_PATH" termination confidential indemnif
   ```
   **On Windows (PowerShell):**
   ```powershell
   python "$HOME\.open-cowork\skills\pdf-legal\scripts\search_clauses.py" "INPUT_FILE_PATH" termination confidential indemnif
   ```
   Multiple keywords can be passed as separate arguments.

## Edge cases

- **Scanned contracts**: If text extraction yields garbage, inform the user OCR is needed.
- **Multi-party agreements**: Clearly identify all parties and their respective obligations.
- **Amendments / addenda**: Check if the document references external amendments not included in the PDF.
- **Complex documents**: If too many clauses to analyze at once, offer to focus on specific sections.

## Scripts

- [extract_text.py](scripts/extract_text.py) — Extract full document text
- [search_clauses.py](scripts/search_clauses.py) — Search for keywords with page/line references
