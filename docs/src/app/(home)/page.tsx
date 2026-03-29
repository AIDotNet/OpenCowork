'use client'

import { ReactNode } from 'react'
import { motion } from 'motion/react'
import Link from 'next/link'
import {
  Github,
  ArrowRight,
  ExternalLink,
  Download,
  Terminal,
  Users,
  Plug,
  Box,
  Code2,
  MessageSquare,
  Zap,
  ShieldCheck,
  Cpu
} from 'lucide-react'

function FadeIn({
  children,
  delay = 0,
  className = '',
  direction = 'up'
}: {
  children: ReactNode
  delay?: number
  className?: string
  direction?: 'up' | 'down' | 'left' | 'right' | 'none'
}) {
  const getInitialY = () => {
    if (direction === 'up') return 40
    if (direction === 'down') return -40
    return 0
  }

  const getInitialX = () => {
    if (direction === 'left') return 40
    if (direction === 'right') return -40
    return 0
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: getInitialY(), x: getInitialX() }}
      whileInView={{ opacity: 1, y: 0, x: 0 }}
      viewport={{ once: true, margin: '-50px' }}
      transition={{
        duration: 0.8,
        delay: delay / 1000,
        ease: [0.16, 1, 0.3, 1] // Custom spring-like easing for a premium feel
      }}
      className={className}
    >
      {children}
    </motion.div>
  )
}

// 容器动画变体，用于错开子元素的动画
const staggerContainer = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: {
      staggerChildren: 0.1
    }
  }
}

const staggerItem = {
  hidden: { opacity: 0, y: 20 },
  show: {
    opacity: 1,
    y: 0,
    transition: {
      type: 'spring' as const,
      stiffness: 300,
      damping: 24
    }
  }
}

const platforms = [
  { name: 'Feishu', label: '飞书' },
  { name: 'DingTalk', label: '钉钉' },
  { name: 'QQ', label: 'QQ 机器人' },
  { name: 'Telegram', label: 'Telegram' },
  { name: 'Discord', label: 'Discord' },
  { name: 'WhatsApp', label: 'WhatsApp' },
  { name: 'WeCom', label: '企业微信' }
]

const WindowsIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 448 512" fill="currentColor" className={className}>
    <path d="M0 93.7l210.5-29.7v167.4H0V93.7zm0 324.6l210.5 29.7V281.3H0v137zM236.1 34v212.8h211.9V0L236.1 34zm0 444l211.9 34V281.3H236.1v196.7z" />
  </svg>
)

const AppleIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 384 512" fill="currentColor" className={className}>
    <path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z" />
  </svg>
)

const LinuxIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 448 512" fill="currentColor" className={className}>
    <path d="M220.8 123.3c1 .5 1.8 1.7 3 1.7 1.1 0 2.8-.4 2.9-1.5.2-1.4-1.9-2.3-3.2-2.9-1.7-.7-3.9-1-5.5-.1-.4.2-.8.7-.6 1.1.3 1.3 2.3 1.1 3.4 1.7zm-21.9 1.7c1.2 0 2-1.2 3-1.7 1.1-.6 3.1-.4 3.5-1.6.2-.4-.2-.9-.6-1.1-1.6-.9-3.8-.6-5.5.1-1.3.6-3.4 1.5-3.2 2.9.1 1 1.8 1.5 2.8 1.4zM420 403.8c-3.6-4-5.3-11.6-7.2-19.7-1.8-8.1-3.9-16.8-10.5-22.4-1.3-1.1-2.6-2.1-4-2.9-1.3-.8-2.7-1.5-4.1-2 9.2-27.3 5.6-54.5-3.7-79.1-11.4-30.1-31.3-56.4-46.5-74.4-17.1-21.5-33.7-41.9-33.4-72C311.1 85.4 315.7.1 234.8 0 132.4-.2 158 103.4 156.9 135.2c-1.7 31.6-17.7 53.3-35.8 76.2-16.4 20.8-38.6 48.9-50.5 81.3-8.8 23.6-11.2 49.4-1.8 74.8-1.5.6-2.9 1.2-4.2 2.1-1.5.9-2.9 1.9-4.2 3.1-6.9 5.9-9.2 14.8-11.2 23.1-2 8.3-3.9 16.3-7.7 20.7-3.5 4-7.4 5.9-11.7 6.4-8.1 1-17.4-2.2-22.1-10.1-2.1-3.5-2.7-7.6-3-11.8l-1-.2c-.3 4.6.8 9.5 3.3 13.5 5.5 8.9 16.5 12.6 26.2 11.4 6.1-.7 11.2-3.6 15.6-8.5 2.5-2.8 4.1-6 5.5-9.1 2.3-5.3 4.2-10.9 6.2-16.3 1.8-5.1 3.5-10 5.8-14.4 1.3-2.5 2.9-4.8 4.8-6.9 7.4-8 17.6-11.9 28-13.4 1-.1 2-.2 3.1-.3 15-1.9 31.7-2.6 48.7-.9 5 4.3 14 10.6 25.1 10.6 6.8 0 12.7-2.2 17-5.9 4 3.5 9.7 5.6 16.1 5.6 11.7 0 21.3-7.2 25.8-12 17.6-2 34.9-1 50.4 1.2 1.1.2 2.2.3 3.3.5 10 1.6 19.9 5.5 27.2 13.4 1.9 2.1 3.4 4.3 4.7 6.8 2.2 4.3 3.9 9.1 5.7 14.1 2 5.3 3.8 10.8 6.1 16.1 1.4 3.2 3.1 6.4 5.6 9.2 4.4 4.9 9.5 7.8 15.6 8.5 9.7 1.2 20.7-2.5 26.2-11.4 2.5-4 3.6-8.9 3.3-13.5l-1 .2c-.3 4.2-.9 8.3-3 11.8-4.7 7.9-14 11.1-22.1 10.1-4.3-.4-8.2-2.3-11.7-6.3zM151.7 186.6c.1-8.1 4.7-14.9 10.5-16.5 6.3-1.8 12.3 3 13.2 11.1.7 6.6-2.5 12.7-7.4 14.9-4.5 2.1-9.5 1.1-13-2.6-2-2-3.2-4.5-3.3-6.9zm65.1-39.7c-2.1-2.9-4.6-5.8-7.7-8.6-3.8-3.4-9.3-7.1-15.6-7-8.6.2-11.1 5.8-10.4 11.2 1 7.2 9.1 12.6 16 11.6 3.6-.5 7.2-2.4 10.1-4.8 3-2.4 5.6-5.4 7.6-9.1v-3.3zm20.8-21.7c-13.5-6.8-22.4-5.2-28.7-2.6-9.6 4-13.5 11.3-11.3 17 2.1 5.2 9 8.3 16 7.6 5.8-.6 11.5-3.8 15.3-8.6 3.3-4.1 5.7-8.5 8.7-13.4zm100 86.8c-1.6 12.4-12.7 19.8-23.4 16.1-9.7-3.3-14.8-13.3-11.8-22.5 3-9 12-14.5 21.2-12.5 7.7 2.2 15 9.7 14 18.9z" />
  </svg>
)

