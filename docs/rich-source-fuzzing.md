# 富文本 / 源码一致性：模糊测试与修复手册

> 建立：2026-10-02 · 最近更新：2026-10-06（0.13.236）
> 用户要求：**不能让用户保存一堆错乱的源码**；「检测到富文本与源码不一致」暂停（#136）要持续减少。
> 本文是该专项的工作手册：怎么跑、怎么分诊、已修家族及根因、未修清单、坑。总体架构与长期账本仍见 [`source-rich-consistency-completion-plan.md`](./source-rich-consistency-completion-plan.md)。

## 1. 两个判据

| 判据 | 含义 | 严重度 |
|---|---|---|
| **CORRUPT** | 保存后用全新 profile 冷启动重开，PM 文档 ≠ 保存前编辑器文档 | P0：写错源码 |
| **PAUSE** | 出现「检测到富文本与源码不一致」「保存已暂停」「原文件未被覆盖…恢复副本」 | fail-closed 生效（没写错），但阻断用户 |

截至 0.13.236：累计数十个 seed、数千步随机编辑，**未出现真正 CORRUPT**。所有暂停都是某个映射路径证明不了 → 拒绝写入。修复方向永远是**让精确 owner 能证明**，不是放宽校验（唯一例外：确实无 Markdown 编码的差异，如单元格边缘空白、段落末尾空白、标题 id）。

CORRUPT 判据已把以下“无编码差异”视为软差异（`scripts/fuzz-rich-source-ui.mjs` 的 `normalizeDoc`）：顶层/引用内空段落、textblock 首尾空白与软换行后的行首空白、`id`/`spread`/列表 `label`/`colwidth`、相邻同类列表（CommonMark 会合并）。

## 2. 运行

```bash
npm run build                       # fuzz/probe 都启动 out/ 下的构建
FUZZ_SEEDS=31,32,33 FUZZ_OPS=200 FUZZ_CHECKPOINT=40 \
  FUZZ_OUT=/tmp/horsemd-fuzz/batchN npm run fuzz:rich-source-ui
```

