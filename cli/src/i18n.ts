import i18n from 'i18next'
import { loadOpenCoworkConfiguration } from './runtime/provider-catalog.js'

/**
 * CLI language codes intentionally mirror the desktop application's language codes. The CLI is
 * published as a standalone package, so its resources live in this package instead of relying on
 * the renderer's Vite-only locale loader.
 */
export const SUPPORTED_CLI_LANGUAGE_CODES = [
  'en',
  'zh',
  'ja',
  'ko',
  'fr',
  'de',
  'es',
  'pt',
  'ru',
  'ar',
  'it',
  'nl',
  'tr',
  'vi',
  'th',
  'id'
] as const

export type CliLanguage = (typeof SUPPORTED_CLI_LANGUAGE_CODES)[number]

const languageSet = new Set<string>(SUPPORTED_CLI_LANGUAGE_CODES)

/** English is also the fallback for languages whose CLI-specific translations are not complete. */
const englishResources = {
  cli: {
    app: {
      description: 'OpenCowork — an agentic coding assistant for your terminal'
    },
    options: {
      language: 'Interface language (auto-detected when omitted)',
      doctor: 'Check the Native Worker transport and shared provider configuration',
      worker: 'Override the OpenCowork.Native.Worker executable path',
      provider: 'Select a configured OpenCowork provider for this session',
      model: 'Select an enabled model for this session',
      prompt: 'Initial prompt to place in the editor',
      permissionMode: 'Initial permission mode',
      tui: 'Terminal renderer',
      repair: 'Reinstall the Native Worker binary for this machine',
      print: 'Run one prompt without the interactive UI and print the result',
      outputFormat: 'Print-mode output format',
      maxTurns: 'Maximum agent loop turns before the run stops',
      timeout: 'Abort a print-mode run after this many seconds',
      continue: 'Continue the most recent CLI session in this folder',
      resume: 'Resume a specific stored CLI session by id'
    },
    commands: {
      update: 'Update OpenCowork CLI to the latest version',
      config: 'Quickly configure an AI provider in the terminal'
    },
    errors: {
      update: 'Update failed. Run: npm install -g @aidotnet/opencowork@latest',
      repair:
        'Native Worker reinstall failed. Check network access, then retry: cowork update --repair',
      configTty: 'Provider setup requires a TTY. Run cowork config in an interactive terminal.',
      provider:
        'Provider “{{provider}}” is not enabled, authenticated, or configured with chat models.',
      model: 'Model “{{model}}” is not enabled{{providerSuffix}}.',
      interactiveTty: 'Interactive mode requires a TTY. Run opencowork --help for options.',
      maxTurns: '--max-turns requires a positive integer.',
      timeout: '--timeout requires a positive number of seconds.',
      printPrompt: 'Print mode needs a prompt: cowork -p "prompt" or echo "prompt" | cowork -p',
      printModel: 'No model configured. Run: cowork config',
      continueResume: '--continue and --resume cannot be combined.',
      noResumableSession: 'No resumable CLI session found for this folder.'
    },
    output: {
      providerReady: 'Provider ready: {{provider}} / {{model}}',
      sharedConfiguration: 'The same configuration is now available in OpenCowork desktop.',
      doctorTitle: 'OpenCowork CLI doctor',
      worker: 'Worker: {{value}}',
      pid: 'PID: {{value}}',
      ipcProtocol: 'IPC protocol: v{{value}}',
      agentProtocol: 'Agent protocol: v{{value}}',
      agentRuntime: 'Agent runtime: {{runtime}} {{version}}',
      routes: 'Routes: {{value}}',
      configuredModel: 'Configured model: {{value}}',
      ready: 'Status: ready',
      doctorIssues: 'Status: issues found',
      repairDone: 'Native Worker reinstalled.'
    },
    help: {
      title: 'Interactive shortcuts:',
      commands: 'Open commands',
      shortcuts: 'Toggle shortcuts',
      provider: 'Configure provider',
      model: 'Switch model',
      modes: 'Cycle modes / Plan',
      details: 'Toggle reasoning/details',
      tasks: 'Toggle task list',
      exit: 'Exit',
      redraw: 'Redraw'
    },
    welcome: {
      title: 'Welcome back!',
      tips: 'Tips for getting started',
      reviewSettings: 'Run /config to review settings',
      configureModel: 'Run /provider to configure a model',
      nativeWorker: 'Native Worker',
      history: 'Canonical history persists to SQLite',
      commands: 'Type / for commands',
      shortcuts: 'Use ? for shortcuts',
      noModel: 'No model configured',
      agent: 'OpenCowork Agent'
    },
    common: {
      search: 'Search',
      cancel: 'Esc to cancel',
      close: 'Enter/Esc close',
      save: 'Enter to save',
      submit: 'Enter to submit',
      back: 'Esc to go back',
      more: 'more',
      above: 'above',
      current: 'current',
      saving: 'saving',
      loading: 'Loading…',
      refreshing: 'Refreshing…',
      noResults: 'No matching results',
      noCommands: 'No matching commands',
      noAgents: 'No agents match “{{query}}”.',
      noModels: 'No enabled provider has a chat model.',
      noMessages: 'No messages to rewind.'
    },
    commandsMenu: {
      agents: 'Inspect configured Native Worker agents',
      clear: 'Clear canonical context in this session',
      codegraph: 'Show CodeGraph availability and index status',
      compact: 'Compact canonical context in the Native Worker',
      config: 'Open shared OpenCowork configuration',
      context: 'Show canonical context usage and compact trigger',
      cost: 'Show token usage and estimated model cost',
      doctor: 'Diagnose Native Worker and configuration',
      effort: 'Choose reasoning effort supported by the active model',
      exit: 'Exit OpenCowork',
      help: 'Show interactive shortcuts',
      mcp: 'Show MCP server status; enable or disable servers',
      model: 'Switch the active model',
      new: 'Start a new Native Worker session',
      permissions: 'View or set the session permission mode',
      plan: 'Enter, leave, or toggle plan mode',
      provider: 'Quickly configure an AI provider',
      rewind: 'Restore a previous conversation turn and optional tracked changes',
      resume: 'Resume a completed CLI session',
      skills: 'List skills available to the Native Worker',
      status: 'Show session, model, and runtime status',
      tasks: 'Toggle the current session task list',
      tui: 'Show renderer status or restart syntax'
    },
    panels: {
      agents: 'Agents',
      nativeAgents:
        '{{count}} Native Worker sub-agents · Task delegates work without a second runtime',
      searchAgents:
        'Type to search · ↑↓ inspect · Enter/Esc close · configure in ~/.open-cowork/agents',
      configuration: 'Configuration',
      modelPicker: 'Select model',
      searchModels: 'Search',
      modelStep: 'Configure model · Step 2 of 2',
      effort: 'Reasoning effort',
      resume: 'Resume session',
      loadingSessions: 'Loading resumable sessions…',
      noSessions: 'No resumable sessions found.',
      rewind: 'Rewind',
      loadingCheckpoints: 'Loading conversation checkpoints…',
      permission: 'Permission required',
      askUser: 'Questions',
      plan: 'Plan',
      provider: 'Provider',
      protocol: 'Protocol',
      endpoint: 'Endpoint',
      apiKey: 'API key',
      sharedDesktop: 'Shared with OpenCowork desktop · credentials are masked',
      enterContinue: 'Enter continue · Esc back · Ctrl+U clear'
    },
    statuses: {
      thinking: 'Thinking…',
      working: 'Working…',
      compressing: 'Compressing context…',
      retrying: 'Retrying',
      planOn: 'Plan mode on · implementation waits for your approval · Shift+Tab to cycle',
      autoOn: 'Auto mode on · tools may run without confirmation · Shift+Tab to cycle',
      acceptEditsOn: 'Accept edits mode on · Shift+Tab to cycle',
      manualOn: 'Manual approval mode · Shift+Tab to cycle'
    }
  }
} as const

