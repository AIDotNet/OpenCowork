# 07 — 索引可视化数据展示 & 手动选目录构建索引（设计）

> **目标（用户需求）：**
> 1. 为 CodeGraph 插件增加**每个项目的索引可视化数据展示**；
> 2. 支持**手动选择项目目录**来构建索引。
>
> 本文是落地设计，锚定当前**真实代码状态**（不是纯规划）。CodeGraph 引擎已建到
> ~M5：C# sidecar 能索引仓库并回答 `codegraph/*` RPC；但渲染端只有一个设置面板小节，
> 没有独立页面、没有可视化、没有"添加任意目录"入口。本文补齐这两块。

---

## 0. 现状盘点（设计基线）

| 层 | 已有 | 缺口 |
|---|---|---|
| **C# 引擎** | `CodeGraphEngine`：`IndexAll` / `Sync` / `GetStats`（含 `NodesByKind`/`EdgesByKind`/`FilesByLanguage`）/ `Traverse` / `GetContext` / `GetCallGraph` / `GetImpactRadius` / `GetFiles` / `GetIndexState` / `IsIndexStale` | 结构化 JSON 读接口**未暴露**——`GetStats`/子图只在进程内，RPC 只吐 markdown |
| **RPC 面** | `index`·`sync`·`status`·`explore`·`search`·`node`·`callers`·`callees`·`impact`·`files`·`list-projects`·`remove-project`·`tools-list`·`instructions` | 无 `index-status`(结构化)、`stats`、`query-neighbors`(子图 DTO)——可视化要的正是这些 |
| **主进程** | `handleCodeGraphRequest` 透传所有 `codegraph/*`；`fs:select-folder` 通用选目录通道；index 进度事件 `codegraph/index-progress`·`codegraph/index-complete` | — |
| **渲染端** | 仅 `AppPluginPanel.tsx:782-914` 的项目列表小节（root/state/files/nodes/edges/dbSize/lastIndexed + Index/Sync/Delete） | 无独立页面、无 NavRail 入口、无 KPI/图表、无图谱画布、**无"添加目录"按钮** |

**关键结论：** 可视化的前置条件是"结构化数据"。当前 `codegraph/*` 读接口几乎都返回
`CodeGraphToolResult`（给 agent 看的 markdown 文本），无法驱动图表/图谱。所以**第一步永远是
补 3 个结构化 RPC**（Tier 0），其余 UI 都建在它之上。

**可复用的现成积木：**
- 选目录：`IPC.FS_SELECT_FOLDER`（`fs:select-folder`）→ `{ canceled?, path? }`。
- 页面骨架：Draw/SSH 的 overlay-page 约定（NavRail → ui-store 标志位 → Layout 分支渲染）。
- KPI 磁贴：`SshDashboardStats.tsx` 的 `grid` + 卡片模式。
- 图表：`AnalyticsOverview.tsx` 的 recharts 封装（画图前先读 `dataviz` skill）。
- 图谱画布：`components/draw/graph/`（DOM 节点 + SVG 连线 + camera store，纯自研、领域无关）。

---

## 1. 手动选目录构建索引

### 1.1 交互
在**新 CodeGraph 页**（§3）和现有设置面板小节各放一个「**添加项目 / 索引新目录**」按钮：

```
[＋ 索引新目录]  → fs:select-folder → 拿到 path
   ├─ 校验：非拒绝根（$HOME, /, /etc …，见引擎 unsafeIndexRootReason / path_refusal）
   ├─ 若该 root 已在 list-projects 中 → 提示"已索引，是否重建？"，走 reindex 语义
   └─ 否则 → codegraph/index({ workingFolder: path, indexId })，订阅进度，完成后刷新列表
```

