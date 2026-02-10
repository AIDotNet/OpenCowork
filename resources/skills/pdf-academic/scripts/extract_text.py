#!/usr/bin/env python3
"""Extract text from an academic PDF paper and print to stdout.

By default the extracted text is printed directly to stdout so the caller
can capture it without an intermediate file.  Use --save to also write a
.txt file, or pass an explicit output path as the second positional arg.
"""

import sys
import os


def setup_encoding():
    """Setup proper encoding for Windows console output."""
    if sys.platform == "win32":
        try:
            sys.stdout.reconfigure(encoding='utf-8', errors='replace')
            sys.stderr.reconfigure(encoding='utf-8', errors='replace')
        except AttributeError:
            pass


def main():
    setup_encoding()

    args = sys.argv[1:]

    if len(args) < 1:
        print("Usage: python extract_text.py <pdf_path> [output_path] [options]", file=sys.stderr)
        print("Options:", file=sys.stderr)
        print("  --password <pwd>    Password for encrypted PDF", file=sys.stderr)
        print("  --quiet             Suppress page markers in output", file=sys.stderr)
        print("  --save              Also write output to a .txt file", file=sys.stderr)
        sys.exit(1)

    pdf_path = args[0]

    password = None
    output_path = None
    quiet = False
    save = False

    i = 1
    while i < len(args):
        arg = args[i]
        if arg == "--password" and i + 1 < len(args):
            password = args[i + 1]
            i += 2
        elif arg == "--quiet":
            quiet = True
            i += 1
        elif arg == "--save":
            save = True
            i += 1
        elif not arg.startswith("-"):
            if output_path is None:
                output_path = arg
                save = True
            else:
                print(f"Warning: unexpected argument '{arg}' ignored", file=sys.stderr)
            i += 1
        else:
            print(f"Warning: unknown option '{arg}' ignored", file=sys.stderr)
            i += 1

    if not os.path.isfile(pdf_path):
        print(f"Error: file not found: {pdf_path}", file=sys.stderr)
        sys.exit(1)

    try:
        import fitz
    except ImportError:
        print("Error: pymupdf not installed. Run: pip install pymupdf", file=sys.stderr)
        sys.exit(1)

    open_kwargs = {}
    if password:
        open_kwargs["password"] = password

    try:
        doc = fitz.open(pdf_path, **open_kwargs)
    except Exception as e:
        if "password" in str(e).lower():
            print("Error: PDF is encrypted. Use --password option", file=sys.stderr)
        else:
            print(f"Error opening PDF: {str(e)}", file=sys.stderr)
        sys.exit(1)

    lines = []
    page_count = len(doc)
    for page_num, page in enumerate(doc, 1):
        text = page.get_text()
        if text:
            text = text.strip()
            if text:
                if quiet:
                    lines.append(text)
                else:
                    lines.append(f"\n--- Page {page_num}/{page_count} ---\n{text}")
        else:
            if not quiet:
                lines.append(f"\n--- Page {page_num}/{page_count} ---\n[No text content - may be scanned image]")
    doc.close()

    full_text = "".join(lines)

    # Always print to stdout so the caller gets the result directly
    print(full_text)

    # Optionally save to file
    if save:
        if output_path is None:
            output_path = pdf_path + ".txt"
        try:
            with open(output_path, "w", encoding="utf-8") as f:
                f.write(full_text)
            print(f"\n[Saved to: {output_path}]", file=sys.stderr)
        except Exception as e:
            print(f"Error writing output file: {str(e)}", file=sys.stderr)
            sys.exit(1)


if __name__ == "__main__":
    main()
