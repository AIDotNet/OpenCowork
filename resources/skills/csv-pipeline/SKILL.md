---
name: csv-pipeline
description: Process, transform, analyze, and report on CSV and JSON data files. Use when the user needs to filter rows, join datasets, compute aggregates, convert formats, deduplicate, or generate summary reports from tabular data. Works with any CSV, TSV, or JSON Lines file.
compatibility: Requires Python 3. No external dependencies beyond Python standard library (csv, json modules).
---

# CSV Data Pipeline

Process tabular data (CSV, TSV, JSON, JSON Lines) using standard command-line tools and Python. No external dependencies required beyond Python 3.

## When to use this skill

- User provides a CSV/TSV/JSON file and asks to analyze, transform, or report on it
- Joining, filtering, grouping, or aggregating tabular data
- Converting between formats (CSV to JSON, JSON to CSV, etc.)
- Deduplicating, sorting, or cleaning messy data
- Generating summary statistics or reports
- ETL workflows: extract from one format, transform, load into another

## Scripts overview

| Script | Purpose | Dependencies |
|---|---|---|
| `csv_tool.py` | All-in-one CSV/JSON processing tool | Python 3 (stdlib only) |

## Steps

### 1. Ensure Python 3 is available

```bash
python --version
```

> **CRITICAL — Error Recovery**: If any script below fails with an error, check that Python 3 is available and re-run the exact same command.

### 2. Inspect a data file

```bash
python scripts/csv_tool.py inspect "DATA_FILE"
```

Shows row count, column names, and non-empty value counts per column.

### 3. Filter rows

```bash
python scripts/csv_tool.py filter "DATA_FILE" --column COLUMN_NAME --op OPERATOR --value VALUE --output "OUTPUT_FILE"
```

Operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains`, `startswith`, `endswith`

### 4. Sort data

```bash
python scripts/csv_tool.py sort "DATA_FILE" --column COLUMN_NAME --order asc --output "OUTPUT_FILE"
```

Options: `--numeric` for numeric sorting, `--order desc` for descending.

### 5. Deduplicate

```bash
python scripts/csv_tool.py dedup "DATA_FILE" --columns "col1,col2" --output "OUTPUT_FILE"
```

Remove duplicates by specified columns (or all columns if omitted).

### 6. Aggregate / Group By

```bash
python scripts/csv_tool.py aggregate "DATA_FILE" --group-by COLUMN --agg-column VALUE_COL --func sum --output "OUTPUT_FILE"
```

Functions: `sum`, `avg`, `count`, `min`, `max`

### 7. Join two datasets

```bash
python scripts/csv_tool.py join "LEFT_FILE" "RIGHT_FILE" --on KEY_COLUMN --how inner --output "OUTPUT_FILE"
```

Join types: `inner`, `left`

### 8. Convert formats

```bash
python scripts/csv_tool.py convert "DATA_FILE" --to json --output "OUTPUT_FILE"
```

Supported conversions: `csv`, `json`, `jsonl` (JSON Lines), `tsv`

### 9. Generate summary report

```bash
python scripts/csv_tool.py report "DATA_FILE" --group-by CATEGORY_COL --value-column VALUE_COL --output "report.md"
```

Generates a Markdown summary table with count, sum, avg, min, max per group.

### 10. Clean data

```bash
python scripts/csv_tool.py clean "DATA_FILE" --output "CLEAN_FILE"
```

Strips whitespace, normalizes empty values (N/A, null, None → empty), normalizes booleans.

## Decision guide

1. **Quick look** → `inspect` to understand the data
2. **Filter/sort/dedup** → use the corresponding subcommand
3. **Summarize** → `aggregate` for raw data, `report` for Markdown output
4. **Combine files** → `join` two datasets on a shared key
5. **Change format** → `convert` between CSV/JSON/TSV

## Edge cases

- **Large files (100MB+)**: The tool processes data in streaming fashion where possible
- **Encoding issues**: Files are read as UTF-8 by default. For BOM files, use UTF-8-SIG
- **Quoted fields**: Python's csv module handles RFC 4180 quoting automatically
- **Mixed types**: Numeric operations attempt float conversion, falling back to 0

## Scripts

- [csv_tool.py](scripts/csv_tool.py) — All-in-one CSV/JSON data processing tool
