# HorseMD 源码 / 富文本一致性最终收口计划

> 建立日期：2026-08-29
> 当前源码版本：`0.13.154`
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
| E | 退役 list legacy owners | **进行中：0.13.151 interior + 0.13.152 tail + 0.13.153 bullet first-empty + 0.13.154 isolated ordered lift 已迁移，下一项 RS-72 ordered successor** | list subtree、item text、Enter/Backspace、task、input rule、conversion 分 family退役 |
| F | 普通段落成为默认 transaction authority | 未开始 | insert/delete/replace/split/join/empty/undo/redo/IME 全覆盖，generic region mapper退出主路径 |
| G | marks、atoms 与特殊入口统一 | 未开始 | inline code、format marks、link/image/math、frontmatter、Slash、paste、generated scratch、whole-doc统一 publication |
| H | 消除所有持久化旁路 | 未开始 | 成功写回只能经 Coordinator；静态审计和 runtime trace 均证明无旁路 |
| I | 长会话与正式安装包资格验收 | 未开始 | clean commit→dist→安装→trace长会话→多轮保存冷重开 first divergence=0 |

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
