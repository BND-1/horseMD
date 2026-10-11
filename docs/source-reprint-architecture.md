# 源码重打印架构（Source Reprint）设计

> 状态：R0 设计（2026-10-06 起草，用户已同意方向：“不是补丁式的做法”）。
> 目标版本：R1–R2 期间线上行为不变；R3 起作为主路径。
> 相关：[`rich-source-fuzzing.md`](./rich-source-fuzzing.md)（判据与模糊测试）、
> [`source-rich-consistency-completion-plan.md`](./source-rich-consistency-completion-plan.md)（现有架构历史）。

## 1. 要解决的问题

富文本编辑后，HorseMD 必须写出一份新源码，满足两条不变量：

1. **正确**：`parse(新源码)` 与编辑器当前文档语义一致（重开看到的就是现在看到的）。
2. **保真**：作者没动过的地方，字节完全不变（列表符号、空行、转义、表格填充、引用前缀、换行符、BOM……）。

现有实现（约 3.6 万行）由三层组成，每一层都按“编辑动作”分情况：

| 层 | 做法 | 为什么必然补丁化 |
|---|---|---|
| 事务 owner（约 40 个） | 每个 owner 认一种编辑形状（引用里打字、表格单元格回车……），把 PM 事务链翻译成源码补丁 | 用户操作组合无限；输入法、撤销、插件追加事务会打乱事务链 |
| 事务 journal / 时序 | 按 Coordinator revision 积累事务、局部性 flush | 依赖 DOM 事件与回调时序，每种新时序都是新 bug |
| legacy canonical diff | 对“编辑器标准写法”的前后文本做 diff，再映射回源码 | 标准写法与作者写法不同（`***` vs `---`、表格填充）时锚点错；且校验比对 `parse(canonical)`，canonical 自身错时放行错误候选（0.13.237 段首空格事故） |

模糊测试（`fuzz:rich-source-ui`）每轮都能找到新组合，证明问题不在某个 owner，而在“按动作翻译”这个模型本身。

## 2. 新模型：只看结果，按结构对齐重打印

同步是一个**纯函数**：

```
reprint(source, editorDoc) → source'
```

- 不看事务、不看时序、不需要上一份编辑器文档。
- `srcDoc = parse(source)`：源码**此刻的含义**（用编辑器同一套 parser，结果可按 source 缓存）。
- 比较 `srcDoc` 与 `editorDoc`：差异恰好就是“源码说的”和“屏幕上看到的”之间的差别——也就是需要写回的全部内容。
- 编辑器独有、无 Markdown 编码的差异（末尾空段落、标题 id、fixTables 补齐的空单元格、`colwidth`）在比较时统一按“无编码”规则处理（§5），不需要专门代码。

借鉴 JS 生态成熟的 recast 思路：**未变的子树原样拷贝作者字节；变了的节点保留它自己的“外壳”，只向下递归到真正变化的子节点；新节点按文档作者风格打印。**

### 2.1 三个阶段

1. **对齐（Align）**：解析源码得到带位置的 mdast（remark parse + HorseMD 的 remark 转换插件链，与 Milkdown parser 输入相同）。对 `srcDoc` 的每个块节点，求出它在源码中的字节范围与“外壳”（前缀、标记、围栏、管道）；对每个文本块，求出**可见字符 ↔ 源码偏移**映射（§3）。
2. **比较并重打印（Diff & Reprint）**：从根递归比较 `srcDoc` 与 `editorDoc` 的子节点序列（§4），产出一组不重叠的源码替换 `{from, to, text}`，从后往前应用。
3. **校验（Verify）**：`parse(source')` 必须与 `editorDoc` 等价——**直接比对编辑器文档**，不再比对 canonical；另加块结构签名守卫。失败走降级阶梯（§6）。

## 3. 对齐

### 3.1 块级

`srcDoc` 由 Milkdown parser 从同一棵 mdast 逐节点构建，块级是确定的一一对应：

