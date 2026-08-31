# HorseMD 源码 / 富文本一致性最终收口计划

> 建立日期：2026-08-29
> 当前源码版本：`0.13.169`
> 分支：`fix/rs-41-rich-source-divergence`
> 最终目标：任何成功持久化的 revision 都满足 `parse(committed source) ≈ committed ProseMirror doc`，源码模式、磁盘和冷重开逐字一致；无法证明的事务只能 fail closed，绝不静默写入错误源码。

## 1. 最终完成定义

项目只有同时满足以下条件，才能宣布“源码与富文本不一致 P0 已关闭”：

1. 作者 Markdown 是唯一持久化事实源；ProseMirror 只提供编辑事务和交互状态。
2. 所有用户可达的持久化操作都通过 `SourceSyncCoordinator` 原子发布，不存在直接成功写 source ref、canonical ref、host `onChange` 或磁盘的旁路。
3. 每个 recognized transaction 都只有两种结果：
   - 由唯一 owner 生成 bounded raw patch，并通过 parser、semantic、list-slot、revision 与 provenance 校验后提交；
   - fail closed，作者源码和磁盘保持不变，并提供 warning / recovery 出口。
4. 新 owner 拒绝后，旧 canonical-diff 逻辑不得重新猜测同一已识别 family。
5. 未编辑字节、BOM、LF/CRLF/lone-CR、列表 marker、ordered delimiter、围栏风格、空行和表格 spacing 保持。
6. 源码 textarea、tab mirror、host state、disk bytes 与 fresh-profile reopen 一致。
7. 正式安装包的长会话 first divergence 为零，不允许“先报错后自愈”。

这里的 `≈` 只允许明确登记的 editor-only 等价，例如 GFM 无法编码的表格列宽、光标/选区和经过精确路径证明的瞬时空段；不允许正文、结构、列表槽位、任务状态或持久化语义差异。

## 2. 全程执行规则

每个阶段都必须遵守：

- 不新增基于 delayed canonical 最终形状的专用猜测。
- family 由真实 ProseMirror Step、对应 `stepDoc`、稳定 node path、journal continuity 和 raw range 证明。
- 先写失败优先测试，再接 production owner。
- 正向测试必须覆盖 callback 与立即 save/source-mode forced flush。
- 负向测试必须证明 owner 拒绝后不会被 generic legacy 接管。
- 只有 focused、相邻、全局门禁全部通过后，才可标记 `legacyRetired` 或删除旧 mapper。
- 一个阶段一个清晰本地提交；未成熟下一阶段草稿不得混入。
- 不执行 `git reset --hard`、`git clean`、批量 checkout/restore；不破坏长期 dirty tree。
- 版本只在形成新的可验收产品行为时递增；test-only / docs-only 收口不强制升版。
- 每次本地提交后重跑该阶段最高风险 Electron smoke。

## 3. 阶段总览

| 阶段 | 目标 | 当前状态 | 完成标志 |
| --- | --- | --- | --- |
| A | 收口 `0.13.148` 代码块显式退出与首批 legacy 退役 | **完成：`9dafd76`** | 完整工作树版本通过 focused/global/build，排除未来草稿，形成本地提交 |
| B | 完成剩余代码块生命周期 owner | **进行中：`code_block → paragraph` 已完成，下一项审计 boundary join / product-reachable conversion** | paragraph↔code、boundary join、完整 fence lifecycle 均有 Step owner与双路径持久化 |
| C | 退役 blockquote legacy owners | **完成：`5da0e17`** | text/split/join/exit 的旧 dedicated/generic fallback 均被 no-hit 合同覆盖并窄删除/阻断 |
| D | 退役 table legacy owners | 未开始 | cell、row、column、alignment、width 不再允许旧整表/行级猜测接管 |
| E | 退役 list legacy owners | **暂停扩面：0.13.151–0.13.165 已完成 empty-item/ordered successor Backspace 链 + plain bullet indent/outdent/split/join + task checkbox AttrStep + task end-Enter empty sibling；0.13.166 又按真实人工 trace 收口 blockquote list-exit、nested ordered parent-join 与既有 list-subtree bullet paragraph-join mapper；在 E0 横切阶段完成前，不继续扩展 task/conversion/input-rule family** | list subtree、item text、Enter/Backspace、task、input rule、conversion 分 family退役 |
| E0 | **公共输入事务链收口：generated-scratch / IME / pending-text / empty-transient** | **立即进行：0.13.169 人工 trace 已证明 blockquote nonempty→empty 与 nested bullet IME→Enter 仍穿过新旧架构接缝** | 已迁移 family 在普通文件/新建文档、普通输入/IME、单步/连续结构操作下共用同一 Journal→proof→Coordinator 路径；不再因 serializer whole-document formatting drift 误判未编辑区域 |
| F | 普通段落成为默认 transaction authority | 未开始 | insert/delete/replace/split/join/empty/undo/redo/IME 全覆盖，generic region mapper退出主路径 |
| G | marks、atoms 与特殊入口统一 | 未开始 | inline code、format marks、link/image/math、frontmatter、Slash、paste、generated scratch、whole-doc统一 publication |
| H | 消除所有持久化旁路 | 未开始 | 成功写回只能经 Coordinator；静态审计和 runtime trace 均证明无旁路 |
| I | 长会话与正式安装包资格验收 | 未开始 | clean commit→dist→安装→trace长会话→多轮保存冷重开 first divergence=0 |

## 3.1 阶段 E0：公共输入事务链收口（当前最高优先级）

### 为什么现在必须先做 E0

0.13.169 人工 trace 证明，当前剩余问题不是“引用又坏了一个 case、列表又坏了一个 case”，而是已迁移 owner 仍按理想化单事务输入模型工作，而真实输入流水线会跨 generated scratch、IME composition、pending text 和结构 Step 形成连续事务链。继续直接迁移 task/conversion/input-rule，只会把同一接缝复制到更多 family，因此阶段 E 暂停扩面，先完成这一横切层。

本轮两条必须直接作为架构验收样本，而不是事后补丁：

1. **Blockquote nonempty → empty**：generated-scratch 文档中，第三个引用 paragraph 只有作者字符 `‘`，物理 Backspace 产生非结构 `ReplaceStep(from=80,to=81,sliceSize=0)`，PM 只把该 paragraph 清空；source candidate 正确删除字符后留下作者 quote marker `>`，serializer canonical 却生成 `> <br />`，旧 `blockquote-paragraph` owner 因“next 必须 nonempty”拒绝，随后 whole-document scratch 校验又把上方未编辑列表的 formatting drift 一并卷入失败。
2. **Nested bullet pending text → Enter split**：generated-scratch 文档中，先 Tab 得到空 nested bullet，再用中文 IME 输入“请问富户”，composition 形成多笔普通 `ReplaceStep`，紧接着 Enter 形成最终 `ReplaceStep(structure=true,sliceSize=4,openStart=2,openEnd=2)`。现有 `list-nested-bullet-item-split` owner只接受 `transactionCount===1 && stepCount===1`，因此完整真实 journal 被拒绝并掉回 scratch canonical fallback。

### E0 架构原则

1. **证据捕获与 publication 永久分离**：普通文档、generated scratch、IME composing 都必须捕获 revision-bound Journal；composing 期间不得发布 source，但也不得丢 Step/StepMap/stepDoc。
2. **公共 pending-text chain 合同**：抽取共享 helper，证明“同一稳定 target path 上 0..N 笔 closed plain-text ReplaceStep + 可选唯一 terminal structural Step”。helper只负责事务链连续性、目标 path、attrs/邻居不变、逐 Step replay 与 terminal Step 分界，不负责 family-specific Markdown patch。
3. **family owner 只做 family-specific topology/raw patch**：blockquote、nested bullet、task 等 owner复用公共 chain proof；不得各自重新实现 IME 拼音中间态识别，也不得从 canonical 最终形状猜 operation。
4. **empty transient 统一为 path-scoped + revision-bound 语义上下文**：只允许 proof 明确登记的空 block/list paragraph 在当前 revision 中作为 editor-only transient；形状消失、path失效或 revision推进时自动清除。禁止全局 `ignore empty`。
5. **generated scratch 不是第二套 source authority**：未识别事务仍可使用 scratch compatibility fallback，但任何已经被 migrated family PM proof 识别的事务，必须优先走 focused owner；recognized rejection 继续 fail closed，不能再被 scratch/legacy canonical 猜测接管。
6. **未编辑区域 formatting drift 永远不能决定局部事务成败**：例如作者 bullet `-` 与 serializer `*`、nested list blank-line 差异只能作为 untouched formatting drift；局部 owner验证应依赖 bounded source patch + semantic/list-slot/provenance，而不是要求 whole-document canonical 字节一致。

### E0 实施步骤与落盘状态

