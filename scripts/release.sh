#!/bin/bash
# OpenCowork 快速发布脚本 (Linux/macOS/Git Bash)
# 用法: ./scripts/release.sh <版本号>
# 示例: ./scripts/release.sh 0.9.117

set -e

VERSION=$1

# 检查版本号参数
if [ -z "$VERSION" ]; then
  echo "❌ 用法: ./scripts/release.sh <版本号>"
  echo "   示例: ./scripts/release.sh 0.9.117"
  echo ""
  echo "注意: 版本号不要带 v 前缀（脚本会自动添加）"
  exit 1
fi

# 检查版本号格式
if ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "❌ 版本号格式错误: $VERSION"
  echo "   正确格式: 0.9.117 (major.minor.patch)"
  exit 1
fi

echo "📦 OpenCowork 快速发布工具"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🏷️  目标版本: v$VERSION"
echo ""

# 检查必要工具
echo "🔍 检查环境..."
if ! command -v git &> /dev/null; then
  echo "❌ 未找到 git，请先安装"
  exit 1
fi

if ! command -v npm &> /dev/null; then
  echo "❌ 未找到 npm，请先安装 Node.js"
  exit 1
fi

if ! command -v gh &> /dev/null; then
  echo "⚠️  未找到 gh CLI，将跳过自动创建 Release"
  echo "   安装: https://cli.github.com/"
  SKIP_GH=true
else
  SKIP_GH=false
  # 检查 GitHub 登录状态
  if ! gh auth status &> /dev/null; then
    echo "❌ 未登录 GitHub，请先运行: gh auth login"
    exit 1
  fi
fi

# 检查当前分支
BRANCH=$(git branch --show-current)
echo "📍 当前分支: $BRANCH"

# 检查是否有未提交的更改
if [ -n "$(git status --porcelain)" ]; then
  echo "⚠️  工作区有未提交的更改，请先提交或暂存"
  echo ""
  git status --short
  echo ""
  read -p "是否继续？(y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "❌ 已取消"
    exit 1
  fi
fi

echo ""
echo "📋 发布前检查..."

# 1. 类型检查
echo "  [1/3] 运行类型检查..."
if ! npm run typecheck; then
  echo "❌ 类型检查失败，请修复后再发布"
  exit 1
fi
echo "  ✅ 类型检查通过"

# 2. 更新版本号
echo "  [2/3] 更新版本号到 $VERSION..."
npm version $VERSION --no-git-tag-version
echo "  ✅ 版本号已更新"

# 3. 提交版本变更
echo "  [3/3] 提交版本变更..."
git add package.json
git commit -m "chore(release): bump version to $VERSION"
git push origin "$BRANCH"
echo "  ✅ 已推送到远程"

echo ""

# 4. 创建 GitHub Release
if [ "$SKIP_GH" = false ]; then
  echo "🚀 创建 GitHub Release..."
  
  # 生成 Release Notes
  TAG="v$VERSION"
  
  gh release create "$TAG" \
    --title "Release $TAG" \
    --target "$BRANCH" \
    --generate-notes \
    --verify-tag
  
  echo "✅ Release 已创建: https://github.com/smawatch/OpenCowork/releases/tag/$TAG"
  echo ""
  echo "🔨 CI/CD 正在自动构建..."
  echo "   查看进度: https://github.com/smawatch/OpenCowork/actions"
  echo ""
  echo "⏱️  预计构建时间: 20-40 分钟"
  echo ""
  echo "📦 构建完成后将自动上传以下平台:"
  echo "   • Windows (x64/arm64)"
  echo "   • Linux (x64/arm64)"
  echo "   • macOS (arm64/x64)"
else
  echo "🚀 请手动创建 GitHub Release:"
  echo ""
  echo "   1. 访问: https://github.com/smawatch/OpenCowork/releases/new"
  echo "   2. Tag version: v$VERSION"
  echo "   3. Release title: Release v$VERSION"
  echo "   4. 填写更新说明"
  echo "   5. 点击 Publish release"
  echo ""
  echo "   或使用 GitHub CLI:"
  echo "   gh release create v$VERSION --title \"Release v$VERSION\" --target $BRANCH --generate-notes"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ 发布流程已完成!"
echo ""
echo "📝 后续步骤:"
echo "  1. 监控 CI/CD 构建进度"
echo "  2. 检查 Release Assets 是否完整"
echo "  3. 下载一个安装包本地测试"
echo "  4. 验证客户端能否检测到更新"
