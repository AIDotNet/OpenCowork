#!/usr/bin/env python3
"""Fetch a web page and extract readable content as clean Markdown.

Uses requests + BeautifulSoup + readability-lxml + html2text for lightweight,
fast extraction without a headless browser. Works well for articles, docs,
blogs, wikis, and most static websites.

Dependencies: pip install requests beautifulsoup4 readability-lxml html2text
"""

import sys
import argparse


def setup_encoding():
    """Setup proper encoding for Windows console output."""
    if sys.platform == "win32":
        import io
        try:
            sys.stdout.reconfigure(encoding='utf-8', errors='replace')
            sys.stderr.reconfigure(encoding='utf-8', errors='replace')
        except (AttributeError, io.UnsupportedOperation):
            sys.stdout = io.TextIOWrapper(
                sys.stdout.buffer, encoding='utf-8', errors='replace', line_buffering=True
            )
            sys.stderr = io.TextIOWrapper(
                sys.stderr.buffer, encoding='utf-8', errors='replace', line_buffering=True
            )


def check_dependencies():
    """Check that required packages are installed."""
    missing = []
    try:
        import requests  # noqa: F401
    except ImportError:
        missing.append("requests")
    try:
        from bs4 import BeautifulSoup  # noqa: F401
    except ImportError:
        missing.append("beautifulsoup4")
    try:
        from readability import Document  # noqa: F401
    except ImportError:
        missing.append("readability-lxml")
    try:
        import html2text  # noqa: F401
    except ImportError:
        missing.append("html2text")

    if missing:
        print(f"Error: missing dependencies: {', '.join(missing)}", file=sys.stderr)
        print(f"Install with: pip install {' '.join(missing)}", file=sys.stderr)
        sys.exit(1)


