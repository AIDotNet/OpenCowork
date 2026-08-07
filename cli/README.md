# @opencowork/cli

OpenCowork 命令行工具源码。独立的 Node/TypeScript 包，不属于根目录 npm 依赖树。

## 开发

```bash
cd cli
npm install
npm run dev       # 直接用 tsx 运行 src/index.ts
npm run build      # 编译到 dist/
npm run typecheck  # 仅类型检查
```

## 目录结构

```
cli/
├── src/
│   └── index.ts   # CLI 入口
├── package.json
├── tsconfig.json
└── README.md
```
