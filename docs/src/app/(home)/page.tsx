import Link from 'next/link';
import { Github, ArrowRight, ExternalLink, Download } from 'lucide-react';

const platforms = [
  { name: 'Feishu', label: '飞书' },
  { name: 'DingTalk', label: '钉钉' },
  { name: 'Telegram', label: 'Telegram' },
  { name: 'Discord', label: 'Discord' },
  { name: 'WhatsApp', label: 'WhatsApp' },
  { name: 'WeCom', label: '企业微信' },
];

const downloads = [
  {
    platform: 'Windows',
    icon: '🪟',
    files: [
      { name: 'Windows Installer (.exe)', url: 'https://github.com/AIDotNet/OpenCowork/releases/latest/download/OpenCowork-Setup.exe' },
      { name: 'Portable (.zip)', url: 'https://github.com/AIDotNet/OpenCowork/releases/latest/download/OpenCowork-win.zip' },
    ],
  },
  {
    platform: 'macOS',
    icon: '🍎',
    files: [
      { name: 'Apple Silicon (.dmg)', url: 'https://github.com/AIDotNet/OpenCowork/releases/latest/download/OpenCowork-arm64.dmg' },
      { name: 'Intel (.dmg)', url: 'https://github.com/AIDotNet/OpenCowork/releases/latest/download/OpenCowork-x64.dmg' },
    ],
  },
  {
    platform: 'Linux',
    icon: '🐧',
    files: [
      { name: 'AppImage', url: 'https://github.com/AIDotNet/OpenCowork/releases/latest/download/OpenCowork.AppImage' },
      { name: 'Debian (.deb)', url: 'https://github.com/AIDotNet/OpenCowork/releases/latest/download/OpenCowork.deb' },
    ],
  },
];

const features = [
  {
    tag: '01',
    title: 'Agent 循环引擎',
    desc: '基于 AsyncGenerator 的流式 Agent 循环。每轮迭代自动执行工具调用、处理结果并决策是否继续，直到任务完成或达到最大轮次。支持中止信号与上下文压缩。',
    code: `// agent-loop.ts
async function* runAgentLoop(config) {
  while (iteration < maxIterations) {
    const stream = provider.sendMessage(messages);
    for await (const event of stream) {
      yield event; // 流式输出给 UI
      if (event.type === 'tool_call') {
        const result = await toolRegistry.execute(event);
        messages.push(result);
      }
    }
    if (!hasToolCalls) break;
  }
}`,
  },
  {
    tag: '02',
    title: 'Agent 团队协作',
    desc: 'Lead Agent 通过 TeamCreate 工具动态组建团队，并行派发子任务给多个 Teammate Agent。各 Agent 通过 MessageQueue 通信，协同完成复杂的多步骤任务。',
    code: `// Lead Agent 调用 TeamCreate
{
  "tool": "TeamCreate",
  "members": [
    { "role": "researcher", "task": "搜索相关资料" },
    { "role": "coder",      "task": "实现核心逻辑" },
    { "role": "reviewer",   "task": "代码审查" }
  ],
  "parallel": true
}`,
  },
  {
    tag: '03',
    title: '消息平台插件',
    desc: '统一的插件工厂模式，接入飞书、钉钉、Telegram 等 6 个平台。收到消息后自动触发 Agent 循环，生成回复并发送。WebSocket 长连接保持实时在线。',
    code: `// plugin-manager.ts
class PluginManager {
  register(type: ProviderType, factory: PluginFactory) {
    this.factories.set(type, factory);
  }
  async onMessage(msg: IncomingMessage) {
    const agent = await this.createAgentLoop(msg);
    const reply = await agent.run();
    await this.sendReply(msg.channel, reply);
  }
}`,
  },
];

const stack = [
  { name: 'Electron', desc: '跨平台桌面框架' },
  { name: 'React 19', desc: '渲染层' },
  { name: 'TypeScript', desc: '类型安全' },
  { name: 'Zustand', desc: '状态管理' },
  { name: 'SQLite', desc: '本地持久化' },
  { name: 'MCP', desc: '工具协议扩展' },
];

