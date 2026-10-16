# AI 开发准备度与技术债审计

**审计日期：** 2026-07-22  
**结论：** 可以开始桌面端原生 AI 助手的基础工程，但不能直接接入真实模型。先完成 A0 的七项基础合同；AI 改写、工作区内容上下文、移动端和开发 Agent 都有各自的后置前提。

本审计只评估会影响 AI 正确性、安全性、可维护性或发布质量的债务。它不是一次全面重构清单；没有必要为了 AI 先重写 Crepe、`App.jsx` 或全局 CSS。

## 1. 当前基础与结论

HorseMD 已有若干可以复用的基础：

- 桌面端主进程使用 Electron `net.fetch`，同步凭据通过 `safeStorage` 加密保存。
- Renderer 与桌面能力之间已有 preload 白名单和 `window.api.capabilities` 跨平台模式。
- 现有 Review/CriticMarkup 能接受、拒绝和显示文本变更。
- 命令面板、设置中心、文件树、工作区、多 tab、外部文件变更提醒和专项脚本均已存在。
- CI 会运行核心纯逻辑回归与构建，编辑器已有源码映射、原文保真、Review 和文件系统测试。

因此，**“选区/当前文档问答 + 流式回答”不被现有编辑器架构阻塞**。但 AI 不能直接沿用 Renderer 的文件接口或 localStorage；必须先建立自己的主进程服务边界。

## 2. A0：接真实 Provider 前必须完成

### A0-1. AI 凭据存储必须是独立、可复用的主进程服务

**现状**

`src/main/sync/credential-store.js` 已正确使用 `safeStorage`，但它属于同步领域。Renderer 设置仍保存于 `localStorage`，不适合 API Key；移动端也没有 Keychain/Keystore 插件。

**风险**

把 AI Key 放入设置对象、会话、日志、同步配置或 preload 返回值会直接造成泄露。复制同步模块又会形成两套加密格式和错误语义。

**要求**

- 提取通用但窄的 `CredentialStore`，以命名空间隔离 `sync` 和 `ai` 的密文记录。
- Provider 列表只返回非敏感元数据，读取 Provider 配置时永不回传 key。
- 所有错误与诊断日志脱敏 URL query、Authorization、API Key 和自定义请求头。
- 保存、更新、删除、解密失败和系统安全存储不可用都要有纯函数/fixture 测试。

**范围**：桌面 AI 必做。移动端不复用 Electron `safeStorage`。

### A0-2. 需要统一的 Provider、流式事件与取消合同

**现状**

当前 `window.api` 基本是一次性 `ipcRenderer.invoke()` 调用，主进程到 Renderer 的事件只用于文件、窗口和 watcher 通知；没有可取消的长请求、请求 ID 或厂商无关的 SSE 事件协议。

**风险**

若让 UI 直接解析 OpenAI/Anthropic 的不同 SSE 格式，会导致 Provider 分支渗入 React。窗口关闭、切 tab、重复发送或网络中断时也会遗留并发请求和错误 loading 状态。

**要求**

- 在主进程实现 `AiProvider.stream()`，标准化为 `text-delta`、`usage`、`error`、`done` 等事件。
- 使用不可预测的 `requestId` 管理单请求生命周期；preload 只暴露 `aiStart`、`aiCancel`、`onAiEvent` 等窄 API。
- 取消由主进程保存 `AbortController` 执行；窗口销毁、Provider 删除和新请求替换都必须清理。
- 把厂商 HTTP/SSE payload 固定为离线 fixture 测试，覆盖成功、认证失败、429、异常流、主动取消与事件顺序。

**范围**：桌面 AI 必做。不要先用 Claude/Codex Agent SDK 代替此合同。

### A0-3. 上下文必须由主进程按明确策略构建

**现状**

`src/renderer/src/hooks/useWorkspace.js` 维护的是界面用的多根路径与文件列表；`src/main/filesystem.js` 的现有 API 允许编辑器读写任意由用户打开的路径，并非“给模型发送内容”的权限模型。

**风险**

如果 AI 直接复用 `readFile`、`listFiles` 或 Renderer 中的文件树，就无法统一限制根目录、隐藏目录、大小、文件数量、符号链接、二进制、排除规则和发送说明。模型输入与应用文件权限也会混在一起。

**要求**

- 新建只读 `ai-context-service`，不从 Renderer 接收任意绝对路径作为可读取授权。
- 上下文引用必须带 `kind`、来源、相对路径、revision hash、大小和 `includesContent`；发送前生成 manifest。
- 首期只允许用户显式提交选区或当前文档快照。工作区结构和指定文件内容按 Phase 3 后置。
- 工作区结构默认排除 `.git`、`node_modules`、构建目录、隐藏应用目录、二进制、超大文件和超深层目录；读文件必须确认它位于已批准的根目录内。
- 建立路径穿越、根目录逃逸、巨型目录、重复根、软链接、空文件、编码失败和 token 截断测试。

