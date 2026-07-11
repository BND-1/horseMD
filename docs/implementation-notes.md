# 实现笔记：踩过的坑、根因与决策

这份文档记录开发过程中发现的关键问题、根本原因、修复方式，以及一些设计决策。很多 bug 是用 CDP 端到端实测（见 [development.md](./development.md)）才定位到的。

---

## 致命 bug 1：所有"视图相关"功能静默失效

**现象**：改标题层级的按钮"点不动"、`Ctrl+1/2/3` 没反应（数字还被打进正文）、右键菜单不弹、选中浮条不出现、Ctrl+点链接/富文本复制/图片解析全不工作。

**根因**：这些功能都依赖底层 ProseMirror 的 `EditorView`，而代码用 `crepe.editor.view` 取它 —— 在本项目的 Milkdown 版本里这是 `undefined`。于是所有 `if (view) { … }` 的逻辑从未执行，监听器一个都没挂上。

**修复**（`Editor.jsx`）：
```js
import { editorViewCtx } from '@milkdown/kit/core'
const view = crepe.editor.ctx.get(editorViewCtx)   // 不是 crepe.editor.view
```

**教训**：一个底层引用取错，会让一大片上层功能"看起来各自坏了"，其实是同一个根。

---

## 致命 bug 2：编辑内容不同步、保存会丢编辑

**现象**：编辑器里改了内容，但大纲不更新、字数不变、"● 已修改"不亮 —— 最严重的是 `Ctrl+S` 会把文件存回**初始内容**，悄悄丢掉所有编辑。

**根因**：内容变更回调 `markdownUpdated` 注册在 `crepe.create()` **之后**。Crepe 在 `create()` 时就把监听器接好了，之后再注册的永远不触发，于是 `tab.content` 一直停在打开时的初始值，所有派生状态（大纲/字数/脏标记/保存内容）都跟着冻结。

**修复**（`Editor.jsx`）：把 `crepe.on(markdownUpdated)` 移到 `create()` **之前**。

```js
crepe.on((api) => api.markdownUpdated((_ctx, md) => { if (ready) onChange?.(md, false) }))
await crepe.create()
```

---

## bug 3：选中/双击时内容整体上移 + 表格里看不见光标

**现象**：在编辑器里选中段落或双击时，内容会"整体向上跳"；表格单元格里完全看不到光标。

**根因**：Crepe 默认开启 **virtual cursor**（`prosemirror-virtual-cursor`），用一个自定义元素替换原生光标。它在选区/聚焦时往文本流里插入元素 → 触发回流（内容跳动）；同时把原生光标设为透明 → 表格里看不见。

**修复**：
- `Editor.jsx` 关闭该特性：`[CrepeFeature.Cursor]: false`，改用原生光标
- `styles/app.css` 给原生光标上色：`caret-color: var(--accent)`，并显式覆盖表格单元格
- 顺手去掉 `.editor-scroll` 的 `scroll-behavior: smooth`（它把每次隐式滚动变成肉眼可见的滑动），加 `overflow-anchor: none`

---

## bug 4：选中浮条永远不出现

**现象**：选中文字后，自研的浮动控件不显示。

**根因**：判断条件用了 `sel instanceof TextSelection`，而 Crepe 自带一份打包好的 `prosemirror-state`，view 的 selection 是它那份 `TextSelection` 的实例，跟我们 `import` 的不是同一个类 → `instanceof` 永远 false。

**修复**：改成鸭子类型判断（`sel.empty || sel.from === sel.to`），不依赖 `instanceof`。

> 后来该浮条整体被"工具条注入按钮"方案替代（见下）。

---

## bug 5：右键菜单/上下文相关的时序假象

**现象**：自动化测试里右键菜单"没打开"。

**根因**：是测试脚本的时序问题 —— 原生监听器调 React `setState` 是异步渲染，脚本同步查 DOM 太早。给测试加上等待后即正常。

**教训**：区分"真 bug"和"测试方法的假象"很重要。多个最初看似失败的项（键盘转换、浮条、图片）最后都被证明是 CDP 合成事件的局限（合成拖拽不驱动 ProseMirror 选区、`requestAnimationFrame` 在窗口被遮挡时被节流等），而非应用本身的问题。

---

## bug 6：标签去重竞态（会话恢复出现重复标签）

**现象**：恢复会话时出现多个重复的 README 标签。

**根因**：`openPaths` 用 `setTabs` 回调异步读 `existing`，但紧接着同步判断，读不到刚加的，导致同一文件被重复打开。

**修复**：用一个始终最新的 `tabsRef` 同步快照来去重 + 调用内 `seen` 集合去重。会自愈（下次恢复时折叠重复项）。

---

## 决策：改标题层级整合进 Crepe 工具条

