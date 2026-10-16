# 跨块连续编辑后富文本 / 源码分叉回归报告

> 状态：0.13.24 已修复并纳入自动化回归
>
> 家族编号：RS-24
>
> 日期：2026-08-08

## 1. 用户症状

在同一个已有文件中连续进行“编辑一处 → 删除另一处 → 再编辑后文”等操作后，富文本画面是最新的，但切换到源码模式可能出现以下任一结果：

- 已在富文本删除的旧内容仍留在源码；
- 富文本刚新增的内容没有进入源码；
- 源码模式没有正常打开，因为同步边界拒绝展示一份已知过期的源码；
- 如果继续保存，旧内容可能在完整重开后复活。

该问题不是单个 Markdown 语法的格式化问题，而是富文本事务、作者源码快照与 canonical 基线不同步的状态机问题。

## 2. 稳定复现夹具

回归夹具同时包含：

- 两个空引用；
- 普通标题；
- 普通无序列表；
- 会被 remark 解释成嵌套有序列表的 `- 4. 技术部`；
- 加粗内容；
- 文档后部的另一个列表。

后台 Electron 通过 `scripts/lib/human-input.mjs` 逐字符执行：

1. 在 `## 目录` 末尾输入“新增”；
2. 移到另一列表项，逐键 Backspace 删除“综合行政部”；
3. 移到文档后部，在“而为”末尾输入“新增”；
4. 不等待 Milkdown 的延迟回调，立即切换源码；
5. 再次往返模式，保存，退出应用并使用全新 profile 重开。

修复前可以捕获到：富文本 current canonical 已含全部操作，但作者源码仍是旧快照，强制 flush 返回 `null`。这与用户看到的“旧内容还在、新内容缺失、偶尔切不过去”一致。

## 3. 根因

### 3.1 延迟回调合并了互不相关的块

Milkdown 的 `markdownUpdated` 会短暂批处理事务。用户在约 200ms 窗口内从标题移动到列表，再移动到后文列表时，HorseMD 可能只收到一个包含多个不相邻块变化的 canonical delta。

原文保真层刻意不允许凭猜测整篇覆盖。当文件此前又存在 `- 4. 文本` 一类 source/canonical 可见流分叉时，这个大事务无法被任何单块 mapper 安全证明，于是 fail closed。Fail closed 保护了磁盘原文，却也意味着源码快照仍旧，直到存在可安全重试的事务边界。

### 3.2 文档可在本次编辑前就已分叉

例如作者源码中的 `- 4. 技术部` 可能被 canonical 表示为外层空 bullet item 加内层 ordered item。后续普通文字本身并不歧义，但全文 ordinal visible offset 已经错位，不能继续假设 source 与 canonical 从文档开头逐字符对齐。

## 4. 修复

1. `Editor.jsx` 记录 pending 编辑所在的 ProseMirror 顶层块。
2. 当下一次真实输入发生在另一个顶层块时，先从 live `view.state.doc` 强制提交已完成块，再让新块事务发生。连续输入同一块仍由 Milkdown 批处理，不会每键序列化全文。
3. 事务 key 使用顶层块起点，而不是内层 paragraph 的位置。输入 `- ` 时 input rule 会给原 paragraph 外包一层 bullet list，内层位置会变化但顶层起点不变；这样不会误把同一处输入当成跨块移动，也不会提前保存 `* <br />` 中间骨架。
4. 对“文档前部已分叉、当前是唯一单行文字变化”的情况，增加严格唯一上下文锚点：只有前后可见上下文在作者源码中恰好出现一次时才局部写回；重复或结构变化继续 fail closed。
5. 不使用整篇 canonical 覆盖作者源码，不放宽未编辑区域逐字符不变的合同。

## 5. 修改文件

- `src/renderer/src/components/Editor.jsx`
  - 增加稳定的顶层块事务边界提交，并避开 paragraph → list input rule 的结构中间态。
- `src/renderer/src/lib/markdown-preservation/regions.js`
  - 增加唯一可见上下文锚定的单行文本局部映射。
- `src/renderer/src/markdown-source-preservation.js`
  - 在 visible-stream 分叉分支接入上述严格回退。
- `scripts/test-mixed-rich-source-transaction-ui.mjs`
  - 固化跨块“新增 → 删除 → 新增 → 立即切换 → 保存 → 重开”全链路。

## 6. 验收合同

```bash
npm run test:mixed-rich-source-transaction-ui
npm run test:markdown-preservation
npm run test:new-document-list-source-ui
npm run test:nested-number-list-source-ui
npm run test:rich-source-continuous-fidelity-ui
npm run test:rich-source-chaos-ui
npm run test:source-fidelity-ui
npm run test:mode-switch-raw-offset-ui
npm run build
```

必须同时满足：

- 第一次立即切源码就包含全部新增，并移除已删除内容；
- 第二次模式往返结果完全相同；
- 未编辑的引用、加粗、空行和列表 marker 不变；
- 磁盘内容与源码 textarea 一致；
- 完整退出重开后旧内容不复活；
- 新文档列表输入、嵌套数字点列表、空段落与前导空格回归仍通过。

## 7. 工程结论

同步正确性不能依赖“异步回调通常很快”。真正的数据边界是 live ProseMirror transaction；当用户跨块继续输入、切模式或保存时，必须先把上一段可证明的事务提交。另一方面，fail closed 仍然必要：解决丢编辑不能以整篇 canonical 重写作者源码为代价。