- [x] **P0 计划落盘与 trace 定性**：把 0.13.169 两条真实 first-divergence、公共根因、实现顺序和门禁写入本长期计划；阶段 E 在 E0 完成前暂停扩面。
- [x] **P1 公共 transaction-chain helper**：`source-sync/pending-text-transaction-chain.js` 的 `provePendingTextTransactionChain()` 已落地——证明"0..N 笔 closed plain-text ReplaceStep + 可选唯一 terminal Step（须独占 transaction）+ target validator 钩子"，逐 Step replay 校验 stepDoc/afterDoc 连续性，失败返回带前缀 reason；`scripts/test-pending-text-transaction-chain.mjs` 覆盖 IME 多 transaction、replacement、terminal structure、delete-to-empty、terminal 隔离与两类 fail-closed，PASS。首个消费者为 blockquote-paragraph owner（P2）；nested bullet owner 在 P3 接入。
- [x] **P2 Blockquote nonempty→empty 并回已有 paragraph family**：`blockquote-paragraph-text-replace` 分类改用 P1 chain proof；仅当 proof 终态为目标 paragraph 清空时才以 family-scoped `allowEmptyTextblock` 授权 mapper 的 delete-to-empty（`source-transaction-sync.js` 历史保护保持默认 armed），raw patch 只删作者正文 bytes，quote prefix/EOL/BOM/邻段不动；empty transient 只登记在 exact blockquote nodePath（`ignoreTrailingEmptyBlockquoteParagraphPaths`），且分类层先证明"trailing + quote ≥2 children + 前一 sibling 非空"——其余 emptied 拓扑（middle/仅此一段）为 `recognizedRejection` fail closed，未新增宽泛 family。validator 侧 `blockquote-paragraph-emptied` reason 的 proof gate + path 激活与 semanticJson owned-path 规则对齐（接受 text-paragraph previous）。验证：`test:blockquote-paragraph-transaction-owner`（真实 trace 单步 + IME 式多步 delete-to-empty + 全部负例）、`test:source-document-equivalence-transients`（含激活矩阵）、新增 `test:blockquote-paragraph-emptied-ui`（existing file × callback/forced-flush：owner 发布 `blockquote-paragraph-emptied`、BOM/CRLF/`> ` marker 保真、save bytes、fresh-profile cold reopen、零 integrity false/warning）全部 PASS。0.13.169 真实 trace 的 generated-scratch 维度由该 family 既有 `generatedScratchEligible` allowlist（348d51f）覆盖，scratch × emptied 专属场景归入 P6 矩阵。
- [ ] **P3 Nested bullet IME→Enter 并回已有 split family**：先用 P1 将 terminal Enter 前的 pending text原子映射回 source，再由既有 split topology证明最终结构 Step；empty nested baseline没有正文 source-map时，用已证明 parent/相邻物理 list row作为稳定锚点定位唯一 authored empty nested marker，不能伪造 offset。
  - **P3a 已完成（2026-08-31，blockquote 侧）**：`blockquote-paragraph-split` 已拥有「尾段段尾 Enter（空右段）」——`findSplitIndex`/`quoteMatchesPhase` 允许 trailing child 的空右段，结构合同允许 `parentOffset === content.size`（仅 trailing）；raw patch 保留作者 `> ` 分隔行字节，空尾段经 exact nodePath transient（`ignoreTrailingEmptyBlockquoteParagraphPaths`）进入语义比较，validator 侧新增 `blockquote-paragraph-split` + `trailingEmptySplit` proof gate（结构 Step 必须在 stepDetails 中）。验证：`test:blockquote-split-transaction-owner`（段尾 split 正例、生产形态语义桥"必要且充分"断言、pending text+段尾 split 链、非尾段空右/空左负例）、新增 `test:blockquote-split-trailing-ui`（IME composition→立即段尾 Enter，callback/forced-flush、save、cold reopen、零 warning）。空右段仅 trailing 可拥有；中段空右、空左仍 fail closed。
  - **P3b 已完成（2026-08-31，0.13.181，09:47:33 用户 trace 驱动）——pending-text 链 + 终态 Enter split**：trace 完整归因（evidence dump + 逐次 publication 演化）：用户在已存盘大文档的 `- 查询某类…` 项下 Tab 出嵌套 bullet → IME 输入「期看；妙可」→ **Enter 建空嵌套 sibling（FIRST DIVERGENCE 09:47:30.938：journal = 4 笔 IME 文本步 + 终态 `4335-4335 slice=4 open2/2` splitListItem，`nested-bullet-split` owner 因 `transactionCount!==1` 拒绝 → legacy `batched-list-block-changes` 把源里的嵌套空行 `  * ` 删掉、在顶层写出 `- `）** → 后续 IME「蔷薇科」落在错误顶层行 → 退格删完后 33.003 legacy 再插顶层 `* ` → 与 PM doc（嵌套空项 indent2）语义冲突 → 3 次警告 → 35.186 `nested-empty-list-item-removed` 自愈收敛。改造（mirror P3a）：① 分类先重放整条 journal 链——每笔 pre-terminal 步必须是 closed plain-text ReplaceStep 且落在**同一**嵌套 item paragraph（按节点身份推导 5 级 path；`ResolvedPos.index()` 在交替列表嵌套上与 child-index 约定错位，不可用）；终态 split 步（slice=4 open2/2）必须独占其 transaction；② 形状匹配改对 **pre-split doc**（split entry 的 beforeDoc）而非 `journal.oldDoc`——leftText+rightText 必须等于用户实际分割的（可能被 IME 改过的）词，而非原始词；③ 发布：单步形态保持历史「只在边界插入 EOL+indent+marker+spacing」补丁；pending-text 形态改为**整行 body 重写** `leftText + EOL + indent + token + spacing + rightText`（blockquote 家族同型的终态 bounded patch，行 body 先对 oldDoc 段落文本证明锚定）。**关键教训（recognized 边界）**：链重放阶段的一切拒绝（文本落在 foreign 段落、步形状不符、链断裂）必须降为普通 rejected——blockquote 段落的 IME+Enter（slice=2 open1/1）会走同一分支，若标 recognized 会 fail-closed 劫持别人的家族（本轮实事故：`nested-bullet-split-text-outside-target-paragraph` recognized 误报 → `blockquote-split-trailing-ui` 红，降级后复绿）；只有终态 split 已定位且后续 slice/range 证明失败才保持 recognized。验证：`test:list-nested-bullet-split-transaction-owner`（新增 IME 链+终态 split 正例、foreign 文本步负例）、新增 `test:list-nested-bullet-split-pending-chain-ui`（真实 CDP IME composition→立即 Enter，callback/forced-flush、嵌套拓扑、owner 唯一发布、零警告、save 磁盘字节含 `  * ` 嵌套 marker）；join/tail-indent/indent/single-child-outdent/blockquote-split 的 UI+Node、blockquote retirement 负例、scratch 兜底×4、paste-tilde、list-conversion、goal-matrix 42/42 全绿。
  - **P3b(2) 未做（剩余缺口，同 trace 第二形态）**：用户在嵌套空 sibling 里 IME 输入「蔷薇科」时，generic mapper 因 `$from.depth>1 && parent.content.size===0` 拒绝（`nested-empty-textblock-edit`），legacy 把文本发布到顶层 `- ` 行（indent 0）。需要 focused owner 证明「0..N 笔 plain-text ReplaceStep 全落在已证明嵌套 bullet item 的空 paragraph」并把文本写进既有嵌套 marker 行尾。P3b(1) 修复后该形态触发面收窄（源里不再有错误顶层行可落），但独立场景（直接在嵌套空项输入）仍存在。
  - **P3n 已完成（2026-08-31，0.13.182，11:50:57 用户 trace 驱动）——raw paste token 竞态的误报警告**：用户在同一文档上粘贴同一份 2904 字节 Markdown 两次：第一次干净（bind ok → plan ok → publish `source-sync-live-document-stale` → scratch 释放 → canonical 发布），随后切源码看了一眼 → Cmd+S 存盘 → Cmd+A 全选 → Backspace 清空（`whole-document-replacement` 发布）→ 第二次粘贴：bind ok(2 tx) → plan ok → publish stale → **延迟的 markdownUpdated 重试 plan 得到 `raw-markdown-paste-document-unproven`（第二笔 transaction 在 bind 之后移动了 doc，token.expectedDoc ≠ 当前 doc）→ 旧代码在此直接 fail-closed 报警**。归因：多事务粘贴里第一笔事务的回调先发布并推进基线，重试对当前状态必然 stale/unproven——这是**发布顺序竞态**，不是内容分歧（用户"完全不知道怎么触发，打字不触发"正是因为它只在「粘贴→存盘→清空→再粘贴」这种序列出现）。修复：把该站点（plan 失败 + publish 失败两个分支）从「scratch 才释放，已存盘直接报警」统一为**释放 token 并落回正常 preserve 管线**——preserve 管线自身完整校验候选后才提交，能证明映射就发布粘贴内容，不能证明才以精确 reason fail-closed。报警从「token 竞态本身」改为只在 preserve 证实真实分歧时触发。注：本机 headless 合成 ClipboardEvent 无法完全复刻原生 Cmd+V 的多事务时序（合成事件下 canonical 混合欢迎文档字节，属合成产物非用户形态）；修复验证依赖真实粘贴回归（`test:paste-tilde-table-ui` 双 flavor 粘贴零警告内容完整、`test:mixed-rich-source-transaction-ui`、`test:diverged-ordinary-save-ui`、`test:scratch-canonical-fallback-ui`、goal-matrix 42/42）。`test:rs-41-middle-rich-source-ui` 需要外部 `FILE` fixture（含「额法俄法」的大文档），无 fixture 时在基线上同样失败，非本改动回归。
  - **P3o 已完成（2026-08-31，0.13.183，12:15:48 用户 trace 驱动）——新空行 marker 闪烁（`-` ↔ `*`）**：用户观察"手打 `-` 后切源码，一会儿是 `*` 一会儿还是 `-`"。trace 归因（`generated-scratch-canonical` 发布扫描）：在嵌套列表项末尾按 **Enter 退出到新的顶层空行**时（`  * 俄法两年了n` → 新 `* `），`preserveGeneratedBulletMarkers` 的四条继承路径全部不命中：① exact-text 匹配不可能（新行无文本）；② ordinal 匹配要求行数不变（行数 +1）；③ `uninterruptedFromPrevious` 要求前一 sibling 同缩进（前一个是 indent2，新行 indent0）；④ `newlyNestedFromPrevious` 只管变深不管变浅 → 序列化器默认 `*` 落进 source。之后用户在该行输入文本、行数稳定，text/ordinal 匹配又把它翻回 `-`——这就是闪烁。修复：新增第五条**空行变浅继承**——当新 canonical 行仍是空 marker 行（无文本锚）且从更深的 sibling 退出到更浅缩进时，向前找最近的同缩进 canonical 行，按其文本（或位置兜底）在 source 里查该层级的作者拼写并继承（**只读拼写不消费 source 行**——第一版要求 unused 行，被 text 匹配消费后饿死，5 个单测全红后修正）。单测 5/5：trace 原形状/单行 `-`/作者用 `*` 保持 `*`/作者用 `+` 保持 `+`/纯嵌套文档无顶层行时不继承。回归：markdown-source-preservation、scratch-marker-spelling、list-conversion、new-document-list-source、paste-tilde、scratch-canonical-fallback、pending-chain、goal-matrix 42/42 全绿。
  - **P3c 已完成（2026-08-31，top-level paragraph 侧）**：`plain-paragraph` owner factory 新增 `requireTerminalSplit` 变体，派生窄 family `plain-paragraph-terminal-split`（boundary `transaction-plain-paragraph-split`，reason `plain-paragraph-split`）——分类只认领「0..N 笔顶层 plain paragraph 文本 ReplaceStep + 唯一且必须为最后一 Step 的顶层结构 split（from===to）」，raw 映射委托 mapper 既有 `isPlainTopLevelSplit` 分支（作者 EOL 分隔行 + 空槽 hint）；split 产生的顶层空段由 semantic comparator 既有的顶层空段过滤桥接（无需 transient）。已注册进 `structuralTransactionSourceSyncOwners`（`generatedScratchEligible: true`——16:38:54 trace 发生在 scratch；不 retired legacy，纯文本 journal 永不匹配该 family，既有 paragraph 权威路径不受影响）。验证：`test-plain-paragraph-transaction-owner.mjs`（IME 链+terminal split 正例、no-split/mid-chain/double-structural/empty-left 负例）、新增 `test:plain-paragraph-split-trailing-ui`（IME composition→立即段尾 Enter，callback/forced-flush、save、cold reopen、零 warning）。过程教训：registry 条目引用的 owner 声明必须先于 registry（TDZ 只在运行时暴露，vite build 不查——本次由 UI 回归的 mount 失败捕获）。
  - **P3a 后续接缝已收口（同日）——exit 消费已发布 transient**：split family 发布尾空段后，后续 staged exit journal（Enter→发布→再 Enter+输入）的 coalesced 路径原先用通用位置映射器定位插入点：staged 分类器会把尾空段从 `sourceQuote` 裁掉（`withoutTrailingEmptyParagraph`），导致插入落在正文行后、把已发布的裸 `>` marker 行孤立成第二个 quote 块（list_item 子节点 3→4，semantic 拒绝 → recognized fail-closed → sticky warning）。修复：`resolveTrailingTransientQuoteRun` 以「前一非空 sibling 的映射行 + 其后连续裸 marker 行」结构化证明 transient run；exit 将该 run **整段消费替换**为 exit 行（字节与既有期望一致，也避免反复 Enter/exit 累积裸 marker 行）；coalesced 模式下 exit 的空段自身定位同样走结构化证明。`blockquote-exit-transient-row-unproven` 为新 fail-closed reason。
  - **P3d（0.13.171 用户 trace，2026-08-30 17:22:18）——已发布尾空段之上的再 Enter**：scratch 引用 `[p1, p2, '']`（尾空段已由此前 Enter 发布）中，倒数第二段 IME 输入后段尾 Enter → `[p1, p2X, '', '']` 两个连续尾空段。`blockquote-split` 以 `target-count` 拒绝（合同只允许恰好 1 个尾空段）；`exit-pending` 以 `empty-baseline-unmapped` 拒绝（其空基线解析器只认单 child 顶层引用）→ legacy scratch flush 整文档比较失败。归因：**transient 语义桥「恰好 1 个尾空段」的限制与真实连续 Enter 流冲突**。修复方向：owned path 上的 transient 桥折叠**全部**连续尾空段（镜像 list_item 既有的连续空段折叠先例；legacy 布尔开关保持恰好 1），split 分类的 trailing 谓词从「最后一个 child」泛化为「split 之后全部为空段」。
  - **P3e（0.13.171 用户 trace，2026-08-30 17:32:19）——语法进行中的瞬态 + 中间态不可表示**：scratch 引用尾空段（split 已发布）中逐字输入 `1` + `.`（输入法此刻输出 ASCII 句点）→ PM 段落文本恰为 `"1."`。该字节写进 `> ` 行会重解析为 ordered_list ≠ paragraph，任何 bounded patch 在该瞬间语义不成立；下一物理按键必然解决（空格→输入规则转真列表，或继续字符→普通文本）。两层修复：① `blockquote-paragraph` owner 新增 `SYNTAX_PENDING_MARKER_PREFIX`（`^\d{1,9}[.)]$|[-*+]$|…` marker-only 瞬态）→ `deferred + holdJournal`（不 recognized、不警告、保住 journal 给下一事务）；② 该 owner 的发布路径从**逐步 view 演化 mapper** 改为**终态 bounded patch**（映射原文 span——已发布纯文本无歧义——整行替换为最终文本，与 split owner 同型）：中间态不再需要可表示（逐步 mapper 在 `> 1.` 中间态上第 2 步映射必然失败），语法安全由终态语义验证兜底（重解析改变块型/mark 即 fail-closed；`alpha*` 等字面回环文本正确发布）。
  - **P3f（0.13.172 用户 trace，2026-08-30 17:43:19）——list intent 阻塞窗 × 引用内列表退出的尾空段**：scratch 引用内 `1. ` 建有序列表 → 连续 IME 编辑 → 空列表项 Enter 退出：退出 journal 被 `listInputIntent` 的 3 秒阻塞窗吞掉（无 owner 可见），引用尾部新出现的空段无人注册 transient 语义上下文（旧上下文在列表编辑期间被形状检查正确清除）→ legacy scratch 整文档比较失败。尝试过的方向与结论：给 intent 加「item 数减少即清除」carve-out 会**破坏 marker 桥接**（`list-conversion-ui` 等 3 个测试证明退出转换本身由 intent/marker 路径拥有）——已撤回。落地方案：**scratch 校验站点（`generated-scratch-canonical`/`generated-scratch-flush`）按 expectedDoc 形状派生 quote-tail transient 桥**（`shapeDerivedTrailingEmptyBlockquotePaths`，规则与 activation 完全一致：≥2 children、尾空段 run、前邻非空 text/list；scratch 的 source 字节本就是编辑器生成的，形状派生在此不违反 proof-bound 原则；非 scratch 校验仍只认 proof 派生路径）。端到端复现脚本（scratch→引用→IME→Enter→`1.`→列表→IME→Enter×2 退出）零警告零 integrity false。同轮修正：**plain-paragraph-terminal-split 的分隔字节从「空槽双空行」改为「最小分隔」**（作者已有的边界字节不动——旧实现把作者 1 个空行改写成 2 个，破坏下游 list-conversion 字节合同，`list-conversion-ui` 锁定）。
  - **P3g（0.13.173→0.13.174 用户 goal-matrix 轮，2026-08-31）——四维矩阵自测闭环**：按用户要求构建真实输入矩阵（A 写后删 / B 有序+无序+任务列表全生命周期 / C 斜杠全部格式+组合 / D 文档最前逐字删除），42 检查点两轮修复后全绿。本轮修复：① **单段引用清空**不再 recognized fail-closed——legacy `paragraph-emptied` 多年来正确拥有该形状（`>\n>\n`），保持可用（矩阵 A2）；② **list-item 尾空段桥**扩到 `typed-bullet-input-rule`（+fallback）reason 集（矩阵 B2：`1. ` 列表空项 Backspace 退出）；③ **scratch 形状桥扩到 list-item 尾空段**（`shapeDerivedTrailingEmptyListItemPaths`，严格形：恰好 1 尾空段+前邻非空文本段；矩阵 B4：Shift-Tab outdent）。跑器层事实（对后续 UI 自动化重要）：斜杠菜单**必须真实 keydown 输入**（insertText 选不中）；**Mod+Enter** 是代码/数学块退出键（Escape 无效）；表格退出需点击表格下方坐标并验证 selection 已离开；新文档首次输入需轮询落地。
  - **P3h（0.13.174 用户 trace，2026-08-31 03:46:16/03:46:40）——scratch 连续空列表项的整文档比较误报**：真实序列（有序两项→Enter→Tab 嵌套填充×2→ArrowUp→逐字删 item2 至空→结构性删除）后，`empty-list-item-removed`（editor-api-flush）与 `generated-scratch-canonical` 校验失败，diff 全部为「多出一行空列表 item」（且 `listSlotsMatch:true`——非空结构完全等价）。三次按键级复现（含真实 IME）未重现警告，判定为时序敏感的 legacy 局部 patch 精度问题（stale 空 row 残留）。修复：**scratch 校验站点对称归一**——`collapseEmptyListItemRuns` 在比较前把两侧连续空列表项折叠为一个（仅 `generated-scratch-canonical/flush` 两个 reason；scratch source 本就是编辑器重建的，stale 空 row 下一次全量 canonical 发布自愈；非 scratch 校验逐字节不变）。验证：用户序列重放零警告、goal-matrix 42/42、blockquote/list/IME/fidelity 回归全绿。遗留：legacy `empty-list-item-removed` 的 raw patch 为何留下 stale 空 row 未定位（按键级复现失败，时序敏感）——若再次触发，evidence dump 现已包含 candidate/canonical 尾部文本以便直接归因。
  - **P3i（0.13.175 用户 trace，2026-08-31 04:03:17）——exit family 对引用内嵌套列表退出的过度认领**：用户在引用的有序列表末项下 Tab 出嵌套子列表、输入后 Enter Enter 退出空嵌套项。journal 的 doc 形状匹配 `blockquote-exit` 的 list-exit-pending 分类（quote +1 尾空段、直接子列表 -1 项），但其 raw 行解析器（`resolveQuoteListTailRows`）只会映射引用**直接**子列表的 `> N. text` 行——嵌套列表内的位置 unmapped → `recognizedRejection('blockquote-list-exit-pending-range-unmapped')` → 阻断 legacy → 警告。而同 dump 证据显示 legacy 对该状态的候选校验 ok。修复语义校准：**range-unmapped（无法定位=无法证明所有权）从 recognized 降为普通拒绝**，放行给 legacy 发布+全文档校验兜底；行内容已定位但背离的两类拒绝（`previous-row-unproven`/`authored-row-unproven`）保持 recognized fail-closed。验证：新增 `test:blockquote-nested-list-exit-ui`（引用嵌套子列表输入+Enter Enter 零警告零 integrity 失败）、exit/list-exit owner+UI、goal-matrix 42/42、IME/mixed/fidelity 全绿。0.13.173 加入的 evidence dump candidate/canonical 尾文本在本轮归因中直接命中根因。
  - **P3j（0.13.176 用户 trace，2026-08-31 04:32:11）——scratch 结构性兜底（本轮架构性收口）**：用户在列表嵌套文档中逐字删除 + 结构性删除空项后 flush，`empty-list-item-removed`（editor-api-flush，scratch 分支的 proven-transient 信任清单内的局部映射结果）校验失败 → 警告。复盘 0.13.169 以来全部用户触发（17:22/17:32/17:43/03:46/04:03/04:32）：**全部发生在 generated scratch（未存盘）文档，且全部来自 legacy 局部映射/校验层，而非 focused owner 发布路径**。结构性修复：scratch 文档没有作者字节需要保护（source 本就是编辑器派生），在任何发布失败点（editor-api flush 发布失败、markdownUpdated 的 primary-preserved/post-fallback 失败、unmapped preserve、publishPrepared 失败、retired-structural 拒绝）**用序列化 canonical 兜底重试一次（仍走完整 Coordinator 校验）**，成功则继续同步并记录 `scratch-canonical-fallback` 事件，失败才警告。已存盘文件严格保持 fail-closed 警告不变（retirement-ui 等既有回归锁定）。代价：scratch 中兜底触发时 marker 拼写可能翻成 serializer 风格（`-`→`*`）——仅未存盘 buffer 的外观差异，非损坏。验证：新增 `test:scratch-canonical-fallback-ui`（字符删除+结构删除+切源 flush 零警告内容完整）、22 项回归 + goal-matrix 42/42 全绿。
  - **P3k（0.13.177 用户 trace，2026-08-31 04:46:23）——兜底候选拼写错误**：P3j 的 editor-api flush 兜底用了 `getGeneratedScratchMarkdown(canonical)`（marker 保留变换），其产物在「引用内列表嵌套删除」场景携带多余 `>` 分隔行、与 PM doc 不等价 → 兜底本身校验失败 → 仍警告。修复：**兜底直接使用原样 canonical**（当前文档的序列化，是唯一保证能解析回自身的拼写；marker 外观差异已由 P3j 声明接受）。验证：新增 `test:scratch-quote-nested-flush-ui`（引用×有序×嵌套×字符删除×结构删除×切源 flush 零警告、引用/列表内容完整）、19 项 UI + 10 项 Node + goal-matrix 42/42 全绿。
  - **P3l（0.13.179，用户确认的互操作需求）——scratch 兜底的 marker 拼写保留**：用户要求未存盘文档也保持输入的 `-`/`+`（与 Typora/Obsidian 等工具互操作，marker 拼写差异会造成全文 diff）。实现为**两层顺序**：scratch 兜底先构造 marker 保留候选（`preserveGeneratedBulletMarkers(lastSource, canonical)`，复用既有按文本匹配+新行继承的实现），过完整 Coordinator 校验后发布；校验不过才落到原样 canonical（保真底线）。三个兜底构造点（editor-api flush、markdownUpdated 的 scratchCanonicalCandidate、retired-structural 分支）统一接入。验证：新增 `test:scratch-marker-spelling-ui`（scratch 输入 `-` 列表→删除项→切源 flush，断言 source 保留 `-` 且无 `*` 重写、零警告）。注：续行项的 `\-` 是 remark 对行首字面 `-` 的标准转义（防重解析成列表），渲染回 `-`，属正常回环。
  - **P3m（0.13.179 用户 trace，2026-08-31 06:53）——raw Markdown 粘贴的发布竞态 + 相邻文本节点拆分**：用户粘贴含孤立 `~`（`45~60`）与紧凑表格的 Markdown 到 scratch 文档。三层问题：① 语义比较器未合并相邻同 mark 的 text 节点——PM 在 `~` 边界拆分 text run 而粘贴解析不拆（12 vs 14 内联节点）→ 同一可见文本被误判不等（`semanticJson` 现在比较前合并相邻同 mark 文本串，附四组单测：基本合并/同 mark 合并/异 mark 不合并/文本内容仍严格）；② 两笔事务的粘贴中第一笔的回调先发布并前移基线，raw-paste token 的重试 plan/publish 对当前状态必然 stale（`document-unproven`/`snapshot-stale`）→ 在 scratch 下**释放 token 落回正常发布管线**（内容已被校验发布，纯竞态误报不再警告；已存盘文件保持严格警告）；③ 序列化器对孤立 `~` 输出 `~~`（防重解析成删除线的标准转义，与 `\-` 同类，渲染回 `~`，校验通过即回环证明）。验证：新增 `test:paste-tilde-table-ui`（text/markdown 双 flavor 粘贴含 `~`+表格 → 零警告、内容完整、转义回环）；18 项 UI + Node 全量 + goal-matrix 42/42 全绿。注：`raw-markdown-paste` owner 对 `-`→`*` marker 的既有失败（rs-41）是 owner 认领层另一问题，仍在此前记录的既有失败清单中。
  - **既有失败清单（与 E0 工作无关，独立 worktree 在 348d51f 干净基线上复验一致）**：`test:rs-41-source-sync` UI 的 raw Markdown paste（`-`→`*`）；`test:list-item-literal-marker-source-ui`（10 连击 marker 输入后首次切源 textarea 不出现，单 marker 场景正常）。P8 门禁前需单独归因。
  - **已知产品限制（非 source-sync，零警告）**：斜杠菜单在列表项内不打开（Milkdown SlashProvider 沿袭门控；`shouldShow` 的 `isInList` 移除无效——按键到达编辑器但 provider 不显示，更深层还有一道闸）。列表内嵌引用可经源码模式 marker 作者化。UI 层后续单独归因。