- 每个 seed 确定性复现同一操作序列（PRNG 只决定操作，不依赖时序）；改代码后用**同一 seed** 复跑即可验证。
- 产物：`$FUZZ_OUT/seed-N/report.json`（op 日志、checkpoint 结论、首次 PAUSE 的 trace 尾部：integrity/diff/coordinator/journal(40)/preserve/flush/各 owner trace）、`checkpoint-K.md`（保存字节）、CORRUPT 时另存 live/reopened/source-view。
- 操作权重见 `OPS`；夹具为中英文混合文档（标题、软换行段落、嵌套列表、有序、任务、引用、代码块、表格、分隔线）。`FUZZ_FIXTURE=path` 可换夹具。`FUZZ_PASTE=1` 额外加入粘贴操作（代码块、列表、表格、引用、公式、多行纯文本，40% 用 CRLF；#171 之前粘贴从未被模糊测试覆盖）；默认关闭，因为加入新操作会改变每个种子的操作序列，文档里引用的种子号会失效。
- `FUZZ_FORMAT=1` 额外加入按快捷键的格式操作（2026-11-04）：Shift+方向键扩选、斜体 / 删除线 / 行内代码 / 高亮、标题级别、正文、引用、无序 / 有序列表。同样默认关闭（会改变种子序列）；夜间长跑打开它。
- `FUZZ_UI=1` 额外加入编辑器自己的界面操作（2026-11-04）：斜杠菜单（`/h1` `/table` `/mermaid` …）、拖动块手柄、表格行 / 列手柄的按钮。报告里 `dragBlock` 带 `dropped`，没落下时 `why`（`no-handle` / `drop-not-handled`）；第一批种子 33 次拖动只落下 4 次（等手柄只等了 300 ms），改为最多等 1.4 s 后 27 次落下 23 次。
- 跑 UI 回归或 fuzz 时**不要重建 out/**（会让中途启动的实例失败）。

### 2.0 夜间长跑（2026-11-04）

mini 上的 launchd 任务 `com.horsemd.nightly-rich-source` 每天 03:30 运行 `scripts/nightly-rich-source.mjs`：在独立 worktree 里构建**最新提交**（不碰工作区、`out/` 和 /Applications 里的 HorseMD），跑全量格式组合测试、规范语料测试和随机 fuzz（`FUZZ_FORMAT=1 FUZZ_PASTE=1`），种子由日期决定，每晚不同。结果摘要在 `~/Library/Logs/HorseMD-nightly/<日期>.md`，失败的输出和 fuzz 报告在同名文件夹里。安装 / 移除：`scripts/nightly-install.sh` / `scripts/nightly-install.sh --remove`。

### 2.1 不靠随机的系统测试（2026-11-04）

随机 fuzz 只能碰到它的操作表里有的东西（#173「高亮覆盖粗体」就从没被碰到）。另有两个确定性的全覆盖测试，都直接用真实 Crepe 的解析 / 序列化 / 校验 / 源码重排（`__hmSourceReprintHarness`），一分钟左右：

- `npm run test:mark-combinations-ui`：12 种行内格式两两叠加 × 各种重叠形状 × 段落 / 标题 / 列表 / 任务 / 引用 / 表格 × 中文 / 英文 / 中文标点 / 其他空白 / emoji，加图片 / 公式 / 换行、部分取消、随机三重、保存后再改；上下标单独开设置跑。检查：保存后读回一致、源码重排成功且一致、再存一次字节不变。`FULL=1` 跑全部 10 种位置（约 33 万例），`PHASE=pairs|atoms|subsup`、`SEED=`、`CAP=`（记录多少失败）。
- `npm run test:spec-corpus-ui`：CommonMark 0.31.2 全部 652 个规范例子 + GFM 扩展 24 个（`scripts/fixtures/`，CC BY-SA 4.0）：不改时逐字重排；每个文本块头 / 中 / 尾插入或删除一个字后重排成功、一致、改动不出所在顶层块。整篇序列化读不回的只报告不判失败（剩 5 个：自动链接里的反斜杠、跨行行内代码 / HTML 属性里的 `\` 换行、表格行比表头多格）。


### 2.2 回归套件之外的 UI 测试（2026-11-06）

`scripts/` 里有 320 个 `test-*-ui.mjs`，`run-ui-regression.mjs` 只列了 97 个，其余没人跑就会悄悄坏掉。`node scripts/sweep-unlisted-ui.mjs`（先 `npm run build`）逐个跑一遍未列入的，结果在 `results.jsonl`。2026-11-06 第一次扫：223 个里 132 个失败。

- **约 76 个只断言内部走哪条路**（某个 owner / mapper / proof 处理了这次编辑，报 `[]`）：写于源码重排成为主路径之前。把 `globalThis.__hmSourceReprintPrimary = false` 注入页面重跑，114 个里 72 个变回通过——在旧路径下行为正确，只是现在不走那条路。这 72 个现在开头写 `process.env.HM_TEST_REPRINT_PRIMARY ??= '0'`（`electron-test-app.mjs` 在页面脚本之前设 `__hmSourceReprintPrimary = false`），专测后备路径。另 42 个关掉重排后仍失败；修掉过时期望 / 测试自身的 bug 后剩 29 个，全是断言旧的内部原因名、专用证明或某条发布记录（`did not use … mapper`、`owner: []`、`proof missing`），两条路径下都不成立，留待逐个决定改写或删除。
- **2026-11-07 复查这 72 个**：在产品路径（重排开着，`HM_TEST_REPRINT_PRIMARY=1`）下重跑，5 个通过，其余都停在第一条内部路径断言（`owner: []`、某个证明 / 发布记录）或旧拼写（空项 `- `）上。行为上只有一个真问题：`test-bullet-exit-keeps-sibling-ui`，松散列表拆成两个单项列表后写成紧凑（RS-86 的漏洞，已修，见 §4）。它和另外 3 个只检查行为的测试（`inline-html-block-handle`、`diverged-delete-source`、`code-fence-delete-source`）进了回归套件却只测旧路径，现在改回产品路径。教训：只检查行为的测试不该关掉重排——旧路径下通过说明不了用户看到什么。旧路径上留一个已有问题（HEAD 同样）：`code-fence-delete` 关掉重排、按键间隔 ≥ 120 ms（或 Windows）时，空段落里打字后旧 owner 一直 `visible-stream-mismatch`，保存暂停；产品路径 3/3 通过。产品路径按键间隔 65 / 150 / 250 / 400 ms 都通过（mini、Windows）；慢到每键单独同步时，「打四个反引号再删三个」剩下的那个写成 `\``（四个反引号那一刻单独成行会开代码块，必须转义，重排保留留下的字节），读回相同，测试两种写法都认。`inline-html-block-handle` 第一次上 Windows 就失败：后台测试窗口每秒只有 2 帧，把手的淡入要约 0.9 秒，测试只等 260 ms；现在等它淡入完成（最多 3 秒，不该出现的两处照旧只等 260 ms），Windows 3/3。
- **2026-11-07：那 67 个旧路径测试有了产品路径模式**。`HM_TEST_REPRINT_PRIMARY=1` 时跳过「哪个内部写入方处理了这次编辑」的断言和读取，行为检查（编辑器内容、源码字节、保存、冷启动重开、不报警）照跑，原来「该暂停」的地方改成检查不报警且源码读回等于编辑器文档；默认（后备路径）不变，67/67 照旧通过。`HM_TEST_ORACLE=1`（`electron-test-app.mjs`）让每个测试在关应用前打一行 `HM_ORACLE`：编辑器文档对源码读回的严格 / 重排比较和有没有警告。产品路径下跑出 4 个真问题（上面 §4 2026-11-07 的四行：代码块语言、相邻列表、表格、分隔线），其余是旧写入方的拼写：空项 `- ` 对 `-`（`scripts/lib/marker-spelling.mjs` 两边都去掉标记后的空格再比）、引用末尾空段落不写 `>` 行、松散列表新项跟着作者的空行。
- **17 个缺环境**：要 `FILE=` / `FAMILY_FILES=`，或读旧 Mac 的 `/Users/yangtingyi/vibe_everything/...`。其中 7 个读 MacBook Air 上的 `vibe_everything/test/无序列表测试.md` / `测试8.18.md`（用户的测试文档，不进仓库），现在都认 `FILE=`；2026-11-07 把两份文档临时拷到 mini 和 Windows 的临时目录跑（跑完删掉），7 个都通过（重排开着）。`forest-middle-list` 原先要求两段之间恰好一个空行，连按两次回车留下的空段落按 §5 规则多写一个空行，改为「至少一个空行」。
- **真问题（都在 HEAD 已存在，已修，测试已进回归套件）**：
  - 新文档里空的嵌套列表项写成 `  - <br />`：`- a\n  -` 是 setext 标题（空项不能打断段落），生成的源码校验失败后退回带 `<br />` 的序列化。`separateEmptyListStarts`（`lists.js`）在这种空项前补一个空行。
  - 列表项里打出 `1) ` 没成列表时，挂着的有序列表意图把另一个列表的 `1.` 改成 `1)`（`restoreTypedBulletMarker` 用了很宽的整篇变化范围）。光标所在块仍以该标记开头时不再恢复（`Editor.jsx` `literalMarkerKept`）。
  - HTML 粘贴：`white-space:pre-wrap` 里套 `white-space:normal` 的换行成了硬换行——ProseMirror 的解析器对 `pre…` 祖先下的空白一律保留，不认后代的重置。`editor-paste-whitespace.js` 先把这些文本按浏览器规则合并成空格。
  - `- 2. x` 里在 x 前按 Backspace：编辑器留下「空段落 + 段落」，没有 Markdown（重开没有那个空行），源码写成 `-` + `  x`。`editor-list-item-lead.js` 去掉这种空段落；`printItem` 把以列表开头的项写在标记行上（`- 1. a`）。
  - 跨粗体删除（`前段。* **输入设备：** 内容` → `前段。* `）：字符补丁要求一种格式，降到分段打印，`*` 被转成 `\*`。新增 `run-deletion` 级：纯删除盖住整段格式时直接删原始字节（含 `**`），段尾的作者空格保留。
  - 先后清空两段：第二段的行丢了（两个保留块之间只用了原空隙）。保留块之间也按编辑器里的空段落数写空行。
  - 源码模式行首点击光标先画在第一个字后面一帧（`editor-source-caret.js` 改正选区后立即重画）；编辑器右键菜单不响应 Esc（全屏模式在菜单打开时把 Esc 让给它，结果什么都不发生）。
- **列表 UI 测试（2026-11-06 修 P1 后对比扫描）**：名字含 list/bullet/ordered/scratch/intent/task/marker 的 103 个里 84 个通过、7 个读旧 Mac 的夹具跑不了、11 个在修之前的构建上同样失败。逐个看过：2 个是真问题（RS-63、RS-86，见 §4），其余 9 个期待旧路径的拼写——空项写 `- ` / `2. `（现在是标记本身 `-` / `2.`）、合并后的列表多一个空行（变松散）、行尾空格必须单独同步、列表项首段的 `1. ` 写成临时嵌套列表——已改成接受源码重排的写法（注释写明）。这 14 个已加入回归套件。
- **过时断言**（按现设计更新）：空段落各占一行（Typora）、新文档保留 `-`、`<font>` 是 `.hm-html-span`、body 上的 `hm-*` 类、表格内公式由节点视图渲染、阅读模式让只读视图也有复制 / 折叠右键菜单、`- - x` 本就是嵌套列表、列表项里的字面标记要转义（不转义重开就成了嵌套列表）。


## 3. 分诊流程

1. 读 `report.json` 的 `firstPause`：最近 8 步操作 + trace。重点字段：
   - `owners.*`：哪个 focused owner 识别了（`recognized:true` + `legacyBlocked:true` 表示它拒绝且禁止回退 → 必暂停）。
   - `integrity[-1]`：`preservationReason`（如 `localized-change`、`table-text-change` 是 legacy）与 candidate/canonical。
   - `diff[-1]`：语义首个差异路径（left=解析候选，right=编辑器）。
   - `journal`：每次 capture 的 step 列表；跨多个顶层块的 journal 是常见根因。
   - `flush`：`preserved:false` 的 forced flush = **静默滞留**，只在保存时暴露为恢复副本提示。
2. 用 `scripts/lib/probe-session.mjs` 写最小复现（见文件头示例）。`p.paused()`、`p.source()`、`p.trace(expr)`。**先最小化再修**。
3. 修在根因层：精确 owner / 校验器无编码规则 / journal 生命周期；加纯函数测试 + 在 `test-rich-source-pause-families-ui.mjs` 增加一例（逐字输入、无警告、源码逐字、保存字节、冷重开一致）。
4. 跑相关单测 + 该 seed 复跑 + 全量回归（见 §6）。

## 4. 已修家族（根因 → 修法 → 位置）

| 家族 | 根因 | 修法 | 位置 |
|---|---|---|---|
| 表格手柄改列对齐（fuzz UI seed 107） | 只有对齐变了：单元格 attrs 不同 → 逐格补丁失败 → 整表重印，而整表重印照抄原分隔行（`---:`），对齐丢失，校验不过 | 重排只重写分隔行里对齐变了的那一段（其余字节不动），整表重印时分隔行同样按新对齐改写 | `source-reprint/reprint.js` `realignDelimiterRow` / `withAlignments`；`test:source-reprint-ui` |
| 标记后直接换行的列表项下插入嵌套项（fuzz UI seed 105） | `LIST_MARKER` 的 `$` 无 m 标志，`4.` + 换行认不出标记 → 内容列按 2 算，新嵌套项缩进 2 格读成别的结构；只有一项的有序列表被当成「全是 1」 | 标记后可接换行（`(?=\r?\n)`）；「全是同一个数」至少要两项 | `source-reprint/reprint.js`；`test:source-reprint-ui` |
| 单元格 / 段尾的行内代码边缘空格丢失（fuzz UI seed 118，保存后内容变了） | 重排和校验器都把单元格边缘、段尾、换行前后的空白当成「Markdown 写不出」去掉，行内代码里的空格却是内容（`` ` test` ``）；校验器因此没拦住 | 两边都不对带行内代码 mark 的文字做这些空白规则 | `source-transaction-sync.js` `isCodeText`、`source-reprint/reprint.js` `isBlank`；`test:source-reprint-ui` |
| 表格手柄删第一行（fuzz UI seed 128） | 表格的行间分隔一律写成换行，表头行和下一行之间的分隔行（`| --- |`）随被删行一起丢了，表格不再是表格；整表序列化又因 Milkdown `serializeText` 丢段落最后一个换行，把单元格 `test<br><br>` 写成 `test<br>` | 表头行之后的分隔总带上原分隔行（没有就按对齐生成），删光正文行时也补上；单元格段落以换行结尾时单元格自己写内容 | `source-reprint/reprint.js` `headerDelimiter`；`editor-crepe-setup.js` `keepTrailingCellBreak`；`test:source-reprint-ui` |
| 段首「空格 + 软换行」（fuzz UI seed 127） | 校验器先剥段首换行再删换行前空格，空格删掉后段首的换行留下，与重开结果不同 | 先删空白，最后剥段首 / 段尾换行 | `source-transaction-sync.js` `semanticJson` |
| 只含空格的行内代码（规范例 332） | 重排把只有空格 / 制表符的段落当成无编码的空段，不看是否在行内代码里（`` ` ` `` 是一个空格的代码） | `isBlankParagraph` 排除行内代码 | `source-reprint/reprint.js`；`test:source-reprint-ui` |
| 两个硬换行相连（fuzz UI seed 151，拖动后的段落） | 作者风格把 `\` 换行改写成两个空格；只有 `\` 的那一行改写后成了空行，段落被切开（整篇序列化同样） | 换行前没有内容（只有缩进 / `>`）的行保留 `\` | `lib/serializer-style.js`；`test:serializer-style` |
| 以代码块开头的任务项被编辑（fuzz seed 154，粘贴代码块到空任务行） | 源码 `- [x] ​` 解析成只含 U+200B 的段落，编辑器里是空段落：被当成「编辑器独有的空段」跳过 → 看起来删了，哨兵跟着删，代码栅栏贴到复选框行；外层列表又把首项为空的任务当成「不能打断段落」整段重印成松散列表 | 两边都是空 / 哨兵段时视为同一段（保留原字节）；任务项总能打断段落（行上总有 `[ ]` + 正文） | `source-reprint/reprint.js` `isSentinelParagraph`、`listCanInterrupt`；`test:source-reprint-ui`（`stripSentinels`） |
| 任务项正文清空、嵌套列表成了第一块（fuzz seed 165） | 只重写了项里的子块区域，嵌套列表被放到复选框行上（`- [x] - [x] ​`） | 标记行上从文字变成块（或反过来）时整项重印，`printItem` 写哨兵 | `source-reprint/reprint.js` `patchContainer`；`test:source-reprint-ui` |
| 列表项里未闭合的 `$$` 块被编辑（fuzz seed 181） | 未闭合的围栏 / `$$` 块的位置结束在下一行开头（含行尾换行），整块替换吃掉换行，下一项接在闭合栅栏后（`$$$- 第三项`） | 重排里代码 / 公式块的结束位置不含那个换行 | `source-reprint/reprint.js` `endOf`；`test:source-reprint-ui` |
| 重开后任务首段留 U+200B（fuzz seed 154 第二轮） | 去哨兵只处理「只有一段」的任务项；后面跟代码块时首段的 `​` 留成文字 | 任务项首段正好是哨兵时都去掉 | `lib/markdown-leading-space.js` |
| 段首「软换行 + 空格」（fuzz UI seed 185） | 校验器「硬换行后的行首空白不算」对段首的换行也生效，而段首换行本身会被去掉，后面的文字成了段首，它的空格是能写出来的（`&#x20;note`）→ 整篇序列化也过不了校验；同一规则也剥掉了行内代码的空格 | 段落 / 标题开头的换行之后、以及行内代码，不用这条规则；空白规则顺序：换行前空白 → 边缘换行 → 软换行后空白 | `source-transaction-sync.js`；`test:source-transaction-sync`（新的行边缘空白用例） |
| 行内代码里换行后的空格（规范例 334） | 重排的「同节点」比较对换行后的行首空白一律去掉，行内代码的空格也去了 → 认为没变，什么都没写 | 行内代码、段首换行之后的文字不去行首空白（与校验器一致） | `source-reprint/reprint.js` `inlineRunsModuloAutolinks` |
| 段落插到 setext 标题前（fuzz seed 226，拖动后） | 「段落后接标题可以只隔一个换行」只对 `#` 标题成立；原文是 setext（`文字` + `-` 下划线）时段落那一行并进标题 | 段落后接原文的 setext 标题时总用空行分隔 | `source-reprint/reprint.js` `pairSeparator` / `isSetextMd`；`test:source-reprint-ui` |
| 紧跟另一个有序列表的任务列表丢复选框（fuzz UI seed 236） | Milkdown 把相邻的第二个有序列表写成 `1)` 以免合并；上游 mdast-util-gfm-task-list-item 2.0.0 只在 `-*+` / `1.` 后插 `[x]`，`1)` 后不插 → 整篇序列化丢复选框，结构指纹校验连自己的解析都不认 | 包一层上游 handler，`1)` 后同样插复选框（上游修了测试会提醒删掉） | `lib/remark-text-handler.js` `taskListItemStringifyHandler`；`test:remark-text-handler` |
| 选中整行 / 整列后粘贴公式 / 代码块，表格被拆开（fuzz UI seed 272，编辑器本身的问题） | 用行 / 列手柄选中后是 CellSelection，`pasteIntoTableCell` 对它直接交给默认替换；单元格放不下块，表格被从中间拆成两个，可能留下没有单元格的表头行（Markdown 写不出）| CellSelection 下的非表格内容先按单元格内粘贴的方式压成行内 + 换行，再走默认替换（第一格得到内容，其余选中格清空，和粘贴纯文本一样） | `editor-table-paste.js`；`test:table-paste-ui`（两个新用例） |
| 空单元格写成 `<br />`（fuzz UI seed 274） | Milkdown 的段落规则把非末尾的空段写成 `<br />`（保留空行），在单元格里也一样 → 重开成含换行的格；校验器把只有换行的段当空，没拦住 | 单元格段落为空时直接写空格 | `editor-crepe-setup.js` `keepTrailingCellBreak` |
| （测试误报）任务项里只剩空白段（fuzz UI seed 269） | oracle 只在项里还有别的内容时才去掉空段 | 全是空段时收成一个空段（与校验器一致） | `scripts/fuzz-rich-source-ui.mjs` |
| 拖动 / Tab 后有序项领头的无序列表（fuzz UI seed 286） | Milkdown 的 syncListOrderPlugin 遇到非通用事务（拖放、粘贴带 `uiEvent`）或 addToHistory:false 就跳过；我们的同步插件又把「首项是有序」留给 Milkdown → 显示 `1.`、保存成 `-` | Milkdown 不跑的批次里由我们按它的规则把列表转成有序 | `lib/list-type-sync.js`；`test:list-type-sync`（新） |
| 空任务行下面的段落（fuzz UI seed 311） | `printItem` 认为「首段为空的项」后面不能有空行（对普通空项成立），任务项的标记行却总有 `[ ] ​`，下一段紧贴着就成了它的懒续行 | 任务项首段为空时按段落之后的规则分隔 | `source-reprint/reprint.js` `printItem`；`test:source-reprint-ui` |
| 段落以两个软换行开头（fuzz UI seed 368：删掉两处换行前的文字） | 序列化器把开头的第二个软换行写成 `&#10;`，读回来是以换行开头的文字；校验只丢掉第一个开头换行后面文字的行首空格规则 | 段首 / 段尾的一串软换行只写一个（与单个边缘换行相同）；校验把整串开头换行都当边缘换行 | `inline-serializer.js` `writeAll`；`source-transaction-sync.js` `leadingBreak`；`test:source-reprint-ui`、`test:source-transaction-sync` |
| 在任务项文字开头粘贴标题（fuzz UI seed 398，`5. [x] k`） | 任务项首段变空（编辑器专有、不参与 diff），标题被印到复选框那一行：`5. [x] ## 标题` 读回是段落文字 | 标记行文字被清空且后面还有块、或任务项首块不是段落时，整项重印（`printItem` 写 `[x] ​`） | `source-reprint/reprint.js` `patchContainer`；`test:source-reprint-ui` |
| 有序列表里的项显示成圆点（fuzz UI seed 403，列表编辑前后的撤销） | Milkdown `syncListOrderPlugin` 想把有序列表的项改成 ordered，却用编号检查的结果覆盖了 `changed`：编号已对的项保留 `listType: 'bullet'`——显示圆点，保存成 `1.` | 有序列表里的项一律 ordered（任何批次） | `list-type-sync.js`；`test:list-type-sync` |
| 行首有空格的段落加斜体（fuzz UI seed 410：缩进代码块转成段落后套斜体） | 硬换行后的行首空格用 U+E000 占位（为 Yuque 的 `<font> 文字`），占位带着斜体，印成 `*    b*`：分隔符后是空格不算斜体，行首 `* ` 还成了列表；`*}*` 前的占位被编码成 `&#xE000;` 漏了还原 | 只有 html span 里的空格留在标记内，粗/斜体先把空格拆出去（行首写 `&#x20;`）；`&#xE000;` 先还原成占位 | `source-reprint/reprint.js` `normalizeForPrint`、`serializeNodes`；`test:source-reprint-ui` |
| 高亮前的普通 `==`（fuzz seed 525：在 `步骤三` 前输入 `段落==编辑器`，再把 `步骤三` 设成高亮） | 文字里的 `==` 不转义，写成 `段落==编辑==步骤三==`，重新打开时文字里的 `==` 和高亮的开头配成一对（高亮落在「编辑」上）；高亮解析只看转义后的值，写 `\=` 也没用，而 Milkdown 的 remarkLineBreak 在软换行处拆出的文字段没有位置 | 写出时能开启高亮的 `==` 写成 `\==`（不在 `{` 后、后面不是空白或 `}`；`a == b`、`===` 不变）；解析时对照源码，转义的 `=` 不算分隔符，无位置的段从段落开头 / 前一个有位置的兄弟顺着源码对齐；紧跟 `{` 或内容以 `}` 开头的高亮写成 `<mark>`（`{==` 不能开启） | `lib/remark-highlight-parse.js`（handler 与 `highlightUnsafe` 也移到这里）、`lib/source-text-align.js`（从 editor-subsup.js 抽出）；`test:highlight-parse`（2 万个随机段落写出再读回）、`test:source-reprint-ui` |
| 转义的 `\==` 读回成高亮（fuzz seed 2829，2026-11-07：一个大代码块转成标题 + 段落，代码里有 `**==g==ambeta**`；之后在列表里粘贴又一次） | 高亮解析顺着源码找 `\=` 转义，两处跟丢了：(1) 段落里的空行写成 `&#10;`，Milkdown 的 remarkLineBreak 也在它解出的换行处拆开，对齐只认真正的换行符；(2) 行首空格的写法「U+200B + 空格」，U+200B 在解析时被删掉而位置没变，对齐从 U+200B 开始就对不上。跟丢后每个 `=` 都算分隔符，`a\n&#10;\==g==`、U+200B + ` a \==g==` 重开都是高亮 `g`，同步暂停（用户打开这样的文件也会看错） | 拆开的换行也认 `&#10;` / `&#xA;`（行中间，之后不跳缩进）；`alignText` 在文本开头跳过被删掉的 U+200B 哨兵（上下标共用这个对齐，不再因此少认） | `lib/remark-highlight-parse.js`、`lib/source-text-align.js`；`test:highlight-parse`（实体换行、哨兵）、`test:source-reprint-ui` 'literal == after a &#10; empty line…'、'…with a leading space…' |
| 代码块转段落 / 标题后，段首段尾只有空白的行在编辑器里还在，重开就没了（2026-11-07，种子 2829 排查时发现；不报警、不丢文字） | Markdown 的段落不能以换行或纯空白行开头 / 结尾（CommonMark 去掉，序列化和校验器也按「没有」处理），编辑器却把代码的这些行原样转成软换行留着：看到的行文件里没有，重开时连下一行的行首缩进（`    }`）也一起去掉 | `editor-textblock-newlines.js`：只对这一步刚从代码块转来的块（setBlockType 的 ReplaceAroundStep，或合并进来的原始换行）去掉段首段尾的纯空白行和换行；用户在段尾按 Shift+Enter 继续打字不受影响；撤销一步恢复整个代码块 | `test:textblock-newlines-ui`（5 种段落 + 转标题 + 撤销 + Shift+Enter；去掉修复会失败） |
| 改代码块语言后 `~~~   ts  ` 被整块重写成 ```` ```go ````（2026-11-07，67 个旧路径测试在产品路径下跑出） | `patchCodeBlock` 要求属性完全相同，语言变了就整块交给序列化器 | 只有语言变了：只改开头围栏里语言那个词，围栏字符、缩进、前后空白不动；内容也变了时先确认整个补丁能成再一起写 | `reprint.js`；`test:source-reprint-ui` 'code block language change keeps the authored fence' 等 5 例、`test-code-block-info-transaction-ui`（产品路径） |
| Backspace 把无序列表并进有序列表后，下面作者写的 `1.` 列表重开并进上面的列表（第 1 项变第 5 项），不报警 | 编辑器里两个直接相邻的同类列表是两个列表，标记相同时 Markdown 读成一个；语义比较和列表槽位检查都把相邻列表当一个，所以谁都没拦 | `list-boundaries.js`，只管这一种：编辑让一个**原本不紧挨**同类列表的作者**有序**列表变得直接相邻（节点在编辑前的文档里就有，靠 ProseMirror 节点身份认），下面那个的分隔符换成另一种（`.`↔`)`，旧写入器和 Milkdown 也这样）。不动：用户刚输入的列表（`1. ` 后保持 `1.`，来自用户报告，`test-repeated-ordered-list-middle-ui`）、早就相邻的列表、bullet 列表（重开合并看不出区别，`test-isolated-empty-ordered-backspace-lift-ui`）、隔着空段落的列表（RS-86）。编辑前的文档：Coordinator 快照，没有时用打开时的文档（快照在第一次编辑时才建）。fuzz 判定照旧把相邻同类列表当一个 | `test-nonempty-bullet-backspace-merge-ordered-ui`（两种路径）、`test:source-reprint-ui` 'adjacent ordered lists keep their markers' 等 3 例 |
| 表格里清空一格再打字，整张表的对齐空格被重写；插入行 / 插入列 / 删除列也整表重写 | 空单元格（`\|   \|`）没有行内节点可打补丁，行打印不出来（`printBlock` 对表格行返回 null），列数变了直接整表打印 | 空单元格：内容插在两根竖线之间最后一个空格前（`\|  否 \|` 清空再填回仍是原样）；新正文行单独打印；单列插入 / 删除只改每行那一格和分隔行那一段 | `test-table-cell-empty-replay-ui`、`test-table-row-insert-transaction-ui`、`test-table-column-insert-transaction-ui`、`test-table-column-delete-transaction-ui`（产品路径） |
| 输入 `---` 生成的分隔线存成 `***` | 新分隔线由序列化器打印 | 被替换的段落是 `--` / `**` / `__` 这类开头时用它的字符（Typora：写什么存什么）；只在最精确的一级，`---` 会被读成标题下划线时下一级照旧写 `***` | `test:source-reprint-ui` 'typed thematic break keeps its character' 等 3 例、`test-middle-thematic-break-input-rule-ui`（产品路径） |
| 段落里一行只有 `-`（前后都是硬换行），保存或同步后上一行变成了标题，之后每次编辑都报「检测到富文本与源码不一致」（mac fuzz seed 3908，第 131 步源码模式改出多行 setext 标题，标题被切开后第 132 步起每步同步都失败，第 137 步报警） | remark 输出硬换行时用的是 `\` + 换行，它看到 `-\` 觉得不用转义；随后 `serializer-style.js` 把 `\` 换成两个空格（作者的写法），`-␠␠` 单独一行就成了 setext 标题下划线。reprint 打印新段落时先把换行前的空格去掉（`- ` → `-`，Markdown 写不出来），于是正好落进这个坑；整段序列化（`- ` 带空格）会被转义，所以只在 reprint 里出现 | `serializer-style.js` `rewriteHardBreaks`：改成两空格时，行里（去掉 `>` / 缩进）只有 `-` 或 `=` 的，第一个字符写成 `\-` / `\=` | `test:serializer-style`（`-` `=` `--` `==` `---`，段落和引用里）、`test:source-reprint-ui` 'new paragraph with a line of only "-" between hard breaks' 等 2 例 |
| 引用里只有一个硬换行的空段落（Shift+Enter 后清空文字），之后每次同步源码都多出两行 `> ` / `>`，越滚越大：1 KB 的文档存成 5 MB，存盘时没有报警（mac fuzz seed 3815，第 35 步起；第 63 步 reprint 抛错才报「不一致」） | 段落末尾的硬换行不是换行，这种段落 Markdown 写不出来，重开读成没有。`isBlankParagraph` 只把软换行当空白，于是这个段落每次都被当成「新插入」再打印一遍空行；源码解析时它又不存在，下次照样再插。校验把引用里的空行当作没有，所以一直通过。列表项、顶层同样会长 | `reprint.js` / `list-boundaries.js` `isBlankParagraph`：只有换行（硬或软）、没有文字的段落也算没有 Markdown 的空段落（RS-63 那条规则）。硬换行旁边有空格的段落照旧算内容（`&#x20;  ` 写得出来）。fuzzer 每步比较源码长度和重新序列化的长度，超过 3 倍 + 4000 字就报 `BLOAT` | `test:source-reprint-ui` 'paragraph of only a hard break in a quote: no new lines on every print' 等 |
| 段落里硬换行后面紧跟软换行（Shift+Enter 之后一个换行），保存后段落被拆成两段，报「不一致」（mac fuzz seed 3788，第 163 步） | 序列化器只把「软换行 + 软换行」的第二个写成 `&#10;`；硬换行的行尾加软换行的行尾 = 一个空行，Markdown 里就是新段落。正常序列化和 reprint 都写错 | `inline-serializer.js`：硬换行后面的软换行同样写成 `&#10;`（和硬换行放在同一个 HTML 值里，避免行尾被换成空格）；在段落末尾时照旧只写一个换行 | `test:source-reprint-ui` 'soft break after a hard break stays in the paragraph' 等 3 例 |
| 文件末尾（或列表项、引用末尾）有一个没闭合的代码块 / `$$` 公式块，在它下面粘贴或打字就报「不一致」（mac fuzz seed 3737，第 318 步粘贴列表） | 没闭合的围栏一直延续到容器结尾，所以它原本一定是容器的最后一块；reprint 照旧保留它的原字节，新块写在后面就被吞进代码块，校验失败，没有别的写入器能接 | `reprint.js` `fenceLeftOpen`：没闭合的代码块后面多了块时，不再当作「没变」，整块重印（序列化器写出闭合围栏）。闭合的围栏照旧保留原字节 | `test:source-reprint-ui` 'block added after an open fence closes it' 等 6 例（文档、只有开头一行、`$$`、列表项、引用、闭合对照） |
| 文字里本来就有 `&#x20;` 这几个字符的块，整块重印时报「不一致」（mac fuzz seed 3735，第 276 步：把含这段文字的公式块拖到标题上） | 序列化器把字面 `&#x20;` 写成 `\&#x20;`；reprint 的后处理把所有 `&#x20;` 都当成自己的空格编码改写，写出 `\ `（行尾时还剩一个 `\`） | 后处理只改写前面没有转义反斜杠的 `&#x20;`（前面是偶数个反斜杠才算） | `test:source-reprint-ui` 'literal &#x20; text in a block printed whole' 等 3 例 |
| 只有空格的段落重开后多出一个 U+200B 段落（Windows fuzz FORMAT+UI+PASTE seed 3716，第 119 步；mac 上同种子不出现，随机点击依赖布局） | 两层：① reprint 把「写不进 Markdown 的空白」当成改动——单元格开头的空格（GFM 会去掉）、软换行前后的空格（CommonMark 会去掉）——补丁打不出来，只能整块重印（degraded），按设计交给旧写入器；② 旧写入器把只有空格的段落写成 U+200B + 空格，段落末尾的空格被去掉，读取端只认「U+200B 后面紧跟空格」的占位符，于是留下一个 U+200B 字符。保存检查两边都当空段落，所以没报警 | ① `sameModuloEditorOnly`：文本块去掉这些空白后相同就算没变，保留原字节（`withoutUnencodedBlanks`；段落开头的空格是内容，不去）；② `remarkStripLeadingSpaceSentinel`：段落只剩一个字面 U+200B、源码里它后面是空格或 Tab 时，就是占位符，段落为空（旧文件里已有这种行也能读对）；实体 `&#x200B;` 和单独的 U+200B 仍是内容 | `test:leading-space-sentinel`（9 例）、`test:source-reprint-ui` 'table cell with an edge blank keeps the table bytes' 等 4 例 |
| 有序列表后新建的无序列表偶尔少了中间的空行（Windows，约 1/4） | 慢机器上回调晚到，reprint 印出新列表时光标已离开列表，列表输入意图没被清掉；之后一次“无新内容可写”的回调交给旧的 typed-bullet 写入器，它用这个过期意图重写了列表 | reprint 给没有作者标记的列表印标记时记 `new-list-marker`；发布带这条记录就清掉待处理的列表意图（原来只在光标仍在列表里时清） | `test-family-multicycle-ui`（Windows 12 次；失败时打印 reprint 跟踪；`CPU_THROTTLE=4` 可降速） |
| 整块重印的代码块里 `&#x20;` 变成 U+200B（fuzz seed 562：给闭合围栏加上 ` src72` 后，后面整篇都成了代码；其中 `## &#x20;   betado` 一行原样进了代码，在代码里再打字） | reprint 的 `serializeNodes` / `withSentinels` 对印出的整段文字做 Markdown 行处理（行首 `&#x20;` → U+200B、`<br />` 占位行删除、U+E000 还原），没有跳过围栏代码 / `$$` 内容 | 这些处理经 `withLiteralBlocksProtected`（从 markdown-source-preservation.js 移到 `lib/literal-blocks.js`）只作用在代码块外；开头围栏也认 `- ```js`（列表项以代码块开头） | `source-reprint/reprint.js`、`lib/literal-blocks.js`；`test:source-reprint-ui` |
| 任务项的唯一一段文字被删空（fuzz seed 619 / 678） | reprint 的区域修补把空段当作编辑器自有内容删掉，写出 `- [ ] `（没有正文），重新打开成了普通列表项（`checked` 不同 → 暂停）；seed 398 的「首段被清空就放弃区域修补」只在还剩别的内容时生效 | 任务项清空后也放弃区域修补，整项重印写 `- [ ] ` + U+200B；普通列表项仍保留作者的 `- ` | `source-reprint/reprint.js` `patchContainer`；`test:source-reprint-ui` |
| 跨代码围栏的整段替换写出 `- [x] <br />`（fuzz seed 672：粘贴带围栏的 Markdown 后删除） | cross-fence-span owner 用 Crepe 的序列化器重写窗口，只跳过顶层空段落；嵌套的空段落 / 空任务正文成了 `<br />`，重新打开是一个只含换行的段落（校验把它当空段落，没拦住） | 该 owner 的输出经 `withoutEmptyParagraphPlaceholders`：空任务正文写 U+200B，其余单独的 `<br />` 行删除（代码 / `$$` 内不动） | `markdown-source-preservation.js`、`Editor.jsx`；种子重放 |
| 只含换行的段落算作存坏（fuzz seed 612：引用里 Shift+Enter 后保存） | fuzzer 只在段落还有别的内容时去掉开头 / 结尾的换行；只剩一个换行的段落没有 Markdown 写法，保存成空段落（Typora 同样） | fuzzer：只剩这种换行的文本块就是空块（表格单元格除外） | `scripts/fuzz-rich-source-ui.mjs`（存坏时也记录 owner / reprint trace） |
| 首行缩进的段落变成多块列表项后暂停（fuzz seed 722：` src1` 转成有序列表，在中间粘贴代码块） | 整块重印列表时替换从 `s` 开始，行首那个空格留在原处，写成 ` 1. s`；内容列成了第 4 列，而后续行只缩进 3 格，代码块和下一段掉出列表项 | `wholeBlockFrom`：多行的整块重印把容器前缀之后的行首空白（CommonMark 忽略的 0–3 格）一并替换 | `reprint.js`；`test:source-reprint-ui` 'indented paragraph becomes a multi-block list item' |
| Windows 上种子报错 EBUSY（fuzz seed 766：删除重开用的临时配置目录） | Electron 的子进程退出后还会占着配置目录里的文件（Dictionaries）好几秒，原来的重试只等约 1.7 秒 | 重试约 10 秒；仍删不掉就只警告（剩下的只是临时目录），不算测试失败。之后 `test-highlight-bold-ui` 自己的 `rm(root)` 也撞上（UI 测试几乎都这样清理）：Windows 上 `stopBuiltElectron` 现在等配置目录能改名（里面没有打开的文件）再返回，最多 10 秒 | `scripts/lib/electron-test-app.mjs` |
| 段落下面跟着从 2 开始编号的嵌套列表时暂停（fuzz seed 814：列表项段落以 `1.` 结尾，下面是 `2. /ol`） | 完整序列化（canonical）把段落和嵌套列表紧挨着写：`1\.` 下一行就是 `2. /ol`。编号不是 1 的有序列表、第一项为空的列表都不能打断段落，读回时成了段落文字，嵌套列表丢失。校验拿这份错的文本比对列表结构，重印引擎写对了也被拒 | `lib/list-interrupt-join.js`：序列化的 `join` 规则，段落后面跟着不能打断段落的列表时空一行 | `test:list-interrupt-join`；`test:source-reprint-ui` 'nested list starting at 2 below an item paragraph' |
| fuzzer 误报存坏（Windows fuzz seed 880：段落以行内代码 `` `1. ` `` 加 4 个空格结尾） | 判定规则先删掉结尾那段全是空白的普通文字，再把新的最后一个节点（行内代码）的结尾空格也裁掉；只在打开后（没有那段空白）的一侧裁到了行内代码，所以 `1. ` ≠ `1.`。行内代码里的空格是内容，保存和打开都保留着 | `normalizeDoc`：只裁普通文字的结尾空白，裁空了就删掉继续往前，遇到行内代码就停 | `scripts/fuzz-rich-source-ui.mjs` |
| 斜杠菜单前一步之后暂停（fuzz seed 936：选区从段落结尾跨进代码块，删除 + 拆分在同一个事务里） | 删除把代码块并进段落，代码里的 `\n` 留在段落文字里；`editor-textblock-newlines.js` 只扫改动范围内的文字节点，并进来的文字紧挨在范围之后，没被扫到 | 改动范围碰到的文本块整块扫描 | `test:textblock-newlines-ui`（加入 UI 回归）。调试：`FUZZ_WATCH_NEWLINE=1` 记录第一个让段落留下原始换行的事务；暂停报告的 `atFailure` 是失败那一刻的源码和文档（trace 模式下 `captureSyncReport` 留存） |
| 块拖拽后暂停（fuzz seed 940：拖走缩进围栏前面的段落、把它放到列表前） | 三处：① 区域替换把下一个块（`  ````）的行首缩进换成了分隔符，围栏顶格而内容行仍带 2 格，读回多 2 个空格；② 复用左边块后面原有的空白当分隔符时，带上了原邻居的缩进（`  - l`）；③ 缩进围栏变成紧跟列表时，留着缩进会被读成列表的续行 | ① 保留下一个块的行首缩进；② 右边已不是原邻居时去掉那段缩进；③ 前面是列表且带缩进的块整块顶格重印 | `reprint.js`；`test:source-reprint-ui` 三个 seed 940 用例 |
| 列表项里按 Tab 后保存暂停（fuzz seed 1001：项的段落是「软换行 + 两个空格 + 软换行 + ` tes…`」） | 整块打印时边缘换行只裁一遍：裁掉第一个换行后，纯空白文字挡住了第二个；打印出的空白行结束了列表项。行首空格又被加上 U+200B 占位符，而它跟在换行之后，本来没有写法 | 边缘换行和夹在其中的纯空白文字反复裁到不变；裁掉开头换行后，下一段文字的行首空白一起去掉 | `reprint.js`；`test:source-reprint-ui` 'item paragraph starting with a blank soft-broken line' |
| 代码块转段落后打字暂停（fuzz seed 1053：段落以「软换行 + `    }`」开头） | 1001 的修复在裁掉开头换行后总是去掉下一行的行首空白；校验器只在换行之间夹着纯空白行时才忽略这些空白，否则 `    }` 的缩进有意义（保留为 U+200B + 空格） | 只在裁掉过纯空白行时去掉行首空白 | `test:source-reprint-ui` 'paragraph starting with a soft break keeps the next line indent' |
| 存坏：空行段落重开后多了 U+200B（fuzz seed 1057：段落只有「软换行 + 8 个空格」） | `isBlankParagraph` 只认纯空白文字，带软换行的就不算空，于是整块打印成「U+200B + 空格」，重开成一个含 U+200B 的段落 | 软换行 + 空白也算空段落（没有写法，按被清空的段落处理） | `test:source-reprint-ui` 'paragraph of a soft break and spaces has no encoding' |
| 引用块里两个空段落后每次编辑都暂停（fuzz seed 1142：`/quote` + Tab + Enter） | 引用块里空段落的个数没有写法（`>` 就是一个），校验器只在列表项里合并连续的空段落，引用块里没有，任何写法都对不上 | `semanticJson`：引用块里连续的空段落合并成一个 | `test:source-reprint-ui` 'quote of two empty paragraphs' |
| 文字本身以「零宽空格 + 空格」开头时每次编辑都暂停（fuzz seed 1286：代码块里有一行 `​ x`，拖动后变成段落；从网页粘贴的文字也会这样） | 读入时 `remarkStripLeadingSpaceSentinel` 把任何文本开头的 U+200B + 空格都当成 HorseMD 自己的前导空格标记去掉，这种文字没有任何写法能读回原样 | 只去掉源码里真正写着 U+200B 的标记（看源码位置上的字符）；`remark-text-handler` 把文本开头的 U+200B + 空格写成 `&#x200B;` | `test:remark-text-handler`；`test:source-reprint-ui` 'text starting with a zero-width space and a space' |
| 引用块里缩进的列表项加了子列表后暂停（fuzz seed 1299：`>   - x` 下面加嵌套列表） | 重排引擎算列表项内容列时只算了标记宽度，没算标记前的空格；新块写在标记的列上，成了列表的兄弟 | `childFrame`：列表项前缀加上标记前（相对外层前缀）的空格数 | `test:source-reprint-ui` 'nested list added to an indented item (in a quote)' |
| 有序列表中间插入几项后暂停（fuzz seed 1505，Windows：`9.` 被重排成 `12.`，项里 5 格缩进的代码块跑出列表项） | 重排编号只改数字，位数变了内容列跟着移，后续行的缩进没跟着移 | `renumberSurvivors`：位数变了就把这一项后面的行按差值加减空格（Typora）；项里另有改动、或有行不以外层前缀开头时，这一项保留原编号（编号不影响内容） | `test:source-reprint-ui` 'renumbered item of a wider / narrower number moves its lines' |
| 拖块把任务列表的第一项拖到一个缩进 3 格的段落前面后暂停（fuzz UI seed 1607，Windows） | 段落已经整块重印到行首，但它前面的分隔符沿用原来的空隙 `\n\n   `，末尾那 3 格缩进是段落自己的；留着它，段落重开后成了列表项的续行 | `replaceRegion`：下一块因前面变成列表而重印时，分隔符末尾去掉它原来的缩进 | `test:source-reprint-ui` 'list moved in front of an indented paragraph' |
| 删光整篇的文字后再写，从此每次编辑都同步失败，几小时后回车时弹「不一致」（Air 0.14.0 用户 trace 2026-11-06：新建文档里打 `woyao` 后全删，再 `# ` + 输入法写满一页；v0.14.0 / HEAD 复现） | 源码只剩 `\n` 时没有任何块可以当插入的锚点，reprint 返回 `reprint-unexpressible`，legacy 也失败（visible-stream-mismatch）；空源码解析出的文档有一个空段落、mdast 一个子节点也没有，`mdChildren` 直接放弃 | `mdChildren`：空源码的空段落对齐成占位；`replaceRegion`：文档层源码全空白（不含 front matter）时新块就是整篇源码 | `test:source-reprint-ui` 'typing into an emptied document / empty file'；`test:emptied-document-retype-ui`（回归套件） |
| 空的 `1) ` 项 Backspace 并入上面的 `+ literal` 列表后，整个列表被写成 `-`（旧测试 `test-list-isolated-empty-ordered-lift-transaction-ui` 改写后暴露） | 两个旧块被一个新列表替换，新列表从头打印，不知道作者用的是 `+` | `replaceRegion`：新列表沿用被替换块中同类型旧列表的标记 | `test:source-reprint-ui` 'list merged from removed blocks keeps its + marker' |
| 删掉父项文字（`1. 父` + `   1. 微风`）后写成 `1. 1. 微风`（RS-67） | 标记行从文字变成块，整项重印，以列表开头的项被写到标记行上 | 普通项第一段清空、其余块不变时只删那段文字的字节（`emptied-lead`） | `test:source-reprint-ui` 'parent item text deleted above a nested list'；`test-nested-parent-body-empty-ui` |
| 列表输入意图挂起期间（打 `- ` / `1. ` 后 3 秒内）源码重排不跑，旧的意图恢复代码把早先的意图套到后来的文档：新列表和上面的列表粘在一起丢空行（`test-family-multicycle-ui` 第 2 轮）、`1.` 变 `1)` | `hasBlockingListInputIntent()` 为真时 markdown-updated / 强制刷新都跳过 `publishReprint` | 意图挂起时重排照样先跑（它对编辑器文档校验，瞬态标记不会误判）；没有作者标记的新列表用意图里的标记打印（`reprintSource` 的 `newListMarkers`）；发布后光标已在列表里就清掉意图。同类两个意图标记不一致时仍交给旧路径 | `test-family-multicycle-ui`、`test-fast-empty-bullet-ordered-input-rule-ui` |
| 新文档里 `- 离婚了` → 回车 → 退格后标题和列表粘在一起（`# 测试\n- 离婚了`，RS-51） | 新文档路径只在意图改了标记时才算用掉；`-` 本来就是默认标记，意图一直挂着，到退格时被旧代码套用 | 光标已在同类列表项里也算用掉（`caretInListOfKind`） | `test-generated-scratch-empty-bullet-backspace-ui` |
| CRLF 文件里 LF 结尾的列表一改，整个列表的行尾都变成 CRLF；`- 1\. ` 后打字写成 `1\. 测 `（多一个行尾空格） | 重排统一用文件里第一个 CRLF；行尾空格不算文字，插入点落在它前面 | 打印的文字用它替换的那段字节的行尾（多数），否则用所在行的；块尾插入的开头空白正好等于行尾空白时复用它们 | `test:source-reprint-ui` 'mixed line endings…'、'text typed after a trailing blank reuses it' |
| 空的最后一项按退格并到上一项后，上一项里嵌套的 `  * wfewff ` 变成 `  - wfewff`（RS-63） | 并过去的是一个没有 Markdown 的空段落，比较时这一项算「变了」，整项重印，嵌套列表没有作者标记可用 | 比较时忽略这种空段落（不是容器的第一个子块），这一项算没变，保留原字节（`sameModuloEditorOnly`） | `test:source-reprint-ui` 'empty last item joined…'；`test-empty-bullet-after-nested-list-backspace-ui` |
| 列表中间连按两次回车，`- 12312\n- 后继项` 写成 `- 12312\n\n\n\n- 后继项`，重开变成一个松散列表（RS-86） | 编辑器里列表被一个空段落拆成两段；顶层空段落按「各占一行」写空行，可同标记的两个列表在 Markdown 里本就是一个列表 | 两个会读成同一个列表的列表之间不写空段落的空行，用那个列表原来的项间分隔（紧凑看文字，不看 Milkdown 的 `spread`——打出来的项总是 `spread: true`）；拆出来的后一段沿用前一段的标记。两项的松散列表（`- a\n\n- b`）拆成两个单项列表时，两段里都没有项间分隔可看，被写成紧凑的 `- a\n- b`（2026-11-07 发现：`test-bullet-exit-keeps-sibling-ui` 一直只在关掉重排的旧路径下跑，产品路径下失败）；现在也看拆出它们的原列表的项间分隔 | `test:source-reprint-ui` 'tight list split…'、'typed list…'、'loose two-item list split…'；`test-rapid-double-enter-bullet-exit-before-sibling-ui`、`test-bullet-exit-keeps-sibling-ui` |
| Windows 模糊测试种子 2322：任务列表里在软换行前按回车拆项，弹「富文本与源码不一致」（这段校验一直如此，不是这轮引入的） | 重印结果本身正确，但校验的列表结构检查在兜底时把编辑器文档里「没有 Markdown 写法的空段落」删掉再序列化——任务项 `- [ ] ​` 的勾选框就挂在首个空段落上，下面跟代码块或标题时它也被删了，任务项变成普通项，`- 列表ist` 这种代码块里的行还被当成列表项，结构对不上，每次重印都被拒 | `withoutEmptyContainerParagraphs` 保留任务项的首段（只有它带勾选框） | `test:source-reprint-ui` 'empty task item above a code block…'、'…above a heading' |
| Windows：刚打开文件就点进列表项，光标跳回文档开头；右键转换列表后 DOM 光标停在别的项（`test-list-isolated-empty-ordered-lift-transaction-ui`、`test-list-conversion-ui` 在 Windows 上一直失败，mac 通过） | Crepe 列表项节点视图挂载时记下选区，下一帧（requestAnimationFrame）再写回，只检查文档没变、不检查选区变没变；后台 / 刚打开的窗口首帧推迟，这期间用户的点击被写回的旧选区覆盖 | `vite.milkdown-fixes.mjs` 构建期补丁：写回改在挂载的那次更新之后立即执行（微任务），且只在选区仍是挂载时那个时才写；Milkdown 这段代码变了构建直接报错。第一版补丁上，勾选任务后光标跳到上面的标题（列表 UI 扫描里 `test-generated-scratch-task-continuation-empty-ui` 失败）：Vue 每次重新渲染都再调一次挂载回调，`appendChild` 把已在原位的正文节点拔出再插回，DOM 光标丢了，ProseMirror 的变更监听先读到丢失后的光标，选区已变，补丁就不再写回（原来晚一帧写回，恰好把它掩盖了）。正文节点已在原位时不再移动 | `test:list-item-mount-selection-ui`（老构建上选区被改回；第一版补丁上勾选任务后光标跑到别的块） |
| 格式叠加（#173 家族，2026-11-04，组合测试 22 680 例中 3 003 例失败） | Milkdown 序列化逐节点开关 mark，`#moveSpaces` 把交叉 mark 里的空格挪到文字另一侧、只剩空格的 mark 写成 `****`、链接被行内代码切成两个；`~~` 贴中文标点不配对；行内代码在链接里被一个 remark 转换去掉；删除线 / 高亮边缘空格校验不容忍 | 自己的行内序列化（整块建树、只在真边缘移出空白 / 换行、反复建树到稳定、相邻 `*` 换 `_`）；中文友好删除线（micromark 扩展，按名替换 GFM）；去掉代码标签转换；容忍集合加删除线 / 高亮 / 上下标、Unicode 空白 | `lib/inline-serializer.js`、`lib/markdown-blanks.js`、`lib/remark-cjk-strikethrough.js`；`test:mark-combinations-ui` |
| 只给图片加格式后保存丢格式 | 序列化缓存的「仅标题 id 不同」判断不比较叶子节点的 mark → 返回上一个文档的字节 | `sameIgnoringHeadingIds` 比较每个节点的 mark；重排的 `sameNode` 同样 | `lib/source-sync/editor-only-document.js`、`source-reprint/reprint.js`；`test:image-mark-ui` |
| 源码重排接受了字面 `**`（Option A 越界） | `minimal` 级别用字面星号通过了「Markdown 写不出」的宽容，没轮到能写出的 `full` / `block` | 先全部级别严格校验，都不行才用 Option A | `source-reprint/index.js` |
| 任务项以格式开头时整段重排丢复选框 | 任务项段落的起点位置只在后面是纯文字时才越过 `[ ] ` | remark 转换修正起点 | `lib/remark-task-paragraph-position.js` |
| 代码块转正文 / 标题、Delete 合并代码块后暂停（FORMAT 种子 2、13–15、18） | 段落文字里留着原始 `\n`，Markdown 写不出 | 换行节点设为 ProseMirror 的 `linebreakReplacement`；appendTransaction 把文本块里的 `\n` 换成软换行、标题里的硬换行变软（再由 one-line-blocks 拆分） | `editor-crepe-setup.js`、`editor-textblock-newlines.js` |
| 单个 `=` 被高亮且旁边还有 `=`（FORMAT 种子 6） | `==` 内容不能含 `=`、也不能贴着 `=` | 这种高亮写成 `<mark class="hm-hl-yellow">` | `editor-highlight.js` |
| 两个反斜杠 + 软换行变硬换行（种子 18） | 作者风格的「反斜杠硬换行 → 两空格」不看反斜杠奇偶 | 只改奇数个结尾反斜杠；文字和它后面的软换行一起交给 text handler 转义 | `lib/serializer-style.js`、`lib/inline-serializer.js` |
| 规范语料：制表符 / 深缩进的缩进代码、HTML 块里的软换行、列表接列表、只有表头的表格、`[](url)` / 只有定义的文档 | 缩进代码重排把内容前导空格当缩进；mdast 把 HTML 前的换行改成空格；边界规则过保守；无单元格的行被印成空行；未改文档也按编辑器副本重印 | 行内对齐补丁；换行放进 HTML 值（类型 1–6 加四空格）；列表接列表保留原间隔；跳过无单元格行；未改直接返回原文 | `source-reprint/reprint.js`、`lib/inline-serializer.js`；`test:spec-corpus-ui` |
| 引用段落含 marks / 多行 / 惰性续行 每键暂停 | blockquote owner 只支持单行纯文本，其余 recognized 拒绝且 legacy 已退役；共享 `pmPosToMarkdownOffset` 在引用续行忽略 `> ` 前缀、会坍缩到块首 | `planInlineLocalizedPatch`：自己按去前缀原始行对齐，验证删除区间字节=删除文本，候选拼写 原样/转义/按 mark 包裹（`*e*`），在去 BOM/LF 规范化副本上校验 | `lib/source-sync/blockquote-paragraph-transaction-owner.js`；链证明 `allowInlineMarks` 在 `pending-text-transaction-chain.js` |
| 表格单元格边缘空格 | GFM 裁剪单元格首尾空白，PM 保留 → 语义失败 → legacy 猜测拼坏整行 | 校验器忽略单元格边缘空白 | `lib/source-transaction-sync.js` `semanticJson` |
| 表格单元格定位失败（CJK、重复值） | 位置映射落错字节 → `raw-block-text-mismatch` → legacy（会把 `| --- |` 改成 `| - |` 或合并单元格） | `mapTableCellBySlot`：按内容匹配表头+分隔行+全部行定位表格，只改目标槽位字节，`|` 必转义 | `lib/source-sync/table-cell-empty-transition.js`，owner 回退调用 |
| 单元格内回车 | hardbreak 不在纯文本单元格契约内 | 契约接纳 hardbreak，槽位按 `<br>` 拼写；比较用文本节点拼接（Milkdown hardbreak `leafText` 为 `\n`） | 同上 + `table-cell-transaction-owner.js` |
| 同一 journal 改多个单元格（Tab 后继续改） | owner 要求恰好一个改动单元格 | `classifyMultiCellJournal` + `mapTableCellsBySlot`，由后往前改 | 同上 |
| 文件末尾是表格/列表/代码/引用 | Milkdown trailing 插件追加空段落被并入下一 journal → 双顶层改动 | `isTrailingEmptyParagraphAppend` → 校验后 `adoptEditorOnlyDocument` | `lib/source-sync/editor-only-document.js`、`editor-bridge.js`、`Editor.jsx handleSourceTransactions` |
| 标题 id 同步 | `syncHeadingIdPlugin` 在标题编辑后**单独**派发 id-only `setNodeMarkup`，混入下一处编辑 → 双块 journal → 静默滞留到保存 | `isHeadingIdOnlyChange`：先发布待发布 journal，再按 editor-only 吸收；`changedTopLevelRange`/replacement owner/bridge live 比较均忽略仅 id 差异 | 同上 + `document-replacement-owner.js` |
| journal 跨块（代码块编辑后改别处等） | `markUserEdit` 的块切换 flush 依赖 DOM 事件，漏掉 CodeMirror/IME/撤销 | **journal 局部性**：事务触及与待发布 journal 不相交的顶层块时，先强制发布（dispatch 在 `view.updateState` 前调用，flush 看到的正是旧状态），再复位 pending 标志 | `Editor.jsx handleSourceTransactions` |
| 行内标记旁/内部回车 | `preserveParagraphSplit` 始终取 forward 偏移（`、|`code``）；在 span 内拆分没补闭合/重开分隔符 | 以 canonical 分隔符两侧的闭合/开启串为准；span 内部拆分插入镜像分隔符；右侧以空白开头时空白放到重开分隔符外 | `lib/markdown-preservation/paragraphs.js` |
| 嵌套列表在空格前回车 | 新项 `  - ` + ` B`，空格被吃 | 失败时重试在新行正文前加行首哨兵 U+200B | `list-nested-bullet-split-transaction-owner.js` |
| 行首空格哨兵残留 | 删除行首空格后 U+200B 留在源码 → 语义失败 | 出口移除孤立哨兵（仅在本次编辑产生的行、哨兵后紧跟非空白） | `markdown-source-preservation.js withoutOrphanLeadingSpaceSentinels` |
| 行首空格后退格合并段落 | 多块删除守卫一律 fail-closed | 原始删除字节去空白/哨兵后恰等于删除可见文本时允许（纯合并） | 同上，`localized-multi-block-delete` 例外 |
| **BOM 文件格式丢失（潜在）** | Milkdown `remarkMarker` 用 `file.value.charAt(offset)`，offset 不含 BOM 而 value 含 → marker 读成前一字符（空格），canonical 把 `*`/`_` 打印成空格 | `remarkFixMarkerOffsetForBom`（与插件顺序无关） | `lib/remark-marker-bom-fix.js` |
| 粗体/斜体首尾空白 | `** word**` 非法，序列化器把空白移出 | 校验器把仅 strong/emphasis 的 run 首尾空白视为非语义 | `semanticJson` |
| 段落/标题末尾空白（引用末尾空格+回车） | CommonMark 必剥离段末空白 | 校验器忽略段落/标题末尾空白（代码块除外；硬换行前的空格仍严格） | `semanticJson` |
| 引用内列表回车（CRLF） | canonical 在行首整行插入，映射落在上一行尾前 → `quote-two> 3.` | 越过一个作者行尾 | `markdown-source-preservation.js` localized-change |
| Markdown 粘贴回退 canonical 拼写 | raw paste owner 在 dispatch 内发布，bridge 的 live doc 还是旧状态 → 必然 stale | 发布期间 `getExpectedDoc` 返回 `dispatchingExpectedDoc` | `Editor.jsx` |
| 网页整篇粘贴 `# # 标题` | 粘贴后标题 id 同步使整篇替换 token stale | replacement owner 文档比较忽略仅 id 差异 | `document-replacement-owner.js` |
| **0.13.237 段落行首 4 空格存成缩进代码块（CORRUPT）** | Milkdown 默认 `text` 序列化 fast path `/^[^*_\\]*\s+$/` 对“以空白结尾”的文本（行内代码前的文本）**跳过一切转义**：`    second ` 原样输出 → 重开成代码块；`1. ` `# ` `- ` `> ` 同理变列表/标题/引用。canonical 与候选同错，校验器（比 parse(canonical)）放行 | 覆盖 `text` handler：保留尾部空白原样，头部走 `state.safe`；纯空白且在行首、首字符为空格/Tab 时编码 `&#x20;`（源码用 U+200B 哨兵）。校验器加 **canonical 结构守卫**：parse(canonical) 顶层块类型序列须与 live doc 一致（忽略空段落、合并相邻同类列表），否则 semantic/transition 证明不成立 | `lib/remark-text-handler.js`、`editor-crepe-setup.js`、`lib/source-sync/validator.js topLevelStructureSignature` |
| 撤销跨越源码编辑（seed 36/28） | 源码模式 `replaceAll` 在 PM 历史里；撤销一步还原整篇（如把被源码改坏的表格还原），journal 出现整篇 ReplaceStep，legacy `unmapped-table-change`，之后所有编辑滞留到保存弹恢复副本 | 记录已证明的 (doc, source) 对（replaceMarkdown 前后、Coordinator 快照 doc 即 oldState.doc 时）；undo/redo 落到已记录文档时按 owned candidate 恢复那份**原字节**（仍经校验器） | `lib/source-sync/history-source-restore.js`、`editor-api.js replaceMarkdown`、`Editor.jsx handleSourceTransactions` |
| 选中分隔线后退格 / 直接输入 | NodeSelection 下 hr 被删（输入时文字并入下一段）；canonical `***` vs 源码 `---` 让 legacy diff 锚错，吃掉表格与段落间分隔 | `top-level-block-removal` owner：PM 文档证明“连续顶层块被删 + 至多一个相邻文本块被改”，remark 位置定位源码块（类型/数量须对齐，BOM 偏移修正）精确删除，剩余文本改动交给段落 diff | `lib/source-sync/top-level-block-removal-transaction-owner.js`（owner 链最后，legacy 未退役） |
| 源码编辑后表格不规则（seed 31/34/35） | 源码里某行多/少单元格；prosemirror-tables 加载时补齐成矩形，canonical 写成矩形 → 之后任何单元格编辑都暂停 | `semanticJson` 对表格两侧同样补齐短行（空单元格，列属性取自有该列的行）；槽位映射接受“源码行短于编辑器行且多出的格为空”；单元格 owner 的多格路径把 fixTables 在首次编辑同批插入的空格（ReplaceStep + 对新格的 setNodeMarkup）视为非改动。注意：表头短于正文时 prosemirror-tables 把补格插在表头**开头**并移动对齐属性——编辑器自身改了表格，legacy 整表重写与 live doc 一致（不暂停，但不保留原拼写） | `lib/source-transaction-sync.js`、`table-cell-empty-transition.js`、`table-cell-transaction-owner.js` |
| 回车拆段后新段以空格开头 | 新 text handler 让 canonical 保留 `&#x20;`，原始空格在块首会被剥离 | `preserveParagraphSplit` 识别 canonical 开头的 `&#x20;`，右段写 U+200B 哨兵 + 原空格 | `lib/markdown-preservation/paragraphs.js` |
| 整篇 Markdown 粘贴丢末尾换行（rs-41，0.13.236 已存在） | 粘贴已按原字节发布后，迟到的 markdownUpdated（另一种 canonical 拼写）再跑 legacy diff | markdownUpdated：无待处理意图/journal 且 live doc 与已发布快照 doc 相同（忽略 id）时，只复核已提交源码并返回 | `Editor.jsx handleMarkdownUpdatedImpl` |

永久回归：`test:rich-source-pause-families-ui`（17 例）、`test:history-source-restore`、`test:top-level-block-removal-owner`、`test:remark-text-handler`、`test:blockquote-inline-patch`、`test:remark-marker-bom-fix`、`test:editor-only-document`、表格单元格 owner 单测、`test-blockquote-transient-trace-regressions-ui`、`test-blockquote-list-exit-backspace-chain-ui`、issue-77 UI——均已在 `run-ui-regression.mjs`。

## 5. 未修清单（按优先级）

- ~~（P1，2026-11-06）列表输入意图挂起时源码重排被跳过~~ 已修（2026-11-06，见 §4 最后三行）。仍有 11 个旧的列表 UI 测试在修之前就失败（期待旧路径的拼写或内部原因），列在 §2.2。

> 2026-10-06 起架构方向已改为**源码重打印引擎**（[`source-reprint-architecture.md`](./source-reprint-architecture.md)）：新问题优先补引擎的通用规则（对齐/外壳/§5 无编码表），不再为单个手势写 owner。下表是引擎接入前的记录，复跑结果以主路径模糊测试为准。

0.13.237 复跑状态（最终构建）：seed 36 200 步无暂停/损坏；31 推进 26→179、35 推进 32→142、28 到 194、37 到 110；全部无损坏。分诊用 `node scripts/lib/fuzz-triage.mjs <out>/seed-N`。

1. **seed 37 op 110**：引用段落内回车拆段（首段留尾随空格）后，同一 journal 又改了引用和代码块 → 引用 owner `blockquote-paragraph-inline-range-unmapped`（recognized，fail-closed）。
2. **seed 38 op 93**：在软换行前（`。|\nSecond line`）回车，新段落以软换行开头（Markdown 无法表达），`preserveParagraphSplit` 走 `paragraph-split-already-authored` 返回原文 → fail-closed。需决定该瞬态的源码拼写（或让 PM 回车时吞掉开头的软换行）。
2b. **seed 34 op 60**：源码编辑造成的不规则表格（正文行多一格、表头短）+ 单元格内回车，journal 未被单元格 owner 接住，legacy `table-text-change` 丢 `<br>` → fail-closed。见表头补格插在开头的说明。
3. **seed 39 op 172**：有序列表项尾随空格 + 回车后，legacy `batched-list-block-changes` 把列表拆成 `1.`/`1.` 两段（`source-list-structure-mismatch`，fail-closed）。
4. **seed 28 op 194**：多次源码编辑后任务列表回车 → `diverged-nested-list-change`。
5. **seed 16**：源码编辑在闭合 ``` 后追加文字，使代码块延伸到文末（作者源码本身已变），之后富文本编辑 fail-closed。优先级低。
6. **段落末尾粘贴 Markdown**：raw paste 候选 `existing para# 标题…` 不成立，回退 canonical 拼写（无警告，仅拼写不保真）。粘贴点在块尾时应补段落分隔。
7. **文件无末尾换行时在末尾回车+输入多一个 `\n`**（`test-paragraph-source-preservation-ui` 唯一失败）：terminal split 补到两个换行的槽位后无法得知原 EOF 换行数；需跨两次发布记忆。
8. **相邻同类列表**在 Markdown 中会被合并（文字不丢，编号续排）：只有编辑弄出来的作者有序列表相邻才换 `1)`，用户输入的和 bullet 保持原样（2026-11-07，见 §4）。
9. 点击源码切换按钮在 flush 失败时会弹**恢复副本保存对话框**（原设计），体验突兀；暂停减少后出现频率降低。

2026-10-23（语雀样本 `scripts/fixtures/yuque-export/start.md`，自检构建）：已修「退格合并段落后缩进代码紧贴列表」（重印改写成 ``` 围栏，其后 `2.` 段落写成 `2\.`；seed 46/47 由暂停变为 200 步无事），以及判据误把两个 `<font>` 之间的空格删掉而误报损坏。仍暂停（均 fail-closed，上一版同步骤同样暂停）：41（缩进代码后从 2 开始的有序列表，无编码）、48 op 108（退格把列表并进上一段）、52（半截 HTML 文本内加粗）、54 op 119（重印编辑重叠）。改增量解析或逐块比对缓存后，fuzz 必须用 `VITE_HM_SYNC_SELF_CHECK=1 npm run build` 的自检构建跑（见 `performance-large-doc.md` 2026-10-23 存档）。

## 6. 回归与交付

```bash
npm run build
npm run test:ui-regression        # 会话 + 独立项；runner 遇首个失败即停
# 想看全量结果：复制 runner 为 keep-going 版本（失败继续），见 ai-handoff。
for f in 纯函数测试; do node scripts/$f; done   # package.json 中非 -ui 的 test:*
npm run build:mobile && npm run guide:check
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:dir   # 再按 ai-handoff 安装流程
```

基线（0.13.236）：全部纯函数测试通过；UI 套件 5 会话 + 40 独立项仅 `test-paragraph-source-preservation-ui`（§5-6）失败。改源码同步后至少跑：`test:markdown-preservation`、`test-source-fidelity-probes`、相关 owner 单测、`test:rich-source-pause-families-ui`、受影响的 UI 测试，再复跑相关 fuzz seed。

## 7. 坑

- **这台 Mac mini 是 DPR=1**：CDP 亚像素点击可能落空。源码模式切换约 0.5s 异步，测试必须等待 textarea 出现，不能点完立即查询。
- **安装时务必结束所有旧进程**：`for P in $(pgrep -f 'HorseMD.app/Contents/MacOS/HorseMD'); do kill "$P"; done`。旧进程存活时新启动会被单实例转发给旧版本；安装后用 `lsof -p PID | grep app.asar` 核实。
- 测试残留的 Electron 会占端口：`pkill -f 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'`；probe-session 会自动清理自身端口。
- legacy 校验器有 canonical 时比较 `parse(candidate)` 与 `parse(canonical)`（不是编辑器文档）；canonical 自身无法表达的状态（如段首空格）以 canonical 拼写为准。
- 修改失败的旧断言前**先查 git 历史**：三个“长期失败”的纯函数测试都是有意设计变更后断言未更新。
- `textContent`/`textBetween` 会把 Milkdown hardbreak 算成 `\n`（spec `leafText` 优先于参数）；需要纯文本时拼接文本节点。
- 跨一次发布的状态（EOF 换行数）没有通道传递，Coordinator 只有 `semanticContext`。
- `waitFor(() => evaluate(...) !== null)` 永远为真：`evaluate` 返回 Promise。要 `async () => (await evaluate(...)) !== null`（`test-mode-switch-caret-settle-ui` 的等待从来没生效过）。
- 在运行中的 app 里改 `localStorage['minimd.session.v1']` 没用：app 关闭时把自己的会话写回去。要恢复会话就让 app 自己打开（启动参数：文件 → 标签，文件夹 → 工作区）。
- 状态栏按钮别按 `⌘` 找：阅读模式的 title 也有 `⌘⇧R`，排在源码按钮前面。
