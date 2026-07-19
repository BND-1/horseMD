# 模式切换位置漂移 — 交接说明

## 应用背景

HorseMD:Electron + Vite + React + Milkdown Crepe(ProseMirror)的 Markdown 编辑器。
底部按钮 / `Ctrl+/` 在「富文本」和「源码」两种视图间切换。
仓库根:`/Users/yangtingyi/vibe_everything/horseMD`,分支 `main`。

## 需求(用户原话精简)

切换时,根据用户当前**是否有光标**,分两种行为:

1. **无光标 / 光标不在可视区**(用户在滚动阅读):双向切换,视图内容(滚动位置)都不应跳。
2. **有光标在可视区**(用户点过光标、在编辑):光标应保持在原处,且视图跟随光标(光标始终可见)。

## 现状

- 第 1 条已基本可用(光标离屏时,视口保持)。
- **第 2 条在小文档上完美,但在大文档(约 12 万字 + 183 张远程图片)上偶尔会偏** —— 光标或视口落到邻近段落。

## 根因(关键)

`src/renderer/src/components/shell/EditorArea.jsx` 约 L85:

```js
const usesTextarea = isPlainTextDoc(tab) || heavyAsSource || (sourceMode && isLeft)
```

进入源码模式时 `usesTextarea` 为真 → 提前 return 渲染 `<textarea>`,**把 Crepe 富文本编辑器整个卸载**;切回富文本时再重新挂载 Crepe → **每次切换都重新解析整篇文档 + 重新加载所有图片**。这次重渲染的布局是非确定的(图片加载时序、分块解析),所以即便用文字锚点去对齐,光标/视口也会偏。源码端 ↔ 富文本端的滚动映射在这种文档上也是非线性的(图片在源码里一行,在富文本里是高高的 `<img>`),进一步放大误差。

## 建议方向(供参考,可自行设计)

让 Crepe 在切换源码时**保持挂载**(只 `display:none`,不卸载),仅在「源码被真正编辑过」时才把新内容同步进已挂载的 Crepe。这样切回富文本不重新解析,光标和滚动位置天然保留,上面两种需求都能精确成立。

注意处理好:源码编辑的内容同步、单实例/内存,以及不要破坏现有功能(标签、查找、保存、审阅、设置、移动端、代码块、Mermaid、图片粘贴等都得正常)。

## 关键文件

- `src/renderer/src/components/shell/EditorArea.jsx`(L85 卸载/挂载逻辑,重构主战场)
- `src/renderer/src/components/Editor.jsx`(Crepe 创建/销毁/内容,~1513 行)
- `src/renderer/src/hooks/useSourceModeSwitch.js`（`toggleSource` + 模式 effect，当前光标/视口锚点恢复状态机）
- `src/renderer/src/scrollAnchor.js`（稳定公共 façade）及 `mode-visible-map.js`、`mode-caret-anchor.js`、`mode-viewport-anchor.js`、`mode-source-headings.js`

## 怎么验证

真实大文档测:`/Users/yangtingyi/vibe_everything/置身钉内/MinerU_markdown_置身钉内_14.34.50_2064164636132720640.md`(12 万字、183 张远程图)。

CDP 启动:`npx electron . <doc> --user-data-dir=/tmp/x --remote-debugging-port=9222`;切换用点底部 `.status-btn[title*='Ctrl+/']`。注意多 tab 时 `querySelector('.ProseMirror')` 可能命中隐藏的,要用 `offsetParent` 找可见的那个。

两类场景:
1. 滚到中后部、不点光标、切换 → 视口应不动。
2. 在可见处点光标、切换 → 光标留在原处且可见。

## 2026-07-09 修复复盘

### 最终结论

这次问题不是单纯的“关键词匹配不准”,而是模式切换同时踩中了四类不稳定来源:

1. 源码模式卸载 Crepe,切回富文本时重建 ProseMirror 文档和图片布局,大文档布局不具备确定性。
2. 源码和富文本不是同一个线性文本流。图片、链接、标题标记、表格管道、HTML、frontmatter 等在源码里占 raw 字符,在富文本里可能是 atom node 或完全不同的可见文本。
3. “用户在编辑”与“用户在滚动阅读”的状态判断混在一起。源码 textarea 的 selection、scroll 事件和程序化恢复滚动会互相污染,导致本来应该跟随光标的场景被当成阅读态,或者反过来。
4. Crepe 首次解析会规范化 Markdown。小文档会把规范化结果回写到标签和源码 textarea,但坐标映射曾继续使用打开文件时的旧 Markdown 快照;富文本算出的 raw offset 因此被应用到另一套源码坐标,造成只在特定文档稳定复现的漂移。