| mdast | PM | 外壳（frame） |
|---|---|---|
| root | doc | 块之间的间隔（空行数、行尾符）原样保留 |
| paragraph | paragraph | 无；续行受容器前缀约束 |
| heading | heading | ATX `#… ` 前缀 / Setext 下划线行 |
| blockquote | blockquote | 每行 `>` 前缀（含作者的空格习惯、惰性续行） |
| list | bullet_list / ordered_list | 无（由 item 承载） |
| listItem | list_item | 标记（`-`/`*`/`+`/`N.`/`N)`）、标记后空格、续行缩进、任务框 `[ ]`/`[x]` |
| code | code_block | 围栏（字符、长度、info string）或缩进代码 |
| table / tableRow / tableCell | table / table_*_row / table_header·table_cell | 管道、单元格填充、分隔行（对齐） |
| thematicBreak | hr | 整行（叶子） |
| html | html | 整块（叶子） |
| math / yaml | math_block / frontmatter | 整块（叶子） |

对齐用并行遍历 + 类型表校验；任何类型/数量不符即**对齐失败**（不猜），该子树降级为整块重打印（§6）。HorseMD 的 remark 插件（合并行内 HTML、`<br>`→break、行首哨兵剥离、非 ASCII 自动链接展开、CriticMarkup 重建等）在对齐时同样运行，保证对齐对象就是 parser 的真实输入。

### 3.2 文本块内：可见字符 ↔ 源码偏移

对 paragraph/heading/单元格，遍历其 mdast 行内子树（各节点带 `position`），生成映射表：PM 文本块里第 k 个可见字符（文本字符；hardbreak 记为一个占位）对应源码偏移 `raw[k]`，并记录每个字符所在的**行内段**（mdast 行内顶层子节点：text、strong、emphasis、inlineCode、link、image、html、break…）。

文本节点内部的扫描规则（逐字符对 value 与原文）：反斜杠转义 `\*`、实体 `&#x20;`/`&amp;`、U+200B 行首哨兵、软换行后的容器前缀（`> `、列表续行缩进、惰性续行）。这些规则只在一个函数里实现一次，替代现在散落在多处的“可见流”换算。

## 4. 比较与重打印

### 4.1 容器：子序列比较

对一对节点（同类型）的子节点序列做 LCS（判等用 `node.eq`，对“无编码差异”先规范化）：

- **相同**：原样保留源码字节（包括它前后的间隔）。
- **删除**：删掉该子节点的源码范围与一侧间隔（与相邻节点的分隔规则由容器决定，如 doc 用空行、列表项按行）。
- **插入**：按容器的外壳规则生成新子节点源码（§4.4）。
- **同位变化（同类型）**：递归进入，保留外壳，只改内部。
- **同位变化（类型变了，如段落→标题、段落→列表）**：整节点重打印（§4.4），间隔保留。

### 4.2 各容器的外壳规则

- **doc**：块间隔沿用相邻原间隔；新插入块用文档主流间隔（通常一个空行）。
- **blockquote**：子块重打印后每行加上该引用的前缀（取作者首行前缀样式，如 `> ` / `>`）。
- **list / list_item**：新项标记取同列表兄弟项的标记与空格；有序列表序号按作者起始号与“全 1 / 递增”风格；续行缩进 = 内容起始列；任务框沿用。
- **code_block**：围栏与 info 原样；内容整体替换（容器前缀/缩进代码逐行补回）。围栏内若出现等长围栏串则加长围栏。
- **table**：单元格级保留填充，只改单元格内容；新增行/列按作者管道风格生成；分隔行列数变化时补齐对齐标记。不规则表格（作者行少格）由“无编码差异”规则吸收。
- **heading**：前缀/下划线保留，内容走 §4.3。

### 4.3 文本块内：行内补丁

1. 比较旧/新文本块的行内内容，求最小变化窗口（公共前后缀，按“字符+标记集合”比较）。
2. 窗口只涉及纯文本且标记集合不变 → **字符级补丁**：用 §3.2 映射把窗口映射到源码，写入新字符（只按需转义：`*_\`[]<>|` 等在该上下文会被解析的字符；行首空格用 U+200B 哨兵）。
3. 否则 → 扩展到覆盖窗口的**整段行内段**（mdast 行内顶层子节点边界），把新文档对应的行内片段用序列化器 + 作者风格（`*`/`_`、`**`/`__`）打印后替换。
4. 仍失败 → 整个文本块重打印（外壳保留）。

### 4.4 新节点的写法

用 Milkdown serializer 打印该节点，再经 `serializer-style.js`（P7 已有：bullet、序号定界、紧/松、硬换行写法）与 `remark-text-handler.js`（转义）统一成作者风格。容器前缀/缩进由所在容器添加。

