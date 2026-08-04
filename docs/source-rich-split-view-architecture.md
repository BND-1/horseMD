# 源码 + 富文本双栏实时预览架构

> 状态：第一版已实现；后续以本架构继续扩展
> 日期：2026-08-04
> 对应 PRD：`docs/source-rich-split-view-prd.md`

## 1. 现有基础与结论

HorseMD 当前不是从零开始实现双栏：

- `components/shell/EditorArea.jsx` 已在“源码模式”保留同标签的 Crepe 挂载，只隐藏富文本容器；这是避免大文档重新解析和远程图片重新加载的关键前提。
- `hooks/useSourceModeSwitch.js` 已处理独占“源码 ↔ 富文本”切换、源码 textarea 同步、富文本强制 flush、光标/阅读视口恢复。
- `scrollAnchor.js` 是稳定门面：`mode-caret-anchor.js` 和 `mode-viewport-anchor.js` 已将光标与阅读视口分开处理，优先使用原始 Markdown offset、可见字符和上下文，最后才回退到比例。
- `source-text-fidelity.js` 维护 textarea 被浏览器规范化成 LF 时的原始字节镜像，保护 CRLF、BOM 与未编辑内容。
- `Editor.jsx` 暴露 `replaceMarkdown()`、`flushMarkdown()`、`restoreMarkdownOffset()`、`markdownOffsetFromSelection()` 等 API；富文本当前文档必须经 `serializerCtx` flush，而不是依赖可能滞后的 `crepe.getMarkdown()`。

因此正确路径是：**在同一 Tab 复用一份 textarea 与一份已挂载 Crepe，并在两者间建立有来源、可取消、单向提交的同步协调器。**

错误路径是：

- 左右各创建一个 Crepe；
- 把 textarea 改成受控组件；
- 用两个 `scroll` 回调互相设置 `scrollTop`；
- 每个键入字符全量重解析 Markdown；
- 用标题名或关键词作为唯一同步定位依据；
- 以 `crepe.getMarkdown()` 的异步缓存作为保存/同步唯一依据。

## 2. 推荐模块边界

```text
App.jsx
  ├─ view state: rich | source | splitSourceRich
  ├─ save / close / external-change boundaries
  └─ wires hooks and EditorArea

hooks/useSourceModeSwitch.js
  └─ retains existing exclusive rich↔source behavior unchanged

hooks/useSplitSourceRichSync.js                  (new)
  ├─ owns source/rich revision state
  ├─ source input debounce + IME settle
  ├─ source→rich replace scheduling/cancellation
  ├─ source→rich replace scheduling/cancellation
  ├─ programmatic-write suppression
  └─ exposes activity / preview status

hooks/useSplitScrollSync.js                      (new)
  ├─ determines scroll owner (source | rich | none)
  ├─ requestAnimationFrame coalescing
  ├─ programmatic-scroll tokens / echo suppression
  └─ reuses scrollAnchor facade only

components/shell/EditorArea.jsx
  ├─ layout only: show one or both existing pane types
  ├─ pane refs / focus events / divider
  └─ forwards events to hooks; contains no reconciliation policy

scrollAnchor.js + mode-*                         (existing)
  └─ content-aware capture/restore primitives, not synchronization state

source-text-fidelity.js                          (existing)
  └─ textarea DOM value ↔ raw source byte-preserving conversion
```

`App.jsx` 不应吸收双栏同步细节；`EditorArea.jsx` 不应决定哪一侧覆盖另一侧；锚点模块不应保存 React 状态或监听滚动。

## 3. 显示状态模型

现状把 `sourceModeIds` 表示为“当前 Tab 是否显示源码”。新增后建议把显示状态抽象为每 Tab：

```js
// conceptual type, not final code
viewModeByTab[id] = 'rich' | 'source' | 'split'
```

迁移原则：

- 先在 `useSourceModeSwitch` 内部兼容现有 `sourceModeIds`，增加一个受控的 `splitModeIds`；
- 第二阶段再评估是否统一成 `viewModeByTab`，但不得在同一个功能提交中同时重写敏感切换状态机；
- `split` 指“同一文档左源码 + 右富文本”，与现有 `splitId`（两个不同 Tab 并排）名称必须区分，例如命名 `sourceRichSplitMode`。

建议优先级：

1. Home / settings 无编辑面板；
2. 现有两个文档分屏优先，禁用同文档双栏；
3. 单文档时可选 rich/source/split；
4. heavy / plain text 按 PRD 规则降级。

这样避免现有 `EditorArea` 的 `split`、`splitId` 与新功能语义冲突。

## 4. 单一内容真相与修订号协议

### 4.1 角色

- **提交真相**：`tabsRef.current[id].content`，用于保存、会话、关闭、外部修改和导出。
- **源码表面**：左侧无控制 textarea，`__horsemdSourceRawValue` 保留浏览器 LF 值背后的原始字节。
- **富文本表面**：右侧同 Tab 的只读 ProseMirror 投影。
- **同步协调器**：唯一有权把一个表面的编辑应用到另一个表面并提交 tab 内容的模块。