需求是把"改层级"做成加粗/斜体工具条里的一个按钮，悬浮展开 H1/H2/H3/¶。Crepe 工具条的 `buildToolbar` 只支持扁平的"图标+点击"，**不支持子菜单**。

**做法**：用 `MutationObserver` 监听 `.milkdown-toolbar` 出现，往里注入自己的 `.hm-heading-item` DOM，CSS `:hover` 展开子菜单。两个坑：
- Crepe 工具条 `overflow: hidden` 会裁掉子菜单 → 覆盖成 `overflow: visible`
- 注入用了 `requestAnimationFrame` 节流，但窗口被遮挡时 rAF 几乎不触发 → 改成同步注入（幂等）

---

## bug 7：Ctrl+B 切侧边栏时灵时不灵

**现象**：按 `Ctrl+B` 想切侧边栏，但经常不生效，或被编辑器拿去加粗。

**根因**：`Ctrl+B` 在主进程菜单注册成了加速器，而编辑器（ProseMirror）也把 `Mod-B` 绑成加粗 —— 冲突，编辑器经常先吃掉这个按键。

**修复**：
- 主进程移除 `Toggle Sidebar` 的 `CmdOrCtrl+B` 加速器（避免和渲染层双触发）
- 渲染层在 **捕获阶段** 监听 `Ctrl/Cmd+B`，先于编辑器处理：切侧边栏 + `preventDefault/stopPropagation`（编辑器收不到 → 不加粗）
- `metaKey` 一并判断，macOS 的 `Cmd+B` 同样生效

---

## 决策：应用图标

- 源图 `icon.png`，用脚本生成多分辨率 `build/icon.ico`（16–256），并裁出 **22% 圆角**（圆角外透明），避免硬直角
- macOS 图标 `build/icon.icns` 同样由 `icon.png` 生成（`iconutil`，16–1024 全尺寸）；`build.mac.icon` 指向它
- `package.json` 的 `build.win.icon` / `nsis` / 文件关联都指向 ico
- 首页 logo 用图标副本 `src/renderer/src/assets/logo.png`（CSS 加圆角）

> 注意：`System.Drawing.Icon` 解码不了 PNG 内嵌的 ICO 帧（会渲染成噪点），这是验证工具的局限，不代表 ICO 坏了 —— Windows / electron-builder 能正常读。

---

## 决策：窗口拖拽区域

无边框标题栏下，拖拽区由 `-webkit-app-region` 决定。最初 `.tabs` 被设成 `no-drag`，而标签容器占了顶栏绝大部分宽度 → 几乎整条顶栏不能拖。改成：标签**容器背景**可拖（`.tabs/.tabs-scroll`），只有标签页/按钮 `no-drag`；活动栏空白也可拖。

---

## bug 8：.txt 大文件卡死 / 加载不出来

**现象**：同样长度的内容，`.md` 秒开流畅，`.txt` 很卡甚至加载不出来。

**根因**：两者走同一条渲染路径，都被丢进 Milkdown。`.md` 段落间有空行 → 解析成很多小段落块，ProseMirror 轻松渲染；而 `.txt` 通常是"行行相连、没有空行" → 在 Markdown 里被当成**一整个超大段落**，内含几千个换行节点。ProseMirror 渲染单个超大文本块极慢，文件一大就卡死。附带问题：纯文本的换行被折叠、`*`/`#` 被误当语法。

**修复**（`App.jsx`）：按扩展名路由编辑器 —— `.md/.markdown/.mdx`（及无路径的新建文档）走 Crepe；`.txt` 等带路径的非 Markdown 文件走 `textarea`（瞬开、保留换行、不解析语法）。判定用 `MD_DOC_RE` / `isPlainTextDoc`。

> 顺带修了一个放大器：原来富文本路径给**每个**标签都挂 Crepe（哪怕隐藏），重型 txt 即使在后台也拖慢全局。现在纯文本标签只在激活时渲染。

---

## 决策：macOS 标题栏布局（红绿灯不交叉）

macOS 用 `titleBarStyle: 'hiddenInset'`，红绿灯（关/最小/最大）浮在左上角。最初它们横跨"活动栏(深色)"和"顶栏"两块背景之间，中间有色缝 → 看起来"交叉"在界面里；按钮还会压住第一个标签。

**做法**（仅 `.app.is-mac`，不影响 Windows）：
- 主进程固定 `trafficLightPosition: { x: 14, y: 14 }`，让渲染层能精确让位
- 顶栏横跨整个宽度成为一条**独立标题栏**（`grid-column: 1 / -1` + `padding-left` 给红绿灯留位）
- 活动栏下移到标题栏**下方**（`grid-row: 2 / -1`）→ 红绿灯落在同一条背景上、自成一行，不再交叉