- [ ] **P4 scratch authority allowlist按 proof 扩展**：只有 P2/P3 已通过完整正负合同后，才给对应 owner增加 generated-scratch publication资格；不批量给 list/table/code owners打开 scratch authority。
- [ ] **P5 empty-transient semantic context泛化并收紧**：把 blockquote/list 的 transient path表达统一到 snapshot/validator 可验证结构；旧 reason 继续兼容，但所有新 path都必须由 transaction proof 推导，错误 path/伪 proof/过期 revision fail closed。
- [ ] **P6 真实 Electron 四维矩阵**：至少覆盖 `existing file / generated scratch × plain input / Chinese IME × single-step / rapid structural follow-up`。本轮硬性样本包括：引用最后字符 Backspace→空；引用 IME→立即 Enter；空 nested bullet→IME fill→立即 Enter；已有 nested bullet正文→IME replacement→立即 Enter；每场都验证 source textarea、save、disk、fresh-profile cold reopen、零 integrity false / warning。
- [ ] **P7 相邻 family 泛化回归**：blockquote split/join/exit、nested bullet indent/outdent/split/join、task checkbox/empty sibling、ordered successor链、generated-scratch RS-49/56/58/60、forced-flush isolation 全部重跑；recognized retirement负例必须仍阻断 broad legacy。
- [ ] **P8 全局门禁与版本候选**：`source-transaction-sync`、Journal、Coordinator、Markdown preservation、source-fidelity probes 39/39、mixed/heterogeneous fidelity、desktop/mobile build、`git diff --check`。只有全部通过才 bump 下一可验收版本并启动独立 trace 实例。
- [ ] **P9 人工长会话验收后更新本计划**：用户真实乱测至少覆盖引用、nested bullet、task和模式切换；如仍触发，先记录新的 first-divergence 是否违反 P1/P5 公共合同，再决定修公共层还是新 family，禁止直接追加字符串/时序特例。

**E0 期间核实的基线事实（2026-08-31）**：`test:rs-41-source-sync` 的 UI 部分（`test-rs-41-source-sync-ui.mjs` 的 `testRawMarkdownPasteOwnership`，raw Markdown paste `-` marker 被写成 `*`、走 legacy `list-line-change` 且弹暂停 toast）在**干净 checkout 的 348d51f 基线**上同样失败（独立 worktree 验证，两次输出一致）。该失败先于 E0 工作存在，与 blockquote-paragraph emptied 改动无关；P8 门禁重跑 rs-41 前需要先单独归因修复。

**0.13.170 人工测试两条新 first-divergence（2026-08-30 16:38/16:39，generated scratch，均 fail-closed 未写坏 source）**：

