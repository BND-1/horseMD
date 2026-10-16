# Markdown 原文保真深度审计（2026-07）

## 结论

本次按“文件读取 → 富文本解析 → 用户事务 → 源码切换 → 非键盘命令 → 保存写盘”逐层检查，并以真实 Electron 对保存后的文件做逐字节比较。审计确认并修复了五类会在用户未明确要求格式化时修改无关源码的路径。

当前合同是：

1. 只打开、阅读、切换标签或切换源码/富文本，不得改变 tab 内容、dirty 状态或磁盘字节。
2. 普通文字编辑只能改变对应 raw 区间；不能顺带改空行、转义、列表符、表格空格、BOM 或换行风格。
3. 标题、列表、表格等明确结构操作最多改动被操作的行或语法块。
4. 映射无法证明安全时保留用户原文，不允许退回 Crepe 的整篇 serializer 输出。
5. 保存不是格式化命令。

## 已确认并修复的问题

### 1. 超大文档首次编辑缺少 canonical 基线

超过分块阈值的文档只记录了第一块的初始化状态。剩余块加载完成后没有记录完整 canonical 快照，首次用户事务无法计算可靠差异，可能丢失本次输入或退入过宽的保护路径。

修复：分块全部插入后只记录完整 serializer 基线，不把它写回原始源码，也不标脏。

### 2. 全局 visible stream 不一致扩大局部修改

Setext 标题、引用定义、实体、自动链接、任务标记、硬换行和 word-internal `_` 等写法曾使原文与 canonical 的可见字符流在远处不一致。用户修改前文时，映射可能扩大到整行或错误位置。

修复：补齐这些 Markdown 语法的可见流规则；全局流不一致时，只允许在同一行、同一 visible ordinal 且前后上下文严格一致时做局部 raw patch。该路径不是关键词匹配。

### 3. 表格文字编辑触发整表 serializer 重排

Crepe 会按新单元格长度重新对齐表格源码。即使只输入一个字符，canonical diff 也可能覆盖整张表，连带添加外侧管线、空格和转义。

修复：先比较表格形状和每个 cell 的可见流，只把真实 cell 文本 delta 映射回用户原表格；增删行列仍走受限的表格结构替换。

### 4. textarea 把 CRLF 标准化为 LF

HTML textarea 的 DOM value 按浏览器标准只暴露 LF。此前源码模式只输入一个字符后，会把整个 LF value 当成新文件，导致 Windows CRLF 文件被全文格式化；BOM 和后续 raw offset 也可能受影响。

修复：`source-text-fidelity.js` 在 DOM 展示值之外保留 raw source snapshot。每次输入、查找替换、审阅、附件插入和大纲移动只把 normalized delta 打回 raw snapshot，并提供 textarea offset 与 source raw offset 的双向转换。CRLF、混合换行和 BOM 均保留。

### 5. 非键盘命令绕过原文快照

- 源码审阅曾在包裹当前选区后规范化整篇 Review 标记。
- 富文本插入附件曾以 `api.getMarkdown()` 的整篇 canonical 输出为基底。
- 初始化更新保留了把 serializer 输出设为干净内容的危险分支。

修复：审阅只改变选区；附件在 `tab.content` raw snapshot 上按映射 offset 插入；初始化更新永远不接纳 serializer 输出。

## 有意允许的源码变化

以下不是隐性格式化，但必须由明确用户动作触发：

- 用户切换标题、列表类型，增删表格行列等结构操作时，被操作的局部语法块可能采用 canonical 写法。
- 用户执行“接受全部/拒绝全部审阅”时，全部 CriticMarkup 标记按命令处理。
- 保存含粘贴生成的 base64 图片或 HorseMD 临时粘贴目录图片时，应用会把图片移入文档同级 `assets/` 并把对应图片 URL 改为相对路径。其他链接不应变化。

HorseMD 当前不是源码优先的 Live Preview 内核，因此不能承诺“被明确结构化编辑的那个语法块也保持每个空格不变”；但未触碰区域必须逐字节保持。

## 自动化证据

- `npm run test:source-text-fidelity`：CRLF、BOM、混合换行和 offset 双向映射。
- `npm run test:markdown-preservation`：文字、段落、列表、表格和结构变更的纯函数边界。
- `npm run test:source-fidelity-ui`：异构 Markdown 12 个真实富文本编辑点，每次切源码比较完整内容，保存后比较磁盘字节。
- `npm run test:large-source-fidelity-ui`：超过 120,000 字符的 BOM + CRLF 文档，覆盖分块加载、只切换、首次富文本编辑、源码编辑、切回和真实保存。
- `npm run test:review`：源码审阅不修改选区外标记。
- `npm run test:source-map`：重复文本、表格、代码、图片和 HTML 的 raw offset 映射。

以上测试已加入 `npm run test:ui-regression` 的强制矩阵。

## 后续修改禁区

- 不得直接用 `crepe.getMarkdown()` 更新 `tab.content` 或作为插入命令的全文基底。
- 不得把非受控 textarea 的 `value` 直接写入 `liveContentRef`；必须经过 `source-text-fidelity.js`。
- 不得在解析完成、切换模式、PDF 导出或恢复会话时重建 saved baseline。
- 新增会改变文档的命令时，必须说明其 raw source 输入、允许修改范围，并增加磁盘差分测试。
