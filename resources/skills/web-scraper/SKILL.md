---
name: web-scraper
description: Scrape web pages, search the internet, and extract structured content using Python. Use when the user wants to fetch a webpage, search for information online, extract links, or crawl JavaScript-rendered dynamic pages.
compatibility: Requires Python 3. Lightweight mode needs requests, beautifulsoup4, readability-lxml, html2text. Dynamic mode needs crawl4ai. Search needs duckduckgo-search.
---

# Web Scraper

Fetch, search, and extract content from websites.

## When to use this skill

- User asks to fetch or read a webpage / URL
- User wants to search the internet for information
- User needs to extract links, tables, or structured data from a website
- User asks to crawl a JavaScript-rendered (dynamic) page
- User wants web content converted to clean Markdown for analysis

## Scripts overview

| Script | Purpose | Dependencies |
|---|---|---|
| `fetch_page.py` | Fetch a URL and extract readable content as Markdown | `requests`, `beautifulsoup4`, `readability-lxml`, `html2text` |
| `search_web.py` | Search the web via DuckDuckGo | `ddgs` |
| `crawl_dynamic.py` | Crawl JS-rendered pages with a headless browser | `crawl4ai` |
| `extract_links.py` | Extract and categorize all links from a page | `requests`, `beautifulsoup4` |

## Steps

### 1. Install dependencies (first time only)

For lightweight scraping (static pages, search, link extraction):
```bash
pip install requests beautifulsoup4 readability-lxml html2text ddgs
```

For dynamic / JavaScript-rendered pages (heavier, installs Playwright + Chromium):
```bash
pip install crawl4ai
crawl4ai-setup
```

> **Note**: `crawl4ai-setup` downloads a Chromium browser (~150 MB). Only install if you actually need dynamic page support.

> **CRITICAL — Dependency Error Recovery**: If ANY script below fails with an `ImportError` or "module not found" error, install the missing dependencies using the command above, then **re-run the EXACT SAME script command that failed**. Do NOT write inline Python code (`python -c "..."`) or your own ad-hoc scripts as a substitute. These scripts handle encoding, error handling, and output formatting that inline code will miss.

### 2. Fetch a web page (static — recommended first choice)

Use this for most websites. It's fast, lightweight, and works for articles, docs, blogs, etc.

**On Linux/macOS (bash):**
```bash
python ~/.open-cowork/skills/web-scraper/scripts/fetch_page.py "URL"
```
**On Windows (PowerShell) — you MUST use the expanded absolute path, NOT `$HOME` or `$Env:USERPROFILE` inside quotes:**
```powershell
python "C:\Users\USERNAME\.open-cowork\skills\web-scraper\scripts\fetch_page.py" "URL"
```
**IMPORTANT:** Replace `USERNAME` with the actual Windows username. You can discover it via `$Env:USERPROFILE` or `whoami` first, then construct the full path as a plain string.

Options:
- `--raw` — Output full page Markdown instead of extracted article content
- `--selector "CSS_SELECTOR"` — Extract only elements matching the CSS selector (e.g. `".article-body"`, `"table"`, `"#content"`)
- `--save OUTPUT_PATH` — Also save output to a file
- `--max-length N` — Truncate output to N characters (default: no limit)

Examples:
```bash
# Fetch an article
python fetch_page.py "https://example.com/article"

# Extract only tables
python fetch_page.py "https://example.com/data" --selector "table"

# Fetch raw full-page markdown, limit to 5000 chars
python fetch_page.py "https://example.com" --raw --max-length 5000
```

### 3. Search the web

Search using DuckDuckGo (no API key required).

**On Linux/macOS:**
```bash
python ~/.open-cowork/skills/web-scraper/scripts/search_web.py "search query"
```
**On Windows (PowerShell) — use the expanded absolute path:**
```powershell
python "C:\Users\USERNAME\.open-cowork\skills\web-scraper\scripts\search_web.py" "search query"
```
**IMPORTANT:** Replace `USERNAME` with the actual Windows username. Discover it via `$Env:USERPROFILE` or `whoami` first.

