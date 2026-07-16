# 大文档打开卡顿：根因分析与优化方案

> 用户反馈：打开一个 **~32 万行 / 0.5 MB** 的 `.md` 文件非常卡。
>
> 根因是 ProseMirror 全量解析 + 全量 DOM，而当时的「大文档」判定恰好漏掉了「行数极多但有正常空行」的文件。优化分三档列出，P0 多数已落地（见各条 ✅）。

> **⚠️ 产品原则（用户明确，必须遵守）**：heavy 文档的纯文本（textarea）
> **只是「快速打开」的跳板**，不是目的地。查看、编辑等一切实际使用都
> **必须在富文本里进行**，用户要能、也理应切到富文本。因此——
> - P0 的 textarea 回退只解决「打开不卡」，**不**解决「富文本里用大文档」。
> - **让富文本能流畅承载大文档是硬需求**（P1/P2），不是「可选优化」，
>   不能以「大多数人文档小」为由搁置。
> - 任何「让用户留在 textarea」的设计都违背本原则；textarea 是过渡，
>   富文本是目标。

---

## 一、先厘清一个数据矛盾

32 万行 **不可能是 0.5 MB**：

- 即便每行只有 1 个字符，32 万行 = 32 万字符内容 + 32 万个换行 ≈ **0.7 MB**（纯 ASCII）。
- 若含中文（UTF-8 下 3 字节/字符），32 万行轻易 **2–5 MB**。

所以「32 万行 / 0.5 MB」二者只能满足其一。两种情况下卡顿根因不同，但**都会卡**，且都能在下面找到对应优化点。本文按「行数极多的超长文档」为主线分析（这是更常见、也更难治的场景）。

---

## 二、卡在哪：完整加载链路与根因

### 链路一图流

```
双击文件树
  └─ main: fs.readFile(path, 'utf8')   ← 整文件一次性读入，无流式、无 size 预检  [main/index.js:319]
       └─ IPC 传整段字符串到渲染层（结构化克隆，大字符串一次性内存拷贝）
            └─ App.jsx openPaths() 把 content 塞进 tab.content  [App.jsx:344,362]
                 └─ isHeavyDoc(content) 判定是否走纯文本回退   [paths.js:48]
                      ├─ 若 heavy → <textarea>，秒开（不卡）
                      └─ 若不 heavy → 挂载 <Editor initialContent={整段字符串}>  [App.jsx:1451]
                           └─ Editor.jsx: isLargeDoc(>8000)? 两层 rAF defer create  [Editor.jsx:159,1111]
                                └─ crepe.create() ← remark 同步解析 → ProseMirror doc → 全量 DOM  [Editor.jsx:510]
                                     ↑↑↑ 主线程在这里冻结数秒～几十秒
```

### 根因（按影响排序）

**根因 1：`isHeavyDoc` 漏判了「行数极多但有空行」的文件**（最致命，决定文件根本进不进卡顿路径）

`src/renderer/src/paths.js:48`：

```js
const HEAVY_MAX_BLOCK_LINES = 150
const HEAVY_MAX_TOTAL = 400000
export function isHeavyDoc(content) {
  if (!content) return false
  if (content.length > HEAVY_MAX_TOTAL) return true      // ① 总字符数（不是字节）
  let run = 0
  for (const line of content.split('\n')) {              // ② 连续非空行
    if (/^[ \t]*$/.test(line)) run = 0
    else if (++run > HEAVY_MAX_BLOCK_LINES) return true
  }
  return false
}
```

它只看 **① 总字符数 > 40 万** 或 **② 最长连续非空行 run > 150**。**完全不看总行数。**

- 若文件有正常的空行分段（每隔几十/几百行一空行）→ 条件② 的 `run` 不断被重置 → 永远到不了 150 → **不判 heavy**。
- 若 0.5 MB 指磁盘字节且含中文 → JS `content.length` ≈ 17 万 < 40 万 → 条件① 也不触发 → **不判 heavy**。