def fetch_url(url, timeout=30):
    """Fetch URL content with proper headers."""
    import requests

    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
        "Accept-Encoding": "gzip, deflate, br",
    }

    try:
        resp = requests.get(url, headers=headers, timeout=timeout, allow_redirects=True)
        resp.raise_for_status()

        # Detect encoding
        if resp.encoding and resp.encoding.lower() != 'utf-8':
            resp.encoding = resp.apparent_encoding or resp.encoding

        return resp.text, resp.url, resp.status_code
    except requests.exceptions.Timeout:
        print(f"Error: request timed out after {timeout}s", file=sys.stderr)
        sys.exit(1)
    except requests.exceptions.ConnectionError as e:
        print(f"Error: connection failed: {e}", file=sys.stderr)
        sys.exit(1)
    except requests.exceptions.HTTPError as e:
        print(f"Error: HTTP {e.response.status_code}: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


def extract_with_readability(html, url):
    """Extract main article content using readability-lxml."""
    from readability import Document

    doc = Document(html, url=url)
    title = doc.short_title()
    content_html = doc.summary()
    return title, content_html


def extract_with_selector(html, selector):
    """Extract content matching a CSS selector."""
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(html, "html.parser")
    elements = soup.select(selector)
    if not elements:
        return None

    # Combine all matching elements
    parts = []
    for el in elements:
        parts.append(str(el))
    return "\n".join(parts)


def html_to_markdown(html, base_url=None):
    """Convert HTML to clean Markdown."""
    import html2text

    converter = html2text.HTML2Text()
    converter.body_width = 0  # Don't wrap lines
    converter.ignore_images = False
    converter.ignore_links = False
    converter.ignore_emphasis = False
    converter.protect_links = True
    converter.unicode_snob = True
    converter.mark_code = True
    converter.wrap_links = False
    converter.single_line_break = False

    if base_url:
        converter.baseurl = base_url

    md = converter.handle(html)

    # Clean up excessive blank lines
    import re
    md = re.sub(r'\n{3,}', '\n\n', md)
    return md.strip()


def extract_metadata(html):
    """Extract page metadata (title, description, etc.)."""
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(html, "html.parser")
    meta = {}

    # Title
    title_tag = soup.find("title")
    if title_tag:
        meta["title"] = title_tag.get_text(strip=True)

    # Meta description
    desc_tag = soup.find("meta", attrs={"name": "description"})
    if desc_tag and desc_tag.get("content"):
        meta["description"] = desc_tag["content"].strip()

    # OG tags
    for prop in ["og:title", "og:description", "og:type", "og:site_name"]:
        tag = soup.find("meta", attrs={"property": prop})
        if tag and tag.get("content"):
            meta[prop.replace("og:", "og_")] = tag["content"].strip()

    # Author
    author_tag = soup.find("meta", attrs={"name": "author"})
    if author_tag and author_tag.get("content"):
        meta["author"] = author_tag["content"].strip()

    # Published date
    for attr in ["article:published_time", "datePublished", "date"]:
        date_tag = soup.find("meta", attrs={"property": attr}) or soup.find("meta", attrs={"name": attr})
        if date_tag and date_tag.get("content"):
            meta["published"] = date_tag["content"].strip()
            break

    return meta


def main():
    setup_encoding()
    check_dependencies()

    parser = argparse.ArgumentParser(
        description="Fetch a web page and extract content as Markdown"
    )
    parser.add_argument("url", help="URL to fetch")
    parser.add_argument("--raw", action="store_true",
                        help="Output full page Markdown (no readability extraction)")
    parser.add_argument("--selector", type=str, default=None,
                        help="CSS selector to extract specific elements")
    parser.add_argument("--save", type=str, default=None,
                        help="Also save output to this file path")
    parser.add_argument("--max-length", type=int, default=None,
                        help="Truncate output to N characters")
    parser.add_argument("--timeout", type=int, default=30,
                        help="Request timeout in seconds (default: 30)")
    parser.add_argument("--no-metadata", action="store_true",
                        help="Skip metadata header in output")

    args = parser.parse_args()

    # Normalize URL
    url = args.url.strip()
    if not url.startswith(("http://", "https://")):
        url = "https://" + url

    print(f"Fetching: {url}", file=sys.stderr)

    # Fetch
    html, final_url, status = fetch_url(url, timeout=args.timeout)
    print(f"Status: {status}, Size: {len(html)} bytes", file=sys.stderr)

    if final_url != url:
        print(f"Redirected to: {final_url}", file=sys.stderr)

    # Extract metadata
    meta = extract_metadata(html) if not args.no_metadata else {}

    # Extract content
    if args.selector:
        # CSS selector mode
        selected_html = extract_with_selector(html, args.selector)
        if not selected_html:
            print(f"Warning: no elements matched selector '{args.selector}'", file=sys.stderr)
            print(f"[No elements matched CSS selector: {args.selector}]")
            sys.exit(0)
        title = meta.get("title", "")
        content_md = html_to_markdown(selected_html, base_url=final_url)
    elif args.raw:
        # Raw full-page mode
        title = meta.get("title", "")
        content_md = html_to_markdown(html, base_url=final_url)
    else:
        # Readability extraction mode (default)
        title, article_html = extract_with_readability(html, final_url)
        content_md = html_to_markdown(article_html, base_url=final_url)

    # Build output
    parts = []

    if not args.no_metadata and meta:
        parts.append(f"# {title or meta.get('title', 'Untitled')}")
        parts.append(f"\n**Source**: {final_url}")
        if meta.get("author"):
            parts.append(f"**Author**: {meta['author']}")
        if meta.get("published"):
            parts.append(f"**Published**: {meta['published']}")
        if meta.get("description"):
            parts.append(f"**Description**: {meta['description']}")
        parts.append("\n---\n")
    elif title and not args.no_metadata:
        parts.append(f"# {title}\n")

    parts.append(content_md)

    output = "\n".join(parts)

    # Truncate if requested
    if args.max_length and len(output) > args.max_length:
        output = output[:args.max_length] + f"\n\n[... truncated at {args.max_length} characters, total {len(output)}]"

    # Print to stdout
    print(output)

    content_length = len(content_md)
    print(f"\nExtracted: {content_length} characters", file=sys.stderr)

    # Save to file if requested
    if args.save:
        try:
            with open(args.save, "w", encoding="utf-8") as f:
                f.write(output)
            print(f"Saved to: {args.save}", file=sys.stderr)
        except Exception as e:
            print(f"Error saving file: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
