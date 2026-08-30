# HorseMD 源码 / 富文本一致性最终收口计划

> 建立日期：2026-08-29
> 当前源码版本：`0.13.166`
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
| E | 退役 list legacy owners | **进行中：0.13.151–0.13.165 已完成 empty-item/ordered successor Backspace 链 + plain bullet indent/outdent/split/join + task checkbox AttrStep + task end-Enter empty sibling；0.13.166 又按真实人工 trace 收口 blockquote list-exit、nested ordered parent-join 与既有 list-subtree bullet paragraph-join mapper；sentinel fill 等仍未完成** | list subtree、item text、Enter/Backspace、task、input rule、conversion 分 family退役 |
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
