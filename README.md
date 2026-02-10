# OpenCowork

<div align="center">

**AI-Powered Collaborative Development Platform**

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Electron](https://img.shields.io/badge/Electron-36+-blue.svg)](https://electronjs.org/)
[![React](https://img.shields.io/badge/React-19+-blue.svg)](https://reactjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5+-blue.svg)](https://typescriptlang.org/)

A sophisticated Electron-based desktop application that combines AI agents with development tools for intelligent coding assistance and project collaboration.

</div>

## ✨ Features

### 🤖 AI Agent System
- **Multi-Provider Support**: Compatible with OpenAI, Anthropic Claude, and other LLM providers
- **Agent Loop Architecture**: Advanced agentic workflow with tool execution and approval system
- **Sub-Agent Framework**: Specialized agents for code review, search, and planning
- **Real-time Streaming**: Live response streaming with token usage tracking

### 💻 Development Tools
- **File System Operations**: Complete file and directory management
- **Code Search**: Advanced codebase search with ripgrep integration
- **Bash Execution**: Secure command execution with approval workflow
- **Task Management**: Built-in todo list and project tracking

### 🎨 Modern UI/UX
- **Three Working Modes**: Chat, Cowork, and Code modes for different workflows
- **Responsive Layout**: Adaptive sidebar and panel system
- **Dark/Light Themes**: Full theme support with system detection
- **Keyboard Shortcuts**: Comprehensive shortcut system for power users

### 🔧 Advanced Features
- **Session Management**: Multiple chat sessions with pinning and export
- **Permission System**: Tool approval workflow for security
- **Context Awareness**: Working folder and project context tracking
- **Artifact Management**: Generated code and file handling

## 🚀 Quick Start

### Prerequisites
- Node.js 18+ 
- npm, yarn, or bun

### Installation

```bash
# Clone the repository
git clone https://github.com/your-username/OpenCowork.git
cd OpenCowork

# Install dependencies
npm install
# or
yarn install
# or
bun install
```

### Development

```bash
# Start development server with hot reload
npm run dev
# or
yarn dev
```

### Building

```bash
# Type check and build for production
npm run build

# Platform-specific builds
npm run build:win    # Windows
npm run build:mac    # macOS  
npm run build:linux  # Linux
```

## 📁 Project Structure

```
OpenCowork/
├── src/
│   ├── main/                 # Electron main process
│   │   ├── ipc/             # IPC handlers
│   │   └── index.ts         # Main entry point
│   ├── preload/              # Preload scripts
│   └── renderer/             # React frontend
│       ├── src/
│       │   ├── components/   # UI components
│       │   ├── lib/         # Core libraries
│       │   │   ├── agent/   # AI agent system
│       │   │   ├── api/     # LLM providers
│       │   │   ├── tools/   # Development tools
│       │   │   └── ipc/     # IPC client
│       │   ├── stores/      # State management
│       │   └── hooks/       # React hooks
├── resources/               # App assets
├── build/                   # Build configuration
└── docs/                    # Documentation
```

## 🛠️ Technology Stack

### Core Framework
- **Electron** - Cross-platform desktop application framework
- **React 19** - Modern UI library with latest features
- **TypeScript 5** - Type-safe development
- **Vite** - Fast build tool and dev server

### UI & Styling
- **Tailwind CSS 4** - Utility-first CSS framework
- **Radix UI** - Accessible component primitives
- **Lucide React** - Beautiful icon set
- **Motion** - Smooth animations and transitions

### State Management
- **Zustand** - Lightweight state management
- **Immer** - Immutable state updates

### Development Tools
- **ESLint + Prettier** - Code quality and formatting
- **Electron Builder** - Application packaging
- **Electron Updater** - Auto-update functionality

## ⚙️ Configuration

### API Providers
Configure your preferred LLM provider in the settings:

1. Open the application
2. Press `Ctrl+,` to open settings
3. Enter your API key
4. Select your preferred provider

### Working Directory
For file operations and code context:
- Use `Ctrl+Shift+O` to select a working folder
- Or use the folder selector in the interface

## 🎯 Usage Modes

### 💬 Chat Mode
- Conversational AI interaction
- Quick questions and answers
- General assistance

### 🤝 Cowork Mode  
- Collaborative development
- File operations and project management
- Tool execution with approval workflow

### 💻 Code Mode
- Focused coding assistance
- Code review and analysis
- Advanced development tools

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+N` | New session |
| `Ctrl+Shift+N` | New session in next mode |
| `Ctrl+1/2/3` | Switch to Chat/Cowork/Code mode |
| `Ctrl+B` | Toggle left sidebar |
| `Ctrl+Shift+B` | Toggle right panel |
| `Ctrl+L` | Clear current conversation |
| `Ctrl+D` | Duplicate current session |
| `Ctrl+P` | Pin/unpin current session |
| `Ctrl+Shift+C` | Copy conversation as markdown |
| `Ctrl+Shift+E` | Export current conversation |
| `Ctrl+Shift+S` | Backup all sessions |
| `Ctrl+Shift+O` | Import sessions from backup |
| `Ctrl+Shift+A` | Toggle auto-approve tools |
| `Ctrl+Shift+D` | Toggle dark/light theme |
| `Ctrl+/` | Show keyboard shortcuts |
| `Escape` | Stop streaming |

## 🔒 Security

- **Tool Approval System**: All tool executions require explicit approval
- **Secure API Storage**: API keys stored in secure main process
- **Sandboxed Execution**: File operations limited to selected directories
- **Permission Controls**: Granular control over tool access

## 🤝 Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

### Development Setup
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests and linting
5. Submit a pull request

### Code Style
- Follow the existing TypeScript and React patterns
- Use Prettier for formatting
- Ensure ESLint passes
- Add appropriate types for all code

## 📝 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- [Electron](https://electronjs.org/) - Cross-platform desktop framework
- [React](https://reactjs.org/) - UI library
- [Tailwind CSS](https://tailwindcss.com/) - CSS framework
- [Radix UI](https://www.radix-ui.com/) - Component primitives
- All contributors and supporters

---

<div align="center">

**Built with ❤️ for the developer community**

[![GitHub stars](https://img.shields.io/github/stars/your-username/OpenCowork.svg?style=social&label=Star)](https://github.com/your-username/OpenCowork)
[![GitHub forks](https://img.shields.io/github/forks/your-username/OpenCowork.svg?style=social&label=Fork)](https://github.com/your-username/OpenCowork)

</div>