最终修复思路是:保持富文本编辑器挂载,让 `lastMarkdownRef` 始终与 App/textarea 中的当前 Markdown 快照一致,双向都优先使用块级 Markdown raw offset。全局可见字符索引、上下文和比例只处理无法精确映射的结构。连续往返时保留未被用户移动或编辑的来源 raw offset,避免再次反推造成不可逆漂移。

### 关键改动

#### 1. 源码模式不再卸载富文本编辑器

`EditorArea.jsx` 中把源码模式拆成两层:

- 源码 textarea 作为当前可见编辑面。
- Crepe/ProseMirror 仍保持挂载,只是隐藏。

这样未编辑源码时切回富文本,不需要重新解析整篇 Markdown,也不会重新加载 183 张远程图片。富文本 selection 和 scrollTop 可以直接保留。

#### 2. 只在源码真正修改后同步到 Crepe

当前由 `useSourceModeSwitch.js` 的 `syncSourceToRich(id)` 负责：

- textarea 内容等于 baseline 时不写回 Crepe。
- 内容变化时调用 Editor API `replaceMarkdown(next)`。
- 如果 Crepe 还没 ready,才退回 reloadNonce 触发下一次挂载消费新内容。

这避免了“只是切换视图”也触发文档更新和 dirty 状态。

#### 3. 新增块级源码映射模块

新增 `src/renderer/src/components/editor-source-map.js`,核心职责:

- 用 Milkdown 当前 `remarkCtx` 解析 Markdown,收集 mdast block 的 raw offset 范围和可见文本。
- 遍历 ProseMirror doc,收集 textblock/atom block 的 pos、contentPos、文本和类型。
- ProseMirror 表格单元格内部实际是 `table_cell → paragraph`；收集 textblock 时必须检查祖先并把内层 paragraph 归类为 `tableCell`,否则富文本表格光标会按普通段落序号映射到表格后的正文。
- `markdownOffsetToPmPos(markdown, rawOffset, doc, remark)`:源码 raw offset → ProseMirror pos。
- `pmPosToMarkdownOffset(markdown, pmPos, doc, remark)`:ProseMirror pos →源码 raw offset。

匹配优先级:

1. 同类型 block 的完整可见文本精确匹配。
2. 重复文本按 occurrence index 选择。
3. contains fallback。
4. 同 index / 同 kind fallback。

这比关键词定位稳定,因为它先确定“哪个块”,再在块内按字符位置转换,不会因为全文里出现相同词而跳到别处。

#### 4. 双向切换都走 raw offset

当前实现不再在初始化或切换时把 Crepe 的规范化 Markdown 整篇交给 App。`lastMarkdownRef` 保持与 App/textarea 相同的用户源码，`canonicalMarkdownRef` 只作为 Crepe serializer 的比较基线；真实局部富文本编辑会把变更映射回原始源码。由此 textarea 的 `selectionStart`、`markdownOffsetToPmPos()` 和 `pmPosToMarkdownOffset()` 始终使用同一份当前源码坐标。完整边界见 [markdown-source-preservation.md](./markdown-source-preservation.md)。

源码 → 富文本:

- `captureSourceCaret()` 捕获 textarea 的 `selectionStart` 作为 `rawOffset`。
- `Editor.restoreMarkdownOffset(rawOffset, follow)` 使用块级映射恢复 ProseMirror selection。
- 图片等 atom block 用 `NodeSelection`,普通文本用 `TextSelection.near()`。
- 命中 CodeMirror 代码块时先让外层 ProseMirror 取得焦点再派发 selection,随后按 CodeMirror 的真实 DOM caret rect 滚动外层容器,保证内部光标可见。

富文本 → 源码:

- `Editor.markdownOffsetFromSelection()` 读取当前 DOM/PM selection。
- 如果 selection 位于 CodeMirror,不能使用普通 `view.posAtDOM()`（它只能得到代码块边界）；需按 `.cm-line` 累计换行和行内字符,得到代码块内 PM offset。
- 用 `pmPosToMarkdownOffset()` 反推 raw offset。
- `restoreSourceCaret()` 优先使用 `anchor.rawOffset`,不再优先使用全局可见字符 index。

这一步修掉了图片密集文档里的根本偏移:源码里图片 Markdown 会占很多字符,富文本里图片通常是 atom node,所以两边全局 index 从第一批图片后就不再等价。

#### 5. 区分源码“点击光标”和“滚动阅读”

`EditorArea.jsx` 给 textarea 维护轻量状态:

- `__horsemdSourceSelectionUser`:用户明确选择/点击/键盘移动过光标。
- `__horsemdSourceSelectionBaseline`:进入源码模式后的 selection 基线。
- `__horsemdSourceViewportMoved`:源码视口是否被用户滚动过。
- `__horsemdSourceSelectionAt`:选择发生时间,用于屏蔽选择后短时间内的惯性/程序化 scroll 事件。

