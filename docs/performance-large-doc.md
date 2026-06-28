# 大文档打开卡顿：根因分析与优化方案

> 用户反馈：打开一个 **~32 万行 / 0.5 MB** 的 `.md` 文件非常卡。
>
> 本文档只做调查与方案设计，**未改动任何代码**。结论是 ProseMirror 全量解析 + 全量 DOM 是根本瓶颈，而当前的「大文档」判定恰好漏掉了这种「行数极多但有正常空行」的文件。优化分三档列出。

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

`fs:readFile`（`main/index.js:319`）整体读，没有 `stat` 预检大小、没有 `createReadStream`。0.5 MB 读+IPC 传输是几十 ms 级，不是卡顿主因，但**大文件场景下应预检并给用户预期**。

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

**P0-1. `isHeavyDoc` 增加「总行数」阈值**

让「行数极多」的文件直接走 textarea 回退，绕开 ProseMirror 全量解析。

```js
const HEAVY_MAX_BLOCK_LINES = 150
const HEAVY_MAX_TOTAL = 400000
const HEAVY_MAX_LINES = 50000          // 新增：超过 5 万行直接判 heavy
export function isHeavyDoc(content) {
  if (!content) return false
  if (content.length > HEAVY_MAX_TOTAL) return true
  let run = 0, lines = 0
  for (const line of content.split('\n')) {     // split 已生成数组，lines 计数零额外成本
    if (++lines > HEAVY_MAX_LINES) return true   // 行数超限 → heavy
    if (/^[ \t]*$/.test(line)) run = 0
    else if (++run > HEAVY_MAX_BLOCK_LINES) return true
  }
  return false
}
```

- **效果**：用户的 32 万行文件（无论 0.5 MB 数据是否矛盾）立即秒开为 textarea，按需点「渲染为富文本」。
- **代价**：5 万行以上的「正常结构」富文本文档会被默认当文本打开，需手动切富文本。阈值可调（5 万 / 2 万 / 1 万，看实际富文本性能曲线）。
- **风险**：极低。只新增一个判断分支，不动编辑器核心。
- **局限**：治标——用户仍想看富文本时会卡，只是把卡顿从「打开就卡」变成「主动点富文本才卡」。

**P0-2. 读取时预检大小，超大文件给提示**

在 `fs:readFile` 前 `fs.stat`，超过某阈值（如 2 MB）时给 main→renderer 一个标志位，UI 提示「文档较大，建议用纯文本模式」，甚至直接 `isHeavyDoc` 之前就拦截。避免「读进来才发现卡」。

- **效果**：用户体验预期更清晰，避免无响应的困惑。
- **风险**：低。

**P0-3. 大文档禁用大纲自动刷新 / 节流更狠**

对 heavy 标记的文档，大纲默认不实时刷新（改为手动「刷新大纲」按钮），或把 `App.jsx:844-866` 的 rAF 节流加长到 1–2 s，且在 heavy 文档上直接跳过。

- **效果**：打字时少一次全 DOM 扫描。
- **风险**：中。需保证富文本模式下大纲仍可用。

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
- **代价/风险**：**极高**。建议除非有大文档富文本编辑的硬需求，否则不做——P0 的「回退 textarea + 按需渲染」已能覆盖 95% 场景。

**P2-2. 流式读取 + 后台解析**

`createReadStream` 分块读 + Web Worker 后台解析成 ProseMirror doc，主线程只接收解析结果。适合 **超大文件（>10 MB）**，0.5 MB 场景收益有限（瓶颈在渲染而非读取）。

---

## 四、推荐执行顺序

| 步骤 | 做什么 | 预期效果 | 工作量 |
|---|---|---|---|
| **1（P0-1）** | `isHeavyDoc` 加 `HEAVY_MAX_LINES` 阈值 | 用户文件立即从「打开就卡几十秒」→「秒开为文本，可按需切富文本」 | 半小时 |
| **2（P0-2）** | 读取前 `stat` 预检 + UI 提示 | 超大文件给预期，不再无响应困惑 | 1 小时 |
| **3（P0-3）** | heavy 文档跳过/节流大纲自动刷新 | 切富文本后打字更跟手 | 1 小时 |
| 4（可选） | 根据实测决定要不要上 P1 的分片/虚拟化 | 富文本也能丝滑 | 数天～数周 |

**第一步就能解决用户当前问题**（让文件秒开）。后续是否投入 P1/P2，取决于「有多少用户需要在富文本模式下编辑超大文档」这个产品判断——大多数 Markdown 用户的日常文档是几千行以内，P0 足够。

---

## 五、关键代码位置索引（供实施时定位）

| 文件:行 | 内容 |
|---|---|
| `src/renderer/src/paths.js:40-60` | `isHeavyDoc` —— P0-1 改这里 |
| `src/main/index.js:319-323` | `fs:readFile` —— P0-2 加 stat 预检 |
| `src/renderer/src/App.jsx:344,362` | 读取 content + 判 heavy |
| `src/renderer/src/App.jsx:1417-1434` | heavy → textarea 路由 |
| `src/renderer/src/App.jsx:1468-1477` | heavy 横幅 + 「渲染为富文本」按钮 |
| `src/renderer/src/App.jsx:844-866` | 大纲全 DOM 扫描 —— P0-3 节流 |
| `src/renderer/src/components/Editor.jsx:159` | `isLargeDoc = length > 8000` |
| `src/renderer/src/components/Editor.jsx:510` | `crepe.create()` 同步解析渲染 |
| `src/renderer/src/components/Editor.jsx:1107-1119` | 两层 rAF defer（只 defer，未减阻塞）|
| `src/renderer/src/components/Editor.jsx:484-498` | `refreshLevel` typing reflow（已 rAF 合并）|
