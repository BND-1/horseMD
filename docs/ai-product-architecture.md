# HorseMD AI 产品与架构方案

**状态：** 设计草案，待产品确认，尚未实现。  
**范围：** 原生 AI 写作与文档助手、后续桌面开发 Agent 的共同底座。  
**最后更新：** 2026-07-22。

## 1. 结论

HorseMD 不应先做插件市场，也不应先把 Claude Code、Codex 或 MCP 直接嵌进编辑器。

第一阶段应是一个原生、可控、以文档为中心的 AI 助手：用户明确选择上下文，模型流式回答，任何改写都先进入 Review，用户再逐项接受或拒绝。它同时服务写作者和开发者，并为以后接入代码 Agent、MCP、技能和插件留下稳定合同。

产品定位可以概括为：

> 一个知道当前文档、可按需理解工作区结构、不会静默改写原文的 Markdown AI 工作台。

这比“聊天框 + API Key”多了上下文和审阅能力，也比一开始做通用自主 Agent 更符合 HorseMD 当前的稳定性、跨平台和用户信任要求。

## 2. 调研结论

### 2.1 CodePilot：借鉴分层，不照搬产品体量

[CodePilot](https://github.com/op7418/CodePilot) 已经把 Provider、会话流、文件树、MCP、Skills、权限和桌面 Agent 拆开。它的 README 明确区分了普通聊天与需要 CLI/本地权限的编辑、终端和 Git 能力；后者不是配置 API Key 后自然获得的能力。

**应借鉴：**

- Provider 配置、模型选择、流式会话、错误诊断必须是独立层，UI 不直接知道厂商协议。
- 工作区、工具、权限和会话有各自的合同，不能在聊天组件里临时堆积。
- 开发型 Agent 与普通文档聊天分开运行，才能让权限提示有意义。

**不应照搬：**

- 不为第一版引入 SQLite、REST 服务层、远程 IM 控制、任务调度、MCP 市场或通用插件体系。
- 不把 Claude Agent SDK 当作所有模型的统一协议。它适合后续桌面开发 Agent，不适合承载 OpenAI、Anthropic、兼容端点和本地模型的基础写作请求。
- 不在工作区根目录自动写入人格、记忆或规则文件。HorseMD 的现有文件夹应保持原样，AI 自己的状态放在应用数据目录。

### 2.2 Obsidian Copilot：借鉴文档工作流

[Obsidian Copilot](https://github.com/logancyang/obsidian-copilot) 的成熟点不在“自动 Agent”，而在于把选区、笔记、文件夹、标签等上下文变成可见且可移除的引用项，并提供 Quick Command、文档问答、Project Context 与可预览的 Composer 改动。其发布记录也表明，模型参数、上下文过长、索引和改写预览都会成为长期维护成本。

**应借鉴：**

- `@` 上下文引用和可见的上下文胶囊；用户始终知道发送了什么。
- 选区上的快速操作不必打开完整聊天面板。
- 文档改写先展示差异，再由用户应用；不能把模型输出直接写回编辑器。
- 工作区问答先做无索引的明确文件/文件夹上下文；向量索引是后续的可选加速，不是第一版前置条件。

### 2.3 Zed：借鉴权限模型

[Zed 的 Agent 权限模型](https://zed.dev/docs/ai/tool-permissions) 将读取、写入、删除、终端、网络和 MCP 工具分别治理，并将默认行为设为确认而不是放行。这是 HorseMD 后续开发 Agent 应采用的方向。

**应借鉴：**

- 能力与权限分离：模型“能调用什么”不等于“本次可以执行什么”。
- 文件写入、删除、命令、网络和第三方 MCP 默认逐次确认；危险操作不可被普通自动授权覆盖。
- 本地项目指令、技能和工具只应从用户明确信任的工作区加载。

## 3. 用户与核心场景

HorseMD 需要同时覆盖两类用户，但不能让任一方承受另一方的复杂度。

| 用户 | 首要需求 | 第一版入口 | 不能发生的事 |
| --- | --- | --- | --- |
| 写作者、学生、知识工作者 | 润色、翻译、总结、提纲、问当前文档 | 选区菜单、右侧 AI 面板 | AI 直接覆盖原文、默认上传整个工作区 |
| 有文档工作流的开发者 | 从目录结构理解项目、基于 README/设计文档讨论架构 | 工作区树上下文、文档面板 | AI 未授权读取源码、擅自运行命令 |
| 开发 Agent 用户（后期） | 多文件任务、生成改动、可用 Claude/Codex 执行 | 单独的 Agent 任务页 | 普通聊天被悄悄升级为本地 Agent |

用户提到“多数时候只需要文件夹和文件层级，不需要具体内容”。这应成为一个一等上下文类型：**工作区结构**。它适合提出架构、定位文档、制定阅读计划，但模型不能仅凭文件名可靠回答文件内部事实。因此 UI 需要明确区分：

- `工作区结构`：仅发送根目录、相对路径、目录层级、文件大小/类型和排除规则，不发送正文。
- `当前文档`：发送当前文件的 Markdown 正文。
- `指定文件/文件夹`：发送用户显式选择的内容，先显示数量、字符数与估算 token。
- `选区`：发送当前选区和必要的少量前后文。

## 4. 产品边界与首期体验

### 4.1 一个 AI 面板，三个轻量入口

1. **右侧 AI 面板**：可折叠，不取代现有文件、大纲和 Review。显示会话、上下文清单、模型、流式回答和改动预览。
2. **选区浮动菜单**：润色、改写、总结、翻译、解释、生成 Review 建议。结果进入面板，不在光标处自动插入。
3. **命令面板和快捷键**：`打开 AI`、`将选区加入 AI`、`问当前文档`、`应用当前建议` 等都是统一命令系统中的显式命令。

首期不要做持续的行内补全。它会在每次输入时发送编辑上下文，成本、隐私和中文输入法体验都需要独立产品验证。

### 4.2 四种用户可理解的工作方式

| 模式 | 默认上下文 | 结果 | 首期 |
| --- | --- | --- | --- |
| 快速编辑 | 选区 | 建议文本或 Review 改动 | 是 |
| 文档对话 | 当前文档或选区 | 流式回答，引用来源位置 | 是 |
| 工作区讨论 | 工作区结构；用户再添加文档 | 架构建议、阅读路径、问题回答 | 是，内容默认不上传 |
| 开发任务 | 受信任的工作区、工具、权限 | 计划、文件 diff、工具记录 | 后期桌面专属 |

### 4.3 Review-first 改写合同

HorseMD 已有 CriticMarkup Review、接受/拒绝和原文保真约束。AI 改写必须遵守以下流程：

```
选择上下文 -> AI 返回结构化改动提案 -> 本地校验基准版本与目标范围
-> 预览差异 -> 用户逐项/全部接受或拒绝 -> 正常 dirty/save 流程
```

- AI 绝不在后台调用 `updateContent` 或写文件。
- 模型不得直接输出 CriticMarkup 让应用盲目插入。它应返回 `ChangeProposal`；本地校验 `before`、raw range 和 revision 后，才决定是否转换为 CriticMarkup。
- 对短选区，经过校验的建议可转换为现有的 CriticMarkup 加/删/替换标记。
- 对整段、跨块或复杂 Markdown，优先使用并排 diff；只有通过 Markdown 和版本校验后才转换为 Review 标记。
- 应用前必须比较 `baseRevisionHash`，并验证目标 raw range 仍等于 `before`。文件已变更、重复文本命中不同位置或结构不再匹配时提示重新生成，不能按关键词查找或旧位置套用。
- 回答中的“复制”“插入到光标处”仍是用户明确点击后的普通编辑行为。

## 5. 推荐架构

### 5.1 进程边界

AI 不能绕过 Electron 的现有安全模型。Renderer 只负责交互和渲染，所有密钥、网络与桌面文件读取都在受信任的主进程内完成。

```
React UI
  AiPanel / SelectionActions / ReviewPreview
        |
        | window.api.ai.* (白名单 IPC)
        v
Electron main process
  ai-ipc.js             参数校验、可信 sender、取消请求
  ai-session-store.js   会话元数据与本地持久化
  ai-context-service.js 上下文构建、token 预算、来源清单
  ai-provider-service.js Provider 选择、验证、流式事件规范
  ai-credential-store.js safeStorage 加密凭据
  ai-policy.js          能力、路径范围、确认策略
        |
        +--> OpenAI Responses / Chat Completions
        +--> Anthropic Messages
        +--> OpenAI-compatible / Ollama
        +--> 后期：Agent runtime adapter
```

网络请求沿用主进程 `net.fetch`，而不是 renderer `fetch` 或 Node 全局 `fetch`。密钥沿用同步功能已经验证过的 `safeStorage` 加密存储模式；preload 只暴露必要方法，移动端在 Capacitor shim 提供同名但能力受限的实现。

### 5.2 稳定领域合同

以下合同应先写测试、再接 UI。具体文件名可在实施时调整，但职责不能混合。

```js
// 统一 Provider 输出；上层不解析 SSE 厂商格式。
AiProvider = {
  id,
  kind, // 'openai-responses' | 'openai-compatible' | 'anthropic'
  validate(config),
  listModels(config),
  stream(request, { signal, onEvent })
}

AiRequest = {
  sessionId,
  providerId,
  modelId,
  messages,
  context: ContextItem[],
  capability: 'assistant' | 'workspace-reader' | 'agent',
  options: { temperature, maxOutputTokens }
}

ContextItem = {
  id,
  kind, // selection | document | heading | workspace-tree | file | folder
  label,
  source: { tabId, path, start?, end?, revisionHash? },
  disclosure: { bytes, estimatedTokens, includesContent },
  content
}

ChangeProposal = {
  documentId,
  baseRevisionHash,
  target: { start, end }, // Markdown raw offsets, never visible-text guesses
  before,
  after,
  rationale
}

AiStreamEvent =
  | { type: 'text-delta', text }
  | { type: 'reasoning-summary', text }
  | { type: 'usage', inputTokens, outputTokens }
  | { type: 'tool-request', request } // 后期 agent 才可能出现
  | { type: 'error', code, message, retryable }
  | { type: 'done' }
```

Provider 差异只存在于 `ai-providers/`。会话、上下文、差异预览和审阅层只消费上面的稳定事件，不能根据 `gpt-*`、`claude-*` 名称写分支。模型输出始终是不可信数据：AI 面板默认按纯文本/安全 Markdown 渲染，不允许 raw HTML、内联事件、脚本、自动打开链接或自动写入编辑器。

### 5.3 Provider 与模型策略

第一期支持的不是“尽可能多的厂商预设”，而是可验证的三种协议：

1. OpenAI 官方 Responses API。
2. Anthropic Messages API。
3. OpenAI-compatible endpoint，覆盖常见代理、Ollama 和自托管网关。

每个 Provider 都有名称、端点、协议、模型、密钥、可选自定义请求头和连接测试。配置保存前执行轻量测试，并把错误分为 URL 不可达、TLS/网络、认证、模型不存在、协议不匹配、限流和服务端错误。API Key 永远不回传到 renderer，也不进入导出、日志、崩溃报告或同步目录。

模型能力是显式元数据，而不是猜测：`text`、`vision`、`reasoning`、`toolCalling`、`maxContextTokens`。首期 AI 文本请求不需要 tool calling；模型不支持的控制项不展示。

### 5.4 上下文组装与隐私

上下文组装必须是一个可审计的纯流程：

```
用户选择上下文
-> 解析相对路径/选区/当前版本
-> 排除秘密与超限内容
-> 估算 token 并显示清单
-> 由用户发送
-> 主进程请求 Provider
```

规则：

- 默认只附带用户正在选择的文本；“当前文档”“工作区结构”必须是明确开关。
- 当前文档必须在用户点击发送时取得一次快照。源码 textarea 先走既有 `commitAllLive()`，不能从磁盘重读、也不能使用 debounce 前的旧 `tab.content`。
- 富文本选区必须通过 Editor API 映射到 Markdown raw range；不能用 DOM 文本、关键词或可见字符位置猜测。Phase 0 要先补 `getMarkdownSelection()` 并覆盖表格、代码块、公式、图片、重复文本和源码模式。
- 工作区结构默认排除 `.git`、`node_modules`、构建产物、隐藏的应用配置、二进制与超大文件，并允许用户在设置中新增排除规则。
- 文件内容只读取受信任的已打开工作区根目录内路径；不得让 AI 请求任意绝对路径。
- 文档或选区在发送前显示来源、大小、估算 token 与是否包含正文；长内容按标题/片段裁剪并告知用户。
- 本地会话默认不进入 WebDAV/S3 同步。用户未来可以单独选择导出或同步 AI 会话。
- 不做隐式向量数据库、后台全库索引或后台上传。后续语义检索也必须逐工作区启用、可见索引范围、可清除。

每个上下文还应带 `trust`：`user-selection`、`current-document`、`workspace-file`、`external-import`、`model-output`。引用内容只作为资料，用清晰分隔符传入模型，不能把文档里的“忽略此前指令”“运行命令”等文字提升为应用指令。`assistant` / `workspace-reader` 没有工具能力，即使内容成功诱导模型，也不能读额外文件、写文件、发网络请求或执行命令。

### 5.5 会话与持久化

HorseMD 当前没有通用 SQLite 数据层，因此首期不为 AI 引入数据库。会话元数据和消息可原子写入用户数据目录：

```
<userData>/ai/
  settings.json             非机密设置与 provider 元数据
  credentials.json          仅加密后的 safeStorage 密文
  sessions/<uuid>.json      本地聊天与来源引用
```

`sessions/*.json` 保存的是用户可见会话，不是模型“长期记忆”。不在工作区根目录悄悄创建 `memory.md`、`CLAUDE.md` 或 AI 配置。后续若会话量、全文检索或并发需求证明 JSON 不足，再设计可迁移的 SQLite 存储。

会话不应无限增长。每次发送前依据所选模型的声明窗口计算输入预算，展示历史、上下文、系统指令与预留输出的估算；响应返回实际 usage 时更新显示。首期采用确定性的“保留最近消息 + 用户可见截断”策略，不在后台自动把旧对话发送给另一个模型压缩。自动摘要、缓存提示词和跨会话记忆均属于后续可选能力，且必须显示会发送什么、成本归属和可清除入口。

### 5.6 能力与权限阶梯

| Profile | 可读 | 可写 | 可运行 | 支持平台 |
| --- | --- | --- | --- | --- |
| `assistant` | 用户加入的选区/文档 | 不可 | 不可 | 桌面；移动端需先完成安全存储 |
| `workspace-reader` | 结构；用户明确加入的工作区文件 | 不可 | 不可 | 桌面优先，移动端受文件能力限制 |
| `workspace-editor` | 已批准的工作区范围 | 仅经 diff/Review 批准 | 不可 | 后期桌面 |
| `agent` | 受信任工作区和已批准工具结果 | 每个 patch 确认 | 命令逐次确认 | 后期桌面 |

首期只实现前两档。`workspace-editor` 和 `agent` 是后续独立入口，不得通过“普通聊天 + 自动应用”偷渡。

Agent 阶段可以提供 `ClaudeAgentSdkAdapter`、`CodexCliAdapter` 或其他受支持的运行时适配器，但它们只实现 `AgentRuntime` 合同。每次工具调用必须展示：工具、参数、受影响路径、输出、允许/拒绝。终端、删除、网络、MCP、Git 写操作均默认确认。

### 5.7 插件与 MCP 的正确顺序

插件市场不是 AI 的前置条件。正确顺序是：

1. 内置 Provider、上下文、会话、Review 改写、权限合同稳定。
2. 内置工具以同一权限系统运行，并有真实错误、取消、升级和审计测试。
3. 再允许插件注册受限的 `command`、`context source`、`provider` 或 `tool`。
4. 最后再考虑 MCP 导入、插件市场、签名/来源提示、版本兼容与卸载清理。

这样插件是扩展稳定能力，而不是要求插件反向定义 HorseMD 的安全边界。

## 6. 分期实施

### Phase 0：设计与保护网

- 建立 `docs/ai-product-architecture.md` 所定义的领域类型、IPC 输入校验和 Provider fixture 测试。
- 定义上下文清单、revision hash、流式取消和错误分类的纯函数测试。
- 定义不可信输入/输出、提示注入、raw HTML、恶意链接、重复文本和选区 raw-offset 的安全 fixture。
- 设计 AI 设置页、右侧面板和 Review 预览，不接真实密钥。
- 完成隐私说明、Provider 配置和移动端能力边界文案。

**完成标准：** 无真实网络请求；类型/fixture 证明 Provider 差异不泄漏到 UI；现有编辑器回归完全通过。

### Phase 1：原生文档助手

- 新增 AI 设置页：OpenAI、Anthropic、兼容端点；保存、编辑、删除、测试连接、模型选择。
- 新增右侧 AI 面板、会话、流式文本、停止生成、重试、复制。
- 支持“选区”和“当前文档”两种可见上下文。
- 支持总结、解释、润色、改写、翻译等内置提示词；自定义提示词后置。
- 首期仅发布桌面端。移动端要先完成 Keychain/Keystore、安全网络通道、能力开关与真机回归，再开放 `assistant`；不开放工作区扫描或 Agent。

**完成标准：** API key 不出主进程；取消不会留下卡住的 loading；错误可理解；编辑器不因 AI 状态变化重挂载或标脏。

### Phase 2：AI 改写与 Review

- 实现基于 revision hash 的改动提案。
- 对短选区转成 CriticMarkup；复杂文档使用并排 diff。
- 复用既有接受/拒绝流程并增加“提案过期”保护。
- 在源模式、富文本、表格、代码块、公式、图片、重复文本和外部文件变更下做回归。

**完成标准：** 任意一次 AI 改写都可见、可拒绝、可恢复，且不会破坏 Markdown 原文保真合同。

### Phase 3：工作区上下文

- 先加入“工作区结构”上下文和显式文件选择器。
- 展示发送清单、token 估算、排除项、超限截断与引用来源。
- 可选实现不依赖 embedding 的文件名/标题本地搜索。
- 仅在用户逐工作区开启后评估本地全文索引与语义索引。

**完成标准：** 用户能只给 AI 看架构，也能精确选择文档；AI 不会在未确认时读取其他文件。

### Phase 4：桌面开发 Agent

- 以独立 Agent 任务页接入一个运行时适配器，先只读计划与 diff。
- 再逐步引入经过确认的写文件、终端、Git 和网络工具。
- MCP 仅作为受权限系统保护的工具来源，不把外部 server 当作可信代码。

**完成标准：** 每个工具调用有清晰审批、日志、取消和失败恢复；普通写作聊天完全不受影响。

### Phase 5：扩展生态

- 发布版本化的 AI Extension API、权限 manifest、兼容性策略、卸载清理和来源提示。
- 先做本地安装与受控开发者模式；市场、签名、评分和远程分发最后再评估。

## 7. 测试与验收矩阵

| 范围 | 自动化 | 人工验收 |
| --- | --- | --- |
| Provider | 请求 shape fixture、SSE 事件、错误分类、取消 | 官方/兼容/本地端点各一次连通与失败提示 |
| 凭据 | `safeStorage` 加密、日志脱敏、IPC 白名单 | macOS/Windows 系统钥匙串不可用时的提示 |
| 上下文 | 路径限制、排除规则、token 截断、来源 manifest | 用户能看清并移除每一个上下文项 |
| 改写 | revision hash、diff/Review 转换、过期拒绝 | 源码/富文本、表格、代码、公式、图片、大文档 |
| 编辑器 | 现有 source-map、模式切换、保存/dirty、Review 回归 | 选区操作与面板开关不造成光标/视口漂移 |
| 平台 | desktop IPC、Capacitor shim capability tests | Windows/macOS/iOS/Android 分别验证显示与禁用边界 |
| Agent（后期） | 工具权限优先级、路径白名单、审批 token | 写入、删除、终端、网络、MCP 每类确认流程 |

任何 Phase 开始前都要提高测试包版本；涉及 renderer 或平台合同必须执行 `npm run build` 和 `npm run build:mobile`，再按 `docs/manual-test-checklist.md` 进行针对性回归。

## 8. 目前明确不做

- 不提供“输入 API Key 后自动读取/修改整个电脑文件”的能力。
- 不默认上传当前工作区、同步目录、AI 会话或用户自定义 CSS。
- 不在第一版做自动补全、长期记忆、云端账号、付费订阅、RAG 云服务、MCP 市场、插件市场或远程手机操控 Agent。
- 不把未知的 OpenAI-compatible endpoint 当成拥有与官方 API 同等工具、视觉或推理能力的 Provider。
- 不为了 AI 功能改动 Crepe 的挂载、源码/富文本状态机或 Markdown 序列化路径。

## 9. 下一次讨论需要确定的产品决策

在开始 Phase 0 代码前，建议确认以下产品项：

1. AI 面板是否作为右侧新增一级入口，还是复用当前侧栏中的一个模式；推荐新增可折叠右侧面板，避免挤占文件树和大纲。
2. 首批 Provider 是否只放 OpenAI、Anthropic、OpenAI-compatible 与 Ollama 引导；推荐如此，先把连接测试和错误做可靠。
3. AI 会话默认是否持久化；推荐默认本地持久化，并提供“新临时会话”和“清空所有会话”。
4. Phase 2 的复杂改动是否先只做并排 diff；推荐是，CriticMarkup 仅用于经过验证的短选区。
5. 开发 Agent 首个运行时选 Claude Agent SDK、Codex CLI，还是仅先做通用只读计划适配器；推荐先完成通用权限与 diff 容器，再决定运行时，避免绑死厂商。

## 10. 参考资料

- [CodePilot README 与架构说明](https://github.com/op7418/CodePilot)
- [Obsidian Copilot README](https://github.com/logancyang/obsidian-copilot)
- [Obsidian Copilot releases: context、Composer 与 diff 的演进](https://github.com/logancyang/obsidian-copilot/blob/master/RELEASES.md)
- [Zed Agent tool permissions](https://zed.dev/docs/ai/tool-permissions)
- [Zed AI privacy and security](https://zed.dev/docs/ai/privacy-and-security)