Options:
- `--max-results N` — Number of results to return (default: 10)
- `--region REGION` — Region code, e.g. `cn-zh`, `us-en`, `jp-jp` (default: `wt-wt` for worldwide)
- `--news` — Search news instead of general web

Examples:
```bash
# General search
python search_web.py "Python web scraping best practices 2025"

# News search, Chinese region, 5 results
python search_web.py "AI 最新进展" --news --region cn-zh --max-results 5
```

### 4. Crawl a dynamic / JavaScript-rendered page

Use this only when `fetch_page.py` returns empty or incomplete content (SPA, React/Vue apps, pages that load content via JS).

**On Linux/macOS:**
```bash
python ~/.open-cowork/skills/web-scraper/scripts/crawl_dynamic.py "URL"
```
**On Windows (PowerShell) — use the expanded absolute path:**
```powershell
python "C:\Users\USERNAME\.open-cowork\skills\web-scraper\scripts\crawl_dynamic.py" "URL"
```
**IMPORTANT:** Replace `USERNAME` with the actual Windows username.

Options:
- `--wait N` — Wait N seconds after page load for JS to finish (default: 3)
- `--selector "CSS_SELECTOR"` — Wait for a specific element to appear before extracting
- `--scroll` — Scroll to bottom of page to trigger lazy loading
- `--save OUTPUT_PATH` — Also save output to a file
- `--max-length N` — Truncate output to N characters

### 5. Extract links from a page

Extract all links with their text labels, categorized by type (internal, external, resource).

**On Linux/macOS:**
```bash
python ~/.open-cowork/skills/web-scraper/scripts/extract_links.py "URL"
```
**On Windows (PowerShell) — use the expanded absolute path:**
```powershell
python "C:\Users\USERNAME\.open-cowork\skills\web-scraper\scripts\extract_links.py" "URL"
```
**IMPORTANT:** Replace `USERNAME` with the actual Windows username.

Options:
- `--filter PATTERN` — Only show links matching a regex pattern (applied to URL)
- `--external-only` — Only show external links
- `--json` — Output as JSON instead of Markdown

## Decision guide: which script to use

1. **Start with `fetch_page.py`** — handles 90% of websites (articles, docs, blogs, wikis).
2. If `fetch_page.py` returns empty/garbled content → try **`crawl_dynamic.py`** (the page likely needs JavaScript).
3. Need to find URLs first? → Use **`search_web.py`** to discover relevant pages.
4. Need to navigate a site structure? → Use **`extract_links.py`** to map out links, then fetch individual pages.

## Common workflows

### Research a topic
1. `search_web.py "topic"` → get relevant URLs
2. `fetch_page.py "best_url"` → read the content
3. Repeat for multiple sources, then synthesize

### Scrape structured data from a page
1. `fetch_page.py "url" --selector "table"` → extract tables
2. Or `fetch_page.py "url" --selector ".product-card"` → extract specific elements

### Crawl a modern web app (SPA)
1. `crawl_dynamic.py "url" --wait 5 --scroll` → full JS-rendered content

## Edge cases

- **Paywalled sites**: May return partial content or login pages. Inform the user.
- **Rate limiting / CAPTCHAs**: If requests fail with 403/429, wait and retry or inform the user.
- **Very large pages**: Use `--max-length` to truncate output and avoid overwhelming the context window.
- **Encoding issues**: Scripts handle UTF-8 by default. Exotic encodings may need manual adjustment.
- **Robots.txt**: These scripts do not check robots.txt. Use responsibly and respect website terms of service.

## Scripts

- [fetch_page.py](scripts/fetch_page.py) — Fetch and extract readable content as Markdown
- [search_web.py](scripts/search_web.py) — Search the web via DuckDuckGo
- [crawl_dynamic.py](scripts/crawl_dynamic.py) — Crawl JavaScript-rendered pages
- [extract_links.py](scripts/extract_links.py) — Extract and categorize page links
