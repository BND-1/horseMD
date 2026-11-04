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
- 跑 UI 回归或 fuzz 时**不要重建 out/**（会让中途启动的实例失败）。

### 2.0 夜间长跑（2026-11-04）

mini 上的 launchd 任务 `com.horsemd.nightly-rich-source` 每天 03:30 运行 `scripts/nightly-rich-source.mjs`：在独立 worktree 里构建**最新提交**（不碰工作区、`out/` 和 /Applications 里的 HorseMD），跑全量格式组合测试、规范语料测试和随机 fuzz（`FUZZ_FORMAT=1 FUZZ_PASTE=1`），种子由日期决定，每晚不同。结果摘要在 `~/Library/Logs/HorseMD-nightly/<日期>.md`，失败的输出和 fuzz 报告在同名文件夹里。安装 / 移除：`scripts/nightly-install.sh` / `scripts/nightly-install.sh --remove`。

### 2.1 不靠随机的系统测试（2026-11-04）

随机 fuzz 只能碰到它的操作表里有的东西（#173「高亮覆盖粗体」就从没被碰到）。另有两个确定性的全覆盖测试，都直接用真实 Crepe 的解析 / 序列化 / 校验 / 源码重排（`__hmSourceReprintHarness`），一分钟左右：

- `npm run test:mark-combinations-ui`：12 种行内格式两两叠加 × 各种重叠形状 × 段落 / 标题 / 列表 / 任务 / 引用 / 表格 × 中文 / 英文 / 中文标点 / 其他空白 / emoji，加图片 / 公式 / 换行、部分取消、随机三重、保存后再改；上下标单独开设置跑。检查：保存后读回一致、源码重排成功且一致、再存一次字节不变。`FULL=1` 跑全部 10 种位置（约 33 万例），`PHASE=pairs|atoms|subsup`、`SEED=`、`CAP=`（记录多少失败）。
- `npm run test:spec-corpus-ui`：CommonMark 0.31.2 全部 652 个规范例子 + GFM 扩展 24 个（`scripts/fixtures/`，CC BY-SA 4.0）：不改时逐字重排；每个文本块头 / 中 / 尾插入或删除一个字后重排成功、一致、改动不出所在顶层块。整篇序列化读不回的只报告不判失败（剩 5 个：自动链接里的反斜杠、跨行行内代码 / HTML 属性里的 `\` 换行、表格行比表头多格）。


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
8. **相邻同类列表**在 Markdown 中会被合并（文字不丢，编号续排）：可考虑第二个列表用 `1)` 分隔符写回。
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