双栏不是“双向同时写数据库”。任一时刻只有一个来源事件拥有下一次同步权。

### 4.2 概念状态

```js
const sync = {
  revision: 0,                    // 单调递增的文档版本
  sourceRevision: 0,              // textarea 当前原始源码版本
  richRevision: 0,                // ProseMirror 当前版本
  appliedToRichRevision: 0,
  appliedToSourceRevision: 0,
  sourceComposition: false,
  sourceTimer: null,
  richReplaceInFlight: null,
  programmaticSourceWrite: 0,
  programmaticRichWrite: 0,
  previewStatus: 'idle' // idle | pending | applying | stale | error
}
```

这是协议描述，不要求一字不差地使用这些字段；关键是每次异步回调能判别“它仍对应最新输入吗”。

### 4.3 左侧源码 → 右侧富文本

1. textarea `onChange` 继续通过 `updateTextareaSourceFromDom()` 写入原始字节镜像，更新 `liveContentRef`，并把本次输入标记为 `sourceRevision = ++revision`。
2. 正在 IME composition 时，只更新左侧和脏状态，不替换富文本。
3. `compositionend` 或约 180ms 无新输入后，协调器读取**同一个 revision**的 raw source；先 `commitLive(id)`，使 tab 提交真相同步。
4. 调用 `api.replaceMarkdown(rawSource)` 前设置 `programmaticRichWrite` token。
5. `replaceMarkdown` 返回/富文本回调到来时，仅当 token 仍是最新 revision 才设置 `appliedToRichRevision`；旧任务静默丢弃。
6. 富文本投影由程序化 `replaceMarkdown()` 更新；其 `markdownUpdated` 不得被误判为用户编辑或标记为第二次用户编辑。

若解析/替换失败：保留左侧 raw source 和 tab 内容，右侧留在最后成功状态，`previewStatus = error`；不可回滚或丢弃源码。

### 4.4 右侧富文本只读

右侧是投影而非第二编辑器：它设为非可编辑，隐藏块柄和选择工具条，并阻止应用右键菜单。点击、选中或滚动仅服务于阅读和复制，绝不写入 `tabsRef`、不触发 `markdownUpdated`、不标脏。唯一内容方向是左侧源码 → 右侧预览；这样避免两个编辑器表面争抢同一份 Markdown。

### 4.5 保存和外部变更

- 保存：若活动来源是源码，先 `commitAllLive()`；若富文本有 pending edit，先 `flushMarkdown()`；随后读取唯一提交真相。
- 外部变更：沿用已有“本地未保存时提示”逻辑。双栏中的任一真实编辑都属于未保存；仅同步不应额外制造冲突。
- 重新载入外部内容：取消该 Tab 的所有 source/rich 定时任务，递增 generation，销毁/重建必要投影并刷新 textarea raw baseline。

## 5. 滚动联动协议

### 5.1 为什么不能直接同步 `scrollTop`

源码中的一行图片语法、表格分隔行和富文本中的真实图片/表格高度不是线性关系。`scrollTop / scrollHeight` 只可作为最后回退，不能是主算法。两个方向都监听滚动并写对方的 `scrollTop` 会产生反馈环，导致跳动、回顶或高频 reflow。

### 5.2 单主控 + 锚点

复用：

- `captureSourceViewport()` / `restoreRichViewport()`
- `captureRichViewport()` / `restoreSourceViewport()`
- 必要时复用 `captureSourceCaret()` / `captureRichCaret()` 处理活动光标

新增同步器需要维护：

```js
scroll = {
  owner: 'source' | 'rich' | null,
  ownerUntil: 0,
  scheduled: false,
  targetWriteToken: { source: 0, rich: 0 },
  ignoredToken: { source: 0, rich: 0 }
}
```

算法：

1. `wheel`、`pointerdown`、键盘翻页、焦点变化首先声明 owner；用户实际滚动也可在短时窗口内夺回 owner。
2. owner 的 `scroll` 只安排一个 `requestAnimationFrame`。
3. rAF 中从 owner 捕获内容锚点，恢复到另一面板；写入目标前生成 token。
4. 目标的随后的 `scroll` 事件若匹配 token / 同一帧，则忽略，不反向同步。
5. 新的用户 wheel/pointerdown/键盘行为立即取消旧 owner，不等动画或 timeout。
6. 在源码/富文本内容替换期间暂时暂停一次滚动镜像，待渲染稳定后以触发者侧的锚点进行一次重对齐。

目标是“看见同一段内容”，不是把两侧文本顶端每一像素对齐。图片、Mermaid、公式高度完成加载后，只允许有界的稳定重对齐，禁止永久轮询。

## 6. 光标、焦点与模式切换