const chineseResources = {
  cli: {
    app: {
      description: 'OpenCowork — 面向终端的智能编程助手'
    },
    options: {
      language: '界面语言（省略时自动检测）',
      help: '显示命令帮助',
      version: '显示版本号',
      doctor: '检查 Native Worker 传输和共享 Provider 配置',
      worker: '覆盖 OpenCowork.Native.Worker 可执行文件路径',
      provider: '为本次会话选择已配置的 Provider',
      model: '为本次会话选择已启用的模型',
      prompt: '放入编辑器的初始提示词',
      permissionMode: '初始权限模式',
      tui: '终端渲染器',
      repair: '为本机重新安装 Native Worker 二进制文件',
      print: '不启动交互界面，运行一条提示词并输出结果',
      outputFormat: 'print 模式的输出格式',
      maxTurns: 'Agent 循环的最大轮数上限',
      timeout: 'print 模式运行超过该秒数后中止',
      continue: '继续当前目录下最近的 CLI 会话',
      resume: '按 ID 恢复指定的已存储 CLI 会话'
    },
    commands: {
      update: '将 OpenCowork CLI 更新到最新版本',
      config: '在终端快速配置 AI Provider'
    },
    errors: {
      update: '更新失败。请运行：npm install -g @aidotnet/opencowork@latest',
      repair: 'Native Worker 重装失败。请检查网络后重试：cowork update --repair',
      configTty: 'Provider 配置需要 TTY。请在交互式终端中运行 cowork config。',
      provider: 'Provider “{{provider}}” 未启用、未认证，或没有配置聊天模型。',
      model: '模型“{{model}}”未启用{{providerSuffix}}。',
      interactiveTty: '交互模式需要 TTY。请运行 opencowork --help 查看选项。',
      maxTurns: '--max-turns 需要一个正整数。',
      timeout: '--timeout 需要一个正的秒数。',
      printPrompt: 'print 模式需要提示词：cowork -p "提示词" 或 echo "提示词" | cowork -p',
      printModel: '尚未配置模型。请运行：cowork config',
      continueResume: '--continue 与 --resume 不能同时使用。',
      noResumableSession: '当前目录下没有可恢复的 CLI 会话。'
    },
    output: {
      providerReady: 'Provider 已就绪：{{provider}} / {{model}}',
      sharedConfiguration: '相同配置现在也可在 OpenCowork 桌面端使用。',
      doctorTitle: 'OpenCowork CLI 诊断',
      worker: 'Worker：{{value}}',
      pid: '进程 ID：{{value}}',
      ipcProtocol: 'IPC 协议：v{{value}}',
      agentProtocol: 'Agent 协议：v{{value}}',
      agentRuntime: 'Agent Runtime：{{runtime}} {{version}}',
      routes: '路由数：{{value}}',
      configuredModel: '已配置模型：{{value}}',
      ready: '状态：就绪',
      doctorIssues: '状态：发现问题',
      repairDone: 'Native Worker 已重新安装。'
    },
    help: {
      title: '交互快捷键：',
      usage: '用法：',
      arguments: '参数：',
      options: '选项：',
      commandSection: '命令：',
      globalOptions: '全局选项：',
      choices: '可选值',
      default: '默认值',
      commands: '打开命令',
      shortcuts: '切换快捷键面板',
      provider: '配置 Provider',
      model: '切换模型',
      modes: '循环切换模式 / Plan',
      details: '展开思考/工具详情',
      tasks: '切换任务列表',
      exit: '退出',
      redraw: '重绘'
    },
    welcome: {
      title: '欢迎回来！',
      tips: '快速开始',
      reviewSettings: '运行 /config 查看设置',
      configureModel: '运行 /provider 配置模型',
      nativeWorker: 'Native Worker',
      history: '对话历史会持久化到 SQLite',
      commands: '输入 / 查看命令',
      shortcuts: '使用 ? 查看快捷键',
      noModel: '尚未配置模型',
      agent: 'OpenCowork Agent'
    },
    common: {
      search: '搜索',
      cancel: 'Esc 取消',
      close: 'Enter/Esc 关闭',
      save: 'Enter 保存',
      submit: 'Enter 提交',
      back: 'Esc 返回',
      more: '更多',
      above: '上方',
      current: '当前',
      saving: '保存中',
      loading: '加载中…',
      refreshing: '刷新中…',
      noResults: '没有匹配结果',
      noCommands: '没有匹配的命令',
      noAgents: '没有匹配“{{query}}”的 Agent。',
      noModels: '没有已启用且包含聊天模型的 Provider。',
      noMessages: '没有可回退的消息。'
    },
    commandsMenu: {
      agents: '查看已配置的 Native Worker Agent',
      clear: '清除本会话的规范上下文',
      codegraph: '查看 CodeGraph 可用性和索引状态',
      compact: '在 Native Worker 中压缩规范上下文',
      config: '打开共享 OpenCowork 配置',
      context: '查看规范上下文用量和压缩触发点',
      cost: '查看 Token 用量和模型成本估算',
      doctor: '诊断 Native Worker 和配置',
      effort: '选择当前模型支持的推理强度',
      exit: '退出 OpenCowork',
      help: '显示交互快捷键',
      mcp: '查看 MCP 服务器状态；启用或停用服务器',
      model: '切换当前模型',
      new: '启动新的 Native Worker 会话',
      permissions: '查看或设置会话权限模式',
      plan: '进入、离开或切换 Plan 模式',
      provider: '快速配置 AI Provider',
      rewind: '恢复之前的对话轮次和可选的跟踪变更',
      resume: '恢复已完成的 CLI 会话',
      skills: '列出 Native Worker 可用的技能',
      status: '显示会话、模型和运行时状态',
      tasks: '切换当前会话的任务列表',
      tui: '显示渲染器状态或重启语法'
    },
    panels: {
      agents: 'Agent',
      nativeAgents: '{{count}} 个 Native Worker Agent · Task 会委派工作但不会启动第二套 Runtime',
      searchAgents: '输入搜索 · ↑↓ 查看 · Enter/Esc 关闭 · 在 ~/.open-cowork/agents 中配置',
      configuration: '配置',
      modelPicker: '选择模型',
      searchModels: '搜索',
      modelStep: '配置模型 · 第 2 步，共 2 步',
      effort: '推理强度',
      resume: '恢复会话',
      loadingSessions: '正在加载可恢复会话…',
      noSessions: '没有找到可恢复的会话。',
      rewind: '回退',
      loadingCheckpoints: '正在加载对话检查点…',
      permission: '需要权限确认',
      askUser: '问题',
      plan: '计划',
      provider: 'Provider',
      protocol: '协议',
      endpoint: '端点',
      apiKey: 'API Key',
      sharedDesktop: '与 OpenCowork 桌面端共享 · 凭据已掩码',
      enterContinue: 'Enter 继续 · Esc 返回 · Ctrl+U 清空'
    },
    statuses: {
      thinking: '思考中…',
      working: '工作中…',
      compressing: '正在压缩上下文…',
      retrying: '重试中',
      planOn: 'Plan 模式已开启 · 实现会等待你的批准 · Shift+Tab 切换',
      autoOn: '自动模式已开启 · 工具可能无需确认直接运行 · Shift+Tab 切换',
      acceptEditsOn: '接受编辑模式已开启 · Shift+Tab 切换',
      manualOn: '手动确认模式 · Shift+Tab 切换'
    },
    shortcuts: {
      commands: '命令',
      files: '引用工作区文件',
      provider: '配置 Provider',
      config: '共享设置',
      compact: '压缩上下文',
      context: '上下文用量',
      rewind: '回退对话轮次',
      modes: '循环切换模式 · 进入/离开 Plan',
      details: '展开思考/工具详情',
      tasks: '切换任务',
      model: '切换模型',
      image: '粘贴剪贴板图片',
      stash: '暂存提示词',
      cancel: '取消 / 退出',
      agents: '查看 Agent'
    },
    statusLine: {
      acceptEditsWide: '⏵⏵ 接受编辑已开启（shift+tab 切换）· ← 查看 Agent',
      acceptEditsMedium: '⏵⏵ 接受编辑已开启 · shift+tab 切换',
      acceptEditsShort: '⏵⏵ 接受编辑 · shift+tab',
      planWide: '⏸ Plan 模式已开启（shift+tab 切换）· ← 查看 Agent',
      planMedium: '⏸ Plan 模式已开启 · shift+tab 切换',
      planShort: '⏸ Plan 开启 · shift+tab',
      autoWide: '⏵⏵ 自动模式已开启（shift+tab 切换）· ← 查看 Agent',
      autoMedium: '⏵⏵ 自动模式已开启 · shift+tab 切换',
      autoShort: '⏵⏵ 自动开启 · shift+tab',
      hints: '? 查看快捷键 · ← 查看 Agent',
      shortHints: '? 快捷键',
      // Keep runtime controls and activity states consistent with their terminal terminology.
      think: 'think',
      on: 'on',
      off: 'off',
      noModel: '无模型'
    },
    spinner: {
      calculating: 'Calculating',
      considering: 'Considering',
      crafting: 'Crafting',
      processing: 'Processing',
      stewing: 'Stewing',
      thinking: 'Thinking',
      working: 'Working'
    },
    metrics: {
      tokens: 'Token',
      thinkingWith: '使用',
      effort: '推理强度'
    },
    permission: {
      yes: '是',
      yesSession: '是，本会话不再询问',
      noChange: '否，并告诉 OpenCowork 如何调整',
      wantsToUse: 'OpenCowork 想要使用',
      colon: '：',
      confirm: 'Enter 确认 · Esc 取消'
    },
    tasks: {
      inProgress: '进行中',
      pending: '待处理',
      completed: '已完成',
      more: '… +{{summary}}',
      blockedBy: '被以下任务阻塞'
    },
    files: {
      searching: '正在搜索文件…',
      noMatches: '没有匹配的文件'
    },
    model: {
      oauth: 'OAuth',
      connectedChannel: '已连接渠道',
      apiKey: 'API Key',
      useCurrent: '使用当前会话模型',
      enabledSummary: '{{models}} 个已启用模型，来自 {{providers}} 个已连接 Provider',
      noConnectedProvider: '没有已连接且启用聊天模型的 Provider。',
      configureProviderHint: '运行 /provider 或按 Enter 在终端配置 Provider。',
      noMatches: '没有匹配“{{query}}”的模型。',
      footer: '输入搜索 · ↑↓ 移动 · Enter 选择 · Esc 取消',
      selectCompression: '选择压缩模型',
      selectStepOne: '选择模型 · 第 1 步，共 2 步',
      compressionSummary: '使用已连接 Provider 的任意启用模型，或跟随当前会话模型',
      model: '模型'
    },
    config: {
      noTimeout: '无超时',
      sharedDescription: '与 OpenCowork 桌面端共享 · Provider 凭据保存在私有存储中',
      noMatches: '没有匹配“{{query}}”的设置。',
      enableCodeGraph: '请先启用 CodeGraph，再开放完整工具面板。',
      noSelection: '未选择设置。',
      footer: '输入搜索 · ↑↓ 移动 · ←→ 修改 · Enter 选择 · Esc 关闭'
    },
    effort: {
      none: '接下来几轮关闭 Provider 推理强度。',
      minimal: '使用最小可用推理配额。',
      low: '普通任务优先使用更快、更低成本的响应。',
      medium: '常规多步骤任务使用适中的推理。',
      high: '为复杂实现和验证投入更多推理。',
      xhigh: '为困难或含糊的任务使用扩展推理。',
      max: '仅在当前会话使用最高推理级别。',
      ultra: '使用此 Provider 的 ultra 推理级别。',
      other: '使用模型提供的 {{level}} 推理级别。',
      followDefault: '跟随此模型的默认级别（{{level}}）。',
      saving: '正在保存模型推理强度到 OpenCowork…',
      footer: '←→ 或 ↑↓ 调整 · Enter 应用 · Esc 取消'
    },
    modelConfig: {
      choose: '选择模型配置。',
      saving: '正在保存模型设置到 OpenCowork…',
      footer: '↑↓ 移动 · ←→ 修改 · 空格切换 · Enter 应用 · Esc 返回'
    },
    provider: {
      newCustom: '新的自定义 Provider',
      quickPreset: '快速预设',
      noKeyRequired: '已配置 · 不需要 Key',
      presetNoKey: '无需 API Key',
      keySaved: '已配置 · Key 已保存',
      needsKey: '需要 API Key',
      name: 'Provider 名称',
      baseUrl: 'Base URL',
      modelId: '模型 ID',
      configure: '配置 Provider',
      reviewTitle: '确认并保存',
      welcomeTitle: '欢迎使用 OpenCowork CLI',
      welcomeSubtitle: '开始第一轮对话前先连接模型 Provider · 与 OpenCowork 桌面端共享',
      welcomeEnter: 'Enter  打开该页面并粘贴 API Key',
      welcomeOther: 'P      选择其他 Provider',
      welcomeSkip: 'Esc    暂时跳过 · 之后可运行 /provider',
      recommended: '推荐',
      routinPitch: '一把 API Key 直连 GPT、Claude、Gemini、DeepSeek 等模型',
      keyPage: 'API Key',
      openKeyPage: 'Ctrl+O 打开页面',
      browserOpened: '已在浏览器中打开该页面。',
      browserFailed: '当前环境无法打开浏览器 — 请手动访问上面的链接创建 Key。',
      groupConfigured: '你的 Provider',
      groupPresets: '快速预设',
      groupCustom: '自定义端点',
      step: '第 {{current}} / {{total}} 步',
      endpointPending: '端点待填写',
      modelPending: '模型待填写',
      noMatches: '没有匹配“{{query}}”的 Provider。',
      listFooter: '输入搜索 · ↑↓ 移动 · Enter 选择 · Esc 取消',
      saved: '已保存',
      notRequired: '不需要',
      savedUnder:
        '已保存到 {{directory}}，使用私有文件权限。已有 Provider 字段和其他 Provider 均会保留。',
      reviewFooter: 'Enter 保存 · M 模型 · E 端点',
      keyShortcut: 'K Key',
      nameShortcut: 'N 名称',
      nameHint: '模型选择器中显示的简短名称。',
      endpointHint: 'HTTP(S) API 根地址，例如 https://api.example.com/v1。',
      keepKeyHint: '留空以保留已保存的 Key。输入显示为 • · Ctrl+V 粘贴。',
      keyHint: '显示为 • · Ctrl+V 粘贴 · 仅保存到共享 Provider 存储。',
      keyPlaceholder: '粘贴或输入 API Key',
      keyChars: '已输入 {{count}} 个字符 · 显示为 •',
      keyFooter: 'Enter 继续 · Esc 返回 · Ctrl+V 粘贴 · Ctrl+U 清空',
      readingClipboard: '正在读取剪贴板…',
      clipboardEmpty: '剪贴板为空。',
      modelHint: '发送给 Provider 的准确模型标识符。'
    },
    resume: {
      description: '从当前工作区恢复已完成的 CLI 对话',
      noSessions: '当前工作区没有可用的已完成 OpenCowork CLI 会话。',
      noMatches: '没有匹配“{{query}}”的会话。',
      resuming: '正在恢复会话… · Esc 中断',
      footer: '输入搜索 · ↑↓ 移动 · Enter 恢复 · Esc 取消'
    },
    rewind: {
      choose: '选择如何回退到此消息之前：',
      working: '处理中… · Esc 中断',
      confirmFooter: '↑↓/jk 移动 · Enter 选择 · 1-3 快速选择 · Esc 返回',
      description: '选择要恢复的之前对话轮次',
      footer: '↑↓/jk 选择轮次 · Enter 继续 · Esc 取消'
    },
    plan: {
      awaitingReview: '等待审阅',
      implementing: '实现中',
      completed: '已完成',
      revisionRequested: '已请求修改',
      approved: '已批准',
      drafting: '起草中',
      autoAccept: '是，自动接受编辑',
      manualApprove: '是，手动批准编辑',
      keepPlanning: '否，继续规划',
      file: '计划文件：{{path}}',
      storedInWorker: '计划存储在 Worker 会话中。',
      addFeedback: '请添加反馈，让 Worker 修改计划',
      reviewStaysOpen: '计划审阅会一直打开，直到你批准或提供反馈',
      mode: '计划模式',
      planningFirst: '先规划 · 实现会等待你的批准',
      approvalRequired: '规划中 · 需要批准',
      researching: 'Native Worker 正在研究并起草计划…',
      whatChange: '需要修改什么？',
      feedbackFooter: 'Enter 请求修改 · Esc 返回',
      chooseContinue: '选择 OpenCowork 接下来如何继续',
      reviewFooterWide: '↑↓ 选择 · Enter 确认 · Ctrl-G 显示文件 · Ctrl-C 中断',
      reviewFooterShort: '↑↓ 选择 · Enter 确认',
      draftFooter: 'Ctrl-G 显示计划文件 · Ctrl-C 中断',
      interrupt: 'Ctrl-C 中断',
      cycle: 'Shift+Tab 切换 · 退出计划模式'
    },
    askUser: {
      unableToRender: '无法显示用户问题。',
      title: 'OpenCowork 需要你的输入',
      questionCount: '问题 {{current}} / {{total}}',
      noteOptional: '添加备注（可选）',
      yourAnswer: '你的回答',
      saveReturn: 'Enter 保存 · Esc 返回',
      ready: '准备提交',
      submitFooter: 'Enter 提交 · ← 回看上一个回答',
      preview: '预览',
      textEntry: '文本输入',
      submitHint: 'Enter 提交 · ← 回看',
      multiHint: '↑↓ 移动 · 空格选择 · Enter 确认 · N 备注 · ←→ 切换问题 · Ctrl-C 取消',
      singleHint: '↑↓ 移动 · Enter 选择 · N 备注 · ←→ 切换问题 · Ctrl-C 取消'
    },
    prompt: {
      removedFileReference: '已移除最后一个文件引用',
      removedImage: '已移除最后一张图片',
      readingClipboard: '图片 {{count}} · 正在读取剪贴板图片…',
      images: '图片 {{count}}',
      removeLastImage: '空输入时按 Backspace 移除最后一张',
      references: '引用 {{count}} 个',
      removeLastReference: '空输入时按 Backspace 移除最后一个引用'
    },
    runtime: {
      configurationUnavailable: '当前 Runtime 不支持配置',
      providerSetupUnavailable: '当前 Runtime 不支持 Provider 配置',
      providerReady: 'Provider 已就绪 · {{provider}} / {{model}}',
      retry: '重试',
      retryIn: '将在',
      turnRunning: '已有会话正在运行 · Esc 中断',
      visionUnsupported: '当前模型不支持图片输入 · 使用 Alt-P 选择 Vision 模型',
      compactUnavailable: '当前 Runtime 不支持手动压缩上下文。',
      workerRunning: '已有 Worker 操作正在运行',
      compactInterrupted: '上下文压缩已中断',
      startingSession: '正在启动新会话…',
      clearingContext: '正在清除上下文…',
      newSessionReady: '新的 Native Worker 会话已就绪',
      contextCleared: '规范上下文已清除',
      checkingWorker: '正在检查 Native Worker…',
      configurationSaved: '配置已保存到 OpenCowork',
      resumingSession: '正在恢复会话…',
      resumedSession: '已恢复会话 · {{count}} 条规范消息',
      summarizingConversation: '正在总结对话…',
      restoringCode: '正在恢复代码…',
      restoringCodeConversation: '正在恢复代码和对话…',
      restoringConversation: '正在恢复对话…',
      updateAvailable: 'OpenCowork {{version}} 已发布 · 运行 `cowork update` 升级'
    },
    transcript: {
      thoughtFor: '思考了 {{seconds}} 秒',
      thought: '思考',
      traceNotExposed: '未公开 trace',
      noTrace: '无 trace',
      expandDetails: 'ctrl+o 展开',
      edited: '已编辑 {{path}}'
    }
  }
} as const