**范围**：上下文安全必做。完整工作区扫描不是首期阻塞项。

### A0-4. 选区与未保存文档需要可验证的 Markdown 快照

**现状**

源码 textarea 的最新内容可能仍位于 `liveContentRef` 的 debounce 中；富文本公开 Editor API 目前只提供单个 `markdownOffsetFromSelection()`，不是 AI 改写所需的完整 anchor/head raw range。

**风险**

AI 可能回答磁盘上的旧内容、发送用户尚未看到的旧快照，或在表格、代码块、公式、图片和重复文字附近选择错误范围。后续的“替换选区”会因此修改错误内容。

**要求**

- AI 发送前必须先提交 source textarea 的 live 内容，再构建不可变的 `DocumentSnapshot`。
- 新增 `getMarkdownSelection()`：返回 anchor/head、start/end、selected Markdown、revision hash 与结构信息；禁止以关键词或 DOM 可见文本重新定位。
- 为源码与富文本各建立 selection fixture，至少覆盖表格、CodeMirror、行内/行外公式、图片 atom、列表、重复文本和模式切换链路。
- 当前文档快照只在用户按下发送时获取一次；不得在流式期间重新读取磁盘或随编辑内容漂移。

**范围**：选区动作和当前文档问答的正确性前提。

### A0-5. AI 输入、输出与文档内容必须按不可信数据处理

**现状**

编辑器为了兼容网页粘贴和 Markdown HTML，拥有自己的 HTML node view 与 sanitizer；主窗口保持 `contextIsolation: true`、`nodeIntegration: false`，但 preload 仍提供文件、shell 等桌面能力。项目中尚没有“模型返回内容”的单独渲染和信任模型。

**风险**

文档、网页粘贴内容或模型输出都可能含有提示注入、恶意链接、raw HTML、伪造的“已获得权限”说明。若把回答直接送进编辑器、`innerHTML` 或工具调度，攻击面会和已有 desktop API 相连。

**要求**

- 定义 `ContentEnvelope { source, trust, content }`；文档内容只是引用资料，不能覆盖系统/产品指令。
- AI 面板使用安全 Markdown 子集或纯文本渲染，禁用 raw HTML、事件属性和自动外链；外链仍通过既有协议校验与用户点击打开。
- `assistant` 和 `workspace-reader` 不注册任何工具。文档中的提示注入即使改变模型文本，也不能获得文件、网络或命令能力。
- 所有改写先走结构化 `ChangeProposal` 校验，不接受模型直接返回的 CriticMarkup、patch 或可执行脚本。
- 增加 prompt injection、恶意 HTML、`javascript:` URL、伪造 tool call、模型输出超长/异常 JSON 的 fixture。

**范围**：接真实模型前必做，属于安全边界而不是 UI 细节。

### A0-6. 会话、成本、并发和日志要有明确治理

**现状**

当前应用没有 AI token 预算、模型窗口声明、活跃请求登记或 AI 日志脱敏机制。现有 PDF 已实现“同一 renderer 最新请求胜出”的任务模型，可作为取消生命周期的参考，但不能直接冒充聊天会话管理。

**风险**

长文档、长对话和重复点击会造成超窗、意外费用、并发串流错配或无法停止。若诊断日志保存原始 prompt/response，也会泄露用户内容和密钥。

**要求**

- 每个模型有显式能力/窗口元数据；发送前展示估算输入、保留输出和上下文来源，响应后记录实际 usage（若 Provider 返回）。
- 每个会话同时只允许一个 active request；同一会话新请求必须先取消或要求用户明确停止旧请求。不同会话的并发上限也要定义。
- 首期只做确定性截断和用户可见的“本次未附带内容”；不做隐式 LLM 自动摘要或后台全文索引。
- 日志记录 requestId、Provider ID、状态、耗时、错误码和脱敏后的 endpoint；默认不记录正文、Key、自定义敏感 header 或完整模型输出。
- 添加关闭窗口、切 tab、删除 Provider、网络中断和连续快速发送的生命周期测试。

**范围**：真实请求、可维护成本与用户信任的前置条件。

### A0-7. Provider 测试必须进入 CI 的核心回归

**现状**

CI 当前运行 `npm run test:core`、教程检查和构建。项目有许多优秀的单独 UI/CDP 脚本，但它们并不全部进入 CI；现有网络测试集中在同步协议，而非 AI Provider 的 HTTP/SSE 兼容性。

