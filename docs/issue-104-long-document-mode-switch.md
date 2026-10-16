# Issue #104：长文档源码 / 富文本切换定位与性能回归

> 状态：已修复并纳入回归。更新时间：2026-08-02。

## 用户可见症状

Issue #104 的原始描述是“双屏 Bug：滑动 MD 源页面，渲染后的页面不会同步滑动”。经确认，产品不提供两个同步滚动的独立窗格；实际需要修复的是**单窗格源码 / 富文本切换**：

1. 打开较长文档，在富文本中只滚动、不点击正文，切换到源码后偶发回到顶部；切回富文本又看似正常。
2. 在富文本正文中放置可见光标，尤其是含行内公式的段落，切到源码后光标会落到邻近甚至无关段落。
3. 纯阅读切换会不必要地卡顿。

真实复现文件：

```text
/Users/yangtingyi/vibe_everything/置身钉内/WhatIf因果推断详细笔记(长文本卡顿）.md
```

该文件约 489KB。复现点之一为“单参数模型（无 β₂aL 项）=…”所在段落；修复前切源码会错误落到前文“理想的做法：敏感性分析…”。

## 根因

### 1. 行内公式破坏了块匹配

`editor-source-map.js` 先在 Markdown AST 与 ProseMirror 文档之间确定“同一块”，再做 raw offset ↔ PM position 的块内映射。

- Markdown AST 的 `inlineMath` 含有公式 TeX 文本；
- ProseMirror 的 `math_inline` 是 atom，其 TeX 不进入 paragraph 的 `textContent`。

旧逻辑直接比较这两份文本，所以含 `$…$` 的段落无法精确匹配。长文档分块解析时，随后按 block index 的兜底不再可靠，光标就被定位到另一段。

**修复**：分离两种文本：完整 `text` 继续用于段内位置计算；`matchText` 只用于锁定块，并在 Markdown / ProseMirror 两侧一致地忽略行内公式、图片与硬换行 atom。锁定块后仍用完整 inline item 序列精确对齐公式之后的字符。

### 2. 阅读态做了不必要的整篇映射与序列化

富文本 → 源码的纯阅读路径原先无论光标是否可见，都会：

- 计算 caret 的 Markdown raw offset；
- 从富文本视口顶部再次计算 raw offset；
- 在必要时 `flushMarkdown()` 序列化整个 ProseMirror 文档。

对 400KB+ 文档，这些操作会触发完整 Markdown AST 解析 / 映射；并且视口 raw offset 在图片、公式等非线性高度结构中不是可靠的阅读锚点。

**修复**：

- 仅当 caret 位于可见区、用户确实在编辑时才计算 caret raw offset；
- 纯阅读使用 `captureRichViewport()` 提供的可见文本 snippet + scroll ratio，切换后按 snippet、再按比例恢复；
- `flushMarkdown()` 用同步 dirty 标记判断是否确有尚未被 `markdownUpdated` 提交的用户编辑。无编辑的切换直接复用已提交 source snapshot；刚刚编辑后仍会同步序列化 `view.state.doc`，不牺牲保存与立即切换的正确性。

富文本编辑器仍保持挂载，源码真正被修改时才同步回 Crepe；这条既有合同不变。

## 验证

### 自动化

```bash
npm run test:source-map
HORSEMD_RAW_OFFSET_TARGET=inline-math npm run test:mode-switch-raw-offset-ui
npm run test:markdown-preservation
npm run test:issues-105-106-ui
npm run build
```

本次结果：全部通过。

### 真实长文档后台 Electron 验证

对上述 WhatIf 文件：

- 阅读态：富文本滚动至约 62%，不点击正文后切源码，源码 scroll ratio 保持约 0.63，未回到顶部；本轮切换准备时间约 **603ms**，改动前测得约 **1030–1068ms**。
- 编辑态：点击“单参数模型（无 β₂aL 项）=…”的公式后正文，切源码选择位置落在该段附近 raw offset **151260**；修复前错误落在约 **143885** 的“敏感性分析”段。

后台 CDP 验证不获取系统键鼠焦点。人工验收仍须按 [手工测试清单](./manual-test-checklist.md) 连续执行双向链路，并覆盖表格、代码块、图片和公式前后的光标。

## 维护约束

- 新增 inline atom 节点时，必须同时更新 `comparableTextOf()` 与 inline item 映射，并添加“atom 前 / 后 / 段尾”的双向用例。
- 不得在无可见 caret 的阅读路径调用全文 raw-offset 映射来恢复 viewport。
- 不得把这次修复退化为全文关键词匹配；重复文本在长文档中不可靠。
