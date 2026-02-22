---
name: excel-processor
description: Read, write, analyze, and format Excel spreadsheets (.xlsx). Use when the user needs to create Excel files, extract data from spreadsheets, apply formulas, format cells, or generate Excel reports from data. Supports multiple sheets, charts, and conditional formatting.
compatibility: Requires Python 3 and openpyxl (pip install openpyxl).
---

# Excel Processor

Read, write, analyze, and format Excel spreadsheets (.xlsx) using Python.

## When to use this skill

- User asks to create an Excel spreadsheet
- User wants to read or extract data from an .xlsx file
- User needs to add formulas, formatting, or charts to a spreadsheet
- User wants to convert CSV/JSON data into a formatted Excel file
- User needs Excel report generation with multiple sheets

## Scripts overview

| Script | Purpose | Dependencies |
|---|---|---|
| `excel_tool.py` | Read, write, format, and analyze Excel files | `openpyxl` |

## Steps

### 1. Install dependencies (first time only)

```bash
pip install openpyxl
```

> **CRITICAL — Dependency Error Recovery**: If the script fails with an `ImportError`, install the missing dependency using the command above, then **re-run the EXACT SAME script command that failed**.

### 2. Read an Excel file

```bash
python scripts/excel_tool.py read "INPUT.xlsx"
```

Options:
- `--sheet SHEET_NAME` — Read a specific sheet (default: active sheet)
- `--format json` — Output as JSON instead of table
- `--format csv` — Output as CSV
- `--save OUTPUT_PATH` — Save output to file

### 3. Create a new Excel file from CSV

```bash
python scripts/excel_tool.py create "OUTPUT.xlsx" --from-csv "DATA.csv"
```

Options:
- `--from-csv PATH` — Import data from CSV file
- `--from-json PATH` — Import data from JSON file
- `--sheet SHEET_NAME` — Set the sheet name (default: Sheet1)
- `--title TITLE` — Add a title row with merged cells
- `--auto-width` — Auto-adjust column widths to fit content
- `--header-style` — Apply bold + colored header row

### 4. Add a sheet to existing workbook

```bash
python scripts/excel_tool.py add-sheet "EXISTING.xlsx" --sheet "NewSheet" --from-csv "DATA.csv"
```

### 5. Apply formatting

```bash
python scripts/excel_tool.py format "FILE.xlsx" --auto-width --header-style --freeze-header
```

Options:
- `--auto-width` — Auto-fit column widths
- `--header-style` — Bold white text on blue background for header
- `--freeze-header` — Freeze the first row
- `--number-format COLS FORMAT` — Apply number format (e.g., `--number-format "C,D" "#,##0.00"`)

### 6. Analyze / summarize

```bash
python scripts/excel_tool.py analyze "FILE.xlsx"
```

Shows: sheet names, row/column counts, column types, basic stats for numeric columns.

### 7. Add formulas

```bash
python scripts/excel_tool.py formula "FILE.xlsx" --cell "E2" --formula "=SUM(B2:D2)"
python scripts/excel_tool.py formula "FILE.xlsx" --column "E" --formula "=SUM(B{row}:D{row})" --start-row 2 --end-row 100
```

## Common workflows

### CSV to formatted Excel report
1. `excel_tool.py create "report.xlsx" --from-csv "data.csv" --title "Monthly Report" --auto-width --header-style --freeze-header`

### Multi-sheet workbook
1. `excel_tool.py create "workbook.xlsx" --from-csv "sales.csv" --sheet "Sales"`
2. `excel_tool.py add-sheet "workbook.xlsx" --sheet "Expenses" --from-csv "expenses.csv"`

### Quick data inspection
1. `excel_tool.py analyze "data.xlsx"` — overview
2. `excel_tool.py read "data.xlsx" --sheet "Sheet1"` — view contents

## Edge cases

- **Large files (100MB+)**: openpyxl loads into memory. Use `--read-only` mode for very large files.
- **Formulas**: When reading, formulas show the formula text, not computed values (unless cached).
- **Macros (.xlsm)**: Not supported. Use .xlsx format only.
- **Password-protected files**: Not supported by openpyxl.
- **Date formats**: Dates are auto-detected. Use explicit format if ambiguous.

## Scripts

- [excel_tool.py](scripts/excel_tool.py) — Read, write, format, and analyze Excel files