两种情况都直接进 Milkdown，然后卡死。**这就是用户这个文件大概率遇到的：它没被回退到 textarea。**

> 设计意图（注释 paths.js:40-45）是抓「无空行塌缩成一个巨型段落 + 几千个 `<br>` 内联节点 → ProseMirror 近二次方复杂度」的病态文件。这个意图是对的，但**漏掉了「行数极多的正常结构文档」**这一大类。

**根因 2：ProseMirror 全量解析 + 全量 DOM，无任何虚拟化**

`crepe.create()`（`Editor.jsx:510`）内部：remark **同步**把整段 markdown 解析成 ProseMirror doc，然后**所有节点同步渲染成 DOM**。对几万～几十万段落：

- = N 个 ProseMirror Node 对象常驻内存
- = N 个 `<p>` DOM 节点一次性插入
- 浏览器对超大队列 `appendChild` 本身就慢

ProseMirror 的架构是「全量持久化 doc tree」，**不是按需渲染**。这是它对超长文档的固有短板，不是配置能解决的。

**根因 3：`isLargeDoc` 的 defer 没解决同步阻塞**

`Editor.jsx:1111`：

```js
if (isLargeDoc) {
  createRaf = requestAnimationFrame(() => {
    createRaf = requestAnimationFrame(() => runCreate())   // 两层 rAF
  })
}
```

这只让 loading skeleton **先 paint 出来**（用户看到「加载中」而非冻住上一屏），但 `runCreate()` → `crepe.create()` 一旦执行，**仍是同步、单次、整文档解析**，主线程照样冻结整个 parse+render 期间。defer 推迟了 2 个动画帧，没缩短冻结时长。

**根因 4：每次按键也全文档扫描**（卡顿延续到打字时）

- **大纲生成** `App.jsx:844-866`：内容一变就 `querySelectorAll('h1..h6')` 全 DOM 扫描（套了 rAF 合并，但扫描本身仍同步全量）。
- **`refreshLevel`** `Editor.jsx:484-498`：注释明说「大文档上 selection change + scroll 每次按键触发的同步 reflow 是主要 typing lag」，已用 `scheduleLevel` rAF 合并，但每次仍执行 `coordsAtPos`/`getBoundingClientRect` 等强制 reflow。
- **`markdownUpdated` 回调**每次编辑 → `onChange(md)` → `updateContent` 更新 tab 状态 → 又触发大纲 effect 重跑。形成「打一个字 → 全文档扫一遍 → 卡」的循环。

**根因 5：读取非流式**（次要，0.5 MB 影响小）

`fs:readFile`（`src/main/filesystem.js`）整体读，没有 `stat` 预检大小、没有 `createReadStream`。0.5 MB 读+IPC 传输是几十 ms 级，不是卡顿主因，但**大文件场景下应预检并给用户预期**。

---

## 二·补：关联 issue #17「滚轮快速滑动后，停止时文本仍继续滚动」

**这是同一个根因家族**，机制是「主线程被强制 reflow 占据 → 滚动呈现滞后 → 合成器线程积压追赶」。

每次 `scroll` 事件触发两条「强制同步布局」链路：

1. **`Editor.jsx:607`** `.editor-scroll` 上 `onScroll` → `scheduleLevel()` → `refreshLevel()`（`:421`）：
   内含 `view.coordsAtPos(sel.from)` + 多处 `getBoundingClientRect()` —— 全是**强制 reflow**。大文档上每次都要重排整棵 DOM。
2. **`App.jsx:826`** outline scrollspy 的 `onScroll` → `compute()`：
   `scroller.querySelectorAll('.ProseMirror h1..h6')` 全文档扫描 + 对每个标题 `getBoundingClientRect()` 找当前查看的标题 —— 又一次强制 reflow。

两条都套了 rAF 合并（`scheduleLevel` / `scrollRaf`），但 rAF 只是「合并到下一帧」，**实际 reflow 仍同步执行**，一帧渲染不完就掉帧。

