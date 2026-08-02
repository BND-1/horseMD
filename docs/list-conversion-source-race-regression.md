# 0.12.52 列表转换后源码丢失与合并问题报告

> 状态：已修复并加入纯函数、真实 Electron、保存和完整重开回归。记录日期：2026-08-01。

## 用户可见症状

用户在富文本中编写有序列表，并通过右键把多处列表转换为无序列表后，富文本当下看起来正确，但切换源码会出现以下一种或多种现象：

- 已转换的无序列表标记丢失或仍显示旧的有序标记；
- 未操作的嵌套列表被改缩进、插入空行，由紧凑列表变成松散列表；
- 转换后紧接着输入的文字丢失、移动或与邻近内容合并；
- 保存并彻底重开后，文件按错误源码重新解析，原先富文本中看到的结构无法恢复。

这不是显示层问题。磁盘最终保存的是源码快照，因此一旦源码快照错误，重新打开必然以错误结构为准。

## 根因

问题由两个边界同时失守造成。

### 1. 用整棵 canonical 列表覆盖用户原文

Crepe 会把同一棵嵌套列表序列化成自己的 canonical Markdown。用户原文可能是“外层松散、内层紧凑”，并使用 3 个空格缩进；canonical 可能给每个内层项目增加空行并改成 2 个空格。旧的 `replaceMarkdownListBlock()` 在列表类型变化时替换整棵列表，导致没有被操作的子层也被格式化。

列表类型转换的真实语义只改变当前层级的 marker/checkbox。它没有权力重写项目文字、空行、缩进、子列表 marker 或相邻列表。

### 2. `markdownUpdated` 与下一次输入存在时序竞争

Milkdown 的 `markdownUpdated` 既可能在列表 transaction 的 dispatch 中触发，也可能延迟到用户下一次输入或切换源码时才触发。旧逻辑等待该回调后才区分“列表转换”。当用户转换后马上继续打字，回调看到的已经是“转换 + 新文字”的组合结果；精确内容匹配失败后，代码退回整棵 canonical 列表覆盖。

更隐蔽的是，有些列表 transaction 不会在源码切换前单独发布回调。此时 `flushMarkdown()` 只能看到完整 canonical 文档，同样会把未提交的转换和输入当成普通整块结构变化。

旧 `flushMarkdown()` 还通过 `crepe.getMarkdown()` 读取 listener 的缓存快照。键盘 transaction 已经进入 `view.state.doc`、但 listener 尚未发布时，用户直接保存会漏掉最后输入；这也是“富文本明明看得到，保存重开却没有”的独立原因。

此外，旧 `saveTab()` 只调用了源码 textarea 的 `commitAllLive()`，随后直接写入上一帧 React `tab.content`。富文本没有对应的强制 flush，因而即使 `flushMarkdown()` 本身正确，保存入口也未调用它。

## 修复

### 当前层级定位

右键菜单把实际命中的 ProseMirror 文字位置作为 `anchorPos` 传给转换链路。不能使用列表容器的 `listPos + 1`：容器边界没有可见字符，嵌套列表中可能映射到第一个子列表，进而修改错误层级。

### marker-only 写回

`lib/markdown-preservation/lists.js` 对 authored source、转换前 canonical、转换后 canonical 的列表项目按结构行对齐，只替换真正发生类型/任务状态变化的行前缀。未变化行保留原始字节，包括：

- `-`、`*`、`+` 与有序列表标点；
- 每一级缩进；
- 紧凑/松散空行；
- 未操作的嵌套列表和相邻列表。

对齐不可靠时不得猜测 marker 位置。

转换专用路径一旦无法精确对齐会直接取消 transaction，并提示“无法安全转换，文档内容已保持不变”；它不得回退到整棵 canonical 列表替换。普通非转换列表编辑仍使用各自已有的局部保真策略。

### dispatch 前建立转换快照

`editor-list-conversion.js` 在 dispatch 前把 transaction 的目标 `doc` 交给 `Editor.jsx`。编辑器使用 Milkdown `serializerCtx` 直接序列化这个确定的目标文档，并提前生成只修改 marker 的 authored source。这样无论 `markdownUpdated` 在 dispatch 内、下一帧、下一次输入或源码 flush 时到达，都有同一份“纯转换基线”。

如果回调同时包含转换后的新输入，先提交 marker-only 源码，再通过普通局部文字差分应用输入；如果回调暂未到达，转换函数立即提交该快照，避免源码切换和保存读到旧状态。

保存、导出和源码切换调用的 `flushMarkdown()` 直接用 `serializerCtx(view.state.doc)` 序列化当前 ProseMirror 文档，仅在编辑器 teardown 时回退到 `crepe.getMarkdown()`。因此强制 flush 不再依赖 listener 是否已经发布最新缓存。

`saveTab()` 在读取 Tab 后立即调用 `getMarkdownForTab()`：源码模式提交非受控 textarea，富文本模式执行上述 ProseMirror flush；若内容更新，先同步 `tabsRef` 和 React state，再把同一个快照交给 `writeTab()`。保存不再依赖下一次 React render。

## 禁止的修法

- 不能在转换后直接采用 `crepe.getMarkdown()` 覆盖完整文档。
- 不能用一个全局 `sourceIsCompact` 决定整棵嵌套列表的空行；不同层级可以分别紧凑或松散。
- 不能用列表容器起点、关键词或项目文字第一次出现的位置猜当前层级。
- 不能依赖固定延迟等待 `markdownUpdated`；事件时序不是稳定 API。
- 不能只验证切换源码前的 DOM。必须验证源码 textarea、真实磁盘和新进程重开。

## 自动化验证

`scripts/test-list-conversion-source-fidelity-ui.mjs` 使用后台 Electron，不抢系统焦点，覆盖：

1. 载入“外层松散有序列表 + 内层紧凑无序列表”的混合源文件；
2. 右键把外层转换为无序列表；
3. 不等待 `markdownUpdated`，通过 `human-input.mjs` 逐字符输入中文；
4. 切源码，逐字节确认只改变外层 marker 和输入文字；
5. 不切源码，直接从富文本点击保存并读取磁盘，再切源码核对同一快照；
6. 关闭整个 Electron 进程，以全新 profile 重新打开；
7. 同时确认富文本列表层级与源码字节不变。

运行：

```bash
npm run test:markdown-preservation
npm run test:list-conversion-ui
```

发布前还应联跑段落、列表输入 marker、任务清单、双向模式切换与移动端构建，避免原文保真策略互相回归。