## 5. 无编码状态（集中处理，替代零散的 validator 例外）

| 状态 | 处理 |
|---|---|
| 编辑器末尾补的空段落、块间空段落 | 视为无编码；不产生源码 |
| 顶层段落被删空（Typora 一致，0.13.242） | 只删文字，保留该行与前后空行（`A\n\n\n\nB`）；编辑器随后删掉这个空段落时（需 `previousDoc` = 与源码配对的 Coordinator 快照），多余空行收回为一个；向多空行间隙插入块时两侧各一个空行 |
| 标题 `id`、表格 `colwidth`、列表 `spread`/`label` | 比较时忽略 |
| fixTables 为短行补的空单元格 | 视为无编码（作者行保持短） |
| 段首空格 / Tab | U+200B 哨兵 + 原空格（Typora 兼容） |
| 段末空格、单元格首尾空格、单元格末尾换行 | 无编码；比较时忽略 |
| 段落以软换行开头 | 无编码（丢弃该软换行），校验同规则 |
| 软换行后的行首空格、软/硬换行前的空格 | 无编码（丢弃；2+ 空格会把软换行变硬换行），校验同规则 |
| 只有空格的段落 / 标题 / 粗体斜体文本 | 视为空段落 / 空标题 / 无标记空格 |
| 删除后露出的行首空格或块标记 | 走片段打印：零宽哨兵 / 转义（`​ b`、`\\- b`） |
| 在带标记文本（链接）边界继续输入 | 片段扩展到相邻同标记的顶层节点，整体重打印 |
| 粗体/斜体在此处无法开合（`a**] ok**`，用户 2026-10-10 选 A，Typora 一致） | 照写字面 `*`/`_`；仅当去掉粗斜体标记后文档相同、且每个文本块只多出 `*`/`_`（`areSourceDocumentsEquivalentWithLiteralEmphasis`）才接受 |
| 字符补丁校验失败 | 依次 minimal → full → segment（只做片段重打印，重新转义周边字面分隔符） |

这张表就是“哪些差异允许不写回”的唯一定义；比较器、重打印、校验三处共用同一个规范化函数。

## 6. 校验与降级阶梯

每次重打印结果都必须通过：`parse(source') ≡ editorDoc`（§5 规范化后）且块结构签名一致。失败按序降级，每级同样校验：

1. 行内补丁 → 2. 整个文本块重打印 → 3. 最近容器整块重打印（例如整个列表项 / 整张表） → 4. 顶层块用编辑器标准写法 → 5. 暂停并提示（文件不覆盖）。

每次降级都记录到 trace（级别、节点路径、原因），作为后续改进的数据来源，而不是再写新 owner。

## 7. 与现有系统的关系与迁移

| 阶段 | 内容 | 线上行为 |
|---|---|---|
| **R0** | 本设计文档 | 不变 |
| **R1** | 新模块 `src/renderer/src/lib/source-reprint/`：align / diff / reprint / verify，纯函数，依赖注入 parser/serializer/remark。单测（remark + 小 schema）+ Electron 测试钩子（真实 Crepe schema，单会话批量跑用例） | 不变 |
| **R2** | 影子模式：每次发布时同时计算 `reprint()`，记录 {有效?, 与现路径字节是否相同, 谁的改动更小, 降级级别}；模糊测试新增影子判据并汇总统计 | 不变 |
| **R3** | 影子数据证明新路径在有效率与保真上不劣于现路径后，`reprint()` 成为主路径；现有 owner/legacy 降为最后一级之前的备用 | 切换 |
| **R4** | 逐步删除 owner、journal 依赖与 legacy canonical diff；Coordinator 保留（发布/校验/恢复副本流程不变） | 精简 |

不变的部分：Coordinator 的发布、校验、checkpoint、恢复副本流程；保存、自动保存、源码模式切换的入口；raw Markdown 粘贴（剪贴板原字节本身就是作者写法，仍直接发布）。

## 8. 测试策略