`App.jsx` 退出源码模式时据此判断:

- 源码未改、未动 selection、未滚动:保留仍挂载的富文本 selection/scroll。
- 用户点击了源码光标:按 raw offset 恢复富文本光标,并跟随光标。
- 用户只是滚动源码阅读:不跟随旧光标,恢复视口锚点。

#### 6. 安全恢复源码粗光标

旧自绘 caret 用 computed width 和 marker span 估算坐标。在超长、自动换行、滚动恢复的源码 textarea 中,滚动条造成约 10px 宽度误差,会累积成数百像素的垂直漂移。

新实现仍以浏览器原生 selection 为准,使用持久 mirror text node + collapsed DOM Range 测量字符坐标；mirror 强制匹配 textarea 最终 `clientWidth`,并用 `ResizeObserver` 和挂载后的多帧校准处理滚动条晚于首帧出现的情况。自绘光标为 3px 宽、比行高多 4px,测量点离开 textarea 可视区时直接隐藏。同步调度使用 rAF + 80ms timer fallback；窗口被遮挡、rAF 被 Chromium 节流时也不会留下永久 pending 状态。

#### 7. 避免纯切换触发 dirty

相关改动:

- `Editor.jsx` 的 `markdownUpdated` 只在最近存在用户编辑意图时向外发 `onChange`。
- `useFileOps.js` 对相同内容 no-op,避免 Crepe 规范化输出把干净文档重新标 dirty。
- `App.jsx` 的 `commitLive()` 对相同内容 no-op。
- 移动端保存按钮在 clean 状态禁用。
- 源码模式审阅操作使用 textarea 当前 value,并同步写回 textarea,避免 stale tab content。

### 验证记录

基础验证:

```bash
npm run build
node scripts/test-strike-guard.mjs
```

结果:

- `npm run build` 通过。
- `test-strike-guard.mjs`:27 passed,0 failed。

真实大文档验证:

文档:

```bash
/Users/yangtingyi/vibe_everything/置身钉内/MinerU_markdown_置身钉内_14.34.50_2064164636132720640.md
```

启动方式:

```bash
./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
  /Users/yangtingyi/vibe_everything/horseMD \
  "/Users/yangtingyi/vibe_everything/置身钉内/MinerU_markdown_置身钉内_14.34.50_2064164636132720640.md" \
  --user-data-dir=/tmp/horsemd-final-test \
  --remote-debugging-port=9351
```

覆盖点:

- 源码 → 富文本:10 个光标位置通过。
- 富文本 → 源码:10 个光标位置通过。
- 覆盖前部、中部、后部,以及此前失败的 `智能是平权的`、`组织`、`业务`、`模型`。
- `业务` 位置单独复现过一次,确认光标落在正确段落并可见。

测试时注意:

- 多 tab 下不要直接 `document.querySelector('.ProseMirror')`,要筛 `offsetParent` 找可见编辑器。
- 源码 textarea 的程序化 scroll 会触发 scroll 事件,自动测试如果要模拟“用户点击源码光标”,要同时设置 selection intent,并避免把这类程序化 scroll 当成阅读态。
- 阅读态不能用 textarea scrollTop 按全文比例反推可见文本;图片密集文档的源码/富文本高度是非线性的,这种断言本身不可靠。

### 这次踩过的坑

- 只用关键词匹配不够。重复词、相邻段落、短标题都会造成误命中。
- 全局可见字符 index 也不够。图片和 atom node 让源码与富文本的文本流从结构上不等价。
- 源码 selection baseline 缺失时,会误把“用户在源码里点过光标”当作“只是查看源码”,从而保留旧富文本光标。
- textarea 自绘光标在大文档中风险高；必须匹配最终 `clientWidth` 而不是 computed width,并处理滚动条在首帧后改变可用宽度。
- “是否 dirty”必须和“模式切换/编辑器规范化输出”解耦,否则只是切换视图也会把已保存状态变成可保存。

### 后续维护建议

- 不要再用全文关键词作为主路径恢复光标。关键词/上下文只能作为兜底。
- 如果新增 Markdown block 类型,需要同步检查 `editor-source-map.js` 的 mdast/PM kind 映射。
- 源码粗光标必须在真实大文档前/中/后检查尺寸、可见边界和点击行误差,否则容易重新出现遮字和空白光标。

### 2026-07-12 重构完成时快照（历史行数）

本轮没有把所有逻辑继续堆进 `App.jsx` / `Editor.jsx`。当前模式切换相关职责如下:

