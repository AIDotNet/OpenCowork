---
name: browser-session-crawler
description: Crawl websites using your logged-in Chrome/Edge browser session. Automatically reuses existing login state; if not logged in, shows a popup to remind you to login, then continues automatically. Ideal for sites requiring authentication (social media, communities, admin panels, etc.).
compatibility: Requires Python 3.8+. Dependencies: playwright (pip install playwright && playwright install chromium)
---

# Browser Session Crawler

Crawl websites using your system's logged-in Chrome/Edge browser session.

## Core Features

- **🔐 Automatic Session Reuse** - Uses Chrome/Edge user data directory, no need to login again
- **⏳ Login Reminder** - Detects unauthenticated state, shows popup reminder, continues after login
- **🌐 Real Browser Environment** - Non-headless mode, fewer anti-bot detections
- **📱 Pre-built Crawlers** - Ready-to-use scripts for Xiaohongshu (Redbook), Zhihu, and more

## Installation

```bash
pip install playwright
playwright install chromium
```

## Quick Start

### Xiaohongshu Crawler (Recommended)

```bash
# Search for beach beauty photos
python scripts/xiaohongshu.py "beach beauty" --count 20

# Search for any keyword
python scripts/xiaohongshu.py "your keyword"
```

**Parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `keyword` | ✅ | Search keyword |
| `--count` | No | Number of items to crawl (default: 20) |
| `--save` | No | Directory to save images |

**Examples:**

```bash
# Crawl 50 beach beauty photos, save to imgs folder
python scripts/xiaohongshu.py "beach beauty" --count 50 --save imgs
```

### Generic Crawler

```bash
python scripts/crawl.py "target_URL" --logged-indicator "login_indicator" --selector "css_selector"
```

| Parameter | Required | Description |
|-----------|----------|-------------|
| `target_url` | ✅ | Target page URL |
| `--logged-indicator` | ✅ | CSS selector that appears only after login |
| `--selector` | No | CSS selector for elements to extract |
| `--wait` | No | Seconds to wait after page load (default: 3) |
| `--scroll` | No | Scroll page to trigger lazy loading |
| `--max-length` | No | Maximum character count for output |
| `--save` | No | Save output to file |

## Pre-built Scripts

| Script | Function | Example |
|--------|----------|---------|
| `xiaohongshu.py` | Xiaohongshu search crawler | `python scripts/xiaohongshu.py "food"` |
| `crawl.py` | Generic webpage crawler | `python scripts/crawl.py "url" --logged-indicator "..."` |
| `example_zhihu.py` | Zhihu crawler example | - |

## Common Site Configurations

### Xiaohongshu (Redbook)

```bash
# Search page crawling (auto extracts images)
python scripts/xiaohongshu.py "beach beauty"

# Generic method
python scripts/crawl.py "https://www.xiaohongshu.com/search_result?keyword=beauty" --logged-indicator ".user-avatar" --selector ".note-item"
```

### Zhihu

```bash
python scripts/crawl.py "https://www.zhihu.com/topic/19550517/hot" --logged-indicator ".AppHeader-profile" --selector ".List-item" --scroll
```

### Weibo

```bash
python scripts/crawl.py "https://weibo.com/hot/search" --logged-indicator ".user-name" --selector ".list_pub" --scroll
```

## Login Detection

Uses `--logged-indicator` selector to detect login state:
- Element found → Logged in, proceed with crawling
- Timeout (not found) → Show login reminder → Continue after login

**Common Login Indicators:**

| Site | Selector |
|------|----------|
| Xiaohongshu | `.user-avatar`, `.profile-avatar`, `.user-name` |
| Zhihu | `.AppHeader-profile`, `.UserAvatar` |
| LinkedIn | `.global-nav__me-wrapper` |
| Weibo | `.user-name`, `.m-text-cut` |

## Workflow

```
1. Detect system browser user data directory
       ↓
2. Launch Chromium (reuse logged-in session)
       ↓
3. Navigate to target page
       ↓
4. Check login status
       ↓
   ┌─────────────┐
   │  Logged in? │
   └─────────────┘
      ↓       ↓
    Yes       No
      ↓       ↓
   Crawl  Show login reminder
      ↓       ↓
   Save results
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Browser launch failed | Check if Chrome/Edge is currently using user data directory |
| Login detection failed | Adjust `--logged-indicator` to correct selector |
| Empty content | Increase `--wait 5` or add `--scroll` |
| Page stuck | Try `--headless` mode (may not support login) |