1. **16:38:54**：slash 菜单插入块后 IME 输入「快去我家拿看了你」（composition 约 8 笔 ReplaceStep，逐字 99→115）→ 空格选字（compositionend，`ReplaceStep 99-115 slice=8`）→ **113ms 后立即 Enter**（`ReplaceStep 107-107 structure=true slice=2`，top-level paragraph split）。focused owners 以 `blockquote-*-anchored-target-count` / `node-type-changed` 拒绝（目标不是 blockquote 子树）；`mapPlainTextTransactionsToSource` 的 top-level split 分支被 `__hmTransactionSourcePrimary` 测试门禁挡住 → legacy scratch flush 整文档比较失败。归因：**top-level paragraph 的 pending-text + split 没有任何 focused owner**（P3 的 blockquote/list 之外第三处同型缺口）。
2. **16:39:14**：引用内 IME（wearilh→wearily 类）→ Backspace 删一字 → **段尾 Enter**（journal = 文本链 + delete + `structure=true` 段尾 split，产生空尾段）。`blockquote-split` owner 因 `findSplitIndex`/`quoteMatchesPhase` 的 `isSimpleParagraph(nonEmpty)` 拒绝**空右段**（`target-count`）→ legacy `paragraph-emptied`/scratch flush 发表 `>\n>\n` 这类不可往返编码 → 后续 flush 整文档比较在尾空段上失败（`$.content[N].content` 1↔2）。归因：**P3（pending chain + terminal structural split）与 P5（尾空段 transient path）在 split family 的缺口**。
   同场证据：P2 owner 已在 scratch 真实管线成功接管引用内 IME 替换（`wearilh→wearily`，`blockquote-paragraph-text-change` 由 transaction owner 发布）——P1/P2 机制对真实 IME 输入有效。

### E0 完成标志

只有同时满足以下条件才允许回到阶段 E 的 task/conversion/input-rule 扩面：

- generated scratch 与 IME 不再是 Journal 捕获或 focused owner 调度的旁路；
- 已迁移 blockquote / nested bullet owner可以消费“pending text chain + terminal structure”的真实 journal，而不是要求理想化单 transaction；
- nonempty→empty 等不可直接由 serializer稳定编码的状态由 exact transaction path semantic context处理，不泄漏 `<br />` 到作者 source；
- 前文列表 marker/空行等 formatting drift不再导致局部引用/list transaction误报；
- 本节 P0–P9 全部打勾，门禁和独立安装/trace人工验收均通过。

### E0 复盘（2026-08-31 收官，0.13.169 → 0.13.184，提交 f117a33 + dcb6ddc）

用户真实乱测驱动的 E0 主线已完成（P1、P2、P3a/b/c、P3d–P3o 全落盘）。复盘提炼出的可复用教训：

**架构层面（哪些做法被证明是对的）**

1. **journal-first 归因闭环**：每次用户说"触发"，第一动作永远是拉 `$TMPDIR/horsemd-input-trace-<pid>.jsonl` 的 evidence dump（journal 步链 + coordinator 发布序列 + integrity candidate/canonical 尾文本），先定位 FIRST DIVERGENCE 再动代码。本轮 16 轮触发全部靠这个闭环一次归因，零盲改。
2. **警告分层经受住了考验**：已存盘文件严格 fail-closed（作者字节受保护）+ scratch canonical 兜底（无作者字节可保护）的双层契约没有再制造误报，也没有漏掉真实错误。P3j 的"兜底必过完整校验"是关键——兜底不是逃生门，是第二证明路径。
3. **pending-text chain 合同收敛了 IME 复杂度**：把"0..N 笔文本步 + 唯一终态结构步"抽成公共合同后，三个 split family（blockquote/顶层段落/嵌套列表）各自只写 topology 和 patch，不再各自猜 IME。新增 family 的边际成本从"重写识别逻辑"降到"写形状匹配"。

**踩坑记录（以后不要再犯）**

1. **recognized 边界要精确到"证明进行到哪一步"**：P3b 实事故——链重放阶段的拒绝标了 `recognized`（fail-closed），结果 blockquote 段落的 IME+Enter（不同 slice 形状）走同一分支被劫持，别的家族绿测变红。规则：**只有"终态结构步已定位且属于本家族"之后的拒绝才 recognized**；之前的拒绝说明"不是我的形状"，必须落回 legacy。
2. **形状匹配要对准正确的文档快照**：pending-text 链存在时，`journal.oldDoc` 是链前快照，而 left/right 文本描述的是链后（split 前）的词。对着 oldDoc 匹配必然 candidateCount=0。规则：**形状匹配对 pre-split doc（终态步所在 entry 的 beforeDoc）**。
3. **PM `ResolvedPos.index(depth)` 在交替嵌套上与 child-path 约定错位**：`index(d)` 数的是 depth d 节点**内部**的孩子索引，不是 node(d) 在 node(d-1) 里的索引。列表这种 doc>list>item>list>item>para 交替结构要按节点身份遍历推导 path，不能直接用 index()。
4. **单测先行暴露继承饿死**：P3o 第一版要求"unused source 行"，被 text 匹配消费后饿死，5 个单测全红后改成"只读拼写不消费行"。marker 继承类修复必须覆盖：目标形状 + 紧/松分隔 + 三种拼写（`-`/`*`/`+`）各保持 + 无父列表不继承 + 上一修复不回归。
5. **死分支要靠真实 trace 发现**：P3p 的 Tab 继承分支要求"恰好一个换行"分隔，但嵌套空行必须带结构性空行（RS-64），分支对目标形状永远不可达——单测如果只测紧分隔永远发现不了。**写继承/分隔类逻辑时，先从真实 trace 抄 serializer 的实际输出形状**。
6. **合成 ClipboardEvent/insertText 不能完全复刻原生输入**：粘贴竞态（P3n）和输入规则（E2E harness 打不出 `-`+空格）在 headless 下时序不同。回归要靠"真实 CDP keydown/imeSetComposition"型测试（库里已有 human-input 模式），合成事件只能做内容级验证。

**遗留（不阻塞，已记录）**

- P3b(2)：直接在嵌套空项输入文字的 focused owner（generic mapper 因 depth>1 空文本块拒绝；P3b(1) 后触发面已收窄）。
- 既有失败清单：`test:rs-41-source-sync` UI raw paste 的 `-`→`*`（owner 认领层）、`test:list-item-literal-marker-source-ui`（10 连击 marker）。P8 门禁前单独归因。
- 已知产品限制：斜杠菜单在列表项内不打开（SlashProvider 深层门控，UI 层）。
- 用户实测残留的 `*` 存量字节：旧版本写入磁盘的拼写，新版不再产生新的；需要用户在源码模式手动统一。

## 4. 阶段 A：0.13.148 可复现检查点

### 范围

- `code-block-exit` 产品命令、pending/coalesced/staged owner 与 provenance。
- `code-block-content-replace`、`code-block-info-string-change`、`empty-code-block-backspace-unpack`、`code-block-exit` 的 legacy 退役。
- `legacyRetired + recognized` 阻断 generic fallback。
- dedicated `preserveFencedCodeBlockTextChange()` 删除。

### 必须排除

以下属于阶段 B 草稿，不进入本阶段提交：

- `paragraph → code_block`；
- 非空 `code_block → paragraph`；
- code block / paragraph boundary join；
- `fenced-code-source-range.js` 草稿；
-对应 diagnostic/UI 草稿；
- 历史 `tmp-repro-rs44/73/76` 文件。

### 门禁

```text
test:code-block-legacy-owner-retirement
test:code-block-legacy-owner-retirement-ui
test:code-block-transaction-owner
test:code-block-info-transaction-owner
test:empty-code-block-unpack-transaction-owner
test:code-block-exit-transaction-owner
test:code-block-info-transaction-ui
test:empty-code-block-unpack-transaction-ui
test:code-block-exit-transaction-ui
test:code-block-exit-staged-ui
test:code-block-exit-forced-flush-ui
test:middle-codeblock-source-ui
test:source-sync-transaction-journal
test:source-sync-coordinator
test:source-transaction-sync
test:editor-api-transaction-flush
test:markdown-preservation
test:source-fidelity-probes
test:source-fidelity-ui
test:mixed-rich-source-transaction-ui
test:tail-fence-ui
build
build:mobile
```

### 完成标志

- 三处版本均为 `0.13.148`。
- 上述矩阵 exit 0。
- staged 集合只含本阶段文件。
- 本地提交后重跑 retirement UI、exit 三条 UI、middle-code、39/39 probes。

### 实际完成记录（2026-08-29）

- 本地提交：`9dafd76 refactor(editor): finish code block source authority`。
- 提交范围：43 个文件，包含 `code-block-exit` 产品入口、owner、provenance、四项代码块 family 的 legacy 退役、负向 fence-collision 回归、版本文档和本路线图。
- 提交前 focused 矩阵全部 exit 0：legacy retirement 静态/真实负例、code content、info、empty unpack、exit callback/staged/forced、middle-code source/save/cold-reopen。
- 提交前 global 矩阵全部 exit 0：Journal、Coordinator、source mapper、flush policy、完整 preservation、39/39 probes、异构 fidelity、mixed immediate switch、tail-fence 两档、desktop build、mobile build。
- post-commit smoke 全部 exit 0：retirement UI、exit callback/staged/forced、middle-code、39/39 probes。
- 提交后 tracked/staged/unstaged 均为空；工作树只保留明确排除的阶段 B 草稿和历史 RS-44/73/76 临时复现文件。
- 本阶段没有打包、安装、推送或发布；正式安装包资格验收仍属于阶段 I。

## 5. 阶段 B：剩余代码块生命周期

依次独立完成：

1. `paragraph → code_block`：真实转换 Step、作者段落唯一 raw range、fence选择与 collision拒绝。
2. 非空 `code_block → paragraph`：完整 opening/content/closing range原子替换，不允许只删一侧 fence。
3. code block / paragraph boundary join：Backspace/Delete真实边界 Step、两侧节点与邻块不变。
4. fence 创建、删除、拆分、合并和围栏字符/长度变化；不能从 canonical fence行猜操作。
5. nested、跨 block selection 和多节点批次。

每个 family 通过后立即做 legacy no-hit/negative fallback测试，不等到全部生命周期完成再统一退役。

### `code_block → paragraph` 实际完成记录（0.13.150）

- 产品入口：真实 HorseMD 右键“转换为正文”通过被点击 CodeMirror NodeView identity 唯一映射目标 PM `code_block`；wrapper 的 end-boundary `posAtDOM` 不再决定归属。
- 事务：`setNodeMarkup(...paragraph)` 的 `ReplaceAroundStep(structure=true)` 与随后快速 paragraph `ReplaceStep` 由同一本 revision-bound journal 拥有；其它块、marks、atom、多行/空代码块保持不认领或 fail closed。
- raw patch：只把作者完整 opening/content/closing fenced range 原子替换为最终 paragraph，保留作者 BOM、LF/CRLF、fence 之外邻块与未编辑字节。
- legacy retirement：生产 registry 的 `code-block-paragraph` 设置 `legacyRetired:true`；family 已识别后的 range/content/language/semantic失败 `recognized:true`，禁止 generic fallback。
- 永久回归：共享 NodeView identity 的 identity/end-boundary/strict-interior/empty 合同；focused owner 正反合同；legacy no-hit；真实 Electron callback、forced-flush、源码、保存、磁盘、fresh-profile reopen；`# heading` semantic rejection证明 warning + source/disk不变且无 publication。
- focused gate、production build 与真实三场 Electron、相邻/全局门禁均已在 2026-08-29 通过；本地提交 `0614893 refactor(editor): journal-own code block paragraph conversion` 已形成，后续代码块 boundary join / product-reachable conversion 草稿继续保持未提交隔离。

## 6. 阶段 C：Blockquote legacy 退役

覆盖：

- `blockquote-paragraph-text-replace`；
- `blockquote-paragraph-split`；
- `blockquote-paragraph-join`；
- `blockquote-paragraph-exit`；
- pending/staged transient。

重点负例：重复引用正文、列表项内引用、多引用同批变化、空引用、marks、错误 quote prefix、source range歧义。recognized rejection必须阻断 `paragraph-emptied`、`middle-block-*`、quote line generic mapper。

### 实际完成记录（2026-08-29）

- 本地提交：`5da0e17 refactor(editor): retire blockquote legacy owners`；19文件白名单，未来代码块生命周期与历史repro草稿均未进入提交。
- `blockquote-paragraph`、`blockquote-split`、`blockquote-join`、`blockquote-exit` 四个生产 registry entry 均设置 `legacyRetired:true`。
- 四个 owner 明确区分 recognition：PM path/Step/stepDoc/replay 尚未证明 family 时为 `recognized:false`；family 已证明后，source range、作者 prefix/separator、正文一致性、syntax-sensitive或semantic失败为 `recognized:true`，统一阻断 generic fallback。
- 新增纯退役合同，静态证明 focused reason 不存在于 canonical-diff 模块，并锁定 `recognized + legacyRetired` 控制流；四个原 owner 正反合同同步覆盖 recognition 边界。
- 新增真实 Electron 负例：引用正文末尾物理输入 `*` 后，trace 为 `syntax-sensitive-insert / recognized:true / legacyBlocked:true`；富文本编辑保留、显示警告、无legacy/Coordinator publication、源码模式不展示陈旧内容、磁盘逐字不变。
- 四项正向 callback/forced/source/save/disk/fresh-profile reopen 全绿；空引用删除、空引用IME、generated scratch尾随空段和文档中间尾随空段兼容矩阵全绿。
- 共享 Journal、Coordinator、transaction sync、forced flush、完整 preservation、39/39 probes、异构 fidelity、mixed rich/source、desktop build与mobile build全部 exit 0。
- post-commit smoke再次通过退役纯合同、真实fail-closed负例、四项正向Electron和39/39 probes。
- 本阶段未打包、安装、推送或发布；完成后返回阶段 B，下一项为非空 `code_block → paragraph`。`paragraph → code_block` 右键草稿因当前产品 `BLOCK_TYPES` 无 code入口，仍不计入完成范围。