> 平台样式一律写在 `.app.is-win` / `.app.is-mac` 选择器下；改顶栏时两个系统都要验证。

---

## bug 9：查找会匹配到查找框自己 + 上下一个卡顿

**现象**：`Ctrl+F` 查找时，输进查找框的字本身也会被算成一处命中；next/prev 还有可感知的延迟。

**根因**：旧实现用 `window.find`（会扫描整页，包含查找框这种 UI 文本），且依赖 IPC/原生选区往返。

**修复**（`App.jsx` 的 find-in-document helpers）：改用 **CSS Custom Highlight API**（`CSS.highlights` + `Highlight`）。只在编辑器正文（富文本 `view.dom` 或源码 `<textarea>`）里收集匹配区间并上色，**不碰查找框、不改 DOM、不插标记节点** —— 既不会匹配到自己，也不污染文档、不触发重排。当前命中用单独的 highlight 名（`hm-find-current`）高亮，上下一个纯前端切换，无 IPC 往返，并实时显示 `当前/总数`。不支持该 API 的环境优雅降级（`findHighlightSupported`）。

---

## 决策：Windows 自绘窗口按钮（弃用 titleBarOverlay）

最初 Windows 用 Electron 的 `titleBarOverlay`（系统画最小/最大/关闭）。为了能自定义 hover 态（关闭悬浮变红）并和整体配色一致，改成**渲染层自绘**三个按钮。

**做法**：
- 主进程关掉 `titleBarOverlay`，加 `window:minimize/toggleMaximize/close/isMaximized` IPC（`main/index.js`）
- 真实窗口状态会被外部操作改变（双击拖拽最大化、系统快捷键），所以主进程监听 `maximize/unmaximize` 推 `window:maximized`，渲染层据此翻"最大化/还原"图标 —— 否则图标会和实际状态脱节
- `WindowControls` 仅在 `platform === 'win32'` 渲染（macOS 保留原生红绿灯）

---

## bug 10：标签塞满后整条标题栏拖不动

**现象**：开很多标签把标签条占满后，顶栏几乎没有空白可拖动窗口。

