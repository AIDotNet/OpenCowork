#!/usr/bin/env python3
"""Extract and categorize all links from a web page.

Fetches the page and extracts all <a> tags, categorizing them as
internal, external, or resource links. Useful for site navigation
and discovery before deeper scraping.

Dependencies: pip install requests beautifulsoup4
"""

import sys
import argparse
import json
import re
from urllib.parse import urlparse, urljoin


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
    if missing:
        print(f"Error: missing dependencies: {', '.join(missing)}", file=sys.stderr)
        print(f"Install with: pip install {' '.join(missing)}", file=sys.stderr)
        sys.exit(1)


RESOURCE_EXTENSIONS = {
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    '.zip', '.rar', '.tar', '.gz', '.7z',
    '.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.ico',
    '.mp3', '.mp4', '.avi', '.mov', '.webm',
    '.css', '.js', '.woff', '.woff2', '.ttf', '.eot',
}


def classify_link(href, base_domain):
    """Classify a link as internal, external, or resource."""
    parsed = urlparse(href)

    # Check for resource files
    path_lower = parsed.path.lower()
    for ext in RESOURCE_EXTENSIONS:
        if path_lower.endswith(ext):
            return "resource"

    # Check domain
    link_domain = parsed.netloc.lower()
    if not link_domain or link_domain == base_domain:
        return "internal"

    # Check for common CDN / same-org subdomains
    base_parts = base_domain.split(".")
    link_parts = link_domain.split(".")
    if len(base_parts) >= 2 and len(link_parts) >= 2:
        if base_parts[-2:] == link_parts[-2:]:
            return "internal"

    return "external"


def extract_links(html, base_url):
    """Extract all links from HTML."""
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(html, "html.parser")
    base_domain = urlparse(base_url).netloc.lower()
    links = []
    seen = set()

    for a_tag in soup.find_all("a", href=True):
        href = a_tag["href"].strip()

        # Skip anchors, javascript:, mailto:, tel:
        if not href or href.startswith(("#", "javascript:", "mailto:", "tel:")):
            continue

        # Resolve relative URLs
        full_url = urljoin(base_url, href)

        # Deduplicate
        if full_url in seen:
            continue
        seen.add(full_url)

        # Extract link text
        text = a_tag.get_text(strip=True) or ""
        text = re.sub(r'\s+', ' ', text)  # normalize whitespace
        if len(text) > 100:
            text = text[:100] + "..."

        link_type = classify_link(full_url, base_domain)

        links.append({
            "url": full_url,
            "text": text,
            "type": link_type,
        })

    return links


def format_markdown(links, url, filter_pattern=None, external_only=False):
    """Format links as Markdown."""
    # Apply filters
    filtered = links
    if external_only:
        filtered = [link for link in filtered if link["type"] == "external"]
    if filter_pattern:
        try:
            pattern = re.compile(filter_pattern, re.IGNORECASE)
            filtered = [link for link in filtered if pattern.search(link["url"])]
        except re.error as e:
            print(f"Warning: invalid regex pattern '{filter_pattern}': {e}", file=sys.stderr)

    # Group by type
    internal = [link for link in filtered if link["type"] == "internal"]
    external = [link for link in filtered if link["type"] == "external"]
    resources = [link for link in filtered if link["type"] == "resource"]

    parts = [f"# Links from {url}\n"]
    parts.append(f"Total: **{len(filtered)}** links ({len(internal)} internal, {len(external)} external, {len(resources)} resource)\n")

    if internal:
        parts.append("## Internal Links\n")
        for lk in internal:
            text = f" — {lk['text']}" if lk['text'] else ""
            parts.append(f"- {lk['url']}{text}")
        parts.append("")

    if external:
        parts.append("## External Links\n")
        for lk in external:
            text = f" — {lk['text']}" if lk['text'] else ""
            parts.append(f"- {lk['url']}{text}")
        parts.append("")

    if resources:
        parts.append("## Resource Links\n")
        for lk in resources:
            text = f" — {lk['text']}" if lk['text'] else ""
            parts.append(f"- {lk['url']}{text}")
        parts.append("")

    return "\n".join(parts)


def main():
    setup_encoding()
    check_dependencies()

    parser = argparse.ArgumentParser(
        description="Extract and categorize links from a web page"
    )
    parser.add_argument("url", help="URL to extract links from")
    parser.add_argument("--filter", type=str, default=None,
                        help="Regex pattern to filter URLs")
    parser.add_argument("--external-only", action="store_true",
                        help="Only show external links")
    parser.add_argument("--json", action="store_true",
                        help="Output as JSON instead of Markdown")
    parser.add_argument("--timeout", type=int, default=30,
                        help="Request timeout in seconds (default: 30)")

    args = parser.parse_args()

    import requests

    url = args.url.strip()
    if not url.startswith(("http://", "https://")):
        url = "https://" + url

    print(f"Extracting links from: {url}", file=sys.stderr)

    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        ),
    }

    try:
        resp = requests.get(url, headers=headers, timeout=args.timeout, allow_redirects=True)
        resp.raise_for_status()
        if resp.encoding and resp.encoding.lower() != 'utf-8':
            resp.encoding = resp.apparent_encoding or resp.encoding
        html = resp.text
        final_url = resp.url
    except requests.exceptions.RequestException as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    links = extract_links(html, final_url)
    print(f"Found {len(links)} unique links", file=sys.stderr)

    if args.json:
        # Apply filters for JSON output too
        filtered = links
        if args.external_only:
            filtered = [lk for lk in filtered if lk["type"] == "external"]
        if args.filter:
            try:
                pattern = re.compile(args.filter, re.IGNORECASE)
                filtered = [lk for lk in filtered if pattern.search(lk["url"])]
            except re.error:
                pass
        print(json.dumps(filtered, indent=2, ensure_ascii=False))
    else:
        print(format_markdown(links, final_url, args.filter, args.external_only))


if __name__ == "__main__":
    main()