**为什么表现为「停止后还在滚」**：滚动是 Chromium 合成器线程处理的；JS 主线程被 reflow 占住时，合成器来不及呈现滚动帧，于是把积压的滚动位置在松手后一帧帧「追」着补出来。issue 描述「**快速滑动越多，停止后滚得越多**」强烈印证是积压追赶（输入越多积压越多）——这跟系统惯性滚动（固定物理曲线、与输入量无关）的特征相反。

**文档越大，reflow 越慢，追赶越明显**。即根因 2（全量 DOM）的下游表现。

→ 因此下文的 **P0-3（节流/跳过滚动驱动的 reflow）能同时治这两个问题**：大文档打开卡 + 滚动追赶。

---


## 三、可优化的地方（分三档）

### 🟢 P0 — 立即见效、改动小、风险低

> **✅ 已实施（commit `35d41e1`）**：P0-1 + P0-3a/b/c 全部完成。P0-2 待做。

**P0-1. `isHeavyDoc` 增加「总行数」阈值** ✅ 已实施

`paths.js` — 新增 `HEAVY_MAX_LINES = 50000`，在现有的 `split('\n')` 循环中顺带计行数（零额外成本）。超过 5 万行直接判 heavy → textarea 回退。

- **效果**：用户的 32 万行文件立即秒开为 textarea，按需点「渲染为富文本」。
- **代价**：5 万行以上的「正常结构」富文本文档会被默认当文本打开，需手动切富文本。
- **局限（重要）**：这只解决「打开不卡」。按文首产品原则，用户仍必须在富文本里查看/编辑大文档——而富文本对大文档的性能是**未解决的硬需求**。P0-1 只是把卡顿从「打开就卡」推迟到「切到富文本才卡」，富文本侧要靠 P1/P2 真正解决。

**P0-2. 读取时预检大小，超大文件给提示** ⬜ 未做

在 `fs:readFile` 前 `fs.stat`，超过某阈值（如 2 MB）时给 main→renderer 一个标志位，UI 提示「文档较大，建议用纯文本模式」。避免「读进来才发现卡」。

- **效果**：用户体验预期更清晰。
- **风险**：低。

**P0-3a. 大纲 scrollspy（reflow-free 重写）** ✅ 已实施（二次优化）

`App.jsx` outline active-heading 效果。
- 初版：从每帧 rAF 改为每 **300ms** 节流。解决了主线程被占满，但留下两个问题——
  ① 节流仍是 leading-edge（`if (scrollTimer) return`），**没有 trailing 更新**：松手后最后一次 compute 是 300ms 前的位置，大纲停在**错误的标题**上；
  ② 每次 compute 仍 `getBoundingClientRect()` 遍历全部标题，大文档上每次都是**全文档强制 reflow**。
- **二次优化**：把每个标题的「内容偏移量」`Y = rect.top − scroller.top + scrollTop` **只测一次**（单次布局 pass，每 2s / resize 重建），滚动时只比 `scrollTop`（**零布局读取**）。于是可以**每帧更新**、永远落在当前标题——既不卡，高亮/大纲面板自动滚动也都精准。`Outline.jsx` 的 `scrollIntoView` 依赖 `activeIndex` 变化，所以这一处同时修了「高亮停错」和「大纲不跟滚」。
- **根因关联**：原 leading-only 节流 + 每帧全文档 reflow = issue #17 滚动追赶 + 大纲停错，是同一根因。

**P0-3b. 移除浮动块类型徽标** ✅ 0.6.5 已实施

早期版本为跟随光标的 level badge 做过节流优化。0.6.5 按产品取舍移除了该纯提示控件，同时删除 selection、mousemove、scroll 路径中的 `coordsAtPos` / `getBoundingClientRect`、定时器和 React 状态；标题快捷键、右键菜单、selection toolbar、状态栏切换和大纲功能不受影响。

**P0-3c. 大纲标题列表 debounce** ✅ 已实施