### 1.2 渲染端调用（零新增 TS 管道，走 agentBridge 透传）
```ts
// 1) 选目录
const picked = (await ipcClient.invoke(IPC.FS_SELECT_FOLDER, {})) as
  { canceled?: boolean; path?: string }
if (picked.canceled || !picked.path) return
const root = picked.path

// 2) 订阅流式进度（主进程已把 worker 事件转发到渲染端，按 indexId 关联）
const indexId = crypto.randomUUID()
const off = ipcClient.on('codegraph:index-progress', (p) => updateBar(p /* {indexId,phase,filesDone,filesTotal,nodeCount,edgeCount} */))

// 3) 触发全量索引（显式大 timeout；省略会以 null 过 msgpack，命不中 JS 默认 60s）
const res = (await agentBridge.request(
  'codegraph/index', { workingFolder: root, indexId }, 15 * 60_000
)) as { success: boolean; state: 'complete'|'partial'|'failed'; nodeCount: number; edgeCount: number; error?: string }
off()
// 注意：失败也会 resolve（§critical error convention），必须查 res.success / res.error
```

### 1.3 落点
- **快路径（今天就能做）**：在 `AppPluginPanel.tsx` 项目小节标题右侧，`indexCurrent` 旁加
  「索引新目录」按钮，复用已有的 `handleCgIndex(root)` + `runCgAction`。改动 < 30 行。
- **正式落点**：新页面头部工具条（§3）。

### 1.4 边界
- `path_refusal` → 硬失败，Toast 明确"该目录不可索引"，不重试。
- 索引期间禁用重复触发（沿用 `cgBusyKey` 单飞锁）。
- 进度条用 `phase`（scan/extract/resolve/synthesize/maintenance）+ `filesDone/filesTotal`。

---

## 2. Tier 0 — 结构化数据 RPC（C# 侧，可视化的地基）

在 `CodeGraphModule.Register` 增加 3 个方法，全部**基于引擎已有能力**，只是加"结构化 DTO +
源生成 JSON 注册"。DTO 全部进 `CodeGraphJsonContext`（反射关闭，`[JsonSerializable]`）。

### 2.1 `codegraph/index-status`（结构化健康快照）
- **背靠：** `GetIndexState` + `GetLastIndexedAt` + `GetStats` + `IsIndexStale` + `GetIndexBuildInfo` + 未决引用数。
- **入参：** `workingFolder`(必填)。
- **出参 `CodeGraphIndexStatus`：** `success, indexed, state?, indexing, lastIndexedAt?, fileCount, nodeCount, edgeCount, pendingReferenceCount, dbSizeBytes, backend, journalMode, stale, indexedWithVersion?`。
- **未索引** → 成功形（`indexed:false, success:true`），非 error。

### 2.2 `codegraph/stats`（分类明细，图表主数据）
- **背靠：** `CodeGraphEngine.GetStats()` → `CodeGraphStats`（已含 3 张分布表）。
- **入参：** `workingFolder`(必填)。
- **出参 `CodeGraphStatsResult`：** `success, nodeCount, edgeCount, fileCount, nodesByKind[], edgesByKind[], filesByLanguage[], dbSizeBytes, lastUpdated?`。
  - 字典→**数组**上线（`{ key, count }[]`），wire 上不放 `Map`（AOT/约定一致）。
- 这是**唯一必须新增的引擎数据出口**——`NodesByKind`/`EdgesByKind`/`FilesByLanguage` 目前只在
  markdown `status` 里，图表拿不到。

### 2.3 `codegraph/query-neighbors`（局部子图，图谱画布数据）
- **背靠：** `Traverse(id, opts)` / `GetContext(id)` → `CodeGraphSubgraph`（已有 `Nodes/Edges/Roots`）。
- **入参：** `workingFolder`(必填), `nodeId` **或** `symbol`(二选一), `depth`(默认 1), `edgeKinds?`(过滤), `limit`(默认 100)。
- **出参 `CodeGraphSubgraphResult`：** `success, nodes: NodeDto[], edges: EdgeDto[], roots: string[], error?`。
  - `NodeDto`: `id, kind, name, qualifiedName?, filePath, language, startLine, endLine, signature?, isExported?`。
  - `EdgeDto`: `source, target, kind, line?, provenance?, synthesizedBy?`。
- 未知节点 → `success:true, nodes:[]`（不报错）。

> 三者都遵守既有铁律：`WorkerResponse.Error` 在 JS 侧**resolve 不 reject**，故每个 DTO 自带
> `success/error/errorKind`；`not_indexed`→成功形引导，`path_refusal`→硬失败；结果里**禁止
> NaN/Infinity**（transcoder 会抛，除零分数一律归 0）。

