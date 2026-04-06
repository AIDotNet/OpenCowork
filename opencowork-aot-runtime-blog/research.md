# 研究笔记：OpenCoWork 宣传博客（.NET AOT Runtime 方向）

## 主题陈述
为 OpenCoWork 写一篇中文宣传博客。重点突出：
- OpenCoWork 是什么
- 它的核心功能与产品气质
- 它解决了哪些真实问题
- .NET AOT / .NET Runtime 迁移后的性能优势
- 轻松接入第三方套餐
- 支持直接登录账户体系使用，不必把“先买 API Key、先充值接口”当成唯一入口

## 受众假设
- 想把 AI 真正接入工作流的开发者
- 已经厌倦“聊天框 + 复制粘贴”的高频用户
- 需要多任务、多工具、多模型协作的人
- 希望低门槛上手 Agent 的个人用户与小团队

## 本次研究范围
本轮写作主要基于：
- 用户提供的性能与版本信息
- 本地仓库 README、CHANGELOG、provider preset、运行时与功能代码
- 未进行额外外网爬取；如涉及版本体验数据，以用户提供材料为主

## 已确认事实

1. **产品定位**
   - OpenCoWork 在仓库中被描述为“开源桌面多智能体协作平台”。
   - package.json 描述为：用于多智能体 AI 协作、支持本地工具与办公集成的开源桌面平台。

2. **它不是纯聊天框，而是带工具执行能力的桌面 Agent 平台**
   - README 明确强调：可读写本地文件、执行 Shell 命令、搜索代码、做 UI 预览。
   - README 同时强调上下文感知、任务编排、人类在回路中的控制能力。

3. **多智能体协作是核心卖点**
   - README 中明确写到主智能体可以协调并行队友。
   - 代码中存在 SubAgent 相关运行与展示模块。

4. **OpenCoWork 支持办公/消息渠道接入**
   - README 提到飞书、钉钉、Discord 等。
   - 主进程频道系统代码显示其具备插件化消息渠道能力。

5. **具备定时与后台运行能力**
   - `cron-scheduler.ts` 显示支持 `at / every / cron` 三类调度。
   - CHANGELOG 0.7.4 说明 scheduled agents 已支持主进程后台执行。

6. **具备 MCP 集成能力**
   - `mcp-manager.ts` 显示支持连接多个 MCP server，并调用其 tools/resources/prompts。

7. **具备 SSH 工作能力**
   - `SshPage.tsx` 显示支持远程连接、终端、多标签、文件浏览与编辑。
   - CHANGELOG 0.6.6 提到支持 OpenSSH 配置导入。

8. **具备工作区记忆与项目记忆能力**
   - CHANGELOG 0.6.6 提到优先使用工作区 `.agents` 记忆文件。
   - 这意味着它能更像“长期搭档”，而不是每次都从零开始。

9. **Provider 与模型接入非常丰富**
   - 内置 provider preset 包含：Routin AI、Routin AI（套餐）、OpenAI、Anthropic、Google、DeepSeek、OpenRouter、Ollama、Azure OpenAI、Moonshot、Qwen、Baidu、MiniMax、SiliconFlow、Gitee AI、Xiaomi、Bigmodel，以及 OAuth 方式的 Codex / GitHub Copilot。

10. **支持轻松接入第三方套餐**
    - `routin-ai.ts` 中存在明确的 `Routin AI（套餐）` 预设。
    - 其 base URL 指向 `https://cn.routin.ai/plan/v1`，并内置一组模型列表。

11. **支持直接登录账户体系使用，不一定非要 API Key**
    - `codex-oauth.ts` 中 `requiresApiKey: false`，`authMode: 'oauth'`，默认走 `https://chatgpt.com/backend-api/codex`。
    - `provider-auth.ts` 中存在完整 OAuth 登录、刷新、账户信息写回逻辑。
    - CHANGELOG 还提到会发送 `Chatgpt-Account-Id` 用于 OpenAI Responses 账户型请求。

12. **GitHub Copilot 也可直接 OAuth 登录**
    - `copilot-oauth.ts` 中 `requiresApiKey: false`，且支持 device code flow。
    - 其模型配置中还包含 `availablePlans` 信息，说明系统在设计上考虑了账户/套餐体系接入，而不仅是裸 API Key。

13. **技能市场的进入门槛被刻意降低**
    - CHANGELOG 0.6.6 提到：用户无需先提供 API Key，也可以浏览与测试 skills market 可用性。

14. **.NET AOT Runtime 是真实架构方向，而非宣传口号**
    - `.csproj` 中明确配置：`TargetFramework net10.0`、`PublishAot true`、`TrimMode full`。
    - CHANGELOG 0.7.10 写明：更多 provider 与消息处理工作已迁移到 .NET sidecar/backend。