- **性质测试（R1）**：对随机文档与随机编辑生成 (source, editorDoc)，断言：① `parse(reprint) ≡ editorDoc`；② 未变子树字节逐字相同；③ `reprint(source, parse(source)) === source`（无改动则字节不变——最重要的保真性质）。
- **真实 schema 批量用例（R1）**：Electron 单会话，测试钩子暴露 `reprint` 与 parser，覆盖 `rich-source-fuzzing.md` §4 的全部已修家族。
- **影子对比（R2）**：模糊测试每个检查点额外记录影子结果；`pause-families`、`goal-matrix` 同步对比。
- **永久回归**：现有 UI 套件全部保留，R3 切换后必须零回退。

## 9. 风险与开放问题

1. **对齐失败面**：remark 插件改写 mdast 形状（行内 HTML 合并、CriticMarkup、数学、脚注/引用式链接定义无对应 PM 节点）。处理：对齐失败即降级，不猜；R1 先统计失败率。
2. **性能**：大文档每次 flush 解析源码 + 比较。对策：`srcDoc` 与对齐结果按源码字符串缓存（只在发布后变化）；顶层先用 `eq` 快速跳过；沿用现有打字让路调度与重文档（>400K 字符）阈值。
3. **作者风格的边界**：混合风格文档（同一文档 `-` 与 `*` 并存）新节点取局部（兄弟）风格优先，其次文档主流风格。
4. **行尾与编码**：CRLF、BOM、文件末尾换行数全部属于 doc 外壳，统一在根节点处理（顺带解决 `rich-source-fuzzing.md` §5 的 EOF 换行问题）。
5. **IME 组合中**：与现状一致，组合期间不发布。

## 10. 进度记录

- 2026-10-06：R0 设计起草。下一步 R1：先实现对齐与“无改动则字节不变”性质，再做容器比较与行内补丁。
- 2026-10-06：**R1 首版完成**。`src/renderer/src/lib/source-reprint/`：`inline-map.js`（文本块可见单元↔源码偏移，含转义/实体/哨兵/容器前缀/无 position 节点的顺序扫描）、`reprint.js`（容器 LCS 比较、外壳保留、字符补丁→行内段→整块的阶梯、代码块围栏保留、任务框切换、列表新项沿用作者标记与序号风格、CRLF/BOM）、`index.js`（`reprintVerified`：最小转义优先，再全转义，校验直接比对编辑器文档）。测试：`npm run test:source-reprint-ui`（真实 Crepe 解析/序列化，单会话 39 例全过，含不规则表格、懒续行、`_em_`、`1)`、setext、链接 URL 拼写、HTML/数学/frontmatter 不动）。
  - 发现：Milkdown/HorseMD 的软换行拆分插件产生**无 position** 的 text/break 节点，故文本块映射以有位置节点锚定、无位置节点顺序扫描；标记 `marker`（`*`/`_`）属拼写，比较时忽略。
  - 测试入口：`--horsemd-input-trace` 下 `globalThis.__hmSourceReprintHarness`（parse/serialize/remark/reprint/equivalent）。
- 2026-10-06：**R2 影子模式接入**。`Editor.jsx` 在每次发布（bridge `setSource`）与每次拒绝（`reportSourceSyncFailure`）时计算 `reprintVerified(上一份源码, 当前文档)`，写入 `__hmSourceReprintShadowTrace`（仅 input trace）；`fuzz-rich-source-ui.mjs` 每步收集，`summary.json` 每个 seed 给出 `{publish, publishVerified, publishSameBytes, failure, failureRescued, maxMs}`。
- 2026-10-06：**首轮影子数据**（14 个 seed，200 步）：当前路径发布 454 次，引擎校验通过 427（94%），与当前字节完全相同 264；当前路径暂停 11 次，**引擎可救 7 次**；单次计算 ≤19ms。引擎自身失败的类型：编辑未回滚导致重叠（5）、`\\` 转义映射、无编码形状（空白粗体 `****`、`<br />` 占位、段落以软换行开头）。均已按通用规则修复：`patchNode` 失败回滚、转义优先于字面匹配、打印前规范化（§5）、`semanticJson` 忽略段落首尾换行。第二轮影子数据见下。
- 2026-10-06：**第二、三轮影子数据**（同 14 个 seed）：第二轮校验通过 452/456（99.1%），暂停可救 9/11；第三轮相同字节 280→380、差异 172→84，校验 464/468，可救 8/10。差异复核后均为引擎更干净（去掉现路径多写的空行/尾随空格/多余转义、保留了现路径丢掉的单元格 `<br>`），修掉的引擎问题都按通用规则处理：
  - 不规则表格：编辑器补的空单元格（含只有占位换行的格）视为无编码，作者短行保持原样；
  - 文本块尾部空白（单元格两端空白）不参与比较——否则每次重打印都会再追加一个空格；
  - 编辑器独有的空段落（Milkdown 末尾段、刚清空的块）不参与容器比较；
  - 任务项空内容写哨兵（RS-50）；标题前缀、任务框后的行首空格写哨兵；行中 `&#x20;`、单元格 `<br>` 后的 `&#x20;` 还原为空格；行尾 `&#x20;` 去掉；
  - 段落以**软换行**开头无编码（比较与打印同一规则）；硬换行仍严格（可用 `<br>` 表达）。
