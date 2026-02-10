#!/usr/bin/env python3
"""Search the web using DuckDuckGo and return structured results.

No API key required. Returns results with title, URL, and snippet.

Dependencies: pip install ddgs
"""

import sys
import argparse
import json


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
    try:
        from ddgs import DDGS  # noqa: F401
    except ImportError:
        try:
            from duckduckgo_search import DDGS  # noqa: F401
        except ImportError:
            print("Error: ddgs not installed.", file=sys.stderr)
            print("Install with: pip install ddgs", file=sys.stderr)
            sys.exit(1)


def _get_ddgs_class():
    """Import DDGS from ddgs (new) or duckduckgo_search (legacy)."""
    try:
        from ddgs import DDGS
        return DDGS
    except ImportError:
        from duckduckgo_search import DDGS
        return DDGS


def search_text(query, max_results=10, region="wt-wt"):
    """Perform a text search."""
    DDGS = _get_ddgs_class()
    ddgs = DDGS()
    try:
        # New ddgs package: positional 'query' arg
        results = list(ddgs.text(query, region=region, max_results=max_results))
    except TypeError:
        # Legacy duckduckgo_search: 'keywords' kwarg + context manager
        with DDGS() as d:
            results = list(d.text(keywords=query, region=region, max_results=max_results))
    return results


def search_news(query, max_results=10, region="wt-wt"):
    """Perform a news search."""
    DDGS = _get_ddgs_class()
    ddgs = DDGS()
    try:
        results = list(ddgs.news(query, region=region, max_results=max_results))
    except TypeError:
        with DDGS() as d:
            results = list(d.news(keywords=query, region=region, max_results=max_results))
    return results


def format_results_markdown(results, query, is_news=False):
    """Format search results as Markdown."""
    search_type = "News" if is_news else "Web"
    parts = [f"# {search_type} Search Results: {query}\n"]
    parts.append(f"Found **{len(results)}** results.\n")

    for i, r in enumerate(results, 1):
        title = r.get("title", "Untitled")
        url = r.get("href") or r.get("url") or r.get("link", "")
        body = r.get("body") or r.get("snippet", "")
        date = r.get("date", "")

        parts.append(f"## {i}. {title}")
        parts.append(f"**URL**: {url}")
        if date:
            parts.append(f"**Date**: {date}")
        if body:
            parts.append(f"\n{body}")
        parts.append("")  # blank line

    return "\n".join(parts)


def format_results_json(results):
    """Format search results as JSON."""
    return json.dumps(results, indent=2, ensure_ascii=False)


def main():
    setup_encoding()
    check_dependencies()

    parser = argparse.ArgumentParser(
        description="Search the web via DuckDuckGo"
    )
    parser.add_argument("query", help="Search query")
    parser.add_argument("--max-results", type=int, default=10,
                        help="Number of results (default: 10)")
    parser.add_argument("--region", type=str, default="wt-wt",
                        help="Region code, e.g. cn-zh, us-en, jp-jp (default: wt-wt)")
    parser.add_argument("--news", action="store_true",
                        help="Search news instead of general web")
    parser.add_argument("--json", action="store_true",
                        help="Output as JSON instead of Markdown")

    args = parser.parse_args()

    query = args.query.strip()
    if not query:
        print("Error: empty query", file=sys.stderr)
        sys.exit(1)

    print(f"Searching: {query} (region={args.region}, max={args.max_results})", file=sys.stderr)

    try:
        if args.news:
            results = search_news(query, args.max_results, args.region)
        else:
            results = search_text(query, args.max_results, args.region)
    except Exception as e:
        print(f"Error: search failed: {e}", file=sys.stderr)
        sys.exit(1)

    if not results:
        print(f"No results found for: {query}")
        sys.exit(0)

    print(f"Got {len(results)} results", file=sys.stderr)

    if args.json:
        print(format_results_json(results))
    else:
        print(format_results_markdown(results, query, is_news=args.news))


if __name__ == "__main__":
    main()
