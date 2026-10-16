# 富文本「删除全部内容」复活 + 模式切换光标被覆盖 根因报告

> 状态：已修复并补齐双层回归（纯函数 + 真实 UI）。更新：2026-08-07。
> 涉及提交（待合入）：`preserveRichMarkdownSource` 新增 `document-emptied` 分支；`useSourceModeSwitch` 新增重试期选区漂移守卫与 follow 判定修正。

## 用户现象（同一会话复现）

1. **删除全部内容后复活**：在富文本中删除文档全部内容并保存 → 切到源码模式，被删除的内容仍在；切回富文本，内容消失；关闭文件重新打开，被删除的内容全部回来了。
2. **模式切换光标漂移**：源码/富文本来回切换时，编辑点会变。期望是「源码在哪，输入点就在哪；富文本在哪，输入点就在哪」，任意切换光标保持不动。

## 根因一：空 canonical 触发保真管道 fail-closed

### 机制

富文本删除全部内容后，Milkdown 序列化的 canonical 变为空串。`preserveRichMarkdownSource(source, previous, '')` 的启发式管道没有任何「文档整体清空」分支：

- `commonChange(previous, '')` 得出 `{start:0, previousEnd:全文长, nextEnd:0}`；
- 空段落/空列表/表格处理器全部不匹配；
- 一旦源码与 canonical 存在可见流分歧（行中 `* `、`-` vs `*` 列表标记、HTML 实体等——真实文档几乎必然存在），`preserveLocallyAlignedTextChange`、`preserveChangedLineRegion`、`preserveDivergedBlockTextChange`（要求单 canonical 块）**全部失败**；
- 管道末尾 fail-closed **返回原源码**（reason：`visible-stream-mismatch` / `localized-change` 残留 `"# "` 等）。

于是「删除全部」被静默撤销：

1. `markdownUpdated` 处理器把 `lastMarkdownRef` 与 `tab.content` 写回旧内容（文档甚至不显示脏标记）；
2. `saveTab → getMarkdownForTab → flushMarkdown({force:true})`：canonical 已等于 `canonicalMarkdownRef.current`（空），直接返回 `lastMarkdownRef.current` = **旧内容** → 磁盘写入旧内容；
3. 切源码挂载的 textarea 同样是旧内容；切回富文本时 `syncSourceToRich` 因 value 未变而不动编辑器，富文本保持空 → 与用户看到的完全一致；
4. 重开文件 = 磁盘旧内容 = 「删除的内容复活」。

### 修复

`src/renderer/src/markdown-source-preservation.js` 的 `preserveRichMarkdownSourceCore`，在 `!previous`（新文档）分支之后新增：

```js
// 富文本整文档删除：canonical 为空是无歧义事实（用户看到的一切都被删除），
// 不需要任何局部映射。此前所有映射在分歧源码上 fail-closed 复活旧内容。
if (!next) {
  return { markdown: '', preserved: true, reason: 'document-emptied' }
}
```

空结果经出口后置条件 `capOutputTrailingNewlines('', source)` 验证保持 `''`。BOM/CRLF 文件清空后同样写空文件（与既有 exact-baseline 路径行为一致）。

### 复现与回归

- **纯函数复现**：`node /tmp/...` 中对分歧文档调用 `preserveRichMarkdownSource(source, canon, '')`，修复前返回旧源码或 `"# "` 残留，修复后全部返回 `''`（reason `document-emptied`）。
- **UI 回归**（新增 `scripts/test-full-doc-delete-source-ui.mjs`，`npm run test:full-doc-delete-source-ui`）：分歧文档 → Cmd+A → Backspace 清空 → 富文本为空 → 切源码为空（无残留、无复活）→ 切回富文本光标在 0 → 保存后磁盘为空 → 重开仍为空。
- 纯函数用例已追加到 `scripts/test-markdown-source-preservation.mjs`（列表标记分歧、可见流分歧、BOM/CRLF 三例）。

## 根因二：settle 重试覆盖用户刚移动的源码光标

