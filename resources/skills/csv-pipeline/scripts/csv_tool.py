#!/usr/bin/env python3
"""
All-in-one CSV/JSON data processing tool.
Supports: inspect, filter, sort, dedup, aggregate, join, convert, report, clean.
No external dependencies — uses only Python 3 standard library.
"""

import csv
import json
import sys
import argparse
from collections import defaultdict


# ---------------------------------------------------------------------------
# I/O helpers
# ---------------------------------------------------------------------------

def read_data(path, delimiter=None):
    """Read CSV/TSV/JSON/JSONL into list of dicts."""
    ext = path.rsplit('.', 1)[-1].lower() if '.' in path else ''

    if ext in ('json',):
        with open(path, encoding='utf-8') as f:
            data = json.load(f)
            if isinstance(data, list):
                return data
            return [data]

    if ext in ('jsonl', 'ndjson'):
        rows = []
        with open(path, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line:
                    rows.append(json.loads(line))
        return rows

    # CSV / TSV
    if delimiter is None:
        delimiter = '\t' if ext == 'tsv' else ','
    with open(path, newline='', encoding='utf-8-sig') as f:
        return list(csv.DictReader(f, delimiter=delimiter))


def write_data(rows, path, fmt=None, delimiter=None):
    """Write list of dicts to CSV/JSON/JSONL/TSV."""
    if not rows:
        print("No rows to write.", file=sys.stderr)
        return

    if fmt is None:
        ext = path.rsplit('.', 1)[-1].lower() if '.' in path else 'csv'
        fmt = ext

    if fmt == 'json':
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(rows, f, indent=2, ensure_ascii=False)
    elif fmt in ('jsonl', 'ndjson'):
        with open(path, 'w', encoding='utf-8') as f:
            for row in rows:
                f.write(json.dumps(row, ensure_ascii=False) + '\n')
    else:
        if delimiter is None:
            delimiter = '\t' if fmt == 'tsv' else ','
        with open(path, 'w', newline='', encoding='utf-8') as f:
            writer = csv.DictWriter(f, fieldnames=rows[0].keys(), delimiter=delimiter)
            writer.writeheader()
            writer.writerows(rows)

    print(f"Wrote {len(rows)} rows to {path}", file=sys.stderr)


def to_float(val, default=0.0):
    """Safely convert a value to float."""
    if val is None:
        return default
    try:
        return float(str(val).strip())
    except (ValueError, TypeError):
        return default


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def cmd_inspect(args):
    """Inspect a data file: row count, columns, non-empty counts."""
    data = read_data(args.file)
    if not data:
        print("Empty file.")
        return

    print(f"Rows: {len(data)}")
    cols = list(data[0].keys())
    print(f"Columns ({len(cols)}): {', '.join(cols)}")
    print()
    for col in cols:
        non_empty = sum(1 for r in data if str(r.get(col, '')).strip())
        print(f"  {col}: {non_empty}/{len(data)} non-empty")


def cmd_filter(args):
    """Filter rows by a column condition."""
    data = read_data(args.file)
    col = args.column
    op = args.op
    val = args.value

    def match(row):
        cell = str(row.get(col, '')).strip()
        if op in ('gt', 'gte', 'lt', 'lte'):
            cell_f = to_float(cell)
            val_f = to_float(val)
            if op == 'gt': return cell_f > val_f
            if op == 'gte': return cell_f >= val_f
            if op == 'lt': return cell_f < val_f
            if op == 'lte': return cell_f <= val_f
        if op == 'eq': return cell == val
        if op == 'neq': return cell != val
        if op == 'contains': return val.lower() in cell.lower()
        if op == 'startswith': return cell.lower().startswith(val.lower())
        if op == 'endswith': return cell.lower().endswith(val.lower())
        return False

    filtered = [r for r in data if match(r)]
    print(f"Filtered: {len(filtered)}/{len(data)} rows match")

    if args.output:
        write_data(filtered, args.output)
    else:
        writer = csv.DictWriter(sys.stdout, fieldnames=data[0].keys() if data else [])
        writer.writeheader()
        writer.writerows(filtered)


def cmd_sort(args):
    """Sort rows by a column."""
    data = read_data(args.file)
    col = args.column
    reverse = args.order == 'desc'

    if args.numeric:
        key_fn = lambda r: to_float(r.get(col, ''))
    else:
        key_fn = lambda r: str(r.get(col, '')).strip().lower()

    sorted_data = sorted(data, key=key_fn, reverse=reverse)
    print(f"Sorted {len(sorted_data)} rows by '{col}' ({args.order})")

    if args.output:
        write_data(sorted_data, args.output)
    else:
        writer = csv.DictWriter(sys.stdout, fieldnames=data[0].keys() if data else [])
        writer.writeheader()
        writer.writerows(sorted_data)


def cmd_dedup(args):
    """Remove duplicate rows."""
    data = read_data(args.file)
    key_cols = [c.strip() for c in args.columns.split(',')] if args.columns else None

    seen = set()
    unique = []
    for r in data:
        if key_cols:
            key = tuple(str(r.get(c, '')) for c in key_cols)
        else:
            key = tuple(sorted((k, str(v)) for k, v in r.items()))
        if key not in seen:
            seen.add(key)
            unique.append(r)

    removed = len(data) - len(unique)
    print(f"Deduplicated: {len(unique)} unique rows ({removed} duplicates removed)")

    if args.output:
        write_data(unique, args.output)
    else:
        writer = csv.DictWriter(sys.stdout, fieldnames=data[0].keys() if data else [])
        writer.writeheader()
        writer.writerows(unique)


def cmd_aggregate(args):
    """Group by a column and aggregate another."""
    data = read_data(args.file)
    group_col = args.group_by
    agg_col = args.agg_column
    func = args.func

    groups = defaultdict(list)
    for r in data:
        groups[r.get(group_col, '')].append(r)

    results = []
    for name in sorted(groups):
        group = groups[name]
        values = [to_float(r.get(agg_col, '')) for r in group if str(r.get(agg_col, '')).strip()]
        if func == 'sum':
            agg = sum(values)
        elif func == 'avg':
            agg = sum(values) / len(values) if values else 0
        elif func == 'count':
            agg = len(values)
        elif func == 'min':
            agg = min(values) if values else 0
        elif func == 'max':
            agg = max(values) if values else 0
        else:
            agg = sum(values)

        results.append({
            group_col: name,
            f'{func}_{agg_col}': f'{agg:.2f}',
            'count': str(len(group))
        })

    print(f"Aggregated {len(data)} rows into {len(results)} groups")

    if args.output:
        write_data(results, args.output)
    else:
        writer = csv.DictWriter(sys.stdout, fieldnames=results[0].keys() if results else [])
        writer.writeheader()
        writer.writerows(results)


def cmd_join(args):
    """Join two datasets on a key column."""
    left = read_data(args.left_file)
    right = read_data(args.right_file)
    on = args.on
    how = args.how

    right_index = defaultdict(list)
    right_cols = set()
    for r in right:
        right_index[str(r.get(on, ''))].append(r)
        right_cols.update(r.keys())
    right_cols.discard(on)

    results = []
    for lr in left:
        key = str(lr.get(on, ''))
        if key in right_index:
            for rr in right_index[key]:
                merged = dict(lr)
                for k, v in rr.items():
                    if k != on:
                        merged[k] = v
                results.append(merged)
        elif how == 'left':
            merged = dict(lr)
            for col in right_cols:
                merged[col] = ''
            results.append(merged)

    print(f"Joined: {len(results)} rows ({how} join on '{on}')")

    if args.output:
        write_data(results, args.output)
    else:
        if results:
            writer = csv.DictWriter(sys.stdout, fieldnames=results[0].keys())
            writer.writeheader()
            writer.writerows(results)


def cmd_convert(args):
    """Convert between CSV, JSON, JSONL, TSV formats."""
    data = read_data(args.file)
    fmt = args.to
    output = args.output

    if not output:
        base = args.file.rsplit('.', 1)[0] if '.' in args.file else args.file
        ext_map = {'json': 'json', 'jsonl': 'jsonl', 'csv': 'csv', 'tsv': 'tsv'}
        output = f"{base}.{ext_map.get(fmt, fmt)}"

    write_data(data, output, fmt=fmt)
    print(f"Converted {len(data)} rows to {fmt} format")


def cmd_report(args):
    """Generate a Markdown summary report."""
    data = read_data(args.file)
    group_col = args.group_by
    value_col = args.value_column

    groups = defaultdict(list)
    for r in data:
        groups[r.get(group_col, '')].append(r)

    lines = [
        f"# Data Summary Report",
        f"",
        f"**Total rows**: {len(data)}",
        f"**Grouped by**: {group_col}",
        f"**Value column**: {value_col}",
        "",
        f"| {group_col} | Count | Sum | Avg | Min | Max |",
        "|---|---|---|---|---|---|"
    ]

    for name in sorted(groups):
        vals = [to_float(r.get(value_col, '')) for r in groups[name] if str(r.get(value_col, '')).strip()]
        if vals:
            lines.append(
                f"| {name} | {len(vals)} | {sum(vals):.2f} | {sum(vals)/len(vals):.2f} | {min(vals):.2f} | {max(vals):.2f} |"
            )
        else:
            lines.append(f"| {name} | 0 | - | - | - | - |")

    lines.extend(["", f"*Generated from {len(data)} rows*"])
    report = '\n'.join(lines)

    if args.output:
        with open(args.output, 'w', encoding='utf-8') as f:
            f.write(report)
        print(f"Report written to {args.output}", file=sys.stderr)
    else:
        print(report)


def cmd_clean(args):
    """Clean common data quality issues."""
    data = read_data(args.file)
    cleaned = []

    for r in data:
        clean_row = {}
        for k, v in r.items():
            k = k.strip()
            v = str(v).strip() if v is not None else ''
            # Normalize empty values
            if v.lower() in ('', 'n/a', 'na', 'null', 'none', '-', '#n/a', '#ref!'):
                v = ''
            # Normalize booleans
            elif v.lower() in ('true', 'yes', '1', 'y'):
                v = 'true'
            elif v.lower() in ('false', 'no', '0', 'n'):
                v = 'false'
            clean_row[k] = v
        cleaned.append(clean_row)

    print(f"Cleaned {len(cleaned)} rows")

    if args.output:
        write_data(cleaned, args.output)
    else:
        writer = csv.DictWriter(sys.stdout, fieldnames=data[0].keys() if data else [])
        writer.writeheader()
        writer.writerows(cleaned)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description='CSV/JSON Data Processing Tool')
    sub = parser.add_subparsers(dest='command', required=True)

    # inspect
    p = sub.add_parser('inspect', help='Inspect a data file')
    p.add_argument('file', help='Input file path')

    # filter
    p = sub.add_parser('filter', help='Filter rows by condition')
    p.add_argument('file', help='Input file path')
    p.add_argument('--column', required=True, help='Column to filter on')
    p.add_argument('--op', required=True, choices=['eq','neq','gt','gte','lt','lte','contains','startswith','endswith'])
    p.add_argument('--value', required=True, help='Value to compare against')
    p.add_argument('--output', help='Output file path')

    # sort
    p = sub.add_parser('sort', help='Sort rows')
    p.add_argument('file', help='Input file path')
    p.add_argument('--column', required=True, help='Column to sort by')
    p.add_argument('--order', default='asc', choices=['asc','desc'])
    p.add_argument('--numeric', action='store_true', help='Numeric sort')
    p.add_argument('--output', help='Output file path')

    # dedup
    p = sub.add_parser('dedup', help='Remove duplicates')
    p.add_argument('file', help='Input file path')
    p.add_argument('--columns', help='Comma-separated columns to deduplicate by (default: all)')
    p.add_argument('--output', help='Output file path')

    # aggregate
    p = sub.add_parser('aggregate', help='Group and aggregate')
    p.add_argument('file', help='Input file path')
    p.add_argument('--group-by', required=True, help='Column to group by')
    p.add_argument('--agg-column', required=True, help='Column to aggregate')
    p.add_argument('--func', default='sum', choices=['sum','avg','count','min','max'])
    p.add_argument('--output', help='Output file path')

    # join
    p = sub.add_parser('join', help='Join two datasets')
    p.add_argument('left_file', help='Left file path')
    p.add_argument('right_file', help='Right file path')
    p.add_argument('--on', required=True, help='Key column for join')
    p.add_argument('--how', default='inner', choices=['inner','left'])
    p.add_argument('--output', help='Output file path')

    # convert
    p = sub.add_parser('convert', help='Convert between formats')
    p.add_argument('file', help='Input file path')
    p.add_argument('--to', required=True, choices=['csv','json','jsonl','tsv'])
    p.add_argument('--output', help='Output file path')

    # report
    p = sub.add_parser('report', help='Generate summary report')
    p.add_argument('file', help='Input file path')
    p.add_argument('--group-by', required=True, help='Column to group by')
    p.add_argument('--value-column', required=True, help='Numeric column to summarize')
    p.add_argument('--output', help='Output file path (Markdown)')

    # clean
    p = sub.add_parser('clean', help='Clean data quality issues')
    p.add_argument('file', help='Input file path')
    p.add_argument('--output', help='Output file path')

    args = parser.parse_args()

    commands = {
        'inspect': cmd_inspect,
        'filter': cmd_filter,
        'sort': cmd_sort,
        'dedup': cmd_dedup,
        'aggregate': cmd_aggregate,
        'join': cmd_join,
        'convert': cmd_convert,
        'report': cmd_report,
        'clean': cmd_clean,
    }

    commands[args.command](args)


if __name__ == '__main__':
    main()