## 7. 阶段 D：Table legacy 退役

覆盖：

- 单 cell正文；
- body row insert/delete；
- simple-grid column insert/delete；
- alignment；
- PM-only colwidth。

必须证明新 owner拒绝后不会回落为 whole-table、table-line或table-region重写。span/merge/split因GFM不可表达，保持明确 fail closed或产品级禁用，不伪造Markdown持久化。

## 8. 阶段 E：List legacy 退役

这是风险最高的阶段，按以下顺序拆分：

1. list item plain paragraph正文。
2. 单一 list subtree结构变化。
3. 空项 Enter退出、Backspace lift、successor补位。
4. nested list split/join/indent/outdent。
5. task list与空task sentinel。
6. bullet/ordered/task conversion。
7. `- `、`1. ` 等 input rules和pending intent。
8. 跨列表选区、多 transaction coalescing、generated scratch。

每一类必须有真实 physical-key Electron negative case，证明旧 broad list mapper不能在 recognized rejection后接管。

### List empty-item Backspace 第一子族实际完成记录（0.13.151）

- 范围刻意只覆盖顶层普通 bullet/ordered list 的 **interior empty item**：目标 item 必须前后都有 sibling、非 task、仅含一个空 paragraph；首项、尾项、nested、task、ordered lift、多 transaction/coalesced 继续交给后续子族或既有兼容 owner。
- 真实 PM Step 已由 Electron 固化：前一 item `[16,23)`、空 item `[23,27)` 时，Backspace 为唯一 `ReplaceStep from=22,to=24,structure=true,sliceSize=0`。owner 要求 `from === previousItemEnd - 1` 且 `to === emptyItem.contentStart`，并逐 Step apply 后必须等于 live expectedDoc；不是根据 canonical 中 `<br />` 消失形状猜 family。
- raw source ownership：PM source-map 锁定唯一顶层 list，source 与 previous canonical 的同级 marker row 数必须等于 old PM item 数；目标作者 row 必须真为空、前后 row 同类且物理连续。成功时仅删除该 marker row + 自身 EOL，作者 BOM、LF/CRLF、marker/delimiter、邻块和未编辑字节逐字保留。
- semantic transient：Backspace 后 PM 会在前一 item 尾部多一个 Markdown 无法编码的空 paragraph。validator 只接受 exact `transaction-list-empty-item-remove-proof`、单 step、精确 removed/listItem/paragraph paths 后忽略这一处；伪 proof、错 path、错 step 继续 fail closed。
- legacy retirement：生产 registry 把 `list-empty-item-remove` 放在 broad `list-subtree` 之前并设置 `legacyRetired:true`。PM family 尚未证明时 `recognized:false`，不会抢其它 list family；family 已证明后 source row/range/body/spacing 不满足则 `recognized:true + legacyBlocked:true`，禁止旧 `empty-list-item-removed` 或 broad canonical fallback“救回来”。
- 失败优先真实证据：迁移前同一 Backspace 已被 `list-subtree` 认领，但候选错误写入 `<br />`，产生 `semanticOk=false` 后再由 legacy `empty-list-item-removed` 自愈；迁移后同一场景只有一次 focused transaction publication，整个周期零 integrity false。
- 永久门禁：focused owner 正反合同；Enter→Backspace callback/forced；初始 BOM+CRLF 空项 callback/forced 的源码、保存、磁盘、fresh-profile reopen；loose-list `recognized + legacyBlocked` 负例；ordered lift、RS-72、cross-list、nested、generated scratch、task、rapid double Enter、generic list-subtree、mixed rich/source、完整 preservation、39/39 probes、异构 source-fidelity均通过。
- 下一 List 子族仍按风险拆分：空项首/尾边界、ordered successor/lift 的更窄 owner，随后 nested、task sentinel、conversion/input-rule、跨列表 coalescing；不得因为 0.13.151 完成一个子族就把全部 `empty-list-item-removed` legacy mapper删除。

### List empty-item Backspace 第二子族实际完成记录（0.13.152）

- 范围只覆盖顶层普通 bullet/ordered list 的 **tail empty item**，且 preceding item 必须只有一个非空 plain paragraph；task、nested preceding structure、first-empty、interior、ordered lift、多 transaction均保持不认领。
- 真实 Electron 证据：`- left / - ` 的 Backspace 为唯一 `ReplaceStep from=16,to=18,structure=true,sliceSize=0`；owner要求 removed item紧邻 preceding item，`from === precedingEnd - 1`、`to === removed.contentStart`，并在捕获 stepDoc 上完整重放到 expectedDoc。
- 成功后 PM 前一 item多一个无法安全编码的 trailing empty paragraph；validator 只依据 `transaction-list-empty-item-tail-remove-proof` 的 exact removed/listItem/paragraph path和单 Step journal忽略这一处 transient。
- raw patch只删除作者最后一个空 marker row和其 EOL，保留列表后 block gap、BOM、LF/CRLF、marker/delimiter与未编辑字节。loose tail row在 PM family已识别后返回 `recognized:true + legacyBlocked:true`，warning且source/disk不变。
- 相邻门禁发现初版会抢 RS-63 nested continuation；发布前已收窄为 old preceding item `childCount===1` 且唯一 child为非空 paragraph，新态恰为该 paragraph + 一个空 paragraph。RS-63恢复 `empty-list-item-merged-after-nested-list`，task/cross-list/rapid Enter/nested Enter均保持原 owner。
- callback与立即源码 forced-flush、BOM+CRLF、source/save/disk/fresh-profile reopen、纯正反合同、loose-tail负例、0.13.151 interior、first-empty控制、isolated ordered lift、RS-72、generic list-subtree、完整 preservation、39/39 probes、mixed rich/source和异构 fidelity均通过。
- 下一独立 family 是 **first-empty Backspace**：真实 Step 已确认是 `ReplaceAroundStep from=8,to=13,structure=true,sliceSize=1`，拓扑为 `[empty,right]` 列表变成“列表前一个顶层 editor-only 空 paragraph + `[right]` 列表”；必须独立证明，不复用 tail 的 trailing-paragraph semantic path。

### List empty-item Backspace 第三子族实际完成记录（0.13.153）

- 范围只覆盖顶层 **plain bullet** first-empty：old list 第一 item 只能是非 task 空 paragraph，第二 item 必须是非 task、单一非空 paragraph；ordered first-empty、task、tail/interior、多 transaction继续不认领。
- 真实 ProseMirror `joinBackward` 形成唯一 `ReplaceAroundStep from=8,to=13,gapFrom=10,gapTo=12,insert=0,structure=true`，slice 是空 `bullet_list` wrapper，`size=1/openStart=0/openEnd=1`。owner精确绑定 old list `[i]`、first item `[i,0]`、first paragraph `[i,0,0]`、successor `[i,1]`，并要求 after 为顶层空 paragraph `[i]` + remaining list `[i+1]`。
- raw source patch只删除作者第一空 marker row + 自身 EOL，successor row、前后 block gap、BOM、LF/CRLF与其它字节保持。loose-first rows在 PM family已识别后 `recognized:true + legacyBlocked:true`，warning且source/disk不变。
- 本 family不新增 validator semantic 例外：共享 comparator 已只在 doc 顶层过滤 editor-owned empty paragraph；该行为正好匹配 first-lift 当前会话 transient，cold reopen从源码恢复时该空段自然消失。
- RS-84 第二拍现在由 `list-empty-item-first-lift` transaction proof接管，第一拍 cross-list owner保持不变；永久测试明确禁止第二拍再回落到 legacy `empty-list-item-removed`。
- callback/立即源码 forced-flush、BOM+CRLF、source/save/disk/fresh-profile reopen、纯正反合同、loose-first负例、tail/interior、isolated ordered lift、RS-72、nested/task/cross-list/rapid Enter、generic list-subtree、Journal/Coordinator/source transaction、完整 preservation、39/39 probes、mixed rich/source、异构 fidelity、desktop/mobile build全部通过。
- 下一独立 family 为 **ordered successor/lift**：先从 `test-isolated-empty-ordered-backspace-lift-ui.mjs` 与 `test-single-empty-ordered-backspace-successor-ui.mjs` 捕获真实 ordered Step/topology、`start`/delimiter/renumbering与 raw source 影响，不能把 ordered 纳入 bullet first owner。

### List ordered Backspace 第一子族实际完成记录（0.13.154）

- 范围刻意只覆盖 **isolated empty ordered lift**：旧拓扑必须是顶层 plain bullet list、紧邻单一空 ordered list、再紧邻一个未变化的 nonempty bullet list；前一/空ordered/后继 item 的显式 `listType` 必须分别与 bullet/ordered/bullet 容器一致。RS-72 的 ordered successor、多 item ordered、task、nested全部不认领。
- 真实 PM `joinBackward` 是一个 `ReplaceStep(structure=true,sliceSize=0)`；最小合同 `24→26`，generated-input真实文档 `40→42`。精确关系是 `from === ordered.beforePos - 1`、`to === ordered.contentStart`，即删除前一 bullet closing wrapper与isolated ordered opening wrapper，保留空 item并追加进前一 bullet list。
- 为使 `1.` input-rule后立即 Backspace可被Journal看到，新增 `list-input-intent-lifecycle`：active且未消费的intent仍阻断结构跟踪；回调已消费但仍处于callback-tail TTL的intent不再阻断后续真实结构事务。没有新增基于时间窗口推断操作的source mapper。
- 空 ordered paragraph无法作为可靠 PM→Markdown offset锚点；owner改用前一 bullet最后非空 paragraph和后继 bullet第一非空 paragraph两端定位，在source与previous canonical的两个list block边界之间分别要求唯一非空top-level ordered row。作者ordered数字必须等于PM `ordered_list.attrs.order`，成功只替换marker token；`1)`/`.` delimiter、`+/-/*` bullet token、BOM、LF/CRLF和空行均由作者source决定。
- legacy retirement：registry把`list-isolated-empty-ordered-lift`置于first/tail/interior/broad list owners之前并`legacyRetired:true`。一空格 authored ordered row在PM family已证明后以`isolated-ordered-lift-row-count / recognized:true / legacyBlocked:true` fail closed，rich lift保留、warning、无publication、disk不变。
- ordered lift后的第二 Backspace会暂时出现`bullet_list`内显式`listType='ordered'` item；前置提交`5c91042`已收紧tail和generic list-subtree，让显式item/container语义冲突在mapper前保持未识别，第二拍因此直接走既有`empty-list-item-removed` legacy且全周期零integrity false。
- 永久门禁：pure owner、input-intent lifecycle、generated-input两拍、直接authored callback/forced、BOM+CRLF source/save/disk/fresh-profile reopen、legacy-blocked负例；first/tail/interior正负、RS-72、RS-63、task、RS-84、rapid Enter、nested Enter、generic list-subtree、Journal/Coordinator/source transaction、完整preservation、39/39 probes、mixed/fidelity、desktop/mobile build全部通过。
- 下一独立 family 是 **RS-72 ordered successor/multi-step**：当前仍由`list-subtree-replace`的两Step journal（`ReplaceStep + ReplaceAroundStep`）处理，后续必须单独证明successor numbering、ordered start/delimiter与transient paragraph path，不把它扩入本 isolated owner。

### List ordered Backspace 第二子族实际完成记录（0.13.155）