const downloads = [
  {
    platform: 'Windows',
    icon: <WindowsIcon className="size-6 text-[#0078D4]" />,
    color: 'from-blue-500/20 to-cyan-500/20',
    borderColor: 'group-hover:border-blue-500/50',
    files: [
      {
        name: 'Windows Installer (AMD64 / x64)',
        url: '/downloads/OpenCowork-Windows-Setup.exe',
        isLocal: true
      },
      {
        name: 'Portable (.zip)',
        url: 'https://github.com/AIDotNet/OpenCowork/releases/latest/download/OpenCowork-win.zip',
        isLocal: false
      }
    ]
  },
  {
    platform: 'macOS',
    icon: <AppleIcon className="size-6 text-foreground" />,
    color: 'from-zinc-500/20 to-zinc-400/20',
    borderColor: 'group-hover:border-zinc-400/50',
    files: [
      {
        name: 'Apple Silicon (.dmg)',
        url: 'https://github.com/AIDotNet/OpenCowork/releases/latest/download/OpenCowork-arm64.dmg',
        isLocal: false
      },
      {
        name: 'Intel (.dmg)',
        url: 'https://github.com/AIDotNet/OpenCowork/releases/latest/download/OpenCowork-x64.dmg',
        isLocal: false
      }
    ]
  },
  {
    platform: 'Linux',
    icon: <LinuxIcon className="size-6 text-foreground" />,
    color: 'from-amber-500/20 to-orange-500/20',
    borderColor: 'group-hover:border-amber-500/50',
    files: [
      { name: 'AppImage', url: '/downloads/OpenCowork.AppImage', isLocal: true },
      { name: 'Debian (.deb)', url: '/downloads/OpenCowork.deb', isLocal: true }
    ]
  }
]

const features = [
  {
    icon: <Terminal className="size-6 text-violet-400" />,
    title: 'Agent 循环引擎',
    desc: '基于 AsyncGenerator 的流式 Agent 循环。每轮迭代自动执行工具调用、处理结果并决策是否继续，直到任务完成。',
    colSpan: 'col-span-1 md:col-span-2 lg:col-span-2'
  },
  {
    icon: <Users className="size-6 text-blue-400" />,
    title: 'Agent 团队协作',
    desc: 'Lead Agent 动态组建团队，并行派发子任务给多个 Teammate Agent，协同完成复杂的多步骤任务。',
    colSpan: 'col-span-1 md:col-span-1 lg:col-span-1'
  },
  {
    icon: <Plug className="size-6 text-cyan-400" />,
    title: '消息平台插件',
    desc: '统一的插件工厂模式，接入飞书、钉钉、QQ 等 7 个平台。收到消息后自动触发 Agent 循环，生成回复并发送。',
    colSpan: 'col-span-1 md:col-span-1 lg:col-span-1'
  },
  {
    icon: <Box className="size-6 text-emerald-400" />,
    title: 'MCP 协议支持',
    desc: '内置 Model Context Protocol (MCP) 支持，轻松扩展 Agent 的工具集和上下文能力，连接本地或远程服务。',
    colSpan: 'col-span-1 md:col-span-2 lg:col-span-2'
  },
  {
    icon: <Code2 className="size-6 text-amber-400" />,
    title: '本地代码工作流',
    desc: '直接在本地工作区读写文件、执行 Shell 命令、搜索代码，实现真正的代码级协作与自动化开发。',
    colSpan: 'col-span-1 md:col-span-2 lg:col-span-2'
  },
  {
    icon: <MessageSquare className="size-6 text-rose-400" />,
    title: '多模型支持',
    desc: '支持 OpenAI, Anthropic, DeepSeek, Google 等 18+ 主流大模型，自由切换，支持视觉和深度思考模式。',
    colSpan: 'col-span-1 md:col-span-1 lg:col-span-1'
  }
]

const stack = [
  { name: 'Electron', desc: '跨平台桌面框架', icon: <Cpu className="size-5" /> },
  { name: 'React 19', desc: '现代渲染层', icon: <Box className="size-5" /> },
  { name: 'TypeScript', desc: '类型安全', icon: <Code2 className="size-5" /> },
  { name: 'Zustand', desc: '状态管理', icon: <Zap className="size-5" /> },
  { name: 'SQLite', desc: '本地持久化', icon: <ShieldCheck className="size-5" /> },
  { name: 'Tailwind 4', desc: '原子化 CSS', icon: <Box className="size-5" /> }
]

