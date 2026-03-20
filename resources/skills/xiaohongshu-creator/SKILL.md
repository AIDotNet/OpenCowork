---
name: xiaohongshu-creator
description: 小红书内容创作与发布工具，支持AI生成文案、自动配图、定时发布、评论互动等完整工作流。基于浏览器会话，需要先登录小红书账号。
compatibility: 需要 Python 3.8+。依赖: playwright, Pillow, cryptography。需先在浏览器中登录小红书。
---

# 小红书内容创作与发布

小红书(Redbook)内容创作、发布与互动工具。

## 核心功能

- AI文案生成 - 基于主题生成吸引人的小红书文案
- 封面生成 - 自动生成精美的笔记封面图
- 内容发布 - 支持图文笔记发布
- 定时发布 - 设置发布时间自动发布
- 评论互动 - 自动回复评论，增加粉丝互动

## 安装

```bash
pip install playwright pillow
playwright install chromium
```

## 使用方法

### 1. 检查登录状态

```bash
python scripts/publish.py status
```

### 2. 发布图文笔记

```bash
python scripts/publish.py publish "标题" "正文内容"
python scripts/publish.py publish "标题" "正文内容" --images "img1.jpg,img2.jpg"
```

### 3. 生成封面

```bash
python scripts/cover.py "标题" --output cover.jpg
```

### 4. 定时发布

```bash
python scripts/publish.py schedule "标题" "正文" --delay 7200
```

## 参数说明

| 参数     | 说明                      |
| -------- | ------------------------- |
| command  | publish, schedule, status |
| title    | 笔记标题                  |
| content  | 笔记正文                  |
| --images | 图片路径(逗号分隔)        |
| --tags   | 标签                      |
| --delay  | 延迟秒数                  |

## 注意事项

1. 养号权重: 建议新账号先养号1-2周再发布
2. 图片质量: 建议使用高清图片，最小宽度1080px
3. 敏感词检测: 发布前自动检测敏感词
4. 频率限制: 每天发布不超过5篇
