## 目标

修正会话切换/初次打开消息列表时的显示时序：在消息窗口和虚拟行尚未完成初始测量、底部定位尚未稳定前，持续显示加载动画；完成后一次性以底部位置显示消息，避免用户看到半成品消息逐步出现或看到列表缓慢滚到底部。

## 已确认的现状

- 主要逻辑集中在 [`src/renderer/src/components/chat/MessageList.tsx`](/Users/token/Desktop/code/OpenCowork/src/renderer/src/components/chat/MessageList.tsx) 的 `MessageListInner`。
- 组件已有 `MessageWindowPhase`：`loading → positioning → ready`，并在 `positioning` 阶段通过 `visibility: hidden` 隐藏列表。
- 但当前只有 `isAwaitingInitialMessages`（消息数组为空且仍在等待数据库窗口）时返回骨架；消息已经进入 store、但仍处于 `loading/positioning` 时，会挂载隐藏列表而没有明确的加载动画。
- 列表当前仅在 `positioning` 阶段隐藏；会话切换进入 `loading` 时可能短暂暴露未完成内容。
- 初始底部定位和高度稳定检查位于 `MessageList.tsx` 约 2288–2481 行：通过 `scrollToBottomImmediate`、`ResizeObserver` 和连续稳定帧判断何时切换到 `ready`。这条链路应继续作为唯一的初始定位机制。
- 父级 [`src/renderer/src/components/layout/SessionConversationPane.tsx`](/Users/token/Desktop/code/OpenCowork/src/renderer/src/components/layout/SessionConversationPane.tsx) 只是渲染 `MessageList`，不需要新增 props、IPC 或跨进程状态。
- 当前工作区已有其他未提交修改；实施时只触碰本需求相关文件。

## 实施步骤

1. **统一初始阶段的可见性与加载态（`MessageList.tsx`）**
   - 引入现有项目风格的加载图标（`lucide-react` 的 `Loader2`），并使用 `animationsEnabled` 控制旋转动画。
   - 保持虚拟列表 DOM 挂载，以便继续完成真实行高测量和虚拟器布局；但在 `messageWindowPhase` 为 `loading` 或 `positioning` 时统一隐藏消息内容。
   - 在 `data-message-list` 容器内增加覆盖层，加载期间显示居中的加载动画和可访问的状态文本；覆盖层不参与滚动，也不改变消息列表的高度计算。
   - 保留现有“无消息等待数据库窗口”的骨架/错误分支语义；当消息已加载但仍在定位时，改为显示统一加载动画，而不是空白隐藏区域。
   - `ready` 后移除覆盖层并显示列表；空会话仍显示现有建议提示，不被初始加载态拦截。
   - 通过 `t(..., { defaultValue })` 提供状态文本，避免为了一个提示同步修改全部语言包。

2. **保证“先定位、后显示”顺序（`MessageList.tsx`）**
   - 保留现有 `scrollToBottomImmediate` 的即时滚动方式，初始定位不使用 smooth behavior。
   - 调整初始稳定检查的提交顺序：每次稳定帧先同步 turn spacer、重新钉住底部并确认距离底部在容差内，随后才把窗口标记为 `ready`。
   - 在从 `positioning` 切到 `ready` 的最后一次布局提交前，再做一次同步底部校正，确保可见的第一帧已经位于最终底部。
   - 保持 `ResizeObserver` 对异步 Markdown、工具卡片、图片等导致的高度变化的重置能力；任何高度变化都应继续延长加载态，直到连续稳定帧达标。
   - 不改变用户主动向上滚动后的 `autoScrollMode` 语义；本次行为只作用于会话初始窗口定位。

3. **处理异常和现有特殊分支**
   - `error` 阶段继续走现有错误/重试路径，避免错误状态被加载覆盖层遮住。
   - `exportAll` 和 `StaticMessageTranscript` 不纳入初始交互式滚动逻辑，保持现有导出/静态渲染行为。
   - 不新增 store 字段，不改 runtime contract，不改 Main/Worker/IPC。

## 验证

实施后按仓库约定执行：

- `npm run typecheck`
- `npm run lint`
- 手动 smoke：切换到包含较长历史、工具调用和 Markdown 的会话，确认切换期间只见加载态，加载完成后首帧直接在底部；再验证空会话、错误重试、用户向上滚动、流式输出和“加载更早消息”。

若自动检查存在当前工作区已有修改导致的失败，将区分记录为预-existing failure，不扩大本次改动范围。
