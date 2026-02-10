# OpenCowork

<div align="center">

**AI 驱动的协作开发平台**

[![许可证](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Electron](https://img.shields.io/badge/Electron-36+-blue.svg)](https://electronjs.org/)
[![React](https://img.shields.io/badge/React-19+-blue.svg)](https://reactjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5+-blue.svg)](https://typescriptlang.org/)

一款基于 Electron 的桌面应用程序，结合 AI 智能体与开发工具，提供智能编程辅助和项目协作功能。

</div>

## ✨ 功能特性

### 🤖 AI 智能体系统
- **多提供商支持**: 兼容 OpenAI、Anthropic Claude 及其他 LLM 提供商
- **智能体循环架构**: 高级智能体工作流，支持工具执行和审批系统
- **子智能体框架**: 专门的代码审查、搜索和规划智能体
- **实时流式传输**: 实时响应流式传输，支持 token 使用量跟踪

### 💻 开发工具
- **文件系统操作**: 完整的文件和目录管理
- **代码搜索**: 基于 ripgrep 的高级代码库搜索
- **Bash 执行**: 安全的命令执行，配备审批工作流
- **任务管理**: 内置待办事项列表和项目跟踪

### 🎨 现代化 UI/UX
- **三种工作模式**: 聊天、协作和编码模式，适应不同工作流程
- **响应式布局**: 自适应侧边栏和面板系统
- **深色/浅色主题**: 完整的主题支持，自动检测系统设置
- **键盘快捷键**: 为高级用户提供的全面快捷键系统

### 🔧 高级功能
- **会话管理**: 多个聊天会话，支持固定和导出
- **权限系统**: 工具审批工作流，确保安全性
- **上下文感知**: 工作文件夹和项目上下文跟踪
- **产物管理**: 生成代码和文件处理

## 🚀 快速开始

### 环境要求
- Node.js 18+
- npm、yarn 或 bun

### 安装

```bash
# 克隆仓库
git clone https://github.com/your-username/OpenCowork.git
cd OpenCowork

# 安装依赖
npm install
# 或者
yarn install
# 或者
bun install
```

### 开发

```bash
# 启动开发服务器（支持热重载）
npm run dev
# 或者
yarn dev
```

### 构建

```bash
# 类型检查并构建生产版本
npm run build

# 平台特定构建
npm run build:win    # Windows
npm run build:mac    # macOS  
npm run build:linux  # Linux
```

## 📁 项目结构

```
OpenCowork/
├── src/
│   ├── main/                 # Electron 主进程
│   │   ├── ipc/             # IPC 处理器
│   │   └── index.ts         # 主入口点
│   ├── preload/              # 预加载脚本
│   └── renderer/             # React 前端
│       ├── src/
│       │   ├── components/   # UI 组件
│       │   ├── lib/         # 核心库
│       │   │   ├── agent/   # AI 智能体系统
│       │   │   ├── api/     # LLM 提供商
│       │   │   ├── tools/   # 开发工具
│       │   │   └── ipc/     # IPC 客户端
│       │   ├── stores/      # 状态管理
│       │   └── hooks/       # React 钩子
├── resources/               # 应用资源
├── build/                   # 构建配置
└── docs/                    # 文档
```

## 🛠️ 技术栈

### 核心框架
- **Electron** - 跨平台桌面应用程序框架
- **React 19** - 具备最新特性的现代 UI 库
- **TypeScript 5** - 类型安全开发
- **Vite** - 快速构建工具和开发服务器

### UI 与样式
- **Tailwind CSS 4** - 实用优先的 CSS 框架
- **Radix UI** - 无障碍组件原语
- **Lucide React** - 精美图标集
- **Motion** - 流畅动画和过渡效果

### 状态管理
- **Zustand** - 轻量级状态管理
- **Immer** - 不可变状态更新

### 开发工具
- **ESLint + Prettier** - 代码质量和格式化
- **Electron Builder** - 应用程序打包
- **Electron Updater** - 自动更新功能

## ⚙️ 配置

### API 提供商
在设置中配置您偏好的 LLM 提供商：

1. 打开应用程序
2. 按 `Ctrl+,` 打开设置
3. 输入您的 API 密钥
4. 选择您偏好的提供商

### 工作目录
进行文件操作和代码上下文：
- 使用 `Ctrl+Shift+O` 选择工作文件夹
- 或在界面中使用文件夹选择器

## 🎯 使用模式

### 💬 聊天模式
- 对话式 AI 交互
- 快速问答
- 一般协助

### 🤝 协作模式  
- 协作开发
- 文件操作和项目管理
- 工具执行（配备审批工作流）

### 💻 编码模式
- 专注编程辅助
- 代码审查和分析
- 高级开发工具

## ⌨️ 键盘快捷键

| 快捷键 | 操作 |
|--------|------|
| `Ctrl+N` | 新建会话 |
| `Ctrl+Shift+N` | 在下一模式中新建会话 |
| `Ctrl+1/2/3` | 切换到聊天/协作/编码模式 |
| `Ctrl+B` | 切换左侧边栏 |
| `Ctrl+Shift+B` | 切换右侧面板 |
| `Ctrl+L` | 清除当前对话 |
| `Ctrl+D` | 复制当前会话 |
| `Ctrl+P` | 固定/取消固定当前会话 |
| `Ctrl+Shift+C` | 复制对话为 Markdown |
| `Ctrl+Shift+E` | 导出当前对话 |
| `Ctrl+Shift+S` | 备份所有会话 |
| `Ctrl+Shift+O` | 从备份导入会话 |
| `Ctrl+Shift+A` | 切换自动审批工具 |
| `Ctrl+Shift+D` | 切换深色/浅色主题 |
| `Ctrl+/` | 显示键盘快捷键 |
| `Escape` | 停止流式传输 |

## 🔒 安全性

- **工具审批系统**: 所有工具执行都需要明确审批
- **安全 API 存储**: API 密钥存储在安全的主进程中
- **沙盒执行**: 文件操作限制在选定目录
- **权限控制**: 对工具访问的细粒度控制

## 🤝 贡献

我们欢迎贡献！请查看我们的[贡献指南](CONTRIBUTING.md)了解详情。

### 开发设置
1. Fork 仓库
2. 创建功能分支
3. 进行更改
4. 运行测试和代码检查
5. 提交拉取请求

### 代码风格
- 遵循现有的 TypeScript 和 React 模式
- 使用 Prettier 进行格式化
- 确保 ESLint 通过
- 为所有代码添加适当的类型

## 📝 许可证

本项目采用 MIT 许可证 - 详情请参阅 [LICENSE](LICENSE) 文件。

## 🙏 致谢

- [Electron](https://electronjs.org/) - 跨平台桌面框架
- [React](https://reactjs.org/) - UI 库
- [Tailwind CSS](https://tailwindcss.com/) - CSS 框架
- [Radix UI](https://www.radix-ui.com/) - 组件原语
- 所有贡献者和支持者

---

<div align="center">

**为开发者社区用 ❤️ 打造**

[![GitHub stars](https://img.shields.io/github/stars/your-username/OpenCowork.svg?style=social&label=Star)](https://github.com/your-username/OpenCowork)
[![GitHub forks](https://img.shields.io/github/forks/your-username/OpenCowork.svg?style=social&label=Fork)](https://github.com/your-username/OpenCowork)

</div>
