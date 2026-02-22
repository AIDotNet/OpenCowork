#!/usr/bin/env python3
"""
Render Mermaid diagram definitions into SVG/PNG image files.
Requires: @mermaid-js/mermaid-cli (npm install -g @mermaid-js/mermaid-cli)
"""

import argparse
import os
import shutil
import subprocess
import sys
import tempfile


def find_mmdc():
    """Find the mmdc (Mermaid CLI) executable."""
    mmdc = shutil.which('mmdc')
    if mmdc:
        return mmdc

    # Try npx as fallback
    npx = shutil.which('npx')
    if npx:
        return None  # Will use npx mmdc

    return None


def render(input_path, output_path, fmt='svg', theme='default',
           width=800, height=600, background='white'):
    """Render a Mermaid diagram file to SVG/PNG/PDF."""
    mmdc = find_mmdc()

    cmd = []
    if mmdc:
        cmd = [mmdc]
    else:
        npx = shutil.which('npx')
        if npx:
            cmd = [npx, 'mmdc']
        else:
            print("Error: mmdc (Mermaid CLI) not found.", file=sys.stderr)
            print("Install with: npm install -g @mermaid-js/mermaid-cli", file=sys.stderr)
            sys.exit(1)

    cmd.extend([
        '-i', input_path,
        '-o', output_path,
        '-t', theme,
        '-w', str(width),
        '-H', str(height),
        '-b', background,
    ])

    if fmt == 'png':
        cmd.extend(['-e', 'png'])
    elif fmt == 'pdf':
        cmd.extend(['-e', 'pdf'])
    # SVG is default

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=60
        )
        if result.returncode != 0:
            print("Error rendering diagram:", file=sys.stderr)
            if result.stderr:
                print(result.stderr, file=sys.stderr)
            sys.exit(1)
    except FileNotFoundError:
        print("Error: mmdc (Mermaid CLI) not found.", file=sys.stderr)
        print("Install with: npm install -g @mermaid-js/mermaid-cli", file=sys.stderr)
        sys.exit(1)
    except subprocess.TimeoutExpired:
        print("Error: Rendering timed out (60s limit).", file=sys.stderr)
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(
        description='Render Mermaid diagrams to SVG/PNG/PDF'
    )
    parser.add_argument(
        'input', nargs='?', default=None,
        help='Input .mmd file path (Mermaid diagram code)'
    )
    parser.add_argument(
        '--code', default=None,
        help='Inline Mermaid code (alternative to input file)'
    )
    parser.add_argument(
        '--output', default='diagram.svg',
        help='Output file path (default: diagram.svg)'
    )
    parser.add_argument(
        '--format', default='svg', choices=['svg', 'png', 'pdf'],
        help='Output format (default: svg)'
    )
    parser.add_argument(
        '--theme', default='default',
        choices=['default', 'dark', 'forest', 'neutral'],
        help='Mermaid theme (default: default)'
    )
    parser.add_argument(
        '--width', type=int, default=800,
        help='Output width in pixels (default: 800)'
    )
    parser.add_argument(
        '--height', type=int, default=600,
        help='Output height in pixels (default: 600)'
    )
    parser.add_argument(
        '--background', default='white',
        help='Background color (default: white, use "transparent" for none)'
    )

    args = parser.parse_args()

    if not args.input and not args.code:
        parser.error("Either provide an input file or use --code for inline Mermaid code")

    input_path = args.input
    temp_file = None

    # If inline code, write to temp file
    if args.code:
        # Replace semicolons used as line separators
        code = args.code.replace('; ', '\n').replace(';', '\n')
        temp_file = tempfile.NamedTemporaryFile(
            mode='w', suffix='.mmd', delete=False, encoding='utf-8'
        )
        temp_file.write(code)
        temp_file.close()
        input_path = temp_file.name

    if not os.path.isfile(input_path):
        print(f"Error: File not found: {input_path}", file=sys.stderr)
        sys.exit(1)

    try:
        render(
            input_path=input_path,
            output_path=args.output,
            fmt=args.format,
            theme=args.theme,
            width=args.width,
            height=args.height,
            background=args.background
        )
        print(f"Rendered: {args.output}")
    finally:
        if temp_file and os.path.isfile(temp_file.name):
            os.unlink(temp_file.name)


if __name__ == '__main__':
    main()
