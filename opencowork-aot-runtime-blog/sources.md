# Sources

本轮写作使用了**用户提供材料 + 本地仓库源码/文档**，未进行额外外部网页检索。

1. **用户提供的版本与性能信息**
   - 类型：用户素材 / 一手输入
   - 标识：聊天消息内提供
   - 重要性：用于文章中的 .NET Core AOT / Runtime 性能段落与宣传主轴
   - 备注：其中内存与 CPU 数据在本轮未独立复测，应按“当前版本体验数据/用户提供数据”表述

2. **OpenCoWork Release 链接**
   - 类型：用户提供链接
   - 链接：https://github.com/AIDotNet/OpenCowork/releases/tag/0.7.11
   - 重要性：用于结尾 CTA 与版本体验入口

3. **README.zh.md**
   - 类型：项目官方文档
   - 路径：`F:\code\OpenCowork\README.zh.md`
   - 重要性：确认产品定位、核心特性、使用场景

4. **README.md**
   - 类型：项目官方文档
   - 路径：`F:\code\OpenCowork\README.md`
   - 重要性：作为英文版本交叉验证产品定位与特性

5. **package.json**
   - 类型：项目配置文件
   - 路径：`F:\code\OpenCowork\package.json`
   - 重要性：确认项目描述、依赖范围与 sidecar/build 脚本

6. **CHANGELOG.md**
   - 类型：项目变更记录
   - 路径：`F:\code\OpenCowork\CHANGELOG.md`
   - 重要性：确认 .NET sidecar 迁移、后台 cron、skills market 无需 API Key 等近期变化

7. **.NET Agent Runtime 项目文件**
   - 类型：源码 / 项目配置
   - 路径：`F:\code\OpenCowork\src\dotnet\OpenCowork.Agent\OpenCowork.Agent.csproj`
   - 重要性：确认 `net10.0`、`PublishAot`、`TrimMode full`

8. **Provider 认证逻辑**
   - 类型：源码
   - 路径：`F:\code\OpenCowork\src\renderer\src\lib\auth\provider-auth.ts`
   - 重要性：确认 OAuth、channel auth、账户信息刷新与落库逻辑

9. **Routin AI Provider Preset**
   - 类型：源码 / 预设配置
   - 路径：`F:\code\OpenCowork\src\renderer\src\stores\providers\routin-ai.ts`
   - 重要性：确认 `Routin AI` 与 `Routin AI（套餐）` 预设存在

10. **Codex OAuth Provider Preset**
    - 类型：源码 / 预设配置
    - 路径：`F:\code\OpenCowork\src\renderer\src\stores\providers\codex-oauth.ts`
    - 重要性：确认支持直接 OAuth 登录 OpenAI 账户体系，且 `requiresApiKey: false`

11. **GitHub Copilot OAuth Provider Preset**
    - 类型：源码 / 预设配置
    - 路径：`F:\code\OpenCowork\src\renderer\src\stores\providers\copilot-oauth.ts`
    - 重要性：确认支持 device code 登录与套餐/plan 信息

12. **OpenAI Provider Preset**
    - 类型：源码 / 预设配置
    - 路径：`F:\code\OpenCowork\src\renderer\src\stores\providers\openai.ts`
    - 重要性：确认 OpenAI Responses、图像、语音、Computer Use 等模型能力

13. **Provider Preset 索引**
    - 类型：源码
    - 路径：`F:\code\OpenCowork\src\renderer\src\stores\providers\index.ts`
    - 重要性：确认内置 provider 范围较广

14. **Cron Scheduler**
    - 类型：源码
    - 路径：`F:\code\OpenCowork\src\main\cron\cron-scheduler.ts`
    - 重要性：确认支持 `at / every / cron` 调度与后台执行

15. **MCP Manager**
    - 类型：源码
    - 路径：`F:\code\OpenCowork\src\main\mcp\mcp-manager.ts`
    - 重要性：确认具备 MCP server 连接与工具调用能力

16. **SSH Page**
    - 类型：源码 / UI 功能入口
    - 路径：`F:\code\OpenCowork\src\renderer\src\components\ssh\SshPage.tsx`
    - 重要性：确认远程终端、多标签、文件浏览与编辑能力