15. **性能数据来源说明**
    - 用户提供的数据指出：迁移到 .NET Core AOT 后，CPU 占用明显下降。
    - 空闲内存约 20MB；多任务平均约 200MB。
    - 旧版 JS 架构高压场景可能到 2GB；新版本多任务并行通常控制在 800MB 左右，而 .NET Core Agents Runtime 基本稳定在约 200MB。
    - 以上数字在本轮未做独立复测，应以“当前版本体验数据/用户提供数据”表述，而非声称为本次亲测结论。

## 文章可采用的角度

### 角度 A：把 AI 从“会聊天”拉回“会干活”
强调 OpenCoWork 的本地工具、SSH、MCP、定时任务、插件渠道等，让 AI 真正进入工作现场。

### 角度 B：不只是更强，而是更轻
将 .NET AOT Runtime 的 CPU / 内存优势作为强记忆点，突出“性能体验可感知”。

### 角度 C：不是把门槛堆高，而是把门槛拆掉
突出三种接入路径：
- 标准 API Key
- 第三方套餐
- 直接 OAuth 登录账户体系

## 风险与边界

1. “无需付费”表述需要谨慎。
   - 更稳妥的表达应为：**无需额外购买 API Key 套餐作为唯一前置条件**，或 **可直接登录现有账户体系使用**。
   - 避免无条件宣称所有场景都完全免费。

2. 性能数字需注明来源。
   - 建议写成“按当前版本体验数据/提供数据来看”。

3. 宣传口吻可以鲜活，但不能偏离已确认功能。

## 建议大纲

1. 开头：很多 AI 像会说话的旁观者，OpenCoWork 想做的是能下场干活的搭档。
2. OpenCoWork 是什么：开源桌面多智能体协作平台。
3. 它能做什么：
   - 本地工具执行
   - 多智能体协作
   - SSH / MCP / Cron / 渠道接入 / Skills
4. 它为什么更好用：
   - 降低上下文搬运成本
   - 减少重复配置
   - 打通本地、远程、办公消息系统
5. 它为什么更值得现在体验：
   - .NET AOT Runtime 带来的性能优势
6. 它为什么更容易上手：
   - 第三方套餐
   - 直接登录账户体系
   - 不把 API Key 作为唯一入口
7. 结尾：把复杂度留给系统，把轻量、稳定、流畅交给用户。

## 自评目标
- 语言拟人化、有个性，但不过度浮夸
- 宣传感强，但信息密度也够
- 让读者在 1 篇文章里理解：OpenCoWork 是什么、能做什么、为什么现在值得试
- 把“性能优势”和“低门槛接入”都打成记忆点

## 自评后应重点优化的方向
- 开头是否足够抓人
- 功能是否说人话，而不是只报模块名
- “无需付费”是否处理得既有宣传力又不失真
- 结尾 CTA 是否足够明确

## 初稿自评

### 优点
1. 开头有画面感，比较容易把“聊天型 AI”和“执行型 Agent”区分开。
2. 结构完整，已经覆盖了 OpenCoWork 是什么、能做什么、解决什么问题、性能为什么重要、接入为什么更轻松。
3. 产品宣传感比较强，拟人化表达也基本到位，不像说明书。
4. 关键宣传点都能被仓库内容支撑，没有完全脱离事实。

### 不足
1. 文章整体偏“顺着讲”，传播性还可以更强，缺少几个更能被转述的金句。
2. 功能部分虽然清楚，但还可以再贴近真实工作场景，减少一点“模块罗列感”。
3. “无需付费”这件事如果说得太满会有风险，更适合表达为：不需要把额外购买 API Key 当成唯一前置条件，可直接登录已有账户体系或接入套餐方案。
4. 性能段落已经有数字，但还可以再强化“这对用户真实意味着什么”，而不只是停留在参数对比。
5. 结尾 CTA 还不够有节奏，可以更像一次明确邀请，而不是普通收束。

## 改进策略
1. 加强开头与中段的记忆句，让文章更像一篇有个性的产品表达，而不是一篇普通介绍文。
2. 用“工作现场”的语言重写功能价值，例如把 SSH、MCP、Cron、渠道接入解释成 AI 真正进入团队与环境的方式。
3. 将“无需付费”修改为更稳妥、更可信的宣传表述：无需额外采购 API Key 才能开始，可通过第三方套餐或直接登录账户体系快速上手。
4. 强化 .NET AOT Runtime 段落，把“低占用”翻译成“敢长期挂着跑、敢多任务并行、机器不容易被拖慢”的体验语言。
5. 收尾改成更有行动感的发布式结尾，增强 GitHub Release 的引导点击意愿。