### 机制

模式切换后 `useSourceModeSwitch` 的布局效应会在 0ms / rAF / 90ms / 220ms / 450ms / 700ms 起每 300ms 重复执行 `apply()`，直到布局稳定（最长约 3s）。源码分支每次都会重新执行 `restoreSourceCaret(...)`，把光标钉回切换时捕获的锚点。

唯一的中止条件是 `sourceEl.__horsemdSourceSelectionUser === true`——该标志由 React 的 textarea `onSelect`/`onClick` 合成事件置位。**键盘方向键移动、IME、辅助输入等路径一旦漏掉这个合成事件，用户移动的光标就会在 ~700ms 后被重试覆盖回旧位置**，随后「源码在哪输入点就在哪」失效。

（真实鼠标点击路径标志可靠置位，因此常规手测不易暴露；合成/键盘边角路径才会踩中。）

### 修复（两处）

`src/renderer/src/hooks/useSourceModeSwitch.js`：

1. **重试期选区漂移守卫**：`apply()` 首次恢复后记录 `firstRestoreDone`；后续重试若发现 textarea 实时选区 ≠ 上次恢复写入的 `__horsemdSourceSelectionBaseline`，立即 `supersededByUserFocus = true` 停手——不依赖合成事件，直接比较选区本身。
2. **follow 判定不再依赖标志**：`followSourceCaret = hasSourceCaretIntent && !sourceViewportMoved`（原为 `&& sourceSelectionUser`）。选区相对基线移动且视口未滚走 = 编辑意图，富文本回程应聚焦并跟随光标；仅视口滚动的阅读路径仍走视口锚点。

### 复现与回归

- 插桩探针复现：源码内把光标从「项一」程序化移到「结尾」（无任何事件 → 无标志）→ 等 2.5s，光标被重试覆盖回「项一」。修复后保持「结尾」。
- **UI 回归**（新增 `scripts/test-mode-switch-caret-settle-ui.mjs`，`npm run test:mode-switch-caret-settle-ui`）：分歧文档 → 富文本光标「项一」→ 切源码（基线建立）→ 程序化移动光标到「结尾」（无事件）→ 等待 2.6s 断言不被覆盖 → 切富文本断言落在「结尾」→ 切回源码断言位置保持。

## 验证矩阵（全部通过）

| 测试 | 结果 |
| --- | --- |
| `npm run build` | ✅ |
| `npm run test:markdown-preservation`（含新增清空用例） | ✅ |
| `npm run test:full-doc-delete-source-ui`（新增） | ✅ |
| `npm run test:mode-switch-caret-settle-ui`（新增） | ✅ |
| `npm run test:diverged-delete-source-ui` | ✅ |
| `npm run test:empty-paragraph-caret-ui` | ✅ |
| `npm run test:source-map` | ✅ |
| `npm run test:source-text-fidelity` | ✅ |
| `npm run test:mode-switch-raw-offset-ui` | ✅ |
| `npm run test:source-fidelity-ui` | ✅ |
| `npm run test:issue-77-ui` | ✅ |
| `npm run test:new-source-fidelity-ui` | ✅ |
| `npm run test:list-conversion-source-fidelity-ui` | ✅ |
| `node scripts/test-source-fidelity-probes.mjs`（35/35） | ✅ |

## 防止再犯

- **「整文档清空」是无歧义变更**：任何未来新增的启发式路径都不能对空 canonical fail-closed 返回旧源码；空输入必须走 `document-emptied` 分支（位于 `preserveRichMarkdownSourceCore` 顶部）。
- **settle 重试只能重复「自己上次写入的」状态**：重试前必须与基线比较，基线漂移即用户接管；禁止仅依赖 React 合成事件标志判断用户意图。
- 真实鼠标/键盘路径与合成路径都要覆盖：本报告两处修复均以「无合成事件」路径为复现条件。

---

# 追加（同日）：行首空格被序列化为 `&#x20;` 实体泄漏

## 用户现象

