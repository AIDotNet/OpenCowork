---
name: xiaohongshu-search
description: Search Xiaohongshu (Rednote) by keyword and extract note image URLs and titles with Playwright. Use when the user wants 小红书搜索结果抓取、图片链接提取或标题采集导出。Supports terminal JSON output and optional local text export.
compatibility: Requires Python 3 and playwright. Run `playwright install chromium` before first use.
---

# Xiaohongshu Search

Extract searchable content from Xiaohongshu using one local script.

## When to use this skill

- 用户要按关键词搜索小红书内容
- 用户要批量提取搜索结果中的图片链接
- 用户要导出搜索结果标题做后续选题或分析
- 用户需要一个可重复执行的本地抓取流程

## Scripts overview

| Script              | Purpose                              | Dependencies |
| ------------------- | ------------------------------------ | ------------ |
| `scripts/search.py` | 打开小红书搜索页并提取图片链接与标题 | `playwright` |

## Setup

### 1. Verify Python

```bash
python --version
```

### 2. Install dependencies (first run)

```bash
pip install playwright
playwright install chromium
```

> Critical error recovery: if a command fails with missing dependency/browser errors, install the missing dependency, then rerun the exact same command.

## Usage

### Basic search

```bash
python scripts/search.py "AI"
```

### Limit extracted items

```bash
python scripts/search.py "AI" --count 30
```

### Save output files

```bash
python scripts/search.py "AI" --count 30 --save ./output
```

## Parameters

- `keyword` (required): 搜索关键词
- `--count` (optional): 最多提取条数，默认 `20`
- `--save` (optional): 本地输出目录

## Output

### Terminal output

Script prints JSON at the end:

```json
{
  "keyword": "AI",
  "images": ["https://..."],
  "titles": ["..."],
  "count": 20
}
```

### Files (when `--save` is used)

- `<keyword>_links.txt`: 图片链接列表
- `<keyword>_titles.txt`: 标题列表（有标题时写入）

## Execution behavior

- 脚本会打开浏览器并访问小红书搜索页
- 如果未登录，会提示手动登录并等待
- 会自动滚动页面加载更多结果后再提取
- 仅做搜索结果层面的链接/标题采集，不抓取详情页评论线程

## Limits and edge cases

- 小红书页面结构变更可能导致选择器失效，需要更新 `scripts/search.py`
- 登录、验证码、风控策略可能影响抓取成功率
- 不同关键词返回结构不一致，标题可能为空或数量少于图片
- 脚本使用可视化浏览器流程，不是纯无头 API 调用

## Out of scope

This skill does **not** provide the following capabilities in current repository state:

- 发布图文/视频
- 点赞、评论、回复、收藏
- MCP server tool calls
- 登录脚本、封面生成器、智能发布脚本

## Script reference

- [search.py](scripts/search.py): Xiaohongshu keyword search extractor