`App.jsx` outline heading-list 效果：
- 从每次按键（`rAF` after content change）改为编辑空闲 **500ms** 后扫描一次。
- 大文档上 `querySelectorAll` 整棵 DOM 是主要按键延迟来源。

---

### 🟡 P1 — 显著改善、需中等改造

**P1-1. 解析与渲染拆分到异步分片（ProseMirror 内）**

`crepe.create()` 之所以阻塞，是「解析 + 渲染」全在一个同步调用里。可改造为：

1. 用 `requestIdleCallback` / `setTimeout(..., 0)` 把 remark 解析**分片**（按 N 行一批，每批之间让出主线程），先构建完整 ProseMirror doc（解析完不一定卡，主要是 DOM 渲染卡）。
2. DOM 渲染分片：把 doc 切成块，先渲染视口附近的前 K 个块，其余用 `IntersectionObserver` / 虚拟滚动按需挂载。

- **效果**：解析和首屏渲染都不再长阻塞，主线程保持响应。
- **代价**：**高**。ProseMirror 的 DOM 是它自己管的（通过 EditorView 的 decorations / dispatch），自己造虚拟化要绕过它的 DOM 同步机制，复杂且易引入编辑 bug。这是社区公认的难点（ProseMirror 作者也建议超长文档走 CodeMirror 或分片）。
- **风险**：高。属较大重构。

**P1-2. 富文本大文档用 CodeMirror「只读快视图」替代**

对 heavy 文档用户主动切富文本时，不进 Milkdown，而进一个 **CodeMirror 6 的 Markdown 只读高亮视图**（CM6 天然支持虚拟滚动，百万行流畅）。需要编辑时再「双击进入编辑区」切回 Milkdown 该段落——但这又是大改。

- **效果**：只读浏览大文档丝滑。
- **代价/风险**：高，引入双编辑器状态。

**P1-3. `markdownUpdated` → outline 链路解耦**

让大纲不依赖每次 `content` 变化，而是：
- 编辑时只对「变化的段落范围」增量更新大纲（ProseMirror 的 transaction 能拿到 changed ranges）；
- 或大纲改为 **debounce 1s + 后台 worker** 解析（Web Worker 跑 remark 提取标题）。

- **效果**：打字时不再触发主线程全文档扫描。
- **代价**：中。需把 markdown 解析搬到 worker，或写增量 diff 逻辑。

---

### 🔴 P2 — 架构级、长期方案

**P2-1. 大文档走「分块 + 虚拟化富文本」专用编辑器**

放弃用单一 Milkdown 实例承载超长文档。文档按标题/固定行数分块，每块一个独立 Milkdown 子编辑器，视口外的块卸载或冻结。这是 Typora 等也用的高级方案，但工程量极大，且会破坏 ProseMirror 跨块选择/拖拽/查找替换的连贯性。

- **效果**：从根本上让富文本支持任意大文档。
- **代价/风险**：**高**（工程量大、需维护跨块选择/查找的连贯性）。**但这是目标方向**——按文首产品原则，富文本必须能流畅承载大文档，这条（或 P1 的 `content-visibility` / 分片虚拟化）绕不开，不能因工程量大而搁置。

**P2-2. 流式读取 + 后台解析**

`createReadStream` 分块读 + Web Worker 后台解析成 ProseMirror doc，主线程只接收解析结果。适合 **超大文件（>10 MB）**，0.5 MB 场景收益有限（瓶颈在渲染而非读取）。

---

## 四、推荐执行顺序