- 范围刻意只覆盖 **RS-72 single-successor**：顶层 plain `ordered_list` 必须恰有三项 `[nonempty, empty, nonempty]`，空项位于 ordinal 1，前后 item 都是非 task、单一非空 plain paragraph；四项以上、多空项、nested、task、首/尾空项继续不认领。
- 真实物理 Backspace 是同一本 journal 内 **2 transactions / 2 steps**。第一笔为 `ReplaceStep(structure=true,sliceSize=0)`，精确删除前一 item closing wrapper 与 empty item opening wrapper；它 apply 后产生 intermediate doc：前一 item 变成原非空 paragraph + 一个 editor-only empty paragraph，原 successor 内容和 label `3.` 均未变化。第二笔为 `ReplaceAroundStep(structure=true,sliceSize=2,insert=1,openStart=0,openEnd=0)`，gap 精确包住 successor content，只把该 successor wrapper/label 改成 `2.`。每笔都必须在捕获时 `stepDoc` 上重放并等于下一实际 doc。
- proof 明确绑定 old `removedPath` / `previousPath` / `successorOldPath`、intermediate successor path、final successor path，以及唯一 transient `[previousItem, trailingParagraph]`；validator 只在 exact `transaction-list-ordered-empty-successor-lift-proof` + 两 Step journal + 精确 path 下忽略这一处 Markdown 无法编码的 empty paragraph。
- raw source ownership 使用 PM source-map 锁定 source / previous canonical / next canonical 中同一顶层 ordered block，但 focused owner不再调用 broad `preserveTransactionOwnedListSubtreeChange()`。新增 `preserveTransactionOwnedSingleEmptyOrderedBackspaceLift()`，只允许 RS-72 专用 mapper解释 bounded fragment；它拒绝 mixed EOL，规范化 canonical 的 ordered delimiter/empty placeholder用于比较，成功后恢复作者 EOL。
- 成功 patch 一次性删除作者中间空 ordered row，并把唯一 successor 的数字从 `order+2` 改成 `order+1`；delimiter完全取作者原 token，所以 `1) / 2) / 3)` 保持 `)`，BOM、LF/CRLF、空行、列表外邻块与其它字节不变。owner要求 mapper reason只能是历史已验证的 `diverged-empty-ordered-backspace-lift`，其它 list mapper不能在 focused rejection后接管。
- legacy retirement：生产 registry 把 `list-ordered-empty-successor-lift` 放在 isolated/first/tail/interior/broad owner之前并设置 `legacyRetired:true`。一空格 authored ordered rows仍可形成相同 PM 两 Step family，但 source range不可安全证明；此时 `recognized:true + legacyBlocked:true`，rich edit保留、显示warning、没有 focused success、没有 broad/legacy/Coordinator publication，磁盘保持原字节。
- 永久门禁：pure owner；BOM+CRLF + `)` delimiter callback/forced source/save/disk/fresh-profile reopen；one-space authored fail-closed；原 `test-single-empty-ordered-backspace-successor-ui` 长文档要求 focused-only publication；generic list-subtree pure/UI；0.13.154 isolated、first/tail/interior正负、RS-63/60/84/85/86、ordered Enter/exit/delimiter/repeated-list；Journal/provenance/Coordinator/source transaction、完整 preservation、39/39 probes、mixed/heterogeneous fidelity、desktop/mobile build全部通过。
- 下一独立 family 是 **multi-successor ordered middle-empty relabel chain**：先捕获四项及更长 ordered list 中删除一个 middle empty item时后续 `3→2, 4→3, ...` 的真实 transaction/Step 链、非 `order=1` 起点和 `.`/`)` delimiter行为；在真实 Step 数和 raw row ownership没有证明前，不把当前三项 owner泛化。

### List ordered Backspace 第三子族实际完成记录（0.13.156）

- 范围覆盖 **multi-successor ordered middle-empty relabel chain**：顶层 plain `ordered_list` 至少四项、恰好一个 middle empty item、empty 后至少两个 nonempty successor；removedIndex 可大于 1，`ordered_list.attrs.order` 可不是 1。single-successor、多个空项、首/尾空项、nested/task继续不认领。
- 真实物理 Backspace 仍是同一本 journal 的 **2 transactions**，但 Step 数随 successorCount 扩展。第一笔只有一个 `ReplaceStep(structure=true,sliceSize=0)`，精确合并 removed item到其前一 item；第二笔 transaction 恰含 `successorCount` 个 `ReplaceAroundStep(structure=true,sliceSize=2,insert=1,openStart=0,openEnd=0)`，按列表顺序逐项 relabel。owner要求 `transactionCount===2`、`stepCount===successorCount+1`，并逐 Step 使用捕获的递进 `stepDoc` 重放；任何遗漏、额外 Step、错误 gap/range 或错误 wrapper attrs 都在 family 已识别后 fail closed。
- topology proof 要求 old ordered labels 从 `attrs.order` 连续增长且 delimiter统一；removed item是唯一空 plain paragraph，其余 items均为单一非空 plain paragraph。intermediate doc只允许前一 item新增一个 editor-owned trailing empty paragraph，所有 successor仍保持旧 label；final doc只允许删除该 empty item并将每个 successor label减 1，正文、attrs、prefix/suffix和邻块全部不变。
- raw source 独立使用 `preserveTransactionOwnedOrderedEmptySuccessorChain()`，不调用 single-successor 或 generic list mapper。bounded source/previous/next 先做 EOL与empty-placeholder比较归一化；source必须有相同数量的顶层 ordered rows、唯一空 row以及连续 authored ordinals。成功时先记录全部 successor ordinal digit patch，再从后向前应用，同时删除 empty row到下一 row起点的完整物理范围；因此作者 `.`/`)` delimiter、marker spacing、body、BOM、LF/CRLF、block gaps和其它未编辑字节都保持。
- validator只在 exact `transaction-list-ordered-empty-successor-chain-proof` 下忽略 removed 前一 item 的一个 trailing empty paragraph；proof同时绑定 removed/previous path、successor count、old/final label数组、第一笔 Step、全部 relabel Step和 Journal snapshot/document证明。single-successor proof不能伪装成chain proof，伪 path、少一个 relabel、错误 transaction/step count均拒绝。
- legacy retirement：registry把chain owner置于0.13.155 single-successor与broad list-subtree之前并`legacyRetired:true`。一空格 authored四项列表仍形成相同PM merge+relabel chain，但source range无法安全映射；此时 `recognized:true + legacyBlocked:true`，保留rich edit和transient paragraph、显示warning，不允许 single/broad/legacy/Coordinator publication，disk不变。
- 永久门禁：pure owner覆盖2/3 successor、removedIndex 1/2、`order=4`、`)` delimiter、body/mixed-EOL/wrong-step负例和single-successor no-hit；真实Electron覆盖callback/forced、BOM+CRLF、source/save/disk/fresh-profile reopen与one-space fail-closed。0.13.155 single-successor、0.13.154 isolated、first/tail/interior、RS-63/60/84/85/86、nested Enter、ordered Enter/exit/delimiter/repeated-list、generic list-subtree、Journal/Coordinator/source transaction、完整preservation、39/39 probes、mixed/heterogeneous fidelity、desktop/mobile build和`git diff --check`均通过。
- 阶段 E 尚未结束。下一项按既定顺序进入 **nested list split/join/indent/outdent**：先从真实物理 Tab/Shift+Tab、Enter、Backspace/Delete 捕获 PM Step/stepDoc/path 家族，再拆 focused owners；task sentinel、conversion、input rules与跨列表/coalescing继续排在后面，不把 broad list owner提前删除。

### Nested list 第一子族实际完成记录（0.13.157）

- 范围刻意只覆盖 **top-level plain bullet list 的 tail empty item 物理 Tab sink**：target 必须是最后一个 non-task、单一空 paragraph item；其前一 sibling 必须是 non-task、只有一个非空 plain paragraph且尚无 nested list。中间项、非空项、已有 nested parent、task、ordered、Shift+Tab/outdent、split/join都不认领。
- 真实产品路径没有 HorseMD 自定义普通列表 Tab 特判，而是 ProseMirror 原生 `sinkListItem`。RS-64 与最小 schema均证明唯一 `ReplaceAroundStep(structure=true,sliceSize=3,openStart=1,openEnd=0,insert=1)`；精确边界为 `from=target.beforePos-1`、`gapFrom=target.beforePos`、`gapTo=to=target.beforePos+target.nodeSize`。slice是一个外层 `list_item` wrapper包住空 `bullet_list` wrapper，target item本身通过 gap移动到该 nested list。
- Milkdown parsed top list目前把 `spread` 表示为字符串 `"false"`，`sinkListItem` 新建 nested wrapper则是布尔 `false`。owner只对 **list wrapper 的 false spread** 做局部语义归一化；target item、parent item、Step、path、sibling与其它 attrs仍严格，不把表示差异扩散到通用 comparator。
- raw source不复用 broad list mapper。CommonMark解析实验表明空 nested bullet若直接写成 `- beta\n  - ` 会被错误解释，而 `- beta\n\n  - ` 才是稳定父 item + 空 nested child。因此成功 patch只在作者 tail marker row前插入“一个原 EOL + 两个 spaces”，即把连续 top-level row变为 parse-safe nested row；原 `-`/`+`/`*` token、marker spacing、body、BOM、LF/CRLF、前后邻块都逐字保持。RS-64 过去由 broad `batched-list-block-changes` 输出 serializer `*`，0.13.157 focused owner后作者 `-` 在 Tab、继续输入`s`、source/save/reopen全周期保持。
- 本 family不需要 semantic transient豁免：空 nested item有合法 authored Markdown 表示，focused candidate可直接通过 strict semantic + list-slot validation。proof仍绑定 Journal snapshot/document、parent/target/nested paths、单一真实 ReplaceAroundStep、source range、原 parent/target rows与 raw insertion。
- legacy retirement：registry把该 owner放在其它 list focused owners和 broad list-subtree之前，并设置 `legacyRetired:true`。两空格 authored marker spacing仍可解析出相同PM family，但当前raw byte合同刻意只证明单空格 spacing；因此在 `nested-empty-bullet-indent-source-row-unproven` 阶段 `recognized:true + legacyBlocked:true`，rich Tab sink和nested list保持可见、显示warning，不允许 broad/legacy/Coordinator publication，disk不变。
- 永久门禁：pure owner使用真实 `sinkListItem`，覆盖BOM+CRLF作者`+` marker以及body/spacing recognized负例、nonempty/existing-nested/task/ordered no-hit；RS-64永久回归升级为必须focused publication且作者`-` marker保持；专用Electron覆盖callback/forced、BOM+CRLF、source/save/disk/fresh-profile reopen与两空格fail-closed。相邻矩阵覆盖nested Enter、RS-68/63/85、generated nested/task、first/tail/interior、0.13.154–156 ordered、generic list-subtree和nested 3×2 fidelity；Journal/Coordinator/source transaction、完整preservation、39/39、mixed/heterogeneous fidelity、desktop/mobile build与`git diff --check`全部通过。
- 阶段 E 仍未完成。下一步先继续真实取证 **nonempty/middle Tab indent** 与 **Shift+Tab outdent**，再决定是否拆成独立 family；nested split/join、task sentinel、conversion、input rules与跨列表/coalescing仍排在后面。

### Nested list 第二子族实际完成记录（0.13.158）

- 范围覆盖 **top-level plain bullet list 的 nonempty middle/tail item 物理 Tab sink**：targetIndex必须≥1；target与紧邻前一parent都必须是non-task bullet item、只有一个无marks非空plain paragraph，parent在old doc中尚无nested list。empty target继续归0.13.157；已有nested parent、task、ordered、首项、marks/复杂item继续不认领。
- 真实产品tail和middle Tab均由原生` sinkListItem `形成单transaction/单`ReplaceAroundStep(structure=true,sliceSize=3,openStart=1,openEnd=0,insert=1)`。对任意targetIndex，`target.beforePos===parent.beforePos+parent.nodeSize`、`from===target.beforePos-1`、`gapFrom===target.beforePos`、`gapTo===to===target.beforePos+target.nodeSize`。new top-level list少一个item，parent在原index新增一个nested bullet list，nested恰含old target；middle case中target后的所有siblings只向前移动一位并保持`.eq()`。
- 真实Milkdown trace显示Step slice外层`list_item`会带`spread:true`，而live newDoc parent attrs仍保持old parent的`spread:"false"`。因此owner不把slice外层wrapper attrs当source语义证据，只要求slice中存在false-like的空bullet wrapper，并以最终new parent node、target `.eq()`、Step/path replay作为ownership合同；false/`"false"`归一化继续只限list wrapper。
- raw source比0.13.157 empty sink更简单：CommonMark实测`- beta\n  - gamma`、`+ beta\n  + gamma`以及middle `+ alpha\n  + beta\n+ gamma`均稳定解析，所以成功patch只在target authored row.start前插入两个ASCII spaces，不新增空行、不改EOL。所有top-level source rows当前要求同一作者bullet token、单空格marker spacing、indent 0；parent/target raw body必须与PM plain text精确一致。作者marker、正文、BOM、LF/CRLF、middle后的top-level successor和其它字节保持。
- 本family不新增validator semantic例外：nonempty nested item有直接合法Markdown表示，patch后必须通过生产`validateTransactionMarkdown`的parser document equivalence和strict list-slot gate。proof绑定Journal snapshot/document、targetIndex/parentIndex、middle/tail position、old/new paths、真实ReplaceAroundStep、source range、原作者rows与`rawInsertion='  '`。
- legacy retirement：registry把nonempty owner放在0.13.157 empty owner之后、ordered focused owners和broad list-subtree之前，并设置`legacyRetired:true`。两空格marker spacing或target raw body无法与PM正文精确证明时，在PM topology+Step已完成分类后返回`recognized:true`并统一`legacyBlocked:true`；empty owner、broad mapper与legacy都不能重新解释，rich nested edit保持、warning出现、Coordinator不发布、disk不变。
- 永久门禁：pure owner用真实`sinkListItem`覆盖middle/tail、作者`+`、BOM+CRLF、wide-spacing/raw-body recognized负例、empty/existing-nested/task/ordered no-hit和wrong-gap Step；真实Electron覆盖tail callback（`+` marker）与middle forced-flush（`-` marker）、source/save/disk/fresh-profile reopen和two-space retirement。相邻矩阵覆盖0.13.157 empty sink、RS-64、continuous fidelity、nested 3×2 continuous+slow、generated empty ordered indent、nested Enter/RS-68/63/85、0.13.154–156 ordered families和generic list-subtree；Journal/Coordinator/source transaction、完整preservation、39/39、mixed/heterogeneous fidelity、desktop/mobile build和`git diff --check`均通过。
- 阶段E仍未完成。0.13.158 当时的 generic-minimal outdent 比较只用于决定“不要做宽 owner”，其中 single-child `sliceSize=0` 的具体参数不是 HorseMD 真实合同；0.13.159 已用真实 Electron 与 HorseMD 同款 attrs 的最小 schema 将 single-child 正式纠正为 `sliceSize=1/openStart=1/openEnd=0/insert=1`。multi-child 的具体 Step 数量/参数仍需按真实产品重新取证，旧预判不再作为正式证据。

