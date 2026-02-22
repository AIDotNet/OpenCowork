#!/usr/bin/env python3
"""
Convert Markdown to Word (.docx), PowerPoint (.pptx), and PDF using Pandoc.
Requires: Pandoc installed on the system.
"""

import argparse
import glob
import os
import shutil
import subprocess
import sys


def find_pandoc():
    """Find the pandoc executable."""
    pandoc = shutil.which('pandoc')
    if pandoc:
        return pandoc
    print("Error: Pandoc not found.", file=sys.stderr)
    print("Install Pandoc:", file=sys.stderr)
    print("  Windows: winget install --id JohnMacFarlane.Pandoc", file=sys.stderr)
    print("  macOS:   brew install pandoc", file=sys.stderr)
    print("  Linux:   sudo apt install pandoc", file=sys.stderr)
    sys.exit(1)


def convert_file(input_path, output_path, to_format, template=None,
                 toc=False, toc_depth=3, pdf_engine=None, margin=None,
                 font=None, metadata=None):
    """Convert a single Markdown file using Pandoc."""
    pandoc = find_pandoc()

    cmd = [pandoc, input_path, '-o', output_path, '--standalone']

    # Format-specific options
    if to_format == 'pdf':
        engine = pdf_engine or 'xelatex'
        cmd.extend(['--pdf-engine', engine])
        if font:
            cmd.extend(['-V', f'mainfont={font}'])
        if margin:
            cmd.extend(['-V', f'geometry:margin={margin}'])

    if template:
        if to_format in ('docx', 'pptx'):
            cmd.extend(['--reference-doc', template])
        else:
            cmd.extend(['--template', template])

    if toc:
        cmd.append('--toc')
        cmd.extend(['--toc-depth', str(toc_depth)])

    if metadata:
        for m in metadata:
            cmd.extend(['-M', m])

    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=120
        )
        if result.returncode != 0:
            print(f"Error converting {input_path}:", file=sys.stderr)
            if result.stderr:
                print(result.stderr, file=sys.stderr)
            return False
        return True
    except FileNotFoundError:
        print("Error: Pandoc not found.", file=sys.stderr)
        sys.exit(1)
    except subprocess.TimeoutExpired:
        print(f"Error: Conversion timed out for {input_path}", file=sys.stderr)
        return False


def main():
    parser = argparse.ArgumentParser(
        description='Convert Markdown to Word, PowerPoint, or PDF'
    )
    parser.add_argument(
        'input', nargs='?', default=None,
        help='Input Markdown file path'
    )
    parser.add_argument(
        '--to', required=True, choices=['docx', 'pptx', 'pdf'],
        help='Output format'
    )
    parser.add_argument(
        '--output', help='Output file path'
    )
    parser.add_argument(
        '--template', help='Reference document for styling (.docx or .pptx)'
    )
    parser.add_argument(
        '--toc', action='store_true', help='Add table of contents'
    )
    parser.add_argument(
        '--toc-depth', type=int, default=3, help='TOC depth (default: 3)'
    )
    parser.add_argument(
        '--pdf-engine', default=None,
        choices=['xelatex', 'pdflatex', 'lualatex', 'wkhtmltopdf'],
        help='PDF engine (default: xelatex)'
    )
    parser.add_argument(
        '--margin', default=None, help='Page margin for PDF (e.g., "2cm")'
    )
    parser.add_argument(
        '--font', default=None, help='Main font for PDF (e.g., "Noto Sans CJK SC")'
    )
    parser.add_argument(
        '--metadata', action='append', default=None,
        help='Document metadata (e.g., "title=My Report"). Can be specified multiple times.'
    )
    parser.add_argument(
        '--batch', default=None,
        help='Directory of .md files to batch convert'
    )
    parser.add_argument(
        '--output-dir', default=None,
        help='Output directory for batch conversion'
    )

    args = parser.parse_args()

    if args.batch:
        # Batch mode
        md_files = sorted(glob.glob(os.path.join(args.batch, '*.md')))
        if not md_files:
            print(f"No .md files found in {args.batch}", file=sys.stderr)
            sys.exit(1)

        out_dir = args.output_dir or args.batch
        os.makedirs(out_dir, exist_ok=True)

        success = 0
        for md_file in md_files:
            base = os.path.splitext(os.path.basename(md_file))[0]
            out_path = os.path.join(out_dir, f"{base}.{args.to}")
            print(f"Converting: {md_file} -> {out_path}")
            if convert_file(
                md_file, out_path, args.to,
                template=args.template, toc=args.toc,
                toc_depth=args.toc_depth, pdf_engine=args.pdf_engine,
                margin=args.margin, font=args.font, metadata=args.metadata
            ):
                success += 1

        print(f"\nBatch complete: {success}/{len(md_files)} files converted")
    else:
        # Single file mode
        if not args.input:
            parser.error("Provide an input file or use --batch for batch conversion")

        if not os.path.isfile(args.input):
            print(f"Error: File not found: {args.input}", file=sys.stderr)
            sys.exit(1)

        output = args.output
        if not output:
            base = os.path.splitext(args.input)[0]
            output = f"{base}.{args.to}"

        if convert_file(
            args.input, output, args.to,
            template=args.template, toc=args.toc,
            toc_depth=args.toc_depth, pdf_engine=args.pdf_engine,
            margin=args.margin, font=args.font, metadata=args.metadata
        ):
            print(f"Converted: {output}")
        else:
            sys.exit(1)


if __name__ == '__main__':
    main()