### 2.4 `codegraph/files-tree`（结构化文件树，可交互树的数据源）
- **背靠：** `CodeGraphEngine.GetFiles()` + 每文件的 `NodeCount`/`Language`（`CodeGraphFileRecord` 已有）。
- **入参：** `workingFolder`(必填), `path?`(子目录过滤), `maxDepth?`。
- **出参 `CodeGraphFilesResult`：** `success, files: FileNodeDto[]`，
  - `FileNodeDto`: `path, language, nodeCount, size, indexedAt?`（扁平数组，前端自行折成树；或直接返回 `dir`/`file` 两类节点）。
- 与现有 markdown `codegraph/files` 并存：markdown 供 agent，`files-tree` 供 UI 可点树。
- **交互语义**：点文件 → 该文件符号列表（`codegraph/node` file 模式 / `GetNodesInFile`）→ 点符号 → 跳 §4 图谱画布种子（`query-neighbors`）。

### 2.5 工作量
纯"包一层 DTO + 注册"，无新算法。4 个方法 + ~8 个 record + `CodeGraphJsonContext` 条目。
`list-projects` 也建议顺手补 `stale`/`pendingReferenceCount` 两个字段（列表徽标要用）。

---

## 3. Tier 1 — 索引数据看板（推荐首个可交付切片）

### 3.1 页面接入（照搬 Draw/SSH overlay-page 约定）
1. `ui-store.ts`：加 `NavItem` 值 `'codegraph'` + `codeGraphPageOpen` 标志位 + `openCodeGraphPage()`/`closeCodeGraphPage()`（互斥置位，复制 `openDrawPage` 那段）。
2. `NavRail.tsx`：注册表加 `{ value:'codegraph', icon:<Waypoints/>, labelKey:'navRail.codegraph' }`（图标沿用插件已用的 `Waypoints`）；`handleNavClick` 分派 `openCodeGraphPage()`。
3. `Layout.tsx`：`lazy(() => import('@renderer/components/codegraph/CodeGraphPage'))` + 在页面链里加 `codeGraphPageOpen ? (...)` 分支。
4. 新建 `stores/codegraph-store.ts`（照 `ssh-store.ts`：状态 + 动作 + 用 `agentBridge.request` 拉数），加载态/错误态/单飞锁。
5. i18n：`locales/en/layout.json` 加 `navRail.codegraph` + `codegraphPage.*`，镜像到其余 15 种语言（既有 `settings.json` 里已有 codegraph 文案可参考）。