const docs = [
  { title: '快速开始', desc: '安装、配置、第一次对话', href: '/docs/getting-started/introduction' },
  { title: 'Agent 循环', desc: '核心引擎工作原理', href: '/docs/core-concepts/agent-loop' },
  { title: '工具系统', desc: '内置工具与自定义扩展', href: '/docs/core-concepts/tool-system' },
  { title: '插件系统', desc: '消息平台接入指南', href: '/docs/plugins/overview' },
  { title: 'AI 提供商', desc: '18+ 模型配置', href: '/docs/providers/overview' },
  { title: '架构设计', desc: '进程模型与数据流', href: '/docs/architecture/overview' },
];

export default function HomePage() {
  return (
    <main className="flex flex-col w-full overflow-hidden">

      {/* ── Hero ── */}
      <section className="relative w-full min-h-[92vh] flex flex-col items-center justify-center bg-zinc-950 text-white px-4 py-24">
        {/* grid pattern */}
        <div className="hero-grid absolute inset-0 pointer-events-none" />
        {/* radial fade */}
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_70%_50%_at_50%_40%,oklch(0.4_0.15_260/0.25),transparent)] pointer-events-none" />

        <div className="relative z-10 flex flex-col items-center text-center gap-6 max-w-3xl">
          <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-xs text-zinc-400 backdrop-blur">
            <span className="size-1.5 rounded-full bg-emerald-400 animate-pulse" />
            v0.2.5 已发布 &nbsp;·&nbsp; Apache License 2.0 &nbsp;·&nbsp; 完全开源
          </div>

          <h1 className="text-6xl sm:text-7xl font-bold tracking-tight leading-none">
            <span className="text-white">Open</span>
            <span className="bg-gradient-to-r from-violet-400 via-blue-400 to-cyan-400 bg-clip-text text-transparent">Cowork</span>
          </h1>

          <p className="text-lg text-zinc-400 max-w-xl leading-relaxed">
            桌面 AI Agent 应用。让 LLM 真正能做事——<br />
            调用工具、管理文件、自动回复消息、并行协作完成复杂任务。
          </p>

          <div className="flex gap-3 flex-wrap justify-center mt-2">
            <Link
              href="/docs/getting-started/introduction"
              className="inline-flex items-center gap-2 rounded-full bg-white text-zinc-900 font-semibold px-6 py-2.5 text-sm hover:bg-zinc-100 transition-colors"
            >
              开始使用 <ArrowRight className="size-4" />
            </Link>
            <Link
              href="https://github.com/AIDotNet/OpenCowork"
              target="_blank"
              className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 text-white px-6 py-2.5 text-sm hover:bg-white/10 transition-colors backdrop-blur"
            >
              <Github className="size-4" /> GitHub
            </Link>
          </div>
        </div>

        {/* Terminal mockup */}
        <div className="relative z-10 mt-16 w-full max-w-2xl rounded-xl border border-white/10 bg-zinc-900/80 backdrop-blur shadow-2xl overflow-hidden">
          <div className="flex items-center gap-1.5 px-4 py-3 border-b border-white/5 bg-zinc-900/50">
            <span className="size-3 rounded-full bg-red-500/70" />
            <span className="size-3 rounded-full bg-yellow-500/70" />
            <span className="size-3 rounded-full bg-green-500/70" />
            <span className="ml-3 text-xs text-zinc-500">OpenCowork — Agent Loop</span>
          </div>
          <div className="p-5 font-mono text-sm space-y-2 text-zinc-300">
            <div><span className="text-zinc-500">user</span> <span className="text-white">帮我分析 src/ 目录下所有 TypeScript 文件的依赖关系</span></div>
            <div className="text-zinc-500">─────────────────────────────────────</div>
            <div><span className="text-violet-400">▶ tool</span> <span className="text-zinc-400">Glob("src/**/*.ts")</span> <span className="text-emerald-400">→ 47 files</span></div>
            <div><span className="text-violet-400">▶ tool</span> <span className="text-zinc-400">Grep("import", files)</span> <span className="text-emerald-400">→ 312 matches</span></div>
            <div><span className="text-violet-400">▶ tool</span> <span className="text-zinc-400">Task("code-analysis", background=true)</span></div>
            <div className="text-zinc-500">  └─ SubAgent 已启动，正在构建依赖图...</div>
            <div><span className="text-blue-400">◆ agent</span> <span className="text-white">分析完成。发现 3 个循环依赖，主要集中在 stores/ 层...</span></div>
          </div>
        </div>

        {/* scroll hint */}
        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 flex flex-col items-center gap-1 text-zinc-600 text-xs">
          <div className="w-px h-8 bg-gradient-to-b from-transparent to-zinc-600" />
          向下滚动
        </div>
      </section>

      {/* ── Platforms ── */}
      <section className="w-full border-b bg-zinc-50 dark:bg-zinc-900/50">
        <div className="max-w-5xl mx-auto px-4 py-10 flex flex-col items-center gap-6">
          <p className="text-xs font-medium tracking-widest text-muted-foreground uppercase">自动接入 6 大消息平台</p>
          <div className="flex flex-wrap justify-center gap-3">
            {platforms.map((p) => (
              <span key={p.name} className="rounded-full border px-4 py-1.5 text-sm font-medium bg-background">
                {p.label}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ── Download ── */}
      <section className="w-full max-w-5xl mx-auto px-4 py-24">
        <div className="flex flex-col items-center gap-10">
          <div className="text-center">
            <h2 className="text-3xl font-bold mb-3">下载 OpenCowork</h2>
            <p className="text-muted-foreground">选择适合你操作系统的版本，开始使用</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 w-full">
            {downloads.map((platform) => (
              <div key={platform.platform} className="flex flex-col gap-4 rounded-xl border bg-card p-6">
                <div className="flex items-center gap-3">
                  <span className="text-3xl">{platform.icon}</span>
                  <h3 className="text-xl font-semibold">{platform.platform}</h3>
                </div>
                <div className="flex flex-col gap-2">
                  {platform.files.map((file) => (
                    <a
                      key={file.name}
                      href={file.url}
                      className="flex items-center justify-between gap-2 rounded-lg border bg-background px-4 py-3 text-sm hover:border-foreground/30 hover:shadow-sm transition-all group"
                    >
                      <span className="font-medium">{file.name}</span>
                      <Download className="size-4 text-muted-foreground group-hover:text-foreground transition-colors" />
                    </a>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>或者查看</span>
            <Link
              href="https://github.com/AIDotNet/OpenCowork/releases"
              target="_blank"
              className="inline-flex items-center gap-1 font-medium hover:underline underline-offset-4"
            >
              所有版本 <ExternalLink className="size-3.5" />
            </Link>
          </div>
        </div>
      </section>

      {/* ── Features ── */}
      <section className="w-full max-w-5xl mx-auto px-4 py-24 flex flex-col gap-24">
        {features.map((f, i) => (
          <div key={f.tag} className={`flex flex-col lg:flex-row gap-10 items-start ${i % 2 === 1 ? 'lg:flex-row-reverse' : ''}`}>
            <div className="flex-1 flex flex-col gap-4 pt-2">
              <span className="text-xs font-mono text-muted-foreground">{f.tag} /</span>
              <h3 className="text-2xl font-bold">{f.title}</h3>
              <p className="text-muted-foreground leading-relaxed">{f.desc}</p>
              <Link href="/docs/core-concepts/agent-loop" className="inline-flex items-center gap-1 text-sm font-medium hover:underline underline-offset-4 mt-2">
                了解更多 <ArrowRight className="size-3.5" />
              </Link>
            </div>
            <div className="flex-1 rounded-xl border bg-zinc-950 dark:bg-zinc-900 overflow-hidden shadow-lg">
              <div className="flex items-center gap-1.5 px-4 py-2.5 border-b border-white/5">
                <span className="size-2 rounded-full bg-white/10" />
                <span className="size-2 rounded-full bg-white/10" />
                <span className="size-2 rounded-full bg-white/10" />
              </div>
              <pre className="p-5 text-xs text-zinc-300 font-mono leading-relaxed overflow-x-auto whitespace-pre-wrap">{f.code}</pre>
            </div>
          </div>
        ))}
      </section>

      {/* ── Tech Stack ── */}
      <section className="w-full border-y bg-zinc-50 dark:bg-zinc-900/30">
        <div className="max-w-5xl mx-auto px-4 py-16 flex flex-col items-center gap-10">
          <div className="text-center">
            <h2 className="text-2xl font-bold mb-2">技术栈</h2>
            <p className="text-muted-foreground text-sm">现代化的桌面应用技术组合</p>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 w-full">
            {stack.map((s) => (
              <div key={s.name} className="flex flex-col items-center gap-1.5 rounded-xl border bg-background p-4 text-center">
                <span className="font-semibold text-sm">{s.name}</span>
                <span className="text-xs text-muted-foreground">{s.desc}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Docs ── */}
      <section className="w-full max-w-5xl mx-auto px-4 py-24">
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-10">
          <div>
            <h2 className="text-2xl font-bold mb-1">文档</h2>
            <p className="text-muted-foreground text-sm">从入门到深入，系统了解每个模块</p>
          </div>
          <Link href="/docs/getting-started/introduction" className="inline-flex items-center gap-1 text-sm font-medium hover:underline underline-offset-4 shrink-0">
            查看全部文档 <ExternalLink className="size-3.5" />
          </Link>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {docs.map((d) => (
            <Link
              key={d.href}
              href={d.href}
              className="group flex flex-col gap-1 rounded-xl border bg-card p-5 hover:border-foreground/30 hover:shadow-sm transition-all"
            >
              <span className="font-semibold text-sm flex items-center justify-between">
                {d.title}
                <ArrowRight className="size-3.5 text-muted-foreground group-hover:translate-x-0.5 transition-transform" />
              </span>
              <span className="text-xs text-muted-foreground">{d.desc}</span>
            </Link>
          ))}
        </div>
      </section>

      {/* ── CTA ── */}
      <section className="w-full bg-zinc-950 text-white">
        <div className="max-w-5xl mx-auto px-4 py-24 flex flex-col items-center text-center gap-8">
          <h2 className="text-4xl font-bold">
            让 AI 真正帮你<br />
            <span className="bg-gradient-to-r from-violet-400 to-cyan-400 bg-clip-text text-transparent">完成工作</span>
          </h2>
          <p className="text-zinc-400 max-w-md">
            OpenCowork 是一个开源桌面 AI Agent 平台，不只是聊天——它能调用工具、管理任务、自动化工作流。
          </p>
          <div className="flex gap-3 flex-wrap justify-center">
            <Link
              href="https://github.com/AIDotNet/OpenCowork/releases"
              target="_blank"
              className="inline-flex items-center gap-2 rounded-full bg-white text-zinc-900 font-semibold px-6 py-2.5 text-sm hover:bg-zinc-100 transition-colors"
            >
              下载应用
            </Link>
            <Link
              href="https://github.com/AIDotNet/OpenCowork"
              target="_blank"
              className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 text-white px-6 py-2.5 text-sm hover:bg-white/10 transition-colors"
            >
              <Github className="size-4" /> Star on GitHub
            </Link>
          </div>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="w-full border-t bg-zinc-950 text-zinc-500">
        <div className="max-w-5xl mx-auto px-4 py-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-sm">
          <span className="font-semibold text-zinc-300">OpenCowork</span>
          <div className="flex items-center gap-6">
            <Link href="https://github.com/AIDotNet/OpenCowork" target="_blank" className="hover:text-zinc-300 transition-colors flex items-center gap-1.5">
              <Github className="size-3.5" /> GitHub
            </Link>
            <Link href="/docs/getting-started/introduction" className="hover:text-zinc-300 transition-colors">文档</Link>
            <Link href="https://github.com/AIDotNet/OpenCowork/issues" target="_blank" className="hover:text-zinc-300 transition-colors">反馈</Link>
            <Link href="https://github.com/AIDotNet/OpenCowork/blob/main/LICENSE" target="_blank" className="hover:text-zinc-300 transition-colors">Apache 2.0</Link>
          </div>
          <span>© {new Date().getFullYear()} OpenCowork</span>
        </div>
      </footer>

    </main>
  );
}
