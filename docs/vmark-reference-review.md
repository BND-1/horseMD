# VMark AI 与导出能力调研

> 调研基线：`xiaolai/vmark` main（2026-07-31）。本文只记录可验证的实现与 HorseMD 决策，不把竞品现状当作产品规范。

## 1. 结论

VMark 最值得参考的不是某个界面，而是两条清晰边界：

- AI 将 Provider、凭据、调用状态、建议应用、MCP 桥接和权限分开；CLI 与 REST 共享上层调用合同。
- PDF、原生 HTML、Pandoc 外部格式是三条独立导出链路。Pandoc 只接收 Markdown，HTML 则先经过专用只读渲染面。

HorseMD 不照搬 VMark 的 Tauri/Rust 代码，也不照搬它当前较简单的 HTML 导出交互。HorseMD 采用 Electron 主进程实现系统能力，并把 HTML 做成与 PDF Studio 同等级的可预览工作台。

## 2. AI 可借鉴点

### 2.1 Provider 边界

VMark 同时支持本地 CLI（Claude、Codex、Gemini）和 REST（Anthropic、OpenAI、兼容接口、Google、Ollama）。上层只关心请求、流事件、取消和结果，不直接依赖某一厂商。

HorseMD 沿用这一思想：

```text
AiPanel / Writing Action
        ↓
AiInvocationService
        ↓
ProviderAdapter (REST / CLI)
        ↓
Electron main process
```

Provider 不得直接修改编辑器。所有写入必须经过 `ChangeProposal`、版本校验和用户确认。

### 2.2 上下文与建议

VMark 的 Genie 用 Markdown 文件描述提示词，支持 selection、block、document 范围和相邻块上下文；结果以 suggestion 形式应用。这种“提示词是普通文件、范围显式”的方式可维护性较好。

HorseMD 首期借鉴范围合同，但不直接复制 Genie 文件格式。先支持用户显式选择“选中文本 / 当前章节 / 当前文档”，并显示将发送的范围。后续提示词模板再独立演进。

### 2.3 MCP

VMark 通过本地 MCP Server、WebSocket 桥和 revision token 让外部 AI 读取或写入活动文档。revision token 能防止 AI 思考期间覆盖用户的新编辑，这是正确的并发保护。

HorseMD 不在 AI 首期开放 MCP 写入。等 `ChangeProposal`、路径权限、审计记录和过期检测稳定后，再提供精简的 read/propose/apply 工具面。

## 3. Pandoc 可借鉴点

VMark 的 Pandoc 实现包含以下正确做法：

- 设置中检测安装状态、版本和可执行路径，并在缺失时给出安装引导。
- Markdown 通过 stdin 发送，不创建会泄漏内容的中间 Markdown 文件。
- 输出扩展名使用严格白名单。
- 图片等相对资源使用源文件目录作为 `--resource-path`。
- 子进程有超时、stderr 上限、错误透传和进程回收。
- 前端只选择格式，进程执行留在原生后端。

HorseMD 会采用这些约束，并额外要求所有 IPC 校验可信 renderer、输出路径由主进程保存对话框产生、命令不经过 shell。

## 4. HTML 导出可借鉴点

VMark 使用独立只读 ExportSurface 渲染 Markdown，等待图片、字体、数学公式和 Mermaid 稳定后再导出；同时支持资源目录版和单文件版。这一“导出面与活动编辑 DOM 分离”的思路是正确的。

但 VMark 当前 HTML 导出没有预览和样式工作台，用户选择位置后直接生成。HorseMD 的目标更高：

- 设置与预览同屏，最终文件与预览使用同一份 HTML 字节。
- 提供主题、正文宽度、字号、行距、目录与标题层级设置。
- 第一版默认生成单文件、脚本禁用的 HTML，图片尽量内嵌，便于分享和离线查看。
- 公式、Mermaid、任务列表、表格使用与 PDF 相同的只读渲染快照，不依赖元素是否处于可视区。

## 5. 不照搬的部分

- 不把 AI 直接接到 `window.api` 文件系统和 shell 能力。
- 不让 AI 响应绕过原文保真层直接调用 `replaceMarkdown`。
- 不把 Pandoc 当作 HorseMD 内置渲染器；它是用户自行安装的外部工具，版本和格式差异要如实提示。
- 不在 HTML 中默认注入阅读器脚本。静态导出先保持无脚本、CSP 收紧，再单独评估交互阅读器。
- 不复用 PDF 的分页 CSS 构建 HTML。两者只共享结构化导出快照和资源准备合同。

## 6. 验收重点

- Pandoc 不可用、路径失效、执行超时、格式不支持和相对图片均有明确结果。
- HTML 预览与保存文件一致，切换设置只保留最后一次结果。
- HTML 中没有编辑器按钮、拖拽柄、CodeMirror 控件或重复 Mermaid。
- AI Provider 合同的测试不需要真实 API Key，也不访问计费接口。