let initialized = false
let activeLanguage: CliLanguage = 'en'

function normalizeLanguageTag(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.utf-?8$/u, '')
    .replace(/@.+$/u, '')
    .replace(/_/g, '-')
}

export function normalizeCliLanguage(value?: string | null): CliLanguage {
  const normalized = normalizeLanguageTag(value ?? '')
  if (!normalized) return 'en'

  const base = normalized.split('-')[0]
  return languageSet.has(base) ? (base as CliLanguage) : 'en'
}

function tryNormalizeCliLanguage(value?: string | null): CliLanguage | undefined {
  const normalized = normalizeLanguageTag(value ?? '')
  if (!normalized) return undefined

  const base = normalized.split('-')[0]
  return languageSet.has(base) ? (base as CliLanguage) : undefined
}

function firstLanguageCandidate(value?: string | null): string | undefined {
  const candidate = value?.split(':').find((item) => item.trim())
  return candidate?.trim() || undefined
}

/** Read the host locale without requiring a browser or desktop renderer. */
export function detectSystemLanguage(): CliLanguage {
  const environmentCandidates = [
    process.env.LC_ALL,
    process.env.LC_MESSAGES,
    process.env.LANG,
    process.env.LANGUAGE
  ]
  for (const candidate of environmentCandidates) {
    const environmentLanguage = tryNormalizeCliLanguage(firstLanguageCandidate(candidate))
    if (environmentLanguage) return environmentLanguage
  }

  try {
    return tryNormalizeCliLanguage(Intl.DateTimeFormat().resolvedOptions().locale) ?? 'en'
  } catch {
    return 'en'
  }
}