### 3.2 看板布局
```
┌ CodeGraph 索引 ───────────────────────────── [项目选择器 ▾] [＋索引新目录] [重建] [同步] ┐
│                                                                                          │
│  ┌ KPI 磁贴行（SshDashboardStats 模式）─────────────────────────────────────────────┐  │
│  │  文件 1,240 │ 节点 38,902 │ 边 51,733 │ 未决引用 12 │ DB 96 MB │ 状态 ● complete │  │
│  └───────────────────────────────────────────────────────────────────────────────────┘  │
│  ┌ 新鲜度卡片 ────────────────────┐  ┌ 语言分布（filesByLanguage，条形/树图）────────┐  │
│  │ 上次索引 2026-07-16 14:22       │  │ ts 620 · py 210 · go 180 · rust 90 · …        │  │
│  │ 抽取版本 v8   ● 最新 / ⚠ 过期   │  │                                               │  │
│  │ backend: sqlite  journal: wal   │  └───────────────────────────────────────────────┘  │
│  └────────────────────────────────┘  ┌ 节点类型分布（nodesByKind，条形）─────────────┐  │
│  ┌ 边类型分布（edgesByKind，条形）─┐  │ function 12k · method 9k · class 3k · …       │  │
│  └────────────────────────────────┘  └───────────────────────────────────────────────┘  │
│                                                                                          │
│  ┌ 项目列表 / 文件树（codegraph/files 或 list-projects）────────────────────────────┐  │
│  │  逐项目行（复用面板现有卡片）：root · state 徽标 · files/nodes/edges · dbSize · 时间 │  │
│  │  行内操作：Index / Sync / Delete；过期项目高亮"需重建"                              │  │
│  └───────────────────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

### 3.3 数据来源
- 顶部选择器：`codegraph/list-projects` 全量项目；选中某项目后：
- KPI + 新鲜度：`codegraph/index-status`（§2.1）。
- 三张分布图：`codegraph/stats`（§2.2）。**画图前调用 `dataviz` skill**统一配色/布局；深/浅色主题都要出。
- 文件树（**可交互，已定**）：`codegraph/files-tree`（§2.4）→ 可折叠/可点击的文件树；点文件展开符号列表，点符号跳 §4 图谱画布。
- 进度：订阅 `codegraph:index-progress`/`codegraph:index-complete`，索引/同步时顶部显示进度条。

### 3.4 复用现有面板
`AppPluginPanel.tsx:782-914` 的项目卡片/操作逻辑（`handleCgIndex`/`handleCgSync`/`handleCgRemoveProject`/`formatDbSize`）抽成共享组件 `components/codegraph/CodeGraphProjectRow.tsx`，页面与设置面板共用，避免两份实现漂移。

---

## 4. Tier 2 — 交互式代码图谱画布（进阶）

复用 `components/draw/graph/` 的相机/连线/画布层（`graph-geometry.ts`·`EdgeLayer.tsx`·`GraphCanvas.tsx` 基本领域无关），换掉领域层：

- **节点类型**：`file` / `symbol`(function·method·class·interface…) / `module`；各写一个 `nodes/*View`。
- **边**：`calls` / `imports` / `extends` / `implements` / 合成边（用 `provenance:'heuristic'` 虚线区分）。
- **种子 & 展开**：从符号搜索（`codegraph/search`）或点选文件切入 → `codegraph/query-neighbors`（§2.3）按 `depth` 拉局部子图 → 点节点"展开邻居"渐进加载（避免一次吐全图）。
- **上下游高亮**：复用 Draw 已有的 `upstreamNodeIds`/`downstreamNodeIds`，把"谁调用我 / 我调用谁 / 改动影响面"直接映射到 `callers`/`callees`/`impact` 语义。
- **性能护栏**：`limit`/`depth` 封顶；大图默认只画种子 + 1 跳；小地图（`GraphMinimap`）已有。

> Tier 2 价值高但成本也高（新领域节点/视图 + 渐进加载）。建议 **Tier 0+1 先落地**，图谱画布作为
> 第二迭代。

---

## 5. 落地顺序与工作量

| 步 | 内容 | 侧 | 规模 |
|---|---|---|---|
| **S1** | 手动选目录 → 索引（页面/面板加按钮，复用 `fs:select-folder` + `handleCgIndex`） | 渲染 | XS |
| **S2** | Tier 0：`index-status` + `stats` + `query-neighbors` + `files-tree` 四个结构化 RPC + JsonContext | C# | S |
| **S3** | Tier 1：新 CodeGraph 页（NavRail/ui-store/Layout/store/i18n）+ KPI 磁贴 + 3 图表 + 新鲜度卡 | 渲染 | M |
| **S4** | 可交互文件树（`files-tree` → 可折叠树，点文件→符号列表→跳图谱）；项目行抽共享组件 | 渲染 | S |
| **S5** | Tier 2：交互式图谱画布（复用 draw/graph，加 file/symbol 节点 + 点选/渐进展开 + 上下游高亮） | 渲染 | L |

**范围（已定）= S1→S5 全量**：手动构建 + 数据看板 + 可交互文件树 + 交互式代码图谱画布。
建议按 S1→S5 顺序推进，每步可独立验收；S5（图谱画布）作为最后一个迭代。

---

## 6. 拍板结果
- ✅ **承载形式**：**独立 NavRail 页面**（新建 CodeGraph 页，左侧导航加入口），而非就地扩
  `AppPluginPanel` 小节。§3.1 的接入步骤即按此执行。
- ✅ **可视化深度**：**全量含交互**——数据看板（Tier 1）+ 可交互文件树 + **交互式图谱画布（Tier 2）**。
- ✅ **文件树**：**可交互**（结构化 `codegraph/files-tree` RPC + 可折叠/可点击树，§2.4）。
- ✅ **当前阶段**：**只出设计，暂不实现**。本文为定稿；实现待后续启动（按 §5 的 S1→S5）。
