# AI 功能分期计划（VMark 参考后）

本文补充 `ai-product-architecture.md` 与 `ai-readiness-audit.md`，只定义近期可执行顺序。

## Phase 0：基础合同

先提交不触发真实模型的纯模块与测试：`AiRequest`、`AiEvent`、`ProviderAdapter`、`ContextSnapshot`、`ChangeProposal`，以及 auth、rate-limit、network、timeout、invalid-response、canceled 错误分类。

Phase 0 不增加聊天入口，不保存 API Key，不运行 CLI。

## Phase 1：桌面只读助手

- 设置页新增“AI”分类，支持 OpenAI、OpenAI-compatible、Anthropic。
- API Key 只进入 Electron 主进程安全存储；renderer 只能看到是否已配置。
- 右侧独立 AI 面板支持问答、流式输出、停止、重试。
- 用户发送前明确选择选区、章节或文档；不在输入/滚动时后台抓全文。
- 结果只能复制或创建 `ChangeProposal`，不能直接改文档。
- 模型调用通过主进程 `net.fetch`，Provider adapter 负责请求/流解析。

## Phase 2：写作动作与差异审阅

- 润色、改写、总结、翻译、续写等动作由普通 Markdown 模板描述。
- AI 返回结果进入并排 diff；应用前验证 revision 与 before 文本。
- 同一层只允许一个 apply transaction，写入沿用原文保真和 dirty 合同。
- 跨表格、代码块、公式或多段结构的结果不强制转换为 CriticMarkup。

## Phase 3：本地 CLI Provider

- 检测 Claude Code、Codex CLI、Gemini CLI，但每个 CLI 都有独立 adapter 和版本矩阵。
- 仅使用官方非交互参数；stdout/stderr、超时、取消和进程回收与 Pandoc runner 共用底层受控进程设施，不共用业务参数。
- CLI 工作目录、可读文件范围和环境变量必须显式，不能继承整个工作区权限。

## Phase 4：工作区与 MCP

- 工作区 AI 先读取用户确认的 manifest，不默认索引全部正文。
- MCP 首期工具面只提供 read、selection、propose；write/apply 需要一次性审批 token。
- 所有写入携带 revision，过期时拒绝而不是静默覆盖。

## 暂不做

- 不把 Claude Code/Codex 的完整 Agent 权限嵌入首版。
- 不让模型直接调用 HorseMD 的文件、shell、同步或插件 IPC。
- 不在移动端安全存储与原生网络合同完成前开放 API Key。
- 不做每次键入触发的 AI 自动补全，避免打断写作和放大大文档序列化成本。

## Phase 0 验收

- 所有合同均为无 UI、无网络的纯测试。
- Provider fixture 覆盖流分片、错误 JSON、取消和超时。
- Context fixture 覆盖大文档截断、选区、章节边界和 revision 变化。
- AI 模块不导入 React、ProseMirror、Electron renderer API 或具体厂商 SDK。