**修复**：始终为标题栏保留一块可拖动区域（即使标签铺满整条），见 `App.jsx` / `styles/app.css` 的拖拽区调整。延续[窗口拖拽区域](#决策窗口拖拽区域)的思路 —— 标签/按钮 `no-drag`，但容器留出可拖背景。

---

## bug 11：卸载会连带删掉用户文件

**现象**：把 Markdown 笔记存在安装目录旁边，卸载 HorseMD 时会被一并清空。

**根因**：NSIS 卸载默认对安装目录做整体递归删除。

**修复**（`build/installer.nsh`）：卸载器只删 HorseMD 自己装进去的文件，保留用户文件；同时把安装位置固定到**专属的 per-user 目录**，避免被装进用户自己的文件夹里。属于 Windows 专有，不影响 macOS。

---

## 决策：源码/富文本切换保持滚动、不重建后台编辑器

切换"源码 / 富文本"时，保留当前滚动位置，且不重建后台（非激活标签）的编辑器实例，使切换明显更快（`App.jsx`）。配合"富文本标签首次激活后常驻挂载、纯文本标签按需渲染"的策略，避免每次切换都重挂一堆 Crepe。

2026-07 更新后，这个策略进一步收紧为：

- 源码模式不卸载当前富文本 Crepe，只隐藏富文本面板并显示 textarea。
- 源码/富文本是**每个标签独立**的视图状态，用 `sourceModeIds` 跟随 tab id。
- 源码 textarea 仍保持非受控；实时内容进 `liveContentRef`，真正编辑过的 tab 才进入 `sourceEditedIds`。
- 切回富文本只同步 `sourceEditedIds` 里的源码内容，未编辑源码时不调用 `replaceMarkdown()`，不触发 dirty。
- 大文档光标定位靠 Markdown raw offset ↔ ProseMirror position 映射，不再用关键词或纯滚动比例猜测。

---

## 决策：Slash 菜单贴边修正

Crepe 的 `/` 菜单使用 Floating UI 的 `flip()`，但没有暴露 `shift()` / boundary 配置；菜单在窗口顶部、底部或小窗口下可能仍算到编辑区外，被标题栏、状态栏或 App 边框遮住。

HorseMD 在 `editor-dom-bindings.js` 做 DOM 层边界修正：

- 监听 `.milkdown-slash-menu[data-show="true"]` 的显示与 style 变化。
- 以当前可见 `.editor-scroll` 与 `window.innerWidth/innerHeight` 的交集作为安全区。
- 菜单超出安全区时修正 `left/top`；小窗口下压缩 `.menu-groups` 的 `max-height`，再下一帧复算位置。
- 该逻辑只作用于已显示的 slash menu，不改 Milkdown schema / node view / 输入规则。

---

## 性能：大文档卡顿 & 重开恢复很慢

**现象**：打开 8 万字符以上的大文档明显比 Typora 慢、卡；关掉重开（自动恢复上次的标签）时也很卡。

**根因**（用 CDP 做了优化前后 A/B 实测）：
1. **重开恢复**：旧版**所有 Markdown 标签一律常驻挂载**——恢复会话时会**同时创建 N 个 Crepe 编辑器**，每个在主线程上同步解析整篇 Markdown。实测恢复 4 个标签 = 启动瞬间建 4 个编辑器。这是"重开很卡"的主因。
2. **大文档打字**：v0.1.4 加的浮动块级标记绑在 `selectionchange` 上（每次按键都触发），每次都做 `coordsAtPos` + `getBoundingClientRect` 这类**强制同步重排**，在巨大 DOM 上很贵；选中工具条的 `MutationObserver` 监听整个 `document.body` 子树，**任何 DOM 变动都跑一次全文档 `querySelectorAll`**，多个编辑器挂载时还要乘以个数。

**修复**：
- **编辑器懒加载**（`App.jsx`）：用 `mountedIds` 记录"被激活过"的标签，标签**只在首次激活时**才渲染 `<Editor>`（创建 Crepe），之后保持挂载（切换仍即时）。恢复会话时只有当前激活的标签会建编辑器——实测恢复时挂载数从 **4 → 1**。
- **块级标记 rAF 节流**（`Editor.jsx` 的 `scheduleLevel`）：`selectionchange` / 滚动把多次测量合并成**每帧一次**；未聚焦的编辑器直接跳过。
- **工具条监听去抖**（`Editor.jsx`）：只在 mutation **真正新增节点**时才重扫，且每帧合并一次，不再每次编辑都全文档查询。

**结果**：恢复挂载 4→1；大文档冷启动到渲染完约 0.87s；打字尾帧（p99）有改善。

> 仍有地板：Crepe/Milkdown 的 `markdownUpdated` 监听器**每次按键都把整篇文档序列化成 Markdown**（库内部机制，我们靠它拿内容做保存/大纲/字数）。这是大文档打字的固定开销，去不掉——除非改成"空闲/保存时才序列化"，那是更大、更有风险的改动（整条内容数据流都依赖逐键回调，见上文"编辑器内容数据流"），留作后续单独处理。

---

## 致命 bug 12：HTML 节点视图把图片/代码块/表格全冲掉了

**现象**：加了"HTML 表格渲染"后，发现图片不能再加说明（caption）、点图片只剩难看的选中线框；进一步排查发现**代码块的 CodeMirror 高亮、GFM 表格、列表项**的组件渲染其实也都没了。

**根因**：最初注册 `html` 节点视图用的是
```js
ctx.update(editorViewOptionsCtx, (prev) => ({ ...prev, nodeViews: { ...prev.nodeViews, html } }))
```
但看 `@milkdown/core` 创建 EditorView 的代码：
```js
new EditorView(el, {
  nodeViews: Object.fromEntries(ctx.get(nodeViewCtx)),  // 组件们(image-block/code/table/list)的节点视图
  ...options   // ← editorViewOptionsCtx 在最后展开，整个 nodeViews 被覆盖
})
```
`...options`（即 `editorViewOptionsCtx`）**在最后展开**，于是我设的 `{nodeViews:{html}}` 把上一行从 `nodeViewCtx` 收集来的**所有组件节点视图全覆盖**了。HTML 表格能渲染，是因为我那份 nodeViews 生效了；代价是其它组件全失效。

**修复**（`Editor.jsx`）：改成往 Milkdown 共享的 `nodeViewCtx` **追加**（`$view` 内部用的同一通道），与组件节点视图合并而非覆盖：
```js
import { nodeViewCtx } from '@milkdown/kit/core'
crepe.editor.config((ctx) => {
  ctx.update(nodeViewCtx, (views) => [...views, ['html', (node) => renderHtmlNodeView(node)]])
})
```

**教训**：给 Crepe/Milkdown 加节点视图一律走 `nodeViewCtx`（或 `$view`），**不要**碰 `editorViewOptionsCtx.nodeViews`——它会整体覆盖。

---

## 决策：图片双击放大 + 点击说明聚焦

需求：点图片放大查看；但**不能影响** Crepe 原生的图片交互（单击选中、加说明）。

几个坑：
- **不能用单击放大**：会抢掉单击 → 说明输入框拿不到点击、焦点，打字跑进正文。改成**双击**放大、单击完全交还原生。
- **不能用原生 `dblclick` 事件**：图片是 Vue 组件（`milkdown-image-block`），第一次单击会选中并**重渲染**，两次物理点击落在不同 DOM 节点上，浏览器根本不触发 `dblclick`。改成**自己按时间判定**：同一张图 350ms 内点两次（用 `img` 的 `src` 匹配，跨重渲染也认得）。
- **放大判定排除控件**：点在说明输入框 / 说明按钮 / 缩放手柄上不触发放大（否则会抢说明输入框的点击）；点图片本体或 `.image-wrapper` 才放大（选中后图片上有浮层，靠 wrapper 兜底）。
- **点说明按钮要自动聚焦输入框**：组件只是显示说明输入框、不聚焦，导致打字进正文。监听说明按钮点击后，等输入框渲染出来再 `focus()`（带重试）。

放大用一个纯显示的灯箱覆盖层（`.hm-image-lightbox`，Esc / 点背景 / ✕ 关闭），不改文档模型。

> 图片说明等文案的中英文：通过 `imageBlockConfig` / `inlineImageConfig` 在创建时按当前语言设置；语言切换时再更新配置 + 直接改已渲染 `.caption-input` 的 placeholder（组件会缓存配置不会自己重读，所以补这一手）。

---

## 决策：关闭窗口时提醒未保存

之前只有**关标签**（`closeTab`）检查未保存，**关窗口/退出**不查。脏状态在渲染层，所以主进程拦截窗口 `close`：用 `allowClose` 标志，未确认时 `preventDefault` 并 `sendToRenderer('app-close-request')`；渲染层检查有无脏标签，干净或用户确认后 `window.api.confirmAppClose()` → 主进程置 `allowClose=true` 再 `mainWindow.close()`。覆盖 macOS 红灯、Windows 自绘关闭按钮、Cmd/Ctrl+Q。干净时无弹窗、不卡。

---

## 决策：大文档加载骨架屏

打开大文档有可感知的渲染耗时，之前是一段空白。加一个骨架屏（`.editor-skeleton`，波动的灰色占位条）。

- **按内容大小触发，不按时间**：实测同一个 30 万字文档冷启动要 ~1.15s、热启动 50ms 内就好，时间延迟方案不可靠。用 `initialContent.length > 8000` 才显示——大文件一定有反馈、小文件绝不闪。
- 骨架在 `!loaded && isLargeDoc` 时渲染，编辑器 ready（`crepe.create()` 完成）后移除；位置和正文对齐。
- **移除时机要用 `flushSync`**，否则会和已渲染正文重叠几百毫秒——见下方 bug 16。

---

## 致命 bug 13：相对路径工作区让文件监听器递归整个文件系统、启动即崩

现象：用 Finder/launchd 打开打包版**秒崩黑屏**（`open` 启动崩，但从终端直接跑二进制不崩）。崩溃报告是主进程 `SIGABRT`，栈在 libuv/c-ares。

根因：会话里存了一个**相对路径**的工作区（`rootPath: "."`，测试时混进去的）。chokidar 监听 `"."` 时按**进程当前目录**解析——Finder/launchd 启动时 CWD 是 `/`，于是去递归监听整个文件系统（`/dev`、`/System/Volumes`…），`EACCES`/`EAGAIN`/`EBUSY` 错误刷屏，未处理 → `abort()`。从终端跑不崩，是因为 shell 的 CWD 是仓库目录。

修法（多层）：
- `watchers.js` 的 `watch:start` **只监听绝对路径**，拒绝受限根（`isRestrictedWatchRoot`：`/`、`.`、`..`、相对路径、`/dev`、`/System/Volumes` 等），`followSymlinks:false`，每个 watcher 加 `'error'` 处理吞掉权限错。
- `extractArgs()` 把启动参数 `resolve()` 成绝对路径，并跳过 app 自身目录（dev 下 argv 含 `.`）。
- 渲染层 `sanitizeWorkspace()` 丢弃非绝对路径的恢复工作区；`onOpenFolderPath` 同样校验。
- 主进程加 `process.on('unhandledRejection'/'uncaughtException')` 兜底，任何漏网异步错误都不再能崩掉应用。
- 顺带：主进程网络请求（更新检查）改用 Electron `net.fetch`（Chromium 网络栈），不用 Node 全局 `fetch`（其 c-ares 解析在未签名应用 + launchd 下也可能 abort）。

## bug 14：标签右键"重命名"点了没反应

`renameTabFile` 用了 `window.prompt` —— **Electron 渲染层不支持 `prompt()`**（直接抛 "prompt() is not supported"），所以重命名静默失效。（文件树的重命名没事，因为它用的是行内 `<input>`，不是 prompt。）

修法：改成自研的内联弹窗 `RenameModal`（居中输入框，默认选中不含扩展名的部分，回车确认 / Esc 取消）。`window.confirm` / `window.alert` 仍可用，只有 `prompt` 不行。

## bug 15：重文档（无空行）富文本渲染卡死十几秒

现象：切到某些"大文件"主线程**冻结 10 秒**、期间点啥都没反应。实测一个 81KB 文件冻结 10.2 秒。

根因：该文件 2735 行里**只有 2 个空行**——Markdown 把它压成几个超大段落，单段内有上千个换行节点，ProseMirror 近乎平方级渲染。和文件大小关系不大，关键是**缺少空行分段**。

修法：`isHeavyDoc()`（连续非空行 > 150 行，或总长 > 400KB）识别重文档，默认用纯文本极速模式打开，顶栏给"渲染为富文本"按需加载。见 [features.md](./features.md) 第 16b 节。

## bug 16：骨架屏与已渲染正文重叠几百毫秒

现象：大文档（尤其切源码↔富文本时）正文已经画出来了，骨架屏还压在上面好几百毫秒。

根因：`crepe.create()` 完成后在**同一个回调**里先做了重活（`getMarkdown()` 整篇序列化 + `onChange` 触发大纲/字数重算），最后才 `setLoaded(true)`。React 把这一整段的状态更新批处理到结尾才重绘，所以"清骨架屏"的重绘被重活挡住了。

修法：内容一进 DOM 就**用 `flushSync(() => setLoaded(true))` 同步移除骨架屏**（绕过批处理），再把序列化/`onChange` 推迟到下一帧。骨架屏阈值也从 `> 20000` 降到 `> 8000` 让反馈更早。

## bug 17：代码块进入时默认高亮"当前行"

CodeMirror 默认带 `highlightActiveLine`，进入代码块/打开时会给光标所在行(及打开时的第一行)画一条横向高亮带,显得多余。用 CSS 把 `.cm-activeLine` / `.cm-activeLineGutter` 背景设为透明,只留光标标示位置。

## bug 18：浮动块级标记与拖拽手柄重叠

跟随光标的 H1/H2/正文 浮动标记和 Crepe 的块级拖拽手柄(⠿,悬停出现)都在文本左侧的 gutter,会重叠。

- 第一版改成"有手柄就藏标记" —— 但手柄一悬停就出现(鼠标常停在编辑区),导致标记几乎一直看不到,过头了。
- 最终:**两个都显示、标记避让** —— 当手柄出现在光标所在行时,把标记的右边缘挪到手柄左侧(`badgeRight = min(默认, handle.left - 6)`),并加 `mousemove → scheduleLevel` 让标记随手柄出现而重定位。键盘编辑(无悬停)时标记照常显示。

## bug 19：点击表格单元格出现刺眼的选中线框

ProseMirror 默认 `.ProseMirror-selectednode { outline: 2px solid #8cf }`(生硬浅蓝方框),加上 Crepe 给选中单元格的强调色描边,点击表格时会出现一圈和主题违和的"线框"(Windows 上尤其明显)。

- 表格:`.milkdown-table-block` 内的节点/单元格选中**一律不画 outline**(多格范围选择的柔和填充保留)。
- 其他节点(图片、HTML 块):把 `.ProseMirror-selectednode` 从硬蓝 `#8cf` 换成**主题色柔光**(`--accent-soft`)。
- 列宽拖拽手柄的硬编码蓝 `#adf` 也换成主题强调色。

## 重构：从 App.jsx / Editor.jsx 拆出纯函数与叶子组件

`App.jsx`(1598 行)、`Editor.jsx`(992 行)过大。按"纯函数 + 仅靠 props 的叶子组件"低风险原则拆分,**核心 `App()` / 编辑器主体保持不动**(状态/ref/effect 高度耦合,拆了易引 bug):

- `find.js`(查找高亮)、`paths.js`(路径/文件名/版本/重文档判定/会话/genId)、`ui.js`(`fireToast` + `copyToClipboard`)。
- `components/{Welcome,WindowControls,UpdateToast,RenameModal}.jsx`。
- `components/editor-{html,images,copy}.js`(HTML 节点视图、图片路径、富文本复制)。
- 顺带去重:路径/文件名/校验 helper、toast+剪贴板、会话写盘(收敛成一个 `flushSession`)。

App.jsx 降到 ~1300、Editor.jsx ~836。冒烟测试 10/10 通过,行为不变。

## 决策：Mermaid 走代码块自带的 "preview" 机制（LaTeX 同款）

Crepe 的 CodeMirror 功能**拥有** `code_block` 的 node view,且代码块自带一套
"preview"（预览/折叠）机制——和 LaTeX 那种"渲染结果 + 工具栏里的隐藏/编辑按钮"完全
一致。所以 Mermaid 不再自己画 widget 装饰,而是复用这套机制:

- `codeBlockConfig.renderPreview(language, text, setPreview)`(`editor-mermaid.js` 的
  `createMermaidPreviewRenderer`):`language === 'mermaid'` 时返回图表 SVG(异步,渲染完
  用 `setPreview` 回填),其它语言返回 `null`(普通代码块照旧,无预览/无折叠按钮)。
- `previewOnlyByDefault: true`:mermaid 块默认只显图、隐藏源码;工具栏里"复制"旁出现
  隐藏/编辑切换。**注意**:`previewOnlyByDefault` 对所有代码块生效,但因为非 mermaid 块
  没有 preview(`renderPreview` 返回 `null`),它们不会被隐藏(`.codemirror-host.hidden`
  的 CSS 要求 `preview` 非空才生效)。
- `previewToggleText` 必须放在 **feature config**(`featureConfigs[CrepeFeature.CodeMirror]`)
  里,不能放在 `codeBlockConfig`——因为它是被 feature 读去**构建** `previewToggleButton`
  的,放错位置就一直卡在英文 Edit/Hide。

两个坑:① `mermaid` 用 `import()` 懒加载(~3MB,无图表的文档不该为它买单);② 懒加载后
**首次** `mermaid.render()` 可能因初始化时序失败,`ensureRender` 会**重试一次**再放弃
(否则一次抖动会把块永久卡在"渲染中",要改源码才重渲)。主题切换不会自动重渲(预览只在
文本/语言变化时重算)——已知小局限。


## bug 20：公式根本不渲染 + 长公式右侧重叠（issue #5）

`$…$` 一直是死文本——因为 `CrepeFeature.Latex` **默认是关的**,我们从没显式开启(features 里那几个 `SelectionTooltip/SlashCommand/InlineCode` 其实不是真 key,是 no-op,相关功能靠 Crepe 默认开着)。开启 `Latex` 后行内/块级公式经 KaTeX 渲染(latex/katex 样式随主题 CSS 已打包)。块级要 `$$` **单独成行**才识别为 display(否则当行内,`\tag` 这种 display-only 命令会报错)。长 display 公式会溢出列宽 → `.katex-display { overflow-x:auto }` 在列内滚动;KaTeX 解析错误文本也允许换行,不再冲出右边。

## bug 21：表格太占地方 + 文字/行内代码超列宽重叠（issue #6）

单行单元格行高一度 **84px**:单元格内边距 + **单元格里 `<p>` 的上下 margin(~25px)** + 行高 1.85 三者叠加。修法:`td/th>p { margin:0 }`、内边距 10×14 → 6×12、行高 → 1.5、表格上下 margin 1.5em → 1.1em,行高降到 ~45px。重叠则是行内代码/长串不换行撑破固定列宽 → 给单元格加 `overflow-wrap/word-break: break-word`(行内 `code` 继承生效)。

## 坑：表格单元格内换行只能走 `<br>`,不能用 hardbreak 序列化（issue #7）

GFM 表格单元格必须单行。直接在单元格插入换行/hardbreak,`mdast-util-to-markdown` 在 `tableCell` 构造里会把换行**强制转成一个空格**(`handle/break.js`),换行保存即丢;直接写 `<br>` 又被我们丢掉、不渲染。最终方案(`editor-tablebreak.js`,均不改 Milkdown 节点定义):① keymap 在单元格插入 hardbreak(渲染为 `<br>`);② 自定义 remark stringify `break` 处理器**仅当 `state.stack.includes('tableCell')`** 时输出 `<br>`,否则回落默认(段落换行不变);③ remark 解析插件把内联 `<br>` 的 html 节点转回 `break`。用真实 mdast 库做了 round-trip 隔离测试 + 应用内端到端验证(`第一行<br>第二行<br>第三行` 单行不损坏)。

## 决策：自定义主题(可直接迁移 Typora 主题)

让用户的 `.css`(含整包下载的 Typora 主题)生效要解决三件事:① **发现**——`themes:list` 递归扫描子目录(Typora 主题常是 `name/coding/name.css`),只扫顶层会找不到;② **资源**——`themes:read` 把相对 `url(...)` 改写成绝对 `file://`,否则注入 `<style>` 后字体/图相对路径指向 app 而非主题目录;③ **命中 + 不被压制**——编辑器内容元素带 Typora 的 `#write`/`markdown-body` 钩子让选择器命中;但我们 `.milkdown`/`.ProseMirror` 自带的文字色比主题的 `html,body{color}` 更具体,会把主题色挡成"暗对暗",故激活时(`body.hm-has-custom-theme`)正文区背景/宽度 + 文字 `color:inherit` 让位给主题。另:`applyTheme` 原来整体覆盖 `body.className`,会擦掉页宽 `hm-full-width` 等 `hm-*` 类 → 改成保留。应用外壳(侧栏/标签/状态栏)始终保持自身风格。

## 功能：更新提示展示"更新内容"

`update:check` 把 release 的 `body`(Markdown,截断 4000 字)作为 `notes` 返回;`UpdateToast` 用**纯 React 元素**把标题/要点/粗体/行内代码渲染出来(**不 `dangerouslySetInnerHTML`,无 XSS**),长内容在卡片内细滚动条滚动。全自动——发布时在 GitHub Release 写的说明,用户升级时就能看到。

## bug 22：审阅「替换」标记在富文本里被删除线吞掉（Mac 尤甚）

CriticMarkup 的替换标记 `{~~旧~>新~~}` 在富文本里**渲染不出来、还会把整行删掉**;而新增 `{++++}`、删除 `{----}` 都正常。修了好几轮都不彻底,根因在两层。

**根因一(prosemirror-inputrules 的 `exec` 不锚定光标)。** GFM 删除线输入规则是 `markRule(/(?<![\w:/])(~{1,2})(.+?)\1(?!\w|\/)/, strike)`。`prosemirror-inputrules` 的 `run()` 是 `match = rule.match.exec(textBefore)`——**`exec` 在光标前的整段文本里任意位置匹配,并不要求匹配结束在光标处**。所以只要这一行有个字面的 `{~~旧~>新~~}`,**打任何一个字符** `exec` 都会先命中标记里的波浪号,然后 `markRule` 执行 `tr.delete(textEnd, to)`——**把标记到光标之间的内容全删掉、标记变删除线**。这正是"打字就把整行删了"的真相,跟打的是不是 `~` 无关。(其它三个标记不用波浪号,所以从不撞删除线。)用真实的 `prosemirror-inputrules` + `markRule` 跑无头测试复现:关掉守卫时,打 `{~~old~>new~~}` 变成 `{old>new~}` + 删除线。

**根因二(为什么 Windows 没事、Mac 坏)。** macOS 中文输入法是通过 `compositionend` 事件提交文字的,而 `prosemirror-inputrules` 的 `compositionend` 处理器会**用 `text=""` 再跑一次 `run()`——这条路不经过 `handleTextInput`**。Windows 输入法提交走的是 `handleTextInput`。所以挂在 `handleTextInput` 上的守卫在 Mac 上被绕过,删除线规则照常吞标记。

**修复(两层,缺一不可):**

1. **守卫插件 `createStrikeGuardPlugin`**(`Editor.jsx`,**prepend 到 `prosePluginsCtx` 最前**,这样它的 `handleTextInput` 抢在 inputRules 之前)。用一个**纯函数** `strikeInputWouldCorruptCriticMarkup(textBefore, typed)`(`strikeGuard.js`,4 个条件:匹配内容含 `~>` / 紧跟在 `{` 后 / 紧接 `}` 前 / 行里有未闭合的 `{~~` 等 opener)判断这次删除线匹配会不会吃掉 CriticMarkup 标记;**会的话就把这次输入按字面字符插进去(程序化事务,绕过输入规则)**,标记保住为纯文本走文本扫描渲染。普通 `~~删除线~~` 不命中这些条件,照常变删除线。Milkdown 的 `customInputRules` 是排在 `...prosePlugins` 之后的(`@milkdown/core` 源码可证),所以 prepend 必然先跑。
2. **`appendTransaction` 兜底 `createSubstitutionLiveReconstructPlugin`**——专门补 compositionend 这条 `handleTextInput` 拦不到的路。重写成**用 `oldState` 还原**:当一笔事务碰了删除线 mark、且某文本块现在有删除线、但 `oldState` 里这里有完整的 `{~~…~~}` 而现在不完整了 → 用 oldState 的原始内容还原(光标也保留)。**只有替换标记撞删除线**(其它标记不用波浪号),所以只处理 `{~~`。快速通道:没碰删除线 mark 就直接 `return null`,正常打字零开销。

**验证**:纯函数 27 例 + 用真实 `prosemirror-inputrules`/`markRule` 的集成 8 例 + 专门复现 compositionend 的 3 例全过(后者用 inputRules 插件真实的 `compositionend` 处理器复现 Mac 路径,断言兜底把标记还原成 `{~~旧~>新~~}` 且无删除线)。教训:改输入规则相关的 bug,**一定要用真实的 `prosemirror-inputrules` 跑无头测试**(光看代码会误以为"匹配必须在光标处"),并且要覆盖 IME 的 compositionend 路径(跨平台差异的常见来源)。
