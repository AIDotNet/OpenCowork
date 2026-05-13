---
description: Post tweets to X.com (Twitter) using the system browser's login state
---

# Post to X

Automatically post tweets to X.com (Twitter) using the system Edge/Chrome browser's login state.

## Features

- **Automatic login state reuse** - Directly uses system browser user data, no need to log in each time
- **Smart login detection** - Automatically detects login status, prompts user if not logged in
- **Multi-line content support** - Can post tweets containing line breaks
- **Edge/Chrome compatible** - Prefers Edge, falls back to Chrome

## Prerequisites

```bash
pip install playwright
playwright install chromium
```

## Usage

### Basic usage

```bash
python scripts/post_to_x.py "Your tweet content"
```

### Multi-line content

```bash
python scripts/post_to_x.py "First line\nSecond line\n#hashtag"
```

### Examples

```bash
# Simple tweet
python scripts/post_to_x.py "Hello X! 👋"

# Multi-line tweet
python scripts/post_to_x.py "🚀 New product launch!\n\n✨ Feature 1: xxx\n✨ Feature 2: yyy\n\n#ProductLaunch #NewFeature"
```

## Workflow

1. Close any running Edge/Chrome browser
2. Script reads system browser user data directory
3. Launches browser and navigates to x.com
4. Detects login status (skips if already logged in)
5. Opens the tweet compose interface
6. Enters content and posts

## First-time usage

If using for the first time:

1. Close all Edge browser windows
2. Run the script, it will prompt for login
3. Log in to X.com in the pop-up browser
4. After successful login, the script continues automatically
5. Next time you use it, the login state is already saved, no need to log in again

## Troubleshooting

| Issue                        | Solution                                       |
| ---------------------------- | ---------------------------------------------- |
| Prompts for login every time | Close Edge browser before running the script   |
| Post button click fails      | Script automatically uses JavaScript click     |
| Page load timeout            | Check network connection, or add `--wait` flag |

## Technical details

- Uses Playwright to control Chromium
- Directly reads `%LOCALAPPDATA%\Microsoft\Edge\User Data`
- Login credentials are saved in the original browser data
- Supports Windows systems