const docs = [
  { title: '快速开始', desc: '安装、配置、第一次对话', href: '/docs/getting-started/introduction' },
  { title: 'Agent 循环', desc: '核心引擎工作原理', href: '/docs/core-concepts/agent-loop' },
  { title: '工具系统', desc: '内置工具与自定义扩展', href: '/docs/core-concepts/tool-system' },
  { title: '插件系统', desc: '消息平台接入指南', href: '/docs/plugins/overview' },
  { title: 'AI 提供商', desc: '18+ 模型配置', href: '/docs/providers/overview' },
  { title: '架构设计', desc: '进程模型与数据流', href: '/docs/architecture/overview' }
]

export default function HomePage() {
  return (
    <main className="flex flex-col w-full overflow-hidden selection:bg-violet-500/30">
      {/* ── Hero Section ── */}
      <section className="relative w-full min-h-[92vh] flex flex-col items-center justify-center bg-zinc-950 text-white px-4 py-24 overflow-hidden">
        {/* Background Effects */}
        <div className="absolute inset-0 bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:24px_24px] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_0%,#000_70%,transparent_100%)]" />

        {/* Animated Orbs */}
        <motion.div
          animate={{ scale: [1, 1.1, 1], opacity: [0.2, 0.3, 0.2] }}
          transition={{ duration: 8, repeat: Infinity, ease: 'easeInOut' }}
          className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[400px] bg-violet-500/20 blur-[120px] rounded-full pointer-events-none"
        />
        <motion.div
          animate={{ scale: [1, 1.2, 1], opacity: [0.1, 0.2, 0.1] }}
          transition={{ duration: 10, repeat: Infinity, ease: 'easeInOut', delay: 1 }}
          className="absolute bottom-0 right-0 w-[600px] h-[400px] bg-cyan-500/10 blur-[100px] rounded-full pointer-events-none"
        />

        <FadeIn
          delay={100}
          className="relative z-10 flex flex-col items-center text-center gap-8 max-w-4xl mt-10"
        >
          <motion.div
            whileHover={{ scale: 1.05 }}
            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-xs text-zinc-300 backdrop-blur-md shadow-xl"
          >
            <span className="relative flex size-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full size-2 bg-emerald-500"></span>
            </span>
            v0.7.5 已发布 <span className="text-zinc-600">|</span> Apache 2.0
            <span className="text-zinc-600">|</span> 完全开源
          </motion.div>

          <h1 className="text-5xl sm:text-7xl lg:text-8xl font-extrabold tracking-tight leading-[1.1]">
            <span className="text-white">Open</span>
            <span className="bg-gradient-to-r from-violet-400 via-blue-400 to-cyan-400 bg-clip-text text-transparent drop-shadow-sm">
              Cowork
            </span>
          </h1>

          <p className="text-lg sm:text-xl text-zinc-400 max-w-2xl leading-relaxed font-medium">
            下一代桌面 AI Agent 工作站。
            <br className="hidden sm:block" />让 LLM
            真正能做事——调用工具、管理文件、自动回复消息、并行协作完成复杂任务。
          </p>

          <div className="flex flex-col sm:flex-row gap-4 mt-4 w-full sm:w-auto">
            <Link
              href="/docs/getting-started/introduction"
              className="inline-flex items-center justify-center gap-2 rounded-full bg-white text-zinc-950 font-bold px-8 py-3.5 text-sm hover:bg-zinc-100 hover:scale-105 transition-transform duration-300 shadow-[0_0_40px_-10px_rgba(255,255,255,0.3)]"
            >
              开始使用 <ArrowRight className="size-4" />
            </Link>
            <Link
              href="https://github.com/AIDotNet/OpenCowork"
              target="_blank"
              className="inline-flex items-center justify-center gap-2 rounded-full border border-white/15 bg-zinc-900/50 text-white px-8 py-3.5 text-sm hover:bg-white/10 hover:border-white/30 transition-all backdrop-blur-md"
            >
              <Github className="size-4" /> GitHub 仓库
            </Link>
          </div>
        </FadeIn>

        {/* Terminal Mockup */}
        <FadeIn
          delay={300}
          className="relative z-10 mt-20 w-full max-w-3xl rounded-2xl border border-white/10 bg-zinc-950/80 backdrop-blur-xl shadow-[0_20px_50px_-20px_rgba(0,0,0,0.5)] overflow-hidden group"
        >
          <div className="absolute inset-0 bg-gradient-to-tr from-violet-500/5 via-transparent to-cyan-500/5 opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
          <div className="flex items-center justify-between px-4 py-3 border-b border-white/5 bg-zinc-900/80">
            <div className="flex items-center gap-2">
              <span className="size-3 rounded-full bg-red-500/80 shadow-[0_0_10px_rgba(239,68,68,0.5)]" />
              <span className="size-3 rounded-full bg-yellow-500/80 shadow-[0_0_10px_rgba(234,179,8,0.5)]" />
              <span className="size-3 rounded-full bg-green-500/80 shadow-[0_0_10px_rgba(34,197,94,0.5)]" />
            </div>
            <span className="text-xs font-mono text-zinc-500 flex items-center gap-2">
              <Terminal className="size-3" /> agent-loop.tsx
            </span>
            <div className="w-12" /> {/* Spacer for centering */}
          </div>
          <div className="p-6 font-mono text-sm space-y-3 text-zinc-300 overflow-x-auto">
            <div className="flex gap-3">
              <span className="text-zinc-600 select-none">1</span>
              <div>
                <span className="text-blue-400">user</span>{' '}
                <span className="text-zinc-100">
                  帮我分析 src/ 目录下所有 TypeScript 文件的依赖关系
                </span>
              </div>
            </div>
            <div className="flex gap-3">
              <span className="text-zinc-600 select-none">2</span>
              <div className="text-zinc-600">
                ──────────────────────────────────────────────────────────
              </div>
            </div>
            <div className="flex gap-3">
              <span className="text-zinc-600 select-none">3</span>
              <div>
                <span className="text-violet-400 font-bold">▶ tool</span>{' '}
                <span className="text-zinc-300">Glob("src/**/*.ts")</span>{' '}
                <span className="text-emerald-400">→ 47 files</span>
              </div>
            </div>
            <div className="flex gap-3">
              <span className="text-zinc-600 select-none">4</span>
              <div>
                <span className="text-violet-400 font-bold">▶ tool</span>{' '}
                <span className="text-zinc-300">Grep("import", files)</span>{' '}
                <span className="text-emerald-400">→ 312 matches</span>
              </div>
            </div>
            <div className="flex gap-3">
              <span className="text-zinc-600 select-none">5</span>
              <div>
                <span className="text-violet-400 font-bold">▶ tool</span>{' '}
                <span className="text-zinc-300">Task("code-analysis", background=true)</span>
              </div>
            </div>
            <div className="flex gap-3">
              <span className="text-zinc-600 select-none">6</span>
              <div className="text-zinc-500">
                {' '}
                <span className="animate-pulse">⠋</span> SubAgent 已启动，正在构建依赖图...
              </div>
            </div>
            <div className="flex gap-3">
              <span className="text-zinc-600 select-none">7</span>
              <div>
                <span className="text-cyan-400 font-bold">◆ agent</span>{' '}
                <span className="text-zinc-100">
                  分析完成。发现 3 个循环依赖，主要集中在 stores/ 层...
                </span>
              </div>
            </div>
          </div>
        </FadeIn>

        {/* Scroll Hint */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1.5, duration: 1 }}
          className="absolute bottom-6 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 text-zinc-500 text-xs font-medium tracking-widest uppercase"
        >
          <motion.div
            animate={{ height: ['0px', '40px', '0px'], y: [0, 0, 40] }}
            transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
            className="w-px bg-gradient-to-b from-transparent via-zinc-400 to-transparent"
          />
          Scroll
        </motion.div>
      </section>

      {/* ── Platforms Marquee ── */}
      <section className="w-full border-b bg-zinc-50 dark:bg-zinc-900/30 overflow-hidden">
        <FadeIn
          delay={100}
          className="max-w-6xl mx-auto px-4 py-8 flex flex-col sm:flex-row items-center justify-center gap-6 sm:gap-12"
        >
          <p className="text-xs font-bold tracking-widest text-muted-foreground uppercase whitespace-nowrap">
            无缝接入 7 大消息平台
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            {platforms.map((p, i) => (
              <motion.span
                key={p.name}
                initial={{ opacity: 0, scale: 0.8 }}
                whileInView={{ opacity: 1, scale: 1 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.05, type: 'spring' }}
                whileHover={{ scale: 1.05, y: -2 }}
                className="rounded-full border border-border/50 bg-background/50 backdrop-blur px-4 py-1.5 text-sm font-medium text-foreground/80 hover:text-foreground hover:border-foreground/30 transition-colors cursor-default shadow-sm hover:shadow-md"
              >
                {p.label}
              </motion.span>
            ))}
          </div>
        </FadeIn>
      </section>

      {/* ── Download Section ── */}
      <section className="relative w-full py-24 bg-background">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,rgba(120,119,198,0.1),transparent)] pointer-events-none" />
        <div className="max-w-6xl mx-auto px-4 relative z-10">
          <FadeIn className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold mb-4 tracking-tight">下载 OpenCowork</h2>
            <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
              选择适合您操作系统的版本。我们提供开箱即用的安装包，让您立即开始 AI 协作之旅。
            </p>
          </FadeIn>

          <motion.div
            variants={staggerContainer}
            initial="hidden"
            whileInView="show"
            viewport={{ once: true, margin: '-100px' }}
            className="grid grid-cols-1 md:grid-cols-3 gap-6"
          >
            {downloads.map((platform) => (
              <motion.div
                key={platform.platform}
                variants={staggerItem}
                whileHover={{ y: -5 }}
                className={`group relative flex flex-col rounded-2xl border bg-card/50 backdrop-blur-sm p-1 overflow-hidden transition-all duration-500 hover:shadow-2xl ${platform.borderColor}`}
              >
                {/* Card Background Gradient */}
                <div
                  className={`absolute inset-0 bg-gradient-to-br ${platform.color} opacity-0 group-hover:opacity-100 transition-opacity duration-500`}
                />

                <div className="relative h-full flex flex-col bg-card rounded-xl p-6 z-10 transition-transform duration-500">
                  <div className="flex items-center gap-4 mb-6">
                    <div className="flex items-center justify-center size-12 rounded-xl bg-muted/50 border shadow-sm text-2xl group-hover:scale-110 group-hover:rotate-3 transition-transform duration-500">
                      {platform.icon}
                    </div>
                    <h3 className="text-xl font-bold">{platform.platform}</h3>
                  </div>

                  <div className="flex flex-col gap-3 mt-auto">
                    {platform.files.map((file) => (
                      <a
                        key={file.name}
                        href={file.url}
                        className="flex items-center justify-between gap-3 rounded-lg border border-border/50 bg-background/50 px-4 py-3 text-sm hover:bg-accent hover:border-accent-foreground/30 transition-all hover:shadow-md"
                      >
                        <div className="flex items-center gap-2 overflow-hidden">
                          <span className="font-medium truncate">{file.name.split(' - ')[0]}</span>
                          {file.isLocal && (
                            <span className="shrink-0 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider border border-emerald-500/20">
                              本地直链
                            </span>
                          )}
                        </div>
                        <Download className="size-4 text-muted-foreground shrink-0 group-hover/btn:text-foreground" />
                      </a>
                    ))}
                  </div>
                </div>
              </motion.div>
            ))}
          </motion.div>

          <FadeIn delay={400} className="mt-10 text-center">
            <Link
              href="https://github.com/AIDotNet/OpenCowork/releases"
              target="_blank"
              className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              在 GitHub 查看所有历史版本 <ExternalLink className="size-4" />
            </Link>
          </FadeIn>
        </div>
      </section>

      {/* ── Features Bento Grid ── */}
      <section className="w-full py-24 bg-zinc-50 dark:bg-zinc-900/20 border-y">
        <div className="max-w-6xl mx-auto px-4">
          <FadeIn className="mb-16">
            <h2 className="text-3xl md:text-4xl font-bold mb-4 tracking-tight">核心特性</h2>
            <p className="text-muted-foreground text-lg">专为开发者与团队协作打造的 AI 基础设施</p>
          </FadeIn>

          <motion.div
            variants={staggerContainer}
            initial="hidden"
            whileInView="show"
            viewport={{ once: true, margin: '-100px' }}
            className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-3 gap-4 auto-rows-[minmax(180px,auto)]"
          >
            {features.map((f, i) => (
              <motion.div
                key={i}
                variants={staggerItem}
                whileHover={{ scale: 1.02 }}
                className={`group relative overflow-hidden rounded-2xl border bg-card p-6 md:p-8 shadow-sm hover:shadow-xl transition-shadow duration-500 ${f.colSpan}`}
              >
                <div className="absolute top-0 right-0 p-8 opacity-5 group-hover:opacity-[0.15] transition-opacity duration-500 scale-150 -translate-y-1/4 translate-x-1/4 group-hover:rotate-12">
                  {f.icon}
                </div>
                <div className="relative z-10 flex flex-col h-full">
                  <div className="mb-4 inline-flex items-center justify-center size-12 rounded-xl bg-muted border shadow-sm group-hover:scale-110 transition-transform duration-500">
                    {f.icon}
                  </div>
                  <h3 className="text-xl font-bold mb-3">{f.title}</h3>
                  <p className="text-muted-foreground leading-relaxed flex-grow">{f.desc}</p>
                </div>
              </motion.div>
            ))}
          </motion.div>
        </div>
      </section>

      {/* ── Tech Stack ── */}
      <section className="w-full py-20 bg-background">
        <div className="max-w-6xl mx-auto px-4 flex flex-col items-center gap-10">
          <FadeIn className="text-center">
            <h2 className="text-2xl font-bold mb-2">现代化的技术栈</h2>
            <p className="text-muted-foreground text-sm">构建于可靠的开源技术之上</p>
          </FadeIn>
          <motion.div
            variants={staggerContainer}
            initial="hidden"
            whileInView="show"
            viewport={{ once: true, margin: '-50px' }}
            className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 w-full"
          >
            {stack.map((s) => (
              <motion.div
                key={s.name}
                variants={staggerItem}
                whileHover={{ y: -5, backgroundColor: 'var(--accent)' }}
                className="flex flex-col items-center gap-3 rounded-2xl border bg-card/50 p-6 text-center transition-colors shadow-sm hover:shadow-md cursor-default"
              >
                <div className="text-muted-foreground">{s.icon}</div>
                <div>
                  <div className="font-bold text-sm mb-1">{s.name}</div>
                  <div className="text-xs text-muted-foreground">{s.desc}</div>
                </div>
              </motion.div>
            ))}
          </motion.div>
        </div>
      </section>

      {/* ── Docs ── */}
      <section className="w-full py-24 bg-zinc-50 dark:bg-zinc-900/20 border-t">
        <div className="max-w-6xl mx-auto px-4">
          <FadeIn className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-12">
            <div>
              <h2 className="text-3xl font-bold mb-2 tracking-tight">开发文档</h2>
              <p className="text-muted-foreground">从入门到深入，系统了解每个模块的工作原理</p>
            </div>
            <Link
              href="/docs/getting-started/introduction"
              className="inline-flex items-center gap-2 text-sm font-bold text-violet-600 dark:text-violet-400 hover:text-violet-700 dark:hover:text-violet-300 transition-colors shrink-0 group"
            >
              阅读完整文档{' '}
              <ArrowRight className="size-4 group-hover:translate-x-1 transition-transform" />
            </Link>
          </FadeIn>
          <motion.div
            variants={staggerContainer}
            initial="hidden"
            whileInView="show"
            viewport={{ once: true, margin: '-50px' }}
            className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4"
          >
            {docs.map((d) => (
              <motion.div key={d.href} variants={staggerItem} whileHover={{ y: -4 }}>
                <Link
                  href={d.href}
                  className="group flex flex-col gap-2 rounded-2xl border bg-card p-6 hover:border-violet-500/30 hover:shadow-lg transition-all h-full"
                >
                  <span className="font-bold text-lg flex items-center justify-between text-foreground group-hover:text-violet-600 dark:group-hover:text-violet-400 transition-colors">
                    {d.title}
                    <ArrowRight className="size-4 text-muted-foreground opacity-0 -translate-x-4 group-hover:opacity-100 group-hover:translate-x-0 transition-all duration-300" />
                  </span>
                  <span className="text-sm text-muted-foreground">{d.desc}</span>
                </Link>
              </motion.div>
            ))}
          </motion.div>
        </div>
      </section>

      {/* ── CTA ── */}
      <section className="relative w-full bg-zinc-950 text-white overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(139,92,246,0.15),transparent_50%)]" />
        <FadeIn
          direction="up"
          className="max-w-4xl mx-auto px-4 py-32 flex flex-col items-center text-center gap-8 relative z-10"
        >
          <h2 className="text-4xl md:text-5xl font-extrabold tracking-tight">
            准备好改变工作方式了吗？
          </h2>
          <p className="text-xl text-zinc-400 max-w-2xl">
            下载 OpenCowork，体验真正的桌面级 AI Agent，让大模型成为你最得力的工作伙伴。
          </p>
          <div className="flex flex-col sm:flex-row gap-4 mt-4">
            <Link
              href="#downloads"
              onClick={(e) => {
                e.preventDefault()
                window.scrollTo({
                  top: document.querySelector('.bg-background')?.getBoundingClientRect().top,
                  behavior: 'smooth'
                })
              }}
              className="inline-flex items-center justify-center gap-2 rounded-full bg-white text-zinc-950 font-bold px-8 py-4 text-sm hover:bg-zinc-100 hover:scale-105 transition-all duration-300 shadow-[0_0_40px_-10px_rgba(255,255,255,0.4)]"
            >
              <Download className="size-4" /> 立即下载
            </Link>
            <Link
              href="https://github.com/AIDotNet/OpenCowork"
              target="_blank"
              className="inline-flex items-center justify-center gap-2 rounded-full border border-zinc-700 bg-zinc-900 text-white px-8 py-4 text-sm hover:bg-zinc-800 hover:border-zinc-500 transition-all duration-300"
            >
              <Github className="size-4" /> 访问 GitHub
            </Link>
          </div>
        </FadeIn>
      </section>

      {/* ── Footer ── */}
      <footer className="w-full border-t border-zinc-800 bg-zinc-950 text-zinc-500 relative z-10">
        <div className="max-w-6xl mx-auto px-4 py-12 flex flex-col md:flex-row items-center justify-between gap-6 text-sm">
          <div className="flex items-center gap-2">
            <span className="font-bold text-zinc-300 text-lg">OpenCowork</span>
            <span className="text-zinc-600">© {new Date().getFullYear()}</span>
          </div>
          <div className="flex flex-wrap justify-center items-center gap-8 font-medium">
            <Link
              href="https://github.com/AIDotNet/OpenCowork"
              target="_blank"
              className="hover:text-zinc-200 transition-colors flex items-center gap-2"
            >
              <Github className="size-4" /> GitHub
            </Link>
            <Link
              href="/docs/getting-started/introduction"
              className="hover:text-zinc-200 transition-colors"
            >
              文档
            </Link>
            <Link
              href="https://github.com/AIDotNet/OpenCowork/issues"
              target="_blank"
              className="hover:text-zinc-200 transition-colors"
            >
              提交反馈
            </Link>
            <Link
              href="https://github.com/AIDotNet/OpenCowork/blob/main/LICENSE"
              target="_blank"
              className="hover:text-zinc-200 transition-colors"
            >
              Apache 2.0 License
            </Link>
          </div>
        </div>
      </footer>
    </main>
  )
}