| 步骤 | 做什么 | 预期效果 | 工作量 | 状态 |
|---|---|---|---|---|
| **1（P0-1）** | `isHeavyDoc` 加 `HEAVY_MAX_LINES` 阈值 | 用户文件立即从「打开就卡几十秒」→「秒开为文本，可按需切富文本」 | 半小时 | ✅ 已完成 |
| **2（P0-2）** | 读取前 `stat` 预检 + UI 提示 | 超大文件给预期，不再无响应困惑 | 1 小时 | ⬜ 待做 |
| **3（P0-3a）** | 大纲 scrollspy 节流 300ms + 缓存 heading 元素 | 滚动不再追赶（#17）；打字时少一次全 DOM 扫描 | 1 小时 | ✅ 已完成 |
| **3（P0-3b）** | `refreshLevel` 节流 200ms | 快速滚动时主线程不被强制 reflow 卡住 | 20 分钟 | ✅ 已完成 |
| **3（P0-3c）** | 大纲标题列表 debounce 500ms | 大文档打字时不再每键全 DOM 扫描 | 20 分钟 | ✅ 已完成 |
| 4（P1） | 富文本 `content-visibility: auto`（CSS 层虚拟化） | 富文本里大文档滚动不卡（#17 Windows 软件合成器） | 已完成 | ✅ 已完成 |
| 4b（P1） | `contain-intrinsic-size` 估算 + `.hm-cv` 下 `overflow-anchor: auto` | 修 content-visibility 引起的「跳页」（#25） | 已完成 | ✅ 已完成 |
| 5（P2） | 富文本分块虚拟化 / 每节点精确 `contain-intrinsic-size` | 极大文档仍卡时的下一步 | 数天～数周 | ⬜ 待评估 |

**第一/三/四步已完成**（大文件秒开 + 滚动追赶修复 + 富文本 `content-visibility`）。**P2（让富文本流畅承载极大文档）不是可选项**——按文首产品原则,用户打开大文档后必须在富文本里查看/编辑,textarea 只是过渡。

**#25「跳页」修复(重要,易踩):** `content-visibility:auto` 用 `contain-intrinsic-size` 估算屏外块高度,滚入视口时从估算变为真实高度 → 块"长高"。若此时 `.editor-scroll { overflow-anchor: none }`,浏览器不补偿 → 视口内容上蹿(停在代码块上尤其明显,因为 CodeMirror 还会延迟测量行换行,代码块真实高度 20em+ vs 估算 5em)。修法两条都已落地:① 估算 `3.5em → 5em`(实测段落均值,降低单块误差);② `.editor-scroll.hm-cv { overflow-anchor: auto }`(让 Chromium 自动补偿高度变化,把 delta 吸收掉)——**只对 CV 文档开,小文档保持 `none` 不变**。**教训:用了 content-visibility,几乎总要配 `overflow-anchor: auto`,否则估算↔真实的差就是可见的跳。**

---

## 五、关键代码位置索引（供实施时定位）

| 文件 | 内容 | 状态 |
|---|---|---|
| `src/renderer/src/paths.js` `isHeavyDoc()` | P0-1：`HEAVY_MAX_LINES = 50000` 行数阈值 | ✅ 已改 |
| `src/main/filesystem.js` `fs:readFile` handler | P0-2：加 stat 预检 | ⬜ 待做 |
| `src/renderer/src/App.jsx` outline scrollspy | P0-3a：reflow-free 重写（偏移量测一次 / 滚动只比 scrollTop / 每帧更新） | ✅ 已改（二次） |
| `src/renderer/src/App.jsx` outline heading-list | P0-3c：setTimeout 500ms debounce | ✅ 已改 |
| `src/renderer/src/components/Editor.jsx` 滚动 handler | P0-3b：滚动停止 150ms 后算一次（trailing）；`scheduleLevel` typing/selection 仍 200ms leading | ✅ 已改（二次） |
| `src/renderer/src/components/Editor.jsx` `crepe.create()` | P1-1：同步解析渲染——分片/虚拟化的改造目标 | 未改 |
| `src/renderer/src/components/Editor.jsx` `isLargeDoc` | `length > 8000` 两层 rAF defer（只 defer，未减阻塞）| 未改 |
| `src/renderer/src/App.jsx` heavy → textarea 路由 | 配合 `isHeavyDoc` 走纯文本 | 已有 |