**风险**

AI 最容易出现“某个厂商格式改了、取消不工作、凭据被误传、报错无法理解”的回归。如果这些只靠人工 API Key 测试，发布不可控且会产生费用。

**要求**

- 新增无真实网络依赖的 `test:ai-core`，包含 Provider request shape、stream parser、错误分类、取消、凭据脱敏和 context policy。
- 将 `test:ai-core` 纳入 `test:core`；真实 Provider 连通性只作为本地手工 smoke test，不进入 CI。
- AI UI 单独提供 CDP fixture，覆盖开始、流式、停止、重试、切 tab、关闭面板和 Provider 未配置。

## 3. 后续能力的阻塞项

### B1. AI 改写缺少通用的提案与版本校验层

**现状**

Review 当前擅长用户主动对选区增加 CriticMarkup，`wrapReviewSelection` 对多行替换有限制；`applyReviewDecision` 处理的是已有 marker，没有“AI 提案基准版本、范围、结构化 diff、过期检测”的模型。

**影响**

这不阻塞聊天、总结或选区生成建议，但**阻塞自动把 AI 结果应用到文档**。若直接调用 `updateContent` 或 `replaceMarkdown`，会绕过原文保真、外部变更和模式切换保护。

**处理方式**

- 先做 `ChangeProposal { baseRevisionHash, target, before, after }` 的纯逻辑与 diff 预览；`target` 使用 Markdown raw offsets，应用前二次确认 `before` 完全一致。
- 短、单行、已验证选区才转 CriticMarkup；跨段/表格/代码块/公式默认并排 diff。
- 应用时比较 revision hash；不匹配就废弃提案，要求重新生成。
- 这个层放在 Phase 2，不与 Phase 1 聊天耦合。

### B2. 工作区树不是 AI 上下文索引

**现状**

`useWorkspace` 是 UI 级 hook，文件列表是 Markdown 文件扁平集合，深度与数量也按现有文件树体验限制。它不携带 AI 所需的类型、大小、token、批准范围、内容快照或审计信息。

**影响**

不能把“工作区树已存在”误判为“已具备 AI 项目问答”。用户只发送结构与发送正文是两种不同权限。

**处理方式**

Phase 3 新建主进程 workspace manifest 扫描器；不要改造 `useWorkspace` 成 AI 服务，也不要让它在每次文件变更时后台索引全文。

### B3. 移动端没有安全密钥存储与原生网络通道

**现状**

Capacitor shim 明确关闭了 `cloudSync`；依赖中也没有 iOS Keychain/Android Keystore 的安全存储插件。已有移动同步架构文档已将 Electron `safeStorage`、Node 文件系统和主进程 `net.fetch` 列为不可直接搬进 WebView 的能力。

**影响**

移动端不能安全保存 API Key，也不能可靠走 WebView 网络限制下的任意兼容 Provider。**移动 AI 不能作为 Phase 1 发布承诺。**

**处理方式**

先设计 `HorseMDSecureStore` 与原生 HTTP 合同，或让移动端在首期明确显示“桌面端可用”。等安全存储、原生网络、能力开关和真机回归完成后，再开放移动端 `assistant`。

### B4. 大文档的全量序列化是性能上限

**现状**

Crepe 的 `markdownUpdated` 会在用户编辑时序列化整篇 Markdown；当前已经通过懒挂载、分块解析、节流和 heavy 文档回退降低风险，但这个底层开销仍存在。

**影响**

AI 若在每次输入、选择变化或滚动时自动抓取全文，会明显放大大文档卡顿，并可能重新触发模式切换/dirty 风险。

**处理方式**

首期只在用户点击发送时获取一次稳定快照；不做实时补全、后台摘要或每次键入自动更新上下文。大文档按显式选区、标题片段或用户确认的截断内容发送。

### B5. Agent 与插件缺少统一的权限策略层

**现状**

现有 Electron IPC 按功能注册，文件系统和 shell 能力本来是为了受信任的编辑器 UI 提供，不存在模型工具调用的“allow/deny/confirm、路径规则、审批记录”抽象。

**影响**

这不阻塞只读文档 AI，但会阻塞任何“模型改文件、运行命令、调用 MCP、安装插件”的实现。直接让模型复用现有 `window.api` 是不可接受的。

**处理方式**

在 Agent Phase 前建立 `ai-policy` / `tool-permission` 层：能力声明、根目录范围、一次性审批 token、不可覆盖的拒绝规则和事件审计。插件只能申请该层已经定义的能力，不能拿到 `ipcRenderer` 或 Node 权限。

### B6. 现有生产依赖存在已知安全更新

**现状**

