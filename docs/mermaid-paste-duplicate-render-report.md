# Mermaid 粘贴重复渲染问题报告

> 修复版本：0.12.46  
> 范围：富文本正文粘贴、Mermaid CodeMirror 内二次粘贴、源码保真、保存重开。

## 用户症状

复制一段 Mermaid 源码到富文本正文后，同一份内容偶尔会显示成两张图。该问题
过去修复过，但后来再次出现，因此不能只删除重复 DOM 或用 CSS 隐藏第二份预览。
必须确认 ProseMirror 文档、可见 SVG 和 Markdown 源码是否都保持一一对应。

## 如何发现

新增真实 Electron 测试 `scripts/test-mermaid-paste-ui.mjs`，使用后台 CDP 派发真实
`ClipboardEvent`，并同时检查：

1. `.milkdown-code-block` 数量；
2. `.preview svg` 数量；
3. 切到源码后的 Mermaid 围栏数量；
4. Mermaid 声明和内容出现次数。

测试先暴露了两个互相独立的问题：

- 裸 `flowchart TD ...` 粘贴后，富文本里暂时只有一个 Mermaid 节点，但源码快照仍是
  没有围栏的普通文字。富文本模型和保存模型已经不一致，切换、保存或重建后会出现
  错误结果。
- 在节点标签中加入 `sequenceDiagram 只是标签` 后，旧的全字符串声明扫描会把标签
  误判为第二张图的起点，将一个代码块拆成两个。

## 根因

### 1. 历史修复使用了过宽的启发式规则

早期为了处理“在已有 Mermaid CodeMirror 中粘贴第二张图，两段源码被直接拼接”的
问题，`createMermaidSplitPlugin()` 会在整个代码块的任意位置搜索
`flowchart TD`、`sequenceDiagram` 等关键词。

这条规则不知道一次粘贴发生在哪里，也不知道关键词是语法声明还是节点标签。只要
用户的标签、注释或说明文字包含同名字符串，就会被当成第二张图。这是重复渲染的
直接原因。

### 2. 裸 Mermaid 的富文本插入和源码保存不是同一种结构

`editor-md-paste.js` 会把裸 Mermaid 创建为 `language=mermaid` 的 ProseMirror
`code_block`，但原文保真链路收到的仍是裸文字。画面是代码块，`lastMarkdownRef`
却是普通段落，后续模式切换与保存无法维持同一个事实来源。

### 3. CodeMirror DOM 不能始终直接映射到 ProseMirror 位置

CodeMirror node view 会隔离内部 DOM，`view.posAtDOM()` 在不同预览/编辑状态下不一定
能从 `.cm-content` 找到外层 `code_block`。只依赖该 API 会让二次粘贴路径偶发失效。

## 最终修复

### 在粘贴发生时精确决定结构

- 正文中的裸 Mermaid 会被包成一个合法的 ` ```mermaid ` Markdown 块，再同步到
  原文保真链路。
- 完整围栏粘贴保留原围栏内容，并只创建一个代码块。
- 在空 Mermaid 块内粘贴时填充当前块。
- 在已有内容的 Mermaid 块内粘贴另一张图时，直接在当前块之后插入一个同级
  `code_block`，同时把对应围栏写入源码快照。
- 成功接管粘贴后使用 `stopImmediatePropagation()`，避免同一事件继续进入另一条
  ProseMirror/CodeMirror 粘贴处理链。

### 把自动拆分降为严格兜底

`createMermaidSplitPlugin()` 仍可修复已经被拼在一起、且第二个声明真正位于行首的旧
内容，但不再扫描任意子串。标签里的 `flowchart TD`、`sequenceDiagram` 不具有结构
意义，绝不能触发拆块。

### DOM 映射使用两级策略

优先使用 `view.posAtDOM()` 和 ProseMirror resolved position；CodeMirror 屏蔽内部
DOM 时，按编辑器内 `.milkdown-code-block` 的 DOM 顺序和 ProseMirror 文档中的
`code_block` 顺序建立同序映射。该回退不使用关键词，不依赖图表内容是否重复。

## 曾经不可取的处理

- **扫描任意位置的 Mermaid 关键词**：没有语法上下文，标签和注释必然误报。
- **只隐藏第二个 SVG**：数据层仍有两个代码块，切源码、保存、PDF 导出都会继续错。
- **只向 ProseMirror 插入第二个节点**：测试中画面短暂出现两个块，但未同步对应
  Markdown 围栏，切源码后第二张图消失。结构事务和原文保真事务必须一起提交。
- **把所有 Mermaid 粘贴交给默认 CodeMirror**：正文中的裸 Mermaid 会成为普通文本，
  在非空 Mermaid 块中又会把两张图拼成一段源码。

## 自动化验证

```bash
npm run build
npm run test:mermaid-paste-ui
npm run test:web-paste-ui
npm run test:issue-77-ui
npm run test:lightbox-ui
npm run test:pdf-rendered-ui
npm run test:ui-regression
```

专项测试覆盖：

1. 裸 Mermaid 粘贴；
2. 完整围栏 Mermaid 粘贴；
3. 标签包含 Mermaid 声明文字；
4. 在已有 Mermaid 块内粘贴第二张图；
5. 富文本、源码和预览数量一致。

最终验证结果：

- `test:mermaid-paste-ui` 使用 10 个独立端口和隔离 profile 连续运行，10/10 通过；
- `test:ui-regression` 第二轮完整通过，结果为 `7 sessions + 25 standalone`；
- PDF rendered formats 中 6 个 Mermaid 图表均生成独立 SVG，未打印源码；
- `test:issue-77-ui`、`test:new-source-fidelity-ui`、`test:markdown-preservation`、
  `build:mobile` 和 `guide:check` 通过。

## 防回归规则

1. 一份 Mermaid 剪贴板输入必须对应一个 `code_block`、一个预览和一个源码围栏。
2. Mermaid 内容识别只能使用源码开头或真实行首声明，不能在任意子串上匹配。
3. 粘贴测试必须检查 ProseMirror/DOM 和源码，不能只看截图。
4. 修改 `editor-md-paste.js`、`editor-mermaid.js`、CodeMirror node view 或原文保真
   链路时，`test:mermaid-paste-ui` 是必跑项。
5. PDF 测试独立验证导出 SVG；编辑器预览通过不代表导出链路通过。