- `App.jsx`（954 行）:组合标签、编辑器 ref 和 shell，不再直接实现跨视图状态机。
- `useSourceModeSwitch.js`（259 行）:唯一负责 per-tab 模式、源码→富文本同步、编辑/阅读意图和延迟锚点恢复。
- `Editor.jsx`（591 行）:仍是 Crepe 生命周期 owner；当时负责同步 Markdown snapshot 和暴露 API。当前原文保真职责见 [markdown-source-preservation.md](./markdown-source-preservation.md)，不要把本段历史描述理解为整篇规范化回写的现行设计。
- `editor-source-map.js`（342 行）:唯一的 Markdown raw offset ↔ ProseMirror pos 块级映射；表格祖先类型在这里归一。
- `editor-api.js`（204 行）:编辑器公开操作,不再内嵌 CodeMirror DOM 遍历。
- `editor-codemirror-selection.js`（49 行）:CodeMirror DOM selection → block/local/PM position 的唯一实现,由 caret capture 与 Editor API 复用。
- `textarea-metrics.js`（74 行）:textarea mirror 样式、最终 client width、char ↔ pixel 的唯一实现；源码 viewport、查找高亮和粗光标共用。
- `editor-source-caret.js`（113 行）:只管理粗光标 DOM、闪烁、事件和可视边界,不自行维护 mirror 排版规则。

本轮清理掉的冗余:

- 删除两份 CodeMirror 行/字符累计实现,统一到 `editor-codemirror-selection.js`。
- 删除源码光标、源码查找和 viewport 各自维护的 mirror width/style 规则,统一到 `textarea-metrics.js`。
- 删除无调用者的 `scrollMarkdownOffsetToTop()` 和已失效的 `rawOffsetExact` 标记。

本轮按测试先行完成的低风险拆分:

- 新增 `npm run test:source-map`,用真实 remark-gfm AST 与 ProseMirror Schema 覆盖重复段落、表格单元格/内联代码、fenced code、列表、图片和 HTML 六组双向 offset。
- `scrollAnchor.js` 从约 1010 行降为约 35 行稳定 façade,外部 import 与 10 个公共函数签名不变。
- `mode-visible-map.js`（约 343 行）承载 visible stream 与 fallback 映射。
- `mode-caret-anchor.js`（约 368 行）承载编辑态光标 capture/restore。
- `mode-viewport-anchor.js`（约 252 行）承载阅读态 viewport capture/restore。
- `mode-source-headings.js`（约 65 行）承载 CommonMark/GFM 源码标题解析和跳转,避免模块循环依赖。

仍需控制的技术债:

- 当时 `App.jsx` 为 954 行，但高风险模式切换已通过稳定 ref 合同提取。后续不得把状态机逻辑回填到 App；只有出现明确独立职责和测试保护时才继续拆。文件行数会随功能变化，以当前工作树为准。
- `app.css` 约 4874 行,是当前最大的单文件。建议按 shell/editor/outline/find/review/settings 分文件,保留统一入口与原有 import 顺序,避免层叠优先级回归。
- 两个 CDP 模式切换脚本合计约 600 行,属于测试驱动代码而非运行时体积。后续可抽共享 CDP client/点击/context helper,但不影响应用包运行复杂度。

结论:模式切换采用结构化映射和边界处理，不以全文关键词作为主路径；状态机现已提取到 `useSourceModeSwitch.js`。任何后续修改都必须保留 keep-mounted、uncontrolled textarea、只同步真实源码编辑和 caret/viewport 双意图四项合同，并执行双向链路、表格、代码块及真实大文档回归。
- 模式切换回归最好固定使用真实大文档,小文档无法暴露图片、atom、chunk parse、远程资源加载带来的问题。

## 2026-07-18：原始 Markdown 写法保真（Issue #77）

模式切换位置稳定不代表源码写法稳定。Crepe/remark 会在富文本编辑后生成 canonical Markdown；若把它整篇回写，未编辑区域也会出现 `\~`、新增空行或列表标记变化。当前 `Editor.jsx` 保留用户原始源码快照和 Crepe canonical 快照，局部文字变更只映射回原始源码的对应范围；无编辑切换不会回写。

剪贴板同时带 `text/plain` Markdown 和 `text/html` 是此前遗漏分支：默认 HTML 粘贴会正确显示，却在切源码时重新序列化。现在只有原始 Markdown 能覆盖 HTML 的标题、列表、表格、格式、链接、图片和硬换行语义时，才直接以 Markdown 插入并保留原文；否则继续采用网页 HTML 粘贴，避免微信公众号内容丢格式或图片。

这与当前的光标/视口 raw offset 映射互补。完整合同、测试命令、竞品调研和未来源码优先 Live Preview 的边界见 [markdown-source-preservation.md](./markdown-source-preservation.md)。
