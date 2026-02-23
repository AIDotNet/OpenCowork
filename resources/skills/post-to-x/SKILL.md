---
description: 发布推文到 X.com (Twitter)，使用系统浏览器登录状态
---

# Post to X

使用系统 Edge/Chrome 浏览器登录状态，自动发布推文到 X.com (Twitter)。

## 特点

- **自动复用登录状态** - 直接使用系统浏览器用户数据，无需每次登录
- **智能检测登录** - 自动检测是否已登录，未登录时提示用户
- **支持多行内容** - 可发布包含换行的完整推文
- **Edge/Chrome 兼容** - 优先使用 Edge，回退到 Chrome

## 前置要求

```bash
pip install playwright
playwright install chromium
```

## 使用方法

### 基本用法

```bash
python scripts/post_to_x.py "你的推文内容"
```

### 多行内容

```bash
python scripts/post_to_x.py "第一行\n第二行\n#标签"
```

### 示例

```bash
# 简单推文
python scripts/post_to_x.py "Hello X! 👋"

# 多行推文
python scripts/post_to_x.py "🚀 新品发布！\n\n✨ 功能1：xxx\n✨ 功能2：yyy\n\n#ProductLaunch #NewFeature"
```

## 工作流

1. 关闭正在运行的 Edge/Chrome 浏览器
2. 脚本读取系统浏览器用户数据目录
3. 启动浏览器并访问 x.com
4. 检测登录状态（已登录则跳过）
5. 打开发推界面
6. 输入内容并发布

## 首次使用

如果是第一次使用，需要：
1. 关闭所有 Edge 浏览器窗口
2. 运行脚本，会提示登录
3. 在弹出的浏览器中登录 X.com
4. 登录成功后脚本自动继续
5. 下次使用时登录状态已保留，无需重复登录

## 故障排除

| 问题 | 解决方案 |
|------|---------|
| 提示需要登录每次 | 关闭 Edge 浏览器后运行脚本 |
| 发布按钮点击失败 | 脚本会自动使用 JavaScript 点击 |
| 页面加载超时 | 检查网络连接，或增加 `--wait` 参数 |

## 技术细节

- 使用 Playwright 控制 Chromium
- 直接读取 `%LOCALAPPDATA%\Microsoft\Edge\User Data`
- 登录凭证保存在原始浏览器数据中
- 支持 Windows 系统