### Nested list 第三子族实际完成记录（0.13.159）

- 范围只覆盖 **top-level plain bullet parent 下唯一 nonempty nested bullet child 的物理 Shift+Tab outdent**。old parent必须是non-task plain bullet item，直接children恰为一个无marks非空paragraph和一个`bullet_list`；nested list必须只有一个child，target同样是non-task、单一无marks非空paragraph。multi-child、empty child、task、ordered、复杂parent/target全部不认领。
- 真实 HorseMD Electron 的 `- beta /  - gamma` Shift+Tab 与使用HorseMD同款`spread:"false"`/listType attrs的最小`liftListItem`完全一致：单transaction / 单`ReplaceAroundStep(structure=true,sliceSize=1,openStart=1,openEnd=0,insert=1)`。结构边界固定为`from=nestedList.beforePos`、`to=parent.beforePos+parent.nodeSize`、`gapFrom=target.beforePos`、`gapTo=target.beforePos+target.nodeSize`，且`target.beforePos===nestedList.contentStart`；slice唯一空`list_item` wrapper的attrs必须与old target一致，Step在捕获`stepDoc`上apply必须精确得到expectedDoc。
- new topology要求同一top-level bullet list childCount增加1：old parent原paragraph保持、nested list消失，old target被提升为紧随parent后的top-level item；parent之后其它old siblings只整体右移一位并逐项`.eq()`，其它top-level blocks与list attrs完全不动。
- raw source不调用broad list mapper。当前安全byte合同要求parent source row indent为0，target source row indent恰为两个ASCII spaces；两row必须物理相邻、使用同一作者`-`/`+`/`*` token、marker spacing恰为一个space，raw body分别精确等于parent/target PM plain text。成功patch只有一个操作：删除target row开头两个spaces；不新增/删除EOL，不改marker/body/BOM/CRLF/邻块。
- 本family不需要validator semantic例外：outdent后的三个top-level bullet items有直接合法Markdown表示，focused candidate必须直接通过生产parser document equivalence与strict list-slot gate。proof绑定Journal provenance、parent/nested/target/targetNew paths、exact ReplaceAroundStep、作者rows、`rawRemoval='  '`与各digest。
- legacy retirement：registry位于0.13.157/158 nested indent owners之后、ordered focused owners与broad list-subtree之前，并设置`legacyRetired:true`。四空格target、mixed parent/target marker或raw body不一致等在PM topology+Step已完整分类后返回`recognized:true`，统一`legacyBlocked:true`；rich outdent保留、warning出现，但indent owners/broad/legacy/Coordinator均不得publication，disk不变。
- 永久门禁：pure owner覆盖真实`liftListItem`、exact range/slice、BOM+CRLF作者`+`、wide-indent/mixed-marker/wrong-step recognized负例、multi-child/empty/task/ordered no-hit。真实Electron覆盖parent为第二项的callback `+`、parent为第一项且后有sibling的forced `-`，两条均验证source/save/disk/fresh-profile reopen与focused-only publication；mixed-marker负例验证rich outdent保留且disk不变。相邻矩阵覆盖0.13.157/158 indent、continuous/nested 3×2 fidelity、nested Enter/RS-68/63/85、generated nested/ordered、0.13.154–156 ordered families和generic list-subtree；Journal/Coordinator/source transaction、完整preservation、39/39、mixed/heterogeneous fidelity、desktop/mobile build与`git diff --check`均通过。
- 阶段E下一步继续 **multi-child Shift+Tab outdent**。先对first-child与last-child分别做真实Electron transaction/stepDoc取证，只有真实Step拓扑一致时才合并；否则继续拆family。nested split/join随后再迁移，task sentinel、conversion、input rules与跨列表/coalescing仍在后面。

### Nested list 第四子族实际完成记录（0.13.160）

- 范围只覆盖 **top-level plain bullet parent 下 nestedCount>=2 时最后一个 nonempty plain bullet child 的物理 Shift+Tab outdent**。parent直接children仍要求一个无marks非空paragraph + 一个plain nested `bullet_list`；nested中每一项当前都要求non-task、单一无marks非空paragraph。first child、single child、empty/task/ordered/复杂nested明确不认领。
- 真实 HorseMD 对两子项 `gamma/delta` 的 last child 与HorseMD同attrs 2/3-child最小`liftListItem`一致：单transaction/单`ReplaceAroundStep(structure=true,insert=2,sliceSize=2,openStart=2,openEnd=0)`。exact relation为`from===gapFrom===target.beforePos`、`gapTo===target.beforePos+target.nodeSize`、`to===parent.beforePos+parent.nodeSize`。slice外层空`list_item` attrs与target精确一致，其唯一child是与old nested attrs一致的空`bullet_list` wrapper；Step在捕获stepDoc上apply必须精确等于expectedDoc。
- topology：new top-level list childCount增加1，parent仍原index；parent paragraph不变，nested list保留old target之前全部prefix children并逐项`.eq()`，最后target被提升为`parentIndex+1` top-level item，parent之后其它siblings整体后移一位且不变。2-child与3-child均使用同一proof。
- raw source：source-map同时锚定parent和全部nested paragraph。当前byte合同要求parent indent 0、所有nested indent恰两个spaces，parent+全部nested物理连续、全部使用同一作者bullet token且marker spacing恰一个space，raw body逐项精确等于PM正文。成功只删除最后target row起始的两个spaces；前面的nested siblings、marker、BOM、LF/CRLF、邻块和其它字节逐字保持。
- retirement：target marker padding为两个spaces、wide indent、mixed marker/body等，在exact PM last-child family已分类后返回`recognized:true + legacyBlocked:true`；rich outdent保留，single-child/broad/legacy/Coordinator不得publication，warning出现且disk不变。
- 永久门禁：pure覆盖2/3 nested children、exact Step/path/slice、BOM+CRLF `+`、wide/mixed/wrong-step recognized负例及first/single/empty/task/ordered no-hit；真实Electron覆盖2-child callback与3-child forced、`+/-`、source/save/disk/fresh-profile reopen和target marker-spacing retirement。真实multi-child diagnostic在production接线后再次证明first-child仍由broad `list-subtree-replace`持有，而last-child由0.13.160 focused owner持有；0.13.157–159、continuous/nested fidelity、nested Enter/RS-68/63/85、ordered families、generic subtree、Journal/Coordinator、完整preservation、39/39、mixed/heterogeneous fidelity与双build均通过。
- **first-of-multiple 不属于本 family**：同一文档transaction中有两笔`ReplaceAroundStep`。实机两子项时第一步`48→58 / gap 49→58 / insert=1 / sliceSize=3`，把剩余`delta`挂到被提升`gamma`下；第二步`39→62 / gap 40→60 / insert=1 / sliceSize=1`完成外层lift，最终`gamma`成为top-level且仍含nested `delta`。下一版本必须按两Step/stepDoc链单独建立focused owner，不允许last-child owner扩宽。
- nested split/join排在first-of-multiple之后；task sentinel、conversion、input rules与跨列表/coalescing继续排后。

### Nested list 第五子族实际完成记录（0.13.161）

- 范围只覆盖 **top-level plain bullet parent 下 nestedCount>=2 时第一个 nonempty plain bullet child 的物理 Shift+Tab outdent**。parent与所有nested items仍要求non-task、单一无marks非空paragraph；last child由0.13.160，single child由0.13.159，empty/task/ordered/复杂nested继续不认领。
- 真实 HorseMD 与 2/3-child同attrs `liftListItem` 都在同一document transaction里产生 **两笔 `ReplaceAroundStep`**。Step 1 `insert=1/sliceSize=3/openStart=1/openEnd=0`，从target结束wrapper前到old nested结束wrapper前，把全部successors通过gap搬入target中新建nested wrapper；Step 2 `insert=1/sliceSize=1/openStart=1/openEnd=0`，严格以Step 1后的`stepDoc`为输入，把这个已经带successor nested list的target从old parent提升到top-level。owner要求Step 1 apply结果精确等于捕获的第二个stepDoc，Step 2 apply结果精确等于live expectedDoc。
- intermediate topology是本family的核心证据：outer top-level item count尚未变化；old parent仍保留一个nested list，但其中只剩target；target已经拥有与old nested attrs一致的新nested list，并按原顺序包含全部successors。第二步之后parent只保留原paragraph，target成为`parentIndex+1` top-level item且successors仍位于target的nested list；其它outer siblings只整体后移一位并`.eq()`。
- raw source不尝试复现中间态。source-map证明parent + 全部nested rows物理连续、同作者bullet token、marker spacing一个space、parent indent=0、nested indent恰两个spaces且raw body逐项等于PM正文后，最终patch只删除**第一 target row**的两个spaces。successor rows完全不动，因此原来的`  + delta`/`  + epsilon`自然在最终Markdown中继续属于被提升target。
- legacy retirement：wide target indent、target marker padding、mixed marker/body等在两-Step PM family已完整分类后`recognized:true + legacyBlocked:true`；last/single/broad/legacy/Coordinator不得接管，rich结构保持、warning出现且disk不变。
- 永久门禁：pure覆盖2/3 nested children、Step 1/2 range/slice、stepDoc中间态、successor顺序、BOM+CRLF、wide/mixed/wrong-step recognized负例以及last/single/empty/task/ordered no-hit；真实Electron覆盖2-child callback与3-child forced、`+/-` marker、source/save/disk/fresh-profile reopen和marker-spacing retirement。相邻矩阵覆盖0.13.157–160、continuous/nested 3×2 fidelity和generic list-subtree；Journal/Coordinator/source transaction、完整preservation、39/39、mixed/heterogeneous fidelity、desktop/mobile build与`git diff --check`全部通过。
- 至此 plain bullet 的基础 Tab/Shift+Tab families 已按真实 Step 拆清。下一步进入 **nested split/join**，先通过真实Electron比较 Enter split、Backspace/Delete join 的Step topology与raw byte影响，优先迁移最小且稳定的子族；task sentinel、conversion、input rules与跨列表/coalescing仍在之后。

### Nested list 第六子族实际完成记录（0.13.162）

- 范围只覆盖 **top-level plain bullet parent 内 nested plain bullet item 的 middle/end Enter split**。target必须non-task、单一无marks非空paragraph；splitOffset必须`>0`，允许等于正文长度以生成空right sibling；任意nested index均可。item开头Enter、task、ordered、marks/atoms/复杂item以及Backspace/Delete join明确不认领。
- 真实 HorseMD end/middle Enter 与同attrs `splitListItem` 完全一致：单document-changing transaction、单`ReplaceStep(structure=true,sliceSize=4,openStart=2,openEnd=2)`，`from===to===targetParagraph.contentStart+splitOffset`；slice是两个空`list_item` wrappers，各含空paragraph且attrs与old target一致。new nested list childCount增加1；target位置变成left/right两个item，`leftText+rightText===oldText`，其它nested和outer siblings逐项`.eq()`。
- raw source只修改target作者row：在语义split boundary插入 **原EOL + 原indent + 原marker + 原spacing**。当前安全合同要求nested indent恰两个ASCII spaces、marker spacing一个space、EOL为LF/CRLF。BOM、marker token、正文其余bytes、siblings与邻块均保持。
- 为避免 authored escape 造成“PM字符offset != raw byte offset”，本family新增局部 `escapedPlainTextBoundary`：逐字符证明raw body等价于PM plain text，仅接受原字符本身或Markdown可转义标点的`\\x → x`，同时返回精确raw boundary；任何无法完整对齐的entity/复杂inline继续fail closed。永久旧基线`1\\. 额啊飞啊发`已验证PM `splitOffset=8`映射到raw `rawSplitOffset=9`，最终source仍保留反斜杠。
- legacy retirement：registry将split owner置于nested focused owners之后、ordered/broad之前并`legacyRetired:true`。两空格marker padding等在PM topology+Step已完整分类后返回`recognized:true + legacyBlocked:true`；rich split保留、warning出现，但outdent/broad/legacy/Coordinator均不得publication，disk不变。原`nested-list-enter-empty-sibling`永久回归已升级为focused-only ownership，禁止 broad `list-subtree-replace`重新接管。
- 永久门禁：pure覆盖middle/end、任意nested index、BOM+CRLF作者`+`、authored `1\\.` raw offset、unsafe row/wrong Step recognized fail-closed及start/task/ordered no-hit；Electron覆盖end callback和middle forced、`+/-` marker、source/save/disk/fresh-profile reopen与marker-spacing retirement。相邻矩阵覆盖0.13.157–161、continuous/nested 3×2 fidelity、RS-68 rapid nested parent Backspace、RS-63 nested Backspace与generic list-subtree；Journal/Coordinator/source transaction、完整preservation、39/39、mixed/heterogeneous fidelity、desktop/mobile build和`git diff --check`均通过。
- 下一独立family是 **nested sibling 起始 Backspace join**。真实诊断已经证明它与split不同：单`ReplaceStep`后final PM为一个list_item内部两个paragraph，作者source形状为nested marker第一段 + continuation paragraph；当前broad transaction candidate会因document mismatch失败并落回legacy。0.13.163必须单独证明old/new paths、Step range、continuation indentation和save/reopen，不能复用split raw patch。