- 左侧保留唯一可编辑光标；右侧可保留浏览器选区用于复制，但不是编辑光标。源码的加粗自绘光标必须完整放在测得的字符边界前，不能覆盖非空行首字或制造“只能落在首字后”的视觉错觉。
- 左侧编辑后，右侧预览更新**不自动夺取焦点**。
- 右侧点击不改变活动编辑面板或查找目标；查找、替换、保存等仍以左侧源码为准。
- 右上角“关闭预览”直接清除 `sourceRichSplitId` 并返回普通富文本；状态栏模式切换仍按既有路径进入独占源码。
- 既有“有可见光标则跟随光标；阅读时优先视口”不改变。
- 复杂结构映射仍以 raw Markdown offset 为首选；可见字符、上下文、标题、比例依次回退。禁止仅用关键词匹配。

## 7. 与既有功能的集成表

| 功能 | 双栏规则 |
| --- | --- |
| 保存/关闭/自动保存 | 使用统一提交真相，先 flush 当前来源 |
| 查找/替换 | 作用于活动面板；避免富文本高亮和 textarea 选区同时竞争 |
| 评阅/评论/选区工具条 | 仅富文本右侧；不改变源码文本事件 |
| 列表/待办/表格操作 | 仅富文本右侧；通过既有保真序列化回源码 |
| Mermaid / LaTeX | 源码变更 debounce 后刷新右侧；资源渲染完成不再触发内容写回 |
| PDF/HTML/其他导出 | 导出前 flush 当前来源，读取单一 Markdown；不从 DOM 克隆双栏 |
| 外部文件修改 | 双栏任一真实编辑均触发现有冲突提示 |
| 文件分屏 (`splitId`) | 第一版互斥，避免四编辑面板与模糊焦点语义 |
| 重文档 | 默认源码 + 明确“加载预览”；不在后台无限解析 |
| 移动端 | 不展示入口，保持单视图/只读行为 |

## 8. 测试设计

### 8.1 纯函数与协调器单测

- revision 过期任务不会覆盖最新内容；
- source/rich 程序化 token 不会回环；
- source debounce 与 IME composition 边界；
- 取消 Tab / 外部重载会取消计时器；
- scroll owner/token 状态机不会反向回写。

### 8.2 后台 Electron UI 回归

使用 `scripts/lib/electron-test-app.mjs` 默认 background：

- 每字符输入普通段落、标题、软换行、列表嵌套、删除再重写；
- 源码→富文本与富文本→源码各验证内容、dirty、保存、重开；
- source/rich/split 交叉切换：`rich→split→source→split→rich`；
- 反复滚动普通文本、重复词、表格、代码块、图片占位样本；
- 分隔线拖动、窄窗口禁用、已有双文档分屏互斥；
- 查找、评阅、PDF 导出、外部修改提示。

输入规则、光标、换行、源保真必须通过 `human-input.mjs` 一字符一字符输入；不得把批量插入冒充手打测试。

### 8.3 人工与真实输入回归

发布候选在 macOS 按 `docs/macos-real-input-testing.md` 进行真实前端输入检查，重点：中文输入法、长按删除、连续撤销、快速切换面板、拖动滚动条、图片异步加载。常规自动测试必须后台运行，不抢占用户窗口和键鼠。

## 9. 第一版落地记录

- `useSplitSourceRichSync.js`：维护每 Tab revision、输入合并、IME 边界和程序化替换抑制；它不接管保存/原文保真算法。
- `useSplitScrollSync.js`：复用 `scrollAnchor` 的 viewport capture/restore，只在用户当前操作的一侧安排 rAF，同步目标的回显 scroll 由时间/位置 token 抑制。
- `EditorArea.jsx`：只负责同一 Tab 两个既有表面的布局和事件转发；富文本节点仍是原有 `Editor`。
- `App.jsx`：持有独立的 `sourceRichSplitId`，与 `splitId`（两个文件）互斥；现有 Ctrl/Cmd+/ 退出双栏后再进入单视图，避免视图状态重叠。
- `useFindReplace.js`：接收活动表面提示，在双栏内不会总是错误地优先源码 textarea。

回归：`npm run test:source-rich-split`（含 10 次交替滚动、两种源码视图的真实鼠标行首光标、尾部留白与面板内关闭）、`npm run test:rich-dirty-indicator-ui`、`npm run test:issues-105-106-ui`、`npm run test:list-conversion-ui`、`npm run test:rich-list-source-ui`。

## 10. 实施顺序与可回退点

1. 新建 `useSplitSourceRichSync`，只做无 UI 的 revision 与同步单测。
2. 在 `EditorArea` 增加同 Tab 双栏结构，但功能开关默认关闭；确认不多创建 Crepe。
3. 接通内容同步，先覆盖保存与保真回归；失败可关闭入口，原 rich/source 完全不受影响。
4. 新建 `useSplitScrollSync`，只复用 `scrollAnchor` 公开方法，不改锚点算法；独立添加滚动压力回归。
5. 接入模式切出/切入、查找、外部变更、重文档、可访问性和文案。
6. 文档、guide、手工清单、构建和发布验证。

每一阶段均可通过功能开关退回既有独占 rich/source 模式；不得以大规模重写 `useSourceModeSwitch` 来换取代码行数下降。