/**
 * Commander parses options after it has already constructed help text. Pre-reading the language
 * option lets `cowork --language zh --help` be localized too.
 */
export function readLanguageArgument(
  argv: readonly string[] = process.argv.slice(2)
): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--language' || argument === '-l') {
      return argv[index + 1]
    }
    if (argument.startsWith('--language=')) {
      return argument.slice(argument.indexOf('=') + 1)
    }
    if (argument.startsWith('-l=')) {
      return argument.slice(argument.indexOf('=') + 1)
    }
  }
  return undefined
}

export function resolveCliLanguage(requestedLanguage?: string | null): CliLanguage {
  if (requestedLanguage?.trim()) return normalizeCliLanguage(requestedLanguage)

  const environmentLanguage = process.env.OPEN_COWORK_LANGUAGE?.trim()
  const resolvedEnvironmentLanguage = tryNormalizeCliLanguage(environmentLanguage)
  if (resolvedEnvironmentLanguage) return resolvedEnvironmentLanguage

  try {
    const configuredLanguage = loadOpenCoworkConfiguration().settings.language
    if (typeof configuredLanguage === 'string' && configuredLanguage.trim()) {
      const resolvedConfiguredLanguage = tryNormalizeCliLanguage(configuredLanguage)
      if (resolvedConfiguredLanguage) return resolvedConfiguredLanguage
    }
  } catch {
    // A missing or malformed shared settings file must not prevent the CLI from starting.
  }

  return detectSystemLanguage()
}

export async function initializeCliI18n(requestedLanguage?: string | null): Promise<CliLanguage> {
  activeLanguage = resolveCliLanguage(requestedLanguage)
  if (initialized) {
    if (i18n.language !== activeLanguage) await i18n.changeLanguage(activeLanguage)
    return activeLanguage
  }

  await i18n.init({
    resources: {
      en: { translation: englishResources },
      zh: { translation: chineseResources }
    },
    lng: activeLanguage,
    fallbackLng: 'en',
    supportedLngs: [...SUPPORTED_CLI_LANGUAGE_CODES],
    nonExplicitSupportedLngs: true,
    load: 'currentOnly',
    showSupportNotice: false,
    interpolation: {
      escapeValue: false
    }
  })
  initialized = true
  return activeLanguage
}

export function getCliLanguage(): CliLanguage {
  return activeLanguage
}

export function translate(
  key: string,
  defaultValue: string,
  values?: Record<string, unknown>
): string {
  if (!initialized) return defaultValue
  return i18n.t(key, {
    defaultValue,
    ...values
  })
}

export const t = translate