### Nested list 第七子族实际完成记录（0.13.163）

- 范围只覆盖 **top-level plain bullet parent 内任意非首 nested plain bullet sibling 在正文起始位置的物理 Backspace join**。previous 与 target 都必须non-task、单一无marks非空paragraph；targetIndex必须`>=1`。task、ordered、复杂item、item中间删除、Delete join与跨list join继续不认领。
- 真实 HorseMD 与同attrs `joinBackward` 对2-child second、3-child middle/last均使用单transaction/单`ReplaceStep(structure=true,sliceSize=0,openStart=0,openEnd=0)`；范围恒为`from=target.beforePos-1=previous.beforePos+previous.nodeSize-1`、`to=target.contentStart`。Step在捕获stepDoc上apply必须精确等于live expectedDoc。
- final topology：nested childCount减1；target sibling消失，previous位置的joined item保留原attrs并拥有两个paragraph，第一paragraph逐字等于old previous，第二paragraph逐字等于old target；其余nested siblings在target之后整体左移一位，outer siblings与parent paragraph保持`.eq()`。
- raw source不调用broad mapper。source-map分别锚定previous/target paragraph，并要求两作者rows物理相邻、nested indent都恰两个ASCII spaces、使用同一作者`-`/`+`/`*` marker、marker spacing一个space、LF/CRLF一致；正文通过有限backslash-escape对齐证明。成功只把target row的`  marker `前缀替换为 **原EOL + 四个spaces**，target正文bytes原样保留，因此生成`previous marker row + blank line + four-space continuation paragraph`。
- 真实Electron已证明该continuation source直接通过生产parser/document equivalence/strict list-slot gate，不需要semantic豁免，并在source/save/disk/fresh-profile cold reopen后稳定恢复为一个nested list_item内两个paragraphs。BOM、CRLF、作者`+/-` marker与`1\\.`正文保持。
- legacy retirement：registry将join owner置于split之后、ordered/broad之前并`legacyRetired:true`。target marker padding等在exact PM family已分类后`recognized:true + legacyBlocked:true`；rich双paragraph join保留、warning出现，split/broad/legacy/Coordinator不得publication，disk不变。
- 永久门禁：pure覆盖2-child、3-child middle/last、exact Step/path、BOM+CRLF、authored escape、unsafe row/wrong-step recognized fail-closed以及task/ordered no-hit；Electron覆盖2-child callback与3-child middle forced、source/save/disk/reopen和marker-padding retirement。相邻矩阵覆盖0.13.157–162、continuous/nested 3×2 fidelity、RS-68、RS-63与generic list-subtree；Journal/Coordinator/source transaction、完整preservation、39/39、mixed/heterogeneous fidelity、desktop/mobile build与`git diff --check`均通过。
- 至此 plain nested bullet 的基础 **Tab indent / Shift+Tab outdent / Enter split / Backspace sibling join** 已全部迁入focused transaction owners。Stage E仍未结束；下一步进入 **task sentinel / task-list item 特有结构** 的真实Step与raw source取证，之后再处理conversion、input rules与cross-list/coalescing。

### Task list 第一子族实际完成记录（0.13.164）

- 范围只覆盖 **plain bullet task item 已存在 boolean `checked` 时的 checkbox 点击切换**。top-level task 与 top-level plain parent 下的一层 nested task均支持；ordinary item `checked:null→false` 的 task conversion、ordered task、空 task sentinel、task Enter/Backspace、复杂multi-block task明确不认领。
- 真实 HorseMD top-level/nested checkbox点击均为单document-changing transaction / 单`AttrStep`：`step.pos===target list_item.beforePos`、`step.attr==='checked'`、`step.value===next checked boolean`，非checked attrs与paragraph content保持。nested场景里祖先parent list_item的`.eq()`也会变化，因此本family不用generic anchored-list-item classifier，而是先在old/new tree中找唯一“checked boolean翻转且content/nonchecked attrs不变”的leaf task，再由AttrStep.pos完成Step-first绑定。
- raw source只锚定target paragraph所在task row。row解析保留indent、作者`-`/`+`/`*` token、bullet marker spacing、`[ ]/[xX]`之后的task spacing、正文与EOL；成功patch只替换checkbox状态字符一个byte/字符，unchecked写` `，checked写`x`。正文允许普通字符和有限Markdown backslash escape，entity等复杂raw spelling当前不猜。
- 该owner直接修复现有 fidelity first divergence：真实诊断证明checkbox点击过去由legacy `list-line-change`持有，会把作者`+ [ ] Top task`及nested作者`  + [x] Nested task`改写为serializer默认`*`。0.13.164 focused callback/forced 回归要求 `+/-` token逐字保持，且source/save/disk/fresh-profile reopen全部一致。
- legacy retirement：registry将`list-task-checkbox-toggle`置于nested join之后、ordered/broad owners之前并`legacyRetired:true`。entity-authored正文`A &amp; B`作为永久负例：PM checked AttrStep已完整分类，但raw body无法由有限plain/escape对齐证明时返回`recognized:true + legacyBlocked:true`；rich checkbox切换保留，warning出现，legacy `list-line-change`、broad list-subtree与Coordinator均不得publication，disk不变。
- 永久门禁：pure覆盖top-level/nested、false→true/true→false、exact AttrStep、BOM+CRLF、作者`+/-`、`1\\.` escape、entity/wrong-step recognized fail-closed、ordinary conversion/ordered no-hit；Electron覆盖top-level callback + nested forced、focused-only publication、source/save/disk/reopen和entity retirement。相邻覆盖原task persistence、RS-70 task Enter empty sibling、RS-58 task continuation empty、RS-60 empty task Backspace、0.13.162/163 nested split/join与generic subtree；Journal/Coordinator/source transaction、完整preservation、39/39、mixed/heterogeneous fidelity、desktop/mobile build及`git diff --check`全部通过。
- Stage E下一步进入 **task Enter/sentinel 生命周期**：需要把`taskEmptyNext`、zero-width sentinel、empty sibling填充/退出等真实transaction/Step拆开；conversion、typed input rule与cross-list/coalescing继续后排，不能扩宽checkbox AttrStep owner。

### Task list 第二子族实际完成记录（0.13.165）

- 范围只覆盖 **已有 plain bullet task item 在正文末尾物理 Enter，新建一个空同层 task sibling**。top-level task 与顶层 plain bullet parent 下的一层 nested task均支持；正文中间 split、item开头 Enter、ordinary bullet、ordered task、task conversion、sentinel 填充/退出与 Backspace明确不认领。
- 真实 HorseMD top unchecked、top checked、nested checked 三组诊断均为单document-changing transaction / 单`ReplaceStep(structure=true,sliceSize=4,openStart=2,openEnd=2)`；`from===to===paragraph.contentStart+oldText.length`，slice恰有两个空`list_item` wrapper，各含空paragraph且attrs与旧task完全一致。new list只在target后增加一个sibling，其它siblings逐项`.eq()`；因此新空task继承旧item的`checked` boolean。
- raw source不序列化整个list，也不让legacy决定marker。source-map锚定旧task paragraph后，row必须满足当前安全合同：top-level indent为空或nested恰两个spaces、作者bullet token任意`-`/`+`/`*`、bullet/task spacing各一个space、checkbox state与PM一致、正文为plain text或有限Markdown backslash escape、EOL为LF/CRLF。成功只在该物理row结束后插入同indent/token/spacing/state spelling的空task row，并用U+200B作为source-owned sentinel；BOM、原正文、后继row和其它bytes不动。
- 该family直接消除了一个现有source-rich divergence：迁移前top-level Enter会落到legacy `list-line-change`，把作者`+` marker改为canonical `*`且曾出现`semanticOk:false`；nested Enter则落到`middle-empty-block-list-filled`。0.13.165 callback/forced永久回归要求 focused owner唯一publication，并禁止这两个legacy reason与broad list-subtree publication。
- legacy retirement：registry将`list-task-empty-sibling-split`置于task checkbox之后、ordered/broad owners之前并`legacyRetired:true`。entity-authored `A &amp; B`作为真实负例：PM Step/topology已完整识别，但raw body不属于当前plain/escape证明时返回`recognized:true + legacyBlocked:true`；rich Enter保留、warning出现，legacy/broad/Coordinator不得publication，disk保持原字节。
- 永久门禁：pure覆盖top unchecked、top checked uppercase `X`、nested checked、exact Step/slice/path、BOM+CRLF、`1\\.` escape、entity/wrong-step recognized fail-closed，以及middle split/ordinary/ordered no-hit；Electron覆盖top callback、nested forced、source/save/disk/fresh-profile reopen和entity retirement。原RS-70已升级为Enter必须由本focused family发布，随后填正文仍由legacy `empty-task-sentinel-filled`；task checkbox/persistence、RS-58 task continuation、RS-60 empty-task Backspace、nested split/join、generic subtree相邻矩阵全绿。Journal/Coordinator/source transaction、完整preservation、39/39 probes、mixed/heterogeneous fidelity、desktop/mobile build与`git diff --check`均exit 0。
- 下一family明确为 **`empty-task-sentinel-filled`**：从U+200B空task继续物理输入正文，当前RS-70已提供稳定legacy first-punch证据。先抓真实ReplaceStep/transaction chain，再做raw row“只消费sentinel并写入正文”的focused owner；不要同时迁移empty-task Backspace或task input rule。

## 9. 阶段 F：普通段落默认 authority

把已有 `plain-paragraph-transaction-owner` 从显式测试门禁提升为生产默认，逐项完成：

- insert/delete/selection replace；
- Enter split；
- Backspace/Delete join；
- 连续空段和新文档 bootstrap；
- trailing spaces、hard break、BOM与三种EOL；
- IME composition；
- undo/redo；
- source-mode/save竞争。

完成后退役 generic localized/line/middle/tail正文写回主路径，只保留明确未迁移 family 的 fail-closed compatibility。

## 10. 阶段 G：Marks、Atoms 与特殊入口

依次迁移：

- strong/emphasis/strike；
- inline code；
- links；
- images、math与其它 atoms；
- frontmatter；
- Slash code/math及其它结构命令；
- paste、drop、whole-document replacement；
- generated scratch；
- source+preview和多标签隐藏editor callback。

每个入口必须与普通 dispatch共享 revision/provenance；命令级 source intent不能绕过最终 Coordinator validation。

## 11. 阶段 H：持久化旁路清零

建立静态和runtime双门禁：

- 搜索成功路径中直接赋值 source/canonical refs、host `onChange`、磁盘写入。
- 所有成功 publication trace必须含 candidate id、owner、family、reason、revision、boundary。
- 识别但拒绝的事务必须有 `legacyBlocked` 或明确未迁移状态。
- 不允许先推进 canonical/source基线再验证。
- 不允许旧 callback在新revision上rebase。

完成后，legacy preservation只能作为未识别 family 的临时兼容层，不得拥有已经迁移的任何操作。

## 12. 阶段 I：最终资格验收

### 自动化

- focused family全矩阵；
- family multicycle默认/transaction authority；
- continuous fidelity；
- chaos多档节奏；
- 100K–400K大文档性能和逐键延迟；
- LF、CRLF、lone-CR、BOM、无final-EOL；
- IME、快速按键、保存/源码切换抢跑；
- 多标签、隐藏editor、外部文件更新；
- desktop/mobile build。

### 正式安装包

1. clean本地提交；
2. `dist:dir`；
3. 核验 bundle版本；
4. 安装到 `/Applications` 前保留旧版唯一备份；
5. `--horsemd-input-trace` 启动；
6. 使用真实长文档连续交替操作段落、列表、引用、代码块、表格、输入规则、IME；
7. 多轮保存、关闭、fresh-profile冷重开并继续编辑；
8. 同时比对 PM、committed source、canonical、textarea、tab mirror和disk；
9. 首个 divergence、integrity false、warning和错误成功保存均为零。

只有该阶段通过，才能关闭 `rich-source-divergence-incident-0.13.47.md` 的P0 Known Issue。

## 13. 进度维护规则

每完成一个阶段，更新本文件：

- 状态从“未开始/进行中”改为“完成”；
- 写入版本和本地提交hash；
- 记录实际执行的focused、negative、global和post-commit smoke；
- 写明仍未覆盖的用户操作；
- 下一阶段只从本文件确定，不从聊天记录或临时 `/tmp` 状态文件推断。