富文本中先按空格输入很多空格、再打字，切到源码模式后行首空格变成了 `&#x20;`（如
`       顶格文字` 变成 `&#x20;     顶格文字`）。

## 根因

remark-stringify 序列化时，**行首第一个空格**必须转义为 `&#x20;` 实体，否则重新解析时
会被当成缩进/列表语义。canonical 里因此出现 `&#x20;`；而保真管道把 canonical 片段
写入作者源码时没有反转义，实体直接进了源码。ProseMirror 文本节点里存的是解码后的
真实空格，`&#x20;` 只是序列化拼写——写入源码违反「不改用户原文」承诺。

泄漏路径（全部为 canonical → 源码的文本翻译点）：
1. `adaptCanonicalRegionToSource`（所有区域替换路径的汇聚点：localized-change、
   行区域、列表、表格、frontmatter、段落）；
2. `generatedScratchMarkdown` / `new-document` 分支（新文档、清空后重新输入）；
3. `lists.js` 输入规则重建列表时的 direct-join 尾部拼接。

「已有文档段中空格」不泄漏（只有行首首个空格转义）；「已有文档新段落行首空格」泄漏；
「空文档先空格后打字」泄漏。

## 修复

`core.js` 新增 `canonicalTextToSource(text)`：`&#x20;` → 空格。所有 canonical 片段
写入源码前必须经过它（`adaptCanonicalRegionToSource` 内部统一处理；scratch/new-document
与 lists direct-join 显式调用）。可见流映射（`mode-visible-map.js`）本就解码实体，
反转义后 raw offset 映射保持一致，不会产生新的可见流分歧。

## 复现与回归

- 纯函数用例已追加到 `scripts/test-markdown-source-preservation.mjs`（scratch、已有
  文档行首、空文档 canonical 三例）。
- **UI 回归**（新增 `scripts/test-leading-space-entity-ui.mjs`，
  `npm run test:leading-space-entity-ui`）：已有文档新段落行首 6 空格 + 文字 → 切源码
  断言 6 个真实空格、无 `&#x20;`；再清空文档输入 8 空格 + 文字（scratch 路径）→ 同样无实体。
- 完整回归矩阵（16 项）全部通过，含 0.13.14–0.13.17 全部修复（嵌套数字列表分歧见
  `canonical-escape-audit.md`，回归 `npm run test:nested-number-list-source-ui`）。

## 0.13.21 再回归：四空格/Tab 结构缩进绕过反转义

最初的 UI 用例只覆盖顶层段落。`canonicalTextToSource()` 又把任何以四空格或 Tab
开头的 canonical 行直接判为 indented code 并原样返回。列表续行、嵌套内容本身也会
带这些结构缩进，所以紧随其后的作者空格仍会以 `&#x20;` 泄漏；这解释了“自动化说通过、
真实文档又复现”的差异。

修复不再凭 canonical 缩进猜测代码区。富文本 serializer 的代码块使用 fenced code，
源码局部字面区由 `literalSourceRegion()` 结合原始 source 判断；四空格、Tab、列表续行
一律继续执行 `&#x20;` 反转义。纯函数新增三种结构缩进断言；UI 用例新增真正空文件启动，
逐字符提交 8 个空格和正文，再验证立即源码、保存磁盘、全新进程重开，避免“清空一个
已有编辑器”冒充 scratch 生命周期。

## 0.13.22 根因补全

0.13.21 把实体改回普通 ASCII spaces 仍不完整：四空格会被 Markdown 解析为代码块；
真实 CGEvent 还证明连续空格会发布多个 whitespace-only canonical，中间态从第 3 个空格
开始误走 structural mapper，删除段落边界并导致模式切换展示坏快照。0.13.22 改为：

1. 纯空格中间态不写源码；
2. 首个可见文字到来时一次性追加段落；
3. 行首按 Typora 实测写 `U+200B + ASCII spaces`；
4. parse/visible/caret map 把哨兵作为源码语法处理。

完整报告：`leading-space-mode-switch-regression.md`。