- 2026-10-06：**R3 接入（主路径）**：`Editor.jsx publishReprint` 在 markdownUpdated（focused owners 之前）与 `flushMarkdown`（journal owners 之前）先尝试重打印；校验通过才经 Coordinator `publishOwned`（family `source-reprint`），否则原有 owners/legacy 原样执行，最后才暂停。不接管：新建未命名文档（generated scratch）、待定的列表输入标记意图、raw 粘贴与列表转换进行中。`globalThis.__hmSourceReprintPrimary = false` 可关闭（A/B）。`__hmSourceReprintTrace` 记录 declined/published/rejected。
- 2026-10-06：**R3 收尾规则**（主路径接入后由回归/模糊测试驱动，全部为通用规则）：
  - **降级优先级**：文本块字符映射失败而整块重打印的结果标记 `degraded`，不与既有路径抢先（避免引用式链接被改写成行内链接）；顺序为 精确重打印 → 既有 owners/legacy → 降级重打印（在 `reportSourceSyncFailure` 内、弹提示之前）→ 暂停。
  - **Coordinator 校验直接比对编辑器文档**：`validator.js` 对 `source-reprint` 候选不再比对 `parse(canonical)`（canonical 表达不了单元格末尾 `<br>`、Tab 前导空格时会误拒/误放）。
  - **引用尾随空段**：编辑器在引用末尾的空段落（引用内列表连按两次回车退出）按既有“精确路径”机制处理：引擎计算 `trailingEmptyBlockquotePaths`，自身校验与 Coordinator 证明都用它，validator 按实际文档形状复核。
  - **单元格换行**：单元格内容按“换行分段 + `<br>` 连接”打印，首尾换行都写出；撤回当日早些时候“忽略单元格末尾换行”的比较规则（它会让旧路径丢掉用户的末尾换行，模糊测试 seed 44/45 发现）。
  - **测试分工**：断言“由哪个 focused owner 发布”的 owner 测试（`test-blockquote-transient-trace-regressions-ui`、`test-blockquote-list-exit-backspace-chain-ui`）启动后设 `__hmSourceReprintPrimary = false`，继续锁住备用路径；同样序列在引擎开启下的用户可见结果由 `test:rich-source-pause-families-ui` 锁住。
  - 主路径模糊测试（14 seed）：seed 28/31/36/38 由暂停变为 200 步无暂停；其余多数推进更远；见 `rich-source-fuzzing.md` §5。
- 2026-10-06：**新 seed（46–60）主路径模糊测试发现 3 个 CORRUPT，均按通用规则修复**：
  - **canonical 忠实性闸门**（`validator.js canonicalFaithful`）：旧路径的候选与 `parse(canonical)` 比对，只在 canonical 本身与编辑器文档等价时可信；否则候选必须直接等价于编辑器文档（seed 50：Markdown 无法表达的粗体 `**] ok**`，旧路径曾静默写出字面星号——现在如实暂停）。它取代/包含了较早的块结构守卫。
  - **列表项类型同步**（`lib/list-type-sync.js`，编辑器插件）：跨无序/有序列表删除合并后，后续项仍带 `listType: 'ordered'`（显示为数字），而 Markdown 只能存成全部无序（seed 60）。Milkdown 只转换“首项为有序”的列表，本插件把其余混合项重置为父列表类型，编辑器显示即文件内容。
  - **软换行前的空格无编码**（比较、引擎打印/字符补丁、模糊测试判据三处同一规则；seed 55）：两个以上空格会把软换行变成硬换行。
  - 模糊测试判据与校验器对齐：粗体/斜体边缘空白、换行上的 marks 不计差异。