`npm audit --omit=dev` 当前报告两项生产依赖问题：直接依赖 `fast-xml-parser@5.10.0` 的高危实体扩展限制绕过，以及 Milkdown/Mermaid 传递依赖 `dompurify@3.4.8` 的中危 sanitizer 问题。

**影响**

这不阻塞纯文本 AI 架构，但 AI 会增加更多不可信输入、连接配置和用户内容路径。发布任何带 AI 的版本前，应升级到 audit 已修复的兼容版本，并完整回归 WebDAV/S3 XML、Mermaid、HTML 粘贴和编辑器渲染。

**处理方式**

把依赖升级作为独立安全修复提交，不与 AI 功能混在同一变更；记录升级前后的 `npm audit` 结果和专项回归。

## 4. 非阻塞但需要守住的技术债

| 项目 | 当前判断 | AI 开发策略 |
| --- | --- | --- |
| `App.jsx` 1125 行 | 高耦合 shell，模式切换和 tab 生命周期敏感 | AI 以 `useAiAssistant`、`AiPanel` 和局部接线接入；不把 Provider 或 stream 状态塞进 App |
| `src/main/index.js` 860 行 | IPC 装配和平台生命周期集中 | AI 只增加 `registerAiIpc(...)`，领域逻辑放进 `src/main/ai/` |
| 全局样式 | 影响面大、主题和移动端耦合 | AI 样式使用独立组件 CSS/明确前缀；不借 AI 顺带拆全局 CSS |
| 现有 Review | 成熟但面向人工 marker | 新增 proposal adapter，不修改既有 marker 语义 |
| 本地状态多用 localStorage | 适合非敏感偏好，缺少通用迁移层 | AI 会话和 Provider 元数据写 `<userData>/ai/` 并设计版本字段/原子迁移 |
| 专项 UI 脚本未全入 CI | 手工回归覆盖广，但 CI 覆盖收敛 | AI 核心纯测试必须进入 `test:core`，高风险 UI 仍保留 CDP 手工矩阵 |
| 文档/模型内容信任边界未抽象 | 当前编辑器只处理本地 Markdown HTML，不等于 AI 输出安全 | AI 增加独立 `ContentEnvelope`、安全输出渲染和注入 fixture，不改动编辑器 HTML 兼容链 |

## 5. 建议实施顺序

1. **A0-1 到 A0-7**：凭据、Provider/stream、context snapshot、输入输出信任边界、成本并发、context policy、CI fixture。完成前不接真实模型 UI。
2. **Phase 1（仅桌面）**：Provider 设置、右侧面板、选区/当前文档显式上下文、问答、停止与重试；没有 AI 自动改写。
3. **Phase 2**：`ChangeProposal`、并排 diff、Revision 过期保护，再有限地复用 Review。
4. **Phase 3**：工作区结构和显式文件上下文，不做后台全库上传或索引。
5. **移动端前置项目**：安全存储、原生网络、真机验证；完成后再开放移动 AI。
6. **最后**：桌面 Agent、MCP、插件 API/市场。

## 6. 开工门槛

满足以下条件后，才建议创建 AI 功能 Goal 并开始代码：

- [ ] 产品确认首期仅桌面端、只读文档助手，不承诺移动端/Agent/插件。
- [ ] 确认首批 Provider 为 OpenAI、Anthropic、OpenAI-compatible；明确不支持的协议在 UI 中说明。
- [ ] A0-1 至 A0-7 的模块接口、测试 fixture 和 IPC 输入校验清单已评审。
- [ ] 明确聊天会话默认本地保存、不同步，以及一键删除策略。
- [ ] 确认 AI 面板的视觉入口与“上下文发送清单”的交互稿。

## 7. 验收重点

- 未配置 Provider 时不会请求网络，UI 给出下一步。
- API Key 从任何 Renderer API、日志、会话、同步文件和导出内容中均不可见。
- 停止生成、切 tab、关文档和关窗口不会留下运行中的请求或错配文本。
- 用户始终能看到本次发送的选区、文档或工作区结构；没有隐式全文上传。
- 未保存的源码和富文本选区会以点击发送时的 Markdown raw snapshot 发送；表格、代码块、公式和重复文本不会被错误定位。
- 文档、网页粘贴和模型回答均不能获得工具权限、运行 HTML、自动打开链接或直接改写文件。
- 长对话和大文档在超预算前可解释地截断或要求缩小上下文，不会后台悄悄压缩/上传更多内容。
- AI 面板开关、请求和结果渲染不会造成编辑器重挂载、dirty 变化、光标/滚动位置漂移。
- 模式切换、保存、Review、表格、代码块、公式、图片和大文档回归与 AI 改写阶段分开验证。
