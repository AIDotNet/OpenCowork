#!/usr/bin/env python3
"""Crawl JavaScript-rendered (dynamic) web pages using Crawl4AI.

Uses a headless Chromium browser to render pages that require JavaScript,
then extracts clean Markdown content. Use this when fetch_page.py returns
empty or incomplete content (SPAs, React/Vue apps, etc.).

Dependencies: pip install crawl4ai && crawl4ai-setup
"""

import sys
import argparse
import asyncio


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
    """Check that Crawl4AI is installed."""
    try:
        import crawl4ai  # noqa: F401
    except ImportError:
        print("Error: crawl4ai not installed.", file=sys.stderr)
        print("Install with:", file=sys.stderr)
        print("  pip install crawl4ai", file=sys.stderr)
        print("  crawl4ai-setup", file=sys.stderr)
        sys.exit(1)


async def crawl_page(url, wait_seconds=3, css_selector=None, scroll=False):
    """Crawl a page with headless browser and return Markdown content."""
    from crawl4ai import AsyncWebCrawler, BrowserConfig, CrawlerRunConfig, CacheMode
    from crawl4ai.content_filter_strategy import PruningContentFilter
    from crawl4ai.markdown_generation_strategy import DefaultMarkdownGenerator

    browser_conf = BrowserConfig(
        headless=True,
        verbose=False,
    )

    md_generator = DefaultMarkdownGenerator(
        content_filter=PruningContentFilter(threshold=0.4, threshold_type="fixed")
    )

    run_conf = CrawlerRunConfig(
        cache_mode=CacheMode.BYPASS,
        markdown_generator=md_generator,
        page_timeout=60000,  # 60s
        wait_until="networkidle",
    )

    # Add wait time if specified
    if wait_seconds > 0:
        run_conf.delay_before_return_html = wait_seconds

    # Wait for specific CSS selector
    if css_selector:
        run_conf.wait_for = f"css:{css_selector}"

    async with AsyncWebCrawler(config=browser_conf) as crawler:
        result = await crawler.arun(url=url, config=run_conf)

        if not result.success:
            return None, result.error_message or "Unknown error"

        # Get the best available markdown
        md = ""
        if result.markdown:
            if hasattr(result.markdown, 'fit_markdown') and result.markdown.fit_markdown:
                md = result.markdown.fit_markdown
            elif hasattr(result.markdown, 'raw_markdown') and result.markdown.raw_markdown:
                md = result.markdown.raw_markdown
            elif isinstance(result.markdown, str):
                md = result.markdown

        title = ""
        if hasattr(result, 'metadata') and result.metadata:
            title = result.metadata.get('title', '')

        return {
            "title": title,
            "url": result.url or url,
            "markdown": md,
            "status_code": getattr(result, 'status_code', None),
        }, None


async def crawl_with_scroll(url, wait_seconds=3, css_selector=None):
    """Crawl with infinite scroll support."""
    from crawl4ai import AsyncWebCrawler, BrowserConfig, CrawlerRunConfig, CacheMode
    from crawl4ai.markdown_generation_strategy import DefaultMarkdownGenerator
    from crawl4ai.content_filter_strategy import PruningContentFilter

    browser_conf = BrowserConfig(
        headless=True,
        verbose=False,
    )

    # JavaScript to scroll to bottom
    scroll_js = """
    async () => {
        await new Promise((resolve) => {
            let totalHeight = 0;
            const distance = 500;
            const timer = setInterval(() => {
                const scrollHeight = document.body.scrollHeight;
                window.scrollBy(0, distance);
                totalHeight += distance;
                if (totalHeight >= scrollHeight) {
                    clearInterval(timer);
                    resolve();
                }
            }, 300);
            // Safety timeout
            setTimeout(() => { clearInterval(timer); resolve(); }, 15000);
        });
    }
    """

    md_generator = DefaultMarkdownGenerator(
        content_filter=PruningContentFilter(threshold=0.4, threshold_type="fixed")
    )

    run_conf = CrawlerRunConfig(
        cache_mode=CacheMode.BYPASS,
        markdown_generator=md_generator,
        page_timeout=60000,
        js_code=scroll_js,
        wait_until="networkidle",
    )

    if wait_seconds > 0:
        run_conf.delay_before_return_html = wait_seconds

    if css_selector:
        run_conf.wait_for = f"css:{css_selector}"

    async with AsyncWebCrawler(config=browser_conf) as crawler:
        result = await crawler.arun(url=url, config=run_conf)

        if not result.success:
            return None, result.error_message or "Unknown error"

        md = ""
        if result.markdown:
            if hasattr(result.markdown, 'fit_markdown') and result.markdown.fit_markdown:
                md = result.markdown.fit_markdown
            elif hasattr(result.markdown, 'raw_markdown') and result.markdown.raw_markdown:
                md = result.markdown.raw_markdown
            elif isinstance(result.markdown, str):
                md = result.markdown

        title = ""
        if hasattr(result, 'metadata') and result.metadata:
            title = result.metadata.get('title', '')

        return {
            "title": title,
            "url": result.url or url,
            "markdown": md,
            "status_code": getattr(result, 'status_code', None),
        }, None


def main():
    setup_encoding()
    check_dependencies()

    parser = argparse.ArgumentParser(
        description="Crawl JavaScript-rendered pages with headless browser"
    )
    parser.add_argument("url", help="URL to crawl")
    parser.add_argument("--wait", type=int, default=3,
                        help="Seconds to wait after page load (default: 3)")
    parser.add_argument("--selector", type=str, default=None,
                        help="CSS selector to wait for before extracting")
    parser.add_argument("--scroll", action="store_true",
                        help="Scroll to bottom to trigger lazy loading")
    parser.add_argument("--save", type=str, default=None,
                        help="Also save output to this file path")
    parser.add_argument("--max-length", type=int, default=None,
                        help="Truncate output to N characters")

    args = parser.parse_args()

    url = args.url.strip()
    if not url.startswith(("http://", "https://")):
        url = "https://" + url

    print(f"Crawling (dynamic): {url}", file=sys.stderr)
    print(f"Options: wait={args.wait}s, selector={args.selector}, scroll={args.scroll}", file=sys.stderr)

    # Run async crawl
    if args.scroll:
        data, error = asyncio.run(crawl_with_scroll(url, args.wait, args.selector))
    else:
        data, error = asyncio.run(crawl_page(url, args.wait, args.selector))

    if error:
        print(f"Error: crawl failed: {error}", file=sys.stderr)
        sys.exit(1)

    if not data or not data["markdown"]:
        print("Warning: no content extracted from page", file=sys.stderr)
        print("[No content could be extracted from this page]")
        sys.exit(0)

    # Build output
    parts = []
    if data["title"]:
        parts.append(f"# {data['title']}\n")
    parts.append(f"**Source**: {data['url']}")
    if data.get("status_code"):
        parts.append(f"**Status**: {data['status_code']}")
    parts.append("\n---\n")
    parts.append(data["markdown"])

    output = "\n".join(parts)

    # Truncate if requested
    if args.max_length and len(output) > args.max_length:
        output = output[:args.max_length] + f"\n\n[... truncated at {args.max_length} characters, total {len(output)}]"

    print(output)

    content_len = len(data["markdown"])
    print(f"\nExtracted: {content_len} characters (dynamic crawl)", file=sys.stderr)

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
