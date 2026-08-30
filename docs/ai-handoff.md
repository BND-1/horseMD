# HorseMD AI 接手手册

> 面向全新的 AI / 开发者。先读这篇，再按链接深入。更新时间：2026-08-30。

## 0. 当前状态快照

- 源码/富文本一致性最终收口的唯一长期进度账本是 [`source-rich-consistency-completion-plan.md`](./source-rich-consistency-completion-plan.md)。后续阶段、完成条件、门禁、提交边界和正式安装包 P0 关闭标准都以该文档为准；不要从聊天摘要或 `/tmp` 状态文件推断完成度。阶段 A 已由本地提交 `9dafd76` 完成；阶段 C 的四个 Blockquote legacy owners 已由 `5da0e17` 完成；0.13.150 非空 `code_block → paragraph` 已由 `0614893` 收口；0.13.151 interior empty-item 已由 `c70fa0b` 收口；0.13.152 plain tail empty-item 已由 `8eed3a2` 收口。当前阶段 E 已推进到 0.13.167：0.13.154 isolated empty ordered lift、0.13.155 RS-72 single-successor、0.13.156 multi-successor relabel chain、0.13.157 nested plain bullet tail-empty Tab sink、0.13.158 plain nonempty bullet middle/tail Tab sink、0.13.159 single nested child Shift+Tab outdent、0.13.160 multi-child last-item Shift+Tab outdent、0.13.161 multi-child first-item Shift+Tab outdent、0.13.162 nested plain bullet middle/end Enter split、0.13.163 nested plain bullet sibling Backspace join、0.13.164 task checkbox toggle、0.13.165 task end-Enter empty sibling split 均已独立 transaction-owned；0.13.166 又按真实人工 trace 扩展 blockquote list-exit、增加 nested ordered first-child parent-join focused owner，并在既有 `list-subtree` transaction owner 内修复 proof-gated bullet sibling→paragraph mapper。task Enter 第一拍已迁移；`empty-task-sentinel-filled`、task empty-row Backspace、conversion、input rule 与跨列表/coalescing 仍未完成，不能把 List legacy 写成已全部退役。
- 当前分支：`fix/rs-41-rich-source-divergence`
- 当前源码与 `package-lock` 为 `0.13.167`；本轮由 0.13.165 安装版人工 trace 驱动，按根因混合采用既有 owner 扩展、focused owner 与成熟 mapper 修复，不为迁移而迁移。已为朋友测试生成 **未签名** 的 0.13.165 arm64/x64 DMG/ZIP，但没有安装覆盖 `/Applications/HorseMD.app`、没有 notarize/publish；因此该外发包只用于功能试测，不等于阶段 I 正式安装包资格验收。`/Applications/HorseMD.app` 与旧人工 trace 实例仍不能用于验收 0.13.132–0.13.165 的 journal owners，后续正式手测必须从当前已提交源码重新 `dist:dir`、覆盖安装并带 `--horsemd-input-trace` 启动。当前 0.13.167 手测实例直接从 `dist/mac-arm64/HorseMD.app` 启动，主进程 PID `31902`，trace 为 `/var/folders/4y/k4t_v1r1745gl5m_h1vwc6j40000gn/T/horsemd-input-trace-31902.jsonl`。执行层未允许把新 `.app` 写入 `/Applications`；旧 `/Applications/HorseMD.app` 已安全备份到 `/tmp/HorseMD.app.before-0.13.167-20260830`，因此当前 `/Applications/HorseMD.app` 为空，后续如需恢复正常安装位置必须显式复制/移动已验证 app 或旧备份，不能假设 Dock/Applications 已指向 0.13.167。
- 当前架构状态是**混合迁移，不是完整重构**：所有普通用户 transaction 已进入唯一 revision-bound `SourceSyncTransactionJournal`；生产 structural registry 已可 transaction-own 单一列表子树、顶层非任务列表项 direct plain paragraph、顶层普通列表 interior empty-item Backspace、plain tail empty-item Backspace、plain bullet first-empty Backspace、isolated empty ordered lift、RS-72 ordered single-successor middle-empty lift、ordered multi-successor relabel chain、nested plain bullet tail-empty Tab sink、plain nonempty bullet middle/tail Tab sink、single nested plain bullet child Shift+Tab outdent、multi-child nested plain bullet last-item Shift+Tab outdent、multi-child nested plain bullet first-item Shift+Tab outdent、nested plain bullet middle/end Enter split、nested plain bullet sibling Backspace join、task checkbox toggle、task end-Enter empty sibling split、已有代码块正文、代码块 language info、空代码块 Backspace 解包、非空代码块显式退出、已完成 recognized legacy退役的 blockquote plain paragraph/split/join/exit、GFM table 单一 cell plain text、已有 table body-row insert/delete，以及 simple-grid table column delete/insert/alignment/width。引用可位于顶层或列表项等稳定 descendant path；family 由 PM path/Step/stepDoc 证明，不由 canonical 形状猜测。列宽是 GFM 不可编码的 PM-only metadata，只推进 Coordinator doc checkpoint而不改 source/canonical。普通段落仍通过显式 shadow/authority 门禁，nested list 生命周期、task/input-rule/conversion、代码块剩余生命周期和其它 family保持 legacy fail-closed fallback；table span/merge/split没有GFM持久化语法，当前明确不迁移为静默 source owner。不要把当前进度写成全部编辑已 transaction-first。
- 0.13.167 收口 0.13.166 继续人工手测暴露的两个 blockquote transient：其一是引用段落末尾单个 ASCII 空格后立即 Enter，真实调度可能是同一本 journal 的 coalesced 两步，也可能是空格先提交、Enter 落到下一 revision 的 staged 时序；既有 `blockquote-paragraph-exit` 现在同时证明两种时序，raw source 保留作者字面单空格，只在 exact transaction path 的 semantic compare 中忽略该单个 Markdown 非语义尾空格和唯一 trailing empty quote paragraph，两个尾空格 hard-break 仍严格。其二是 blockquote 直系 ordered list 尾空项 Backspace：`list-empty-item-tail-remove` 原本已识别正确 PM family，但空 paragraph 无稳定正文 source-map 导致 `list-empty-item-tail-range-unmapped`；现改为锚定前一个已证明的非空 item，并沿物理相邻 quote-list marker rows 验证 prefix/token/EOL 与 `<br />` 尾行后只删 exact authored row。永久 Electron 回归对两个用户操作都覆盖 source/save/disk/fresh-profile cold reopen；原 blockquote exit、顶层 tail Backspace、0.13.166 quote/nested/bullet 长链、Coordinator、完整 preservation、39/39 probes 与 desktop/mobile build 均通过。
- 0.13.166 收口同一次人工会话中连续出现的三个 first-divergence 根因：第一处是 blockquote ordered-list 空尾项第二次 Enter 退出列表，复用 `blockquote-paragraph-exit` family 新增 `list-exit-pending` 子模式，并把被 transaction proof 证明的“列表后 trailing empty quote paragraph”作为 path-scoped semantic context 绑定到 SourceSync revision，后续 unrelated edits 可继续严格校验且 transient 消失即清除；第二处是 nested ordered 第一 child 在起点 Backspace 后并入父 item 成第二 paragraph、剩余 sibling 重编号，新增 `list-nested-first-ordered-parent-join` focused owner，证明 `joinBackward` + label relabel 两个 `ReplaceAroundStep` 后只补 raw paragraph blank line并把 `2.` 改为 `1.`；第三处是普通 bullet 第二项 Backspace，现有 `list-subtree-replace` 已正确拥有事务，因此不新增 family，只允许 exact `transaction-list-sibling-item-paragraph-join-proof` 驱动 mapper 补一个 paragraph boundary。完整真实 Electron 链路为 quote Enter×2 → nested ordered Backspace → bullet Backspace → source → save → fresh-profile reopen，三处均 integrity 全绿且零 warning；39/39 probes 与相邻 blockquote/list-subtree/bullet-outdent 回归通过。remaining task sentinel/conversion/input-rule 等仍保持原计划，不因本轮人工问题已解决而伪称 Stage E 完成。
- 0.13.165 新增 `list-task-empty-sibling-split`：只认领已有 plain bullet task item 在正文**末尾**物理 Enter 后新增空同层 task sibling；top-level 与一层 nested task 均为单 transaction / 单 `ReplaceStep(structure=true,sliceSize=4,openStart=2,openEnd=2)`，range 固定在 paragraph content end，slice 两个 task wrappers 的 attrs 精确继承原 item，所以 checked/unchecked 状态也继承。raw source 在原 task 物理行结束后插入同 indent/作者 marker/spacing/checkbox spelling + U+200B sentinel + 原 EOL，不走 `list-line-change` 或 `middle-empty-block-list-filled`，因此作者 `+/-/*`、BOM、CRLF、`1\\.` escape 与邻项保持；entity body 无法证明时 `recognized:true + legacyBlocked:true`。top-level callback、nested forced、source/save/disk/fresh-profile reopen、retirement 与升级后的 RS-70 已通过；RS-70 在 sentinel 后继续输入正文仍明确命中 legacy `empty-task-sentinel-filled`，这仍是后续独立 family，不因 0.13.166 的真实人工回退问题收口而并入本轮。专项见`transaction-journal-list-task-empty-sibling-split.md`。
- 0.13.164 新增 `list-task-checkbox-toggle`：只认领 plain bullet task 已有 boolean `checked` 的 checkbox 点击切换。真实 top-level/nested 点击均为单 `AttrStep`，`pos===list_item.beforePos`、`attr='checked'`、`value===nextChecked`；nested target 使用 checked-toggle leaf + exact AttrStep.pos 绑定，不再依赖祖先也会变化的 generic list_item diff。raw source只替换 `[ ]`/`[xX]` 的状态字符，作者 bullet token/spacing/body/BOM/CRLF完全保持，修复 legacy `list-line-change` 会把作者 `+` 改成 `*` 的 fidelity 问题。top-level callback、nested forced、save/disk/fresh-profile reopen均通过；entity body负例在exact AttrStep识别后`recognized:true + legacyBlocked:true`，rich toggle保留且disk不变。原 task persistence、RS-70 sentinel Enter、RS-58/60 generated scratch、nested split/join、39/39与双build均通过。专项见`transaction-journal-list-task-checkbox-toggle.md`。下一步进入 task Enter/sentinel 生命周期，不把 task conversion/input rule混进本owner。
- 0.13.163 新增 `list-nested-bullet-item-join`：只认领顶层 plain bullet parent 内任意非首 nested plain bullet sibling 在正文起点的物理 Backspace。真实 `joinBackward` 是唯一 `ReplaceStep(structure=true,sliceSize=0)`，`from=target.beforePos-1=previousEnd-1`、`to=target.contentStart`；target sibling消失，其paragraph成为previous item的第二paragraph。raw source只把target的两空格indent+作者marker+单空格prefix替换为原EOL+四空格 continuation，正文/BOM/CRLF/作者marker邻项与`1\\.` escape保持；callback/forced、save/disk/fresh-profile reopen已证明该 continuation source稳定重建双paragraph item。marker padding负例在PM family识别后`recognized:true + legacyBlocked:true`，禁止split/broad/legacy publication。pure、相邻0.13.157–162、continuous/nested fidelity、RS-68/63、generic subtree、39/39和双build均通过。专项见`transaction-journal-list-nested-bullet-join.md`。下一步进入 task sentinel / task-list 特有结构取证。
- 0.13.162 新增 `list-nested-bullet-item-split`：只认领顶层 plain bullet parent 内 nested plain bullet item 在正文 middle/end 的物理 Enter；真实 `splitListItem` 为唯一 `ReplaceStep(structure=true,sliceSize=4,openStart=2,openEnd=2)`，`from=to=paragraph.contentStart+splitOffset`。raw source只在作者语义 split boundary 插入原EOL+两空格indent+原marker+原spacing；为保留 `1\.` 等 authored literal，局部 backslash-escape 对齐器将PM语义offset映射到raw byte offset，旧永久基线已验证`splitOffset=8/rawSplitOffset=9`且反斜杠不丢。两空格marker padding等不安全形状在PM family识别后`recognized:true + legacyBlocked:true`。end callback、middle forced、BOM+CRLF、save/reopen、retirement、0.13.157–161、continuous/nested fidelity、RS-68/63、generic subtree、39/39和双build均通过。专项见`transaction-journal-list-nested-bullet-split.md`。下一独立family为 nested sibling 起始 Backspace join；实机final PM是同一list_item内两个paragraph，不能并入split。
- 0.13.161 新增 `list-nested-first-child-bullet-outdent`：只认领顶层 plain bullet parent 下 `nestedCount>=2` 的第一个 nonempty plain nested child 的物理 Shift+Tab。真实 HorseMD 与2/3-child最小 `liftListItem` 都在同一 document transaction 内产生两笔 `ReplaceAroundStep`：第一步把 target 后全部 nested successors 挂到 target 下，第二步在第一步 `stepDoc` 上完成 outer lift；owner逐步绑定 intermediate topology、successor 顺序和 Step replay。raw source只删除 first target row 的两个 leading spaces，后续 nested rows字节不动，因此冷重开后仍为 target 的 nested children。marker padding/wide/mixed/raw-body不安全形状在PM family已识别后`recognized:true + legacyBlocked:true`。pure、2-child callback、3-child forced、BOM+CRLF、save/reopen、retirement、0.13.157–160相邻owner、continuous/nested fidelity、generic subtree、39/39与双build均通过。专项见`transaction-journal-list-nested-first-child-bullet-outdent.md`。下一步进入 nested split/join 真实 Step 取证，不再扩宽 outdent owner。
- 0.13.160 新增 `list-nested-last-child-bullet-outdent`：只认领顶层 plain bullet parent 下 `nestedCount>=2` 的最后一个 nonempty plain nested child 的物理 Shift+Tab。真实 HorseMD two-child 与同attrs 2/3-child最小 `liftListItem` 都是单 `ReplaceAroundStep(structure=true,insert=2,sliceSize=2,openStart=2,openEnd=0)`，`from=gapFrom=target.beforePos`、`gapTo=targetEnd`、`to=parentEnd`；new parent保留原 nested prefix，target提升为紧随parent后的top-level item。raw source先证明parent+全部nested rows连续、同marker、单空格padding、nested两空格缩进和正文一致，再只删除最后target的两个leading spaces。two-space target marker padding等未证明byte形状在PM family识别后`recognized:true + legacyBlocked:true`。2-child callback、3-child forced、BOM+CRLF、save/reopen、retirement、0.13.159 single-child、0.13.157/158 indent、nested/ordered/generic subtree、39/39和双build均通过。真实multi-child diagnostic同时证明 first-child仍是另一两-Step family：第一步把剩余nested sibling挂到被提升项，第二步完成外层lift；当前继续由broad owner持有，下一步只迁移first-of-multiple。专项见`transaction-journal-list-nested-last-child-bullet-outdent.md`。
- 0.13.159 新增 `list-nested-single-child-bullet-outdent`：只认领顶层 plain bullet parent 下唯一 nonempty nested bullet child 的物理 Shift+Tab。真实 HorseMD 与同attrs最小 `liftListItem` 都是单 `ReplaceAroundStep(structure=true,sliceSize=1,openStart=1,openEnd=0,insert=1)`，边界精确绑定 nested list / target / parent；此前 0.13.158 文档里 single-child `sliceSize=0` 只是预判，现已被真实产品证据纠正。raw source当前只证明“parent顶层row + 紧邻下一行两个spaces的同marker nested row”，成功只删两个spaces；四空格、mixed marker或body mismatch在PM family已识别后`recognized:true + legacyBlocked:true`。callback/forced、BOM+CRLF、`+/-` marker、save/reopen、mixed-marker retirement、0.13.157/158 indent、nested/ordered相邻矩阵、39/39与双build均通过。专项见`transaction-journal-list-nested-single-child-bullet-outdent.md`。下一步继续真实取证 **multi-child Shift+Tab outdent**，先比较 first-child 与 last-child 是否需要拆两个 family；旧的 generic-minimal Step 参数不再视为正式证据。
- 0.13.158 新增 `list-nested-nonempty-bullet-indent`：只认领顶层 plain bullet list 的 nonempty middle/tail item 物理 Tab sink 到紧邻前一 nonempty sibling，target/parent都必须是non-task、只有一个无marks plain paragraph且parent尚无nested list。真实tail与middle Electron均为单transaction/单`ReplaceAroundStep(structure=true,sliceSize=3,openStart=1,openEnd=0,insert=1)`；owner绑定targetIndex/parentIndex、parent/target/nested paths和exact from/to/gap，最终parent attrs保持原值；真实Step slice外层list_item的`spread:true`不作为source ownership依据。raw source只在target row前插入两个spaces，作者`-`/`+`/`*`、正文、BOM、CRLF与middle后的top-level successor逐字保持，不需要empty sink的额外blank line。两空格marker spacing/raw body mismatch在PM family已识别后`recognized:true + legacyBlocked:true`。pure、tail callback+middle forced、BOM+CRLF、save/reopen、负向retirement、0.13.157 empty owner、continuous/nested fidelity、generated ordered indent、0.13.154–156 ordered、generic subtree、39/39和双build均通过。专项见`transaction-journal-list-nested-nonempty-bullet-indent.md`。其文档末尾关于 outdent 的旧预判已在 0.13.159 收口时纠正；multi-child仍需真实实机取证。
- 0.13.157 新增 `list-nested-empty-bullet-tail-indent`：只认领顶层 plain bullet list 的 tail empty item 物理 Tab sink 到紧邻前一 nonempty sibling，且该 sibling尚无 nested list。真实 `sinkListItem` 是单 transaction / 单 `ReplaceAroundStep(structure=true,sliceSize=3,openStart=1,openEnd=0,insert=1)`；owner精确绑定 parent/target/nested paths与 from/to/gap，局部容忍 Milkdown top list `spread:"false"` 与新 nested wrapper `spread:false` 的同一 false 语义，target item attrs仍严格。raw source只在作者 tail row前插入一个原 EOL + 两个 spaces，以 `父正文\n\n  marker` 的 parse-safe 形状持久化空 nested item，保留作者 `-`/`+`/`*` marker；RS-64 因而从 broad `batched-list-block-changes` 迁出并修复了 marker被 canonical `*` 改写的问题。两空格 marker spacing等未证明 source形状在 PM family已识别后 `recognized:true + legacyBlocked:true`。pure、RS-64继续输入/save/reopen、BOM+CRLF `+` callback/forced、负向 retirement、相邻 nested/list、39/39、mixed/heterogeneous fidelity和双build均通过。专项见 `transaction-journal-list-nested-empty-bullet-tail-indent.md`。下一步仍在 nested family 内取证 nonempty/middle indent 与 Shift+Tab outdent/split/join，不跳阶段 F。
- 0.13.156 新增 `list-ordered-empty-successor-chain-lift`：只认领顶层 plain ordered list 中唯一 middle empty item 后至少还有两个 successor 的 Backspace。真实 journal 固化为 2 transactions：第一笔 structural zero-slice `ReplaceStep` 合并空项并在前一 item留下一个 editor-only trailing empty paragraph；第二笔 transaction 含与 successorCount 完全相同的 `ReplaceAroundStep` 链，每一步在自己的 `stepDoc` 上只重写对应 successor wrapper/label，最终把所有后继 ordinal 各减 1。owner支持 removedIndex 1/2、非 1 `attrs.order` 和 2/3 successor，single-successor明确返回未识别并留给0.13.155。raw mapper `preserveTransactionOwnedOrderedEmptySuccessorChain()` 只删除作者空 row并原位改 successor ordinal digits，作者 `)`/`.`、spacing、BOM、CRLF与邻块保持；body/mixed-EOL/wrong-step 或 one-space authored range 无法证明时 `recognized:true + legacyBlocked:true`，阻断 single/broad/legacy。pure、callback/forced、BOM+CRLF、source/save/disk/reopen、负向 retirement、相邻列表矩阵、Journal/Coordinator、完整 preservation、39/39、mixed/heterogeneous fidelity和双 build已通过。专项见 `transaction-journal-list-ordered-empty-successor-chain.md`。下一项进入 nested list split/join/indent/outdent family。
- 0.13.155 新增 `list-ordered-empty-successor-lift`：只认领顶层 plain ordered list 恰为 `[nonempty, empty, nonempty]` 的 RS-72 Backspace。真实 journal 是两笔事务：第一笔 structural zero-slice `ReplaceStep` 把空项并入前项并留下唯一 editor-only trailing empty paragraph，第二笔 `ReplaceAroundStep` 只把原 successor wrapper/label 从 `3.` 改为 `2.`；owner逐步绑定 stepDoc、old/intermediate/final paths和labels，validator只按 exact proof/path忽略该 transient。raw source已从 generic list-subtree adapter中分离，focused owner只调用 `preserveTransactionOwnedSingleEmptyOrderedBackspaceLift()`：删除作者空row并把 successor ordinal前移一位，作者 `.`/`)` delimiter、BOM、CRLF、邻块逐字保持；一空格 authored rows在PM family已识别后range不可证明，触发`recognized:true + legacyBlocked:true`，rich edit保留、warning、无 broad/legacy/Coordinator publication且disk不变。pure、callback/forced、BOM+CRLF + `)`、source/save/disk/reopen、原RS-72长文档、generic subtree、18项相邻list、39/39、mixed/heterogeneous fidelity和双build均通过。专项见`transaction-journal-list-ordered-empty-successor-lift.md`。四项及更长的 multi-successor chain 已由 0.13.156 独立 owner接管。
- 0.13.154 新增 `list-isolated-empty-ordered-lift`：只认领顶层 plain bullet list + 单一空 ordered list + 未变化后继 bullet list 的第一拍 Backspace。真实`joinBackward`是一个structural zero-slice `ReplaceStep`，最小合同`24→26`、generated-input真实文档`40→42`，删除前一bullet closing wrapper与isolated ordered opening wrapper，把空ordered item追加进前一bullet list。为允许`1.` input-rule回调消费后立即Backspace进入Journal，新增list-input-intent lifecycle：只有active且未消费intent阻断结构跟踪，consumed callback-tail不再阻断。空ordered paragraph无可靠source offset，owner用前后两个nonempty bullet paragraph做source-map双锚点，在两block之间证明唯一ordered空row；数字必须匹配PM`attrs.order`，只把作者`1.`/`1)` token替换为前一作者`-`/`+`/`*` token，BOM/CRLF/空行/邻块保持。registry中该family位于first/tail/interior/broad前且`legacyRetired:true`；一空格ordered marker触发`isolated-ordered-lift-row-count / recognized:true / legacyBlocked:true`，warning且disk不变。前置`5c91042`又让tail/broad在显式item`listType`与容器冲突时不认领，保证第二Backspace直接走旧`empty-list-item-removed`而无错误transaction候选。pure/lifecycle、generated-input两拍、direct callback/forced、BOM+CRLF save/reopen、负向门禁、相邻list、39/39、mixed/fidelity与双build均通过。专项见`transaction-journal-list-isolated-empty-ordered-lift.md`。下一family为RS-72 ordered successor/multi-step。
- 0.13.153 新增 `list-empty-item-first-lift`：只认领顶层 plain bullet list 第一空 item 的 Backspace，ordered首空项明确保留给 ordered family。真实 `joinBackward` 为唯一 `ReplaceAroundStep from=8,to=13,gapFrom=10,gapTo=12,insert=0,structure=true`，slice 为 empty `bullet_list` wrapper、`size=1/openStart=0/openEnd=1`；拓扑是 `[empty,right]` → 顶层 editor-only empty paragraph + `[right]` list。raw patch只删除作者第一空 marker row+EOL，BOM/CRLF、successor marker与block gaps逐字保留。该 family不新增 semantic allowlist：共享 comparator已只在doc顶层忽略editor-owned空段。registry位于tail/interior前并`legacyRetired:true`；loose-first source rows在PM family已识别后`recognized:true + legacyBlocked:true`，warning且source/disk不变。RS-84第二拍已迁移为该 transaction owner，第一拍cross-list owner保持。纯合同、callback/forced、BOM+CRLF source/save/disk/reopen、loose-first负例、tail/interior、ordered lift/RS-72、nested/task/cross-list/rapid Enter、generic list-subtree、39/39、mixed/fidelity和desktop/mobile build均通过。专项见 `transaction-journal-list-empty-item-first-lift.md`。下一family是ordered successor/lift。
- 0.13.152 新增 `list-empty-item-tail-remove`：只认领顶层普通 bullet/ordered list 的最后一个空 item，且前一 item 必须只有一个非空 plain paragraph。真实 Backspace 是唯一 `ReplaceStep(structure=true,sliceSize=0)`；以 `- left / - ` 为例为 `from=16,to=18`，精确删除 preceding closing wrapper 与 empty opening wrapper。成功只删作者尾空 marker row + EOL，validator 按 exact tail proof/path 忽略前一 item 新增的一个 editor-only trailing empty paragraph。registry 位于 interior owner 前并 `legacyRetired:true`；loose authored tail row在 PM family 已证明后 `recognized:true + legacyBlocked:true`，warning且source/disk不变。初版相邻门禁发现会抢 RS-63 nested continuation，发布前已收紧 preceding item 必须 `childCount===1`，RS-63 恢复原 `empty-list-item-merged-after-nested-list`。callback/forced、BOM+CRLF、source/save/disk/reopen、loose-tail负例、interior/first-empty控制、ordered lift/RS-72、task/cross-list/rapid Enter、39/39、mixed与异构 fidelity均通过。专项见 `transaction-journal-list-empty-item-tail-remove.md`。下一独立 family 是 first-empty Backspace：真实 `ReplaceAroundStep from=8,to=13,structure=true,sliceSize=1`，会把 editor-only 空 paragraph 提升到列表前。
- 0.13.151 新增 `list-empty-item-remove`：只认领顶层非任务 bullet/ordered list 的唯一 interior empty item。真实 Backspace 必须是一个 closed structural `ReplaceStep` 精确删掉 preceding item closing wrapper 与 empty item opening wrapper；成功 raw patch 只删除作者空 marker row + EOL。validator 仅按 exact transaction proof/path 忽略 preceding item 新增的一个 editor-only trailing empty paragraph。registry 将该 narrow family 置于 broad list-subtree 前并 `legacyRetired:true`；PM family已识别但 loose source rows/range/body不符时 `recognized:true + legacyBlocked:true`，不允许旧 `empty-list-item-removed` 再自愈。纯合同、callback/forced、BOM+CRLF source/save/disk/fresh-profile reopen、loose-list负例、ordered lift/RS-72/cross-list/nested/generated/task/rapid-double-Enter、39/39 probes与异构 fidelity均已通过。专项见 `transaction-journal-list-empty-item-remove.md`。
- 0.13.149（本地提交 `5da0e17`）完成四个 Blockquote family 的 legacy 退役：paragraph/split/join/exit owner 现在将 PM Step/stepDoc 分类失败显式返回 `recognized:false`，而在 family 已完整识别后，将 raw range、作者 quote prefix/separator、正文一致性、Markdown-sensitive输入和semantic proof失败返回 `recognized:true`；生产registry为四项设置`legacyRetired`，共享控制流只阻断后一类，避免 generic `paragraph-emptied`、`middle-block-*`、`diverged-tail-block-append`或行级mapper重新猜测同一事务。真实物理星号负例为`syntax-sensitive-insert / recognized:true / legacyBlocked:true`，编辑留在富文本、显示警告、无legacy/Coordinator publication且磁盘不变；四项正向callback/forced/save/reopen、空引用删除、IME填充、generated scratch与middle transient均全绿。Journal/Coordinator、完整preservation、39/39 probes、异构fidelity、mixed rich/source、desktop/mobile build全部通过。专项见 `transaction-journal-blockquote-legacy-owner-retirement.md`。当前仍未生成或安装0.13.149手测包。
- 0.13.148 完成 `code-block-exit` 并补齐真实产品入口：此前CodeMirror会吞掉`Mod+Enter`并在代码块内继续换行；现在固定不可配置命令`editor.code.exit`仅在非空可见代码块内生效，DOM keydown bridge以NodeView identity/`posAtDOM`唯一映射顶层PM code block，建立临时code-end selection并调用官方`exitCode`，只dispatch其文档事务，普通区域、空块、外部/歧义DOM均fail open。owner要求exact closed ReplaceStep在code block后插入空paragraph，文字只能落在该段；共享journal新增baseOwner/baseFamily/baseReason provenance并与revision/source/canonical一同校验，staged continuation只接受上一revision确由transaction/code-block-exit发布。raw patch复用生产fence range，只在closing fence后插入最终段落，保留作者围栏、info、BOM、CRLF与邻块。真实快速路径是forced pending→staged，自然等待是markdownUpdated pending→staged，立即源码切换是forced pending→staged；coalesced仅由纯owner合同保留。三条Electron路径、全部focused owners、相邻code/list/quote/table UI、39/39 probes、RS-68 5/18/70ms与desktop/mobile build均通过。专项见 `transaction-journal-code-block-exit.md`。当前仍未生成或安装0.13.148手测包。
- 0.13.147 完成 `list-item-paragraph-text-replace` 并收窄 RS-72 transient：顶层 bullet/ordered list 的单一非任务 item direct plain paragraph 由稳定 PM path、完整 ReplaceStep/stepDoc journal、attrs/marks/兄弟/邻块不变共同证明，正文替换或清空只修改作者 raw body，保留 marker、ordered delimiter、BOM 与 EOL；nested/task/marks/多 item/结构 Step/敏感语法均拒绝。RS-72 删除中间空 ordered item后遗留的 editor-only paragraph 只在唯一 old/new topology 与 exact PM path `[topLevel,item,paragraph]` 成立时由 transaction list-subtree proof忽略，候选 source 不写 `<br />`。纯合同、RS-72、mixed immediate switch、空代码块相邻回归、39/39 probes与 desktop/mobile build均已通过。`tail-fence` 的旧全局红确认是 orphan Electron 占用 CDP 9913；共享启动器现预检端口，挂载失败会停止进程并清理 profile，两档回归 exit 0且无端口残留。专项见 `transaction-journal-empty-code-list-paragraph-families.md`。
- 0.13.146 完成 `empty-code-block-backspace-unpack`：空 fenced code block 中物理 Backspace 的完整 `code_block → paragraph` ReplaceStep 与紧随的快速 plain-text Steps 由同一本 revision-bound journal 拥有。空中间态返回 `holdJournal`，不再让零延迟 generic reconcile 或 legacy canonical diff 提前提交；快速 `XY` 由 callback 原子发布，立即切源码或保存由 forced-empty 发布。owner 只删除作者完整 fenced range，保留 BOM、CRLF、tilde/backtick/info、邻块与未编辑字节，且不泄漏 `<br />`。纯合同和双场真实 Electron 已覆盖源码、保存、磁盘、冷重开与零 warning；安装包仍是旧 0.13.131，不可用于验收。专项见 `transaction-journal-empty-code-block-backspace.md`。
- 0.13.145 完成 `table-column-width`：真实长按列边界拖拽在 mouseup 前先 `markUserEdit()`，随后 `persistColumnWidth()` 对 header/body 每行依次 `setNodeMarkup(...colwidth)`，形成单 journal entry、每 row 一个 `ReplaceAroundStep(structure=true)`。owner 要求 simple-grid、唯一 changed column、全部 rows 的 previous/new width分别一致、table/row/cell content与其它 attrs/topology/columns/邻块不变，并逐 Step 在递进 stepDoc 上精确核对完整 cell wrapper range和gap；single/multi-column、mixed widths、多 transaction、text/alignment混改、span、非法 width、source/canonical/doc stale fail closed。GFM没有colwidth语法，成功时source/canonical完全不变、notifyChange=false、只推进Coordinator expectedDoc；semantic gate仅在exact proof/reason和完整cellPaths下忽略对应colwidth，漏path/错reason/伪proof仍严格。本轮修复共享proof sibling reference被误标`[Circular]`、preflight污染first-diff，以及canonical不变forced flush未询问journal三个通用生命周期问题。真实callback与立即源码切换forced-flush、BOM+CRLF、自定义表格spacing、唯一publication、源码/磁盘/dirty不变、当前宽度生效、fresh-profile冷重开恢复自动宽度全部通过；全表格/UI/PDF/issue-86、相邻list/code/blockquote、LF/CRLF/BOM transaction、39/39 probes、异构fidelity和desktop/mobile build全绿。安装包仍是旧0.13.131，不可用来验收。专项见 `transaction-journal-table-column-width-family.md`。
- 0.13.144 完成 `table-column-alignment`：真实列手柄 left/center/right 按钮建立整列 CellSelection，`setCellAttr('alignment', direction)` 在单 transaction 中按 header/body rows 产生多个 `ReplaceAroundStep(structure=true)`；每步在递进 stepDoc 上只替换目标 cell wrapper attrs，gap 保留全部内容。owner 要求唯一 changed column、所有 rows 从同一旧 alignment 变为同一新 alignment，table/row/cell content、其它 attrs/topology/columns/邻块不变；single cell、多列、alignment+正文、多 transaction、marks/atoms、multi-paragraph、span/colwidth、source/semantic/stale fail closed。raw patch只改作者 delimiter row 的目标 cell冒号，保留 dash数、padding、其它 delimiter cells、header/body rows、BOM/CRLF和邻段；old delimiter必须逐列匹配 previous PM attrs，不从 next canonical形状猜 alignment。真实 left/center/right、callback/forced-flush、source/save/disk/cold reopen、全部 table owners/UI、issue-86、39/39 probes、异构 fidelity、RS-68 5/18/70ms与 desktop/mobile build全绿。复杂 span topology仍未迁移；安装包仍为旧 0.13.131，不能用于验收。专项见 `transaction-journal-table-column-alignment-family.md`。
- 0.13.143 完成 `table-column-insert`：真实 `addColumnBefore` / `addColumnAfter` 在一个 journal entry 中按 header/body rows 产生多个 `from===to` ReplaceStep，每步必须在自己的递进 `stepDoc` 上精确插入同一 column ordinal 的空 cell；old/new rows、attrs 和其它 cells不变，simple-grid 由无 span、等列数、单 paragraph共同证明。raw patch在作者 header、delimiter/alignment row与全部 body rows插入同一 pipe segment，普通行复用相邻作者 cell spacing，delimiter由 transaction-owned `alignment`/兼容 `align` attrs生成；重复 `Value`/`same` 列由 ordinal + paths区分，BOM、LF/CRLF/lone-CR、其它列/行和邻段保持。本轮共享 semantic normalization 同时兼容 standalone `hard_break` 与 `hardbreak` 空占位，文本包围的 hard break仍严格。自然 settle与立即切源码分别经 markdown-updated/forced-flush；纯合同、真实 y-line add button、source/save/disk/cold reopen、全部 table families/UI、issue-86、39/39 probes、异构 source fidelity、RS-68 5/18/70ms与 desktop/mobile build全绿。alignment 已由 0.13.144 独立 owner 迁移，复杂 span仍未迁移；安装包仍是旧 0.13.131，不能用于验收。专项见 `transaction-journal-table-column-insert-family.md`。
- 0.13.142 完成 `table-column-delete`：真实 `deleteColumn` 在一个 journal entry 中按 header/body rows 产生多个 empty `ReplaceStep`，每步必须在自己的递进 `stepDoc` 上精确删除同一 column ordinal 的完整 cell node；old/new rows、attrs 和其它 cells 不变，simple-grid 由无 span、等列数、单 plain paragraph共同证明。raw patch 分别映射作者 header/body cell，并在 header、delimiter/alignment row 与全部 body rows 中删除同一 pipe segment，重复 `Value`/`same` 列由 ordinal + cell paths 精确区分；BOM、LF/CRLF/lone-CR、每行独立 spacing、其它列/行和邻段保持。本轮同时修复 `table_header → paragraph` 未被 source-map 识别的根因。自然 settle 经 markdown-updated，立即切源码经 forced-flush；真实 col handle、source/save/disk/cold reopen、相邻 table owners、issue-86、39/39 probes 与 build 全绿。column insert 已由 0.13.143、alignment 已由 0.13.144 独立 owners 迁移；复杂 span仍未迁移。专项见 `transaction-journal-table-column-delete-family.md`。
- 0.13.141 完成 `table-row-insert`：真实 Milkdown `addRowAfter` 必须形成唯一 `from === to` 的 closed `ReplaceStep`，slice 恰含一个等列数空 body row；old/new row stream、Step insertion boundary、slice/expected row equality、simple grid 和 semantic/list-slot gate共同证明所有权。raw patch 不写 canonical 整表，而是逐 cell 映射选中位置前一条非空作者 body row并删除正文 spans，生成保留原 pipes/spacing 的空行模板；header 后首 body row、中间行、EOF 无尾换行、BOM、LF/CRLF/lone-CR均通过。自然 settle 经 markdown-updated，立即切源码经 forced-flush；真实 x-line add button、source/save/disk/cold reopen全绿。非空/已输入 inserted row、同 journal 后续输入、marks、空/multi-paragraph template、span、邻块、source/semantic/stale继续 fail closed。专项见 `transaction-journal-table-row-insert-family.md`。
- 0.13.140 完成 `table-row-delete`：真实 Milkdown `deleteRow` 必须形成唯一 empty `ReplaceStep`，range 精确等于一个 body `table_row` node；old/new table row stream、simple-grid topology、逐 cell PM→source/previous-canonical 映射和 semantic/list-slot gate共同证明所有权。raw patch 只删除选中作者行及其 LF/CRLF/lone-CR EOL，重复行按 ordinal + Step range 精确区分，header/最后 body row、多行/多 transaction、marks、空/multi-paragraph cell、span、邻块、source/semantic/stale 全部 fail closed。真实 Milkdown 行柄+删除按钮在自然 dirty-reconcile 与立即切源码两条路径均经 forced-flush/Coordinator 发布，源码、保存、磁盘和冷重开精确；纯合同另证 markdown-updated boundary。相邻矩阵还修复任意 preservation 分支泄漏 sole-cell `<br />` 占位符，真实 `text<br>text` 保持。专项见 `transaction-journal-table-row-delete-family.md`。
- 0.13.139 完成 `table-cell-plain-text-replace`：stable cell path、table/row/cell/paragraph attrs与 topology不变、完整 ReplaceStep/stepDoc journal共同证明单一单元格所有权；raw patch复用 GFM source-map与 plain-text mapper，重复 cell text按 occurrence定位，只修改目标 cell bytes，作者 pipe/spacing/alignment row、BOM/CRLF、其它 cells和邻段保持，`|`/marks/空/跨 cell/attrs/topology/source/semantic/stale fail closed。真实 callback/forced-flush/source/save/disk/cold reopen和纯合同全绿；安装包仍为旧 0.13.131，不可用来验收。专项见 `transaction-journal-table-cell-family.md`。
- 0.13.138 完成 `blockquote-paragraph-exit`：第一次 Enter 的 trailing empty quote paragraph 由同一 owner 以 source 不变的既有 reason `trailing-empty-blockquote-paragraph-created` transaction-owned 提交 canonical checkpoint；第二次 Enter 的 ReplaceAroundStep 将空段提升为 quote 后同级 paragraph，快速 `XY` 只能继续落在 inserted path。coalesced journal（split+lift+text）、staged journal（pending 已提交后 lift+text）和立即 forced flush 三种真实路径全部在 nested list parent `[1,0]` 上通过，proof paths 为 quote `[1,0,1]`、inserted `[1,0,2]`；raw patch保留作者 `  >   alpha` 并插入 `  XY`，BOM/CRLF、前后列表、源码、保存、磁盘和冷重开精确，零 warning。空退出、marks、邻块、unsupported parent、source/semantic/callback/stale 全部 fail closed。专项见 `transaction-journal-blockquote-exit-family.md`。
- 0.13.137 完成 `blockquote-paragraph-join`：真实物理 Backspace 的 journal 含 structure=false 空 ReplaceStep，纯 `joinBackward` command 为 structure=true；owner 不依赖该 hint，而由宽度 2 的相邻段落边界、空 slice、childCount -1、merged text、stable path、stepDoc 重放和祖先/邻块不变证明所有权。raw patch 只删除作者 left EOL + quote-only separator + right prefix，并把快速 `XY` 后 final merged text 写入左段正文；真实 nested-list path `[1,0,1]` 在 callback/forced-flush、源码、保存、磁盘和冷重开均通过，BOM/CRLF、作者 `  >   ` spacing 与前后列表保持，多引用/marks/邻块/source/semantic/stale 负例 fail closed。专项见 `transaction-journal-blockquote-join-family.md`。
- 0.13.136 完成 `blockquote-paragraph-split`：通用 `classifySingleAnchoredSubtreeChange()` 先证明唯一 changed top-level subtree，再要求其中恰有一个 stable `blockquote` nodePath 承担全部变化；每个 Step 在捕获时 stepDoc 上核对 path 与祖先兄弟。真实 nested-list fixture path `[1,0,1]` 的物理 Enter + 快速 `XY` 已在 callback/forced-flush、源码、保存、磁盘和冷重开两条路径通过，BOM/CRLF、作者 `  >   ` spacing 与前后列表保持；多引用同时变化 fail closed。引用正文 owner 同步复用该 path 机制。专项见 `transaction-journal-blockquote-split-family.md`。
- `SourceSyncCoordinator` 阶段 A 的核心生命周期已在 `0.13.125` 工作树完成，属于行为保持型
  架构抽取、没有消费新 patch 版本。普通 `markdownUpdated`、forced flush、transaction-first
  early/late authority 已共用 revision-bound candidate/proof/validation/Publisher；transaction
  proof 组装位于 `lib/source-sync/editor-bridge.js`，host callback 抛错会回滚 source/canonical
  refs；validation 不提前 trust，只有成功 commit 后才建立 checkpoint；Coordinator 只保留最近
  candidate ID。inline-code、frontmatter 与 Slash code/math 已作为首批 post-Phase-A 专项入口迁移；其它 direct publication 仍登记在
  `source-sync-coordinator-phase-a.md`，不得误写为全部迁移完成。
- 0.13.131 的 RS-86 修复真实长会话 mixed-marker bullet 中“中间项末尾快速连续按两次 Enter，空 bullet 在 source callback 前立即提升为顶层空段”时后继项被误删的问题。0.13.130 正式安装版 PID 258 trace 在 2026-08-27 04:02:31.385 line 332 首发 `source-document-mismatch`：第一拍在 `- 12312` 后创建位于 `- 1\\. 色粉色分` 前的空 bullet，第二拍在延迟 callback 前把它退出为顶层空 paragraph；列表拆分后后继项正文不变，但 live canonical marker 从长期 PM 树中的 `-` 重序列化为 `*`，形成 `- 12312\n\n<br />\n\n* 1\\. 色粉色分`。旧 `empty-list-item-removed` 因 marker 漂移扩大 common-change，line 331 错误删除非空后继项。新增严格 raw owner `preserveCoalescedEmptyBulletExitBeforeSibling` / reason `coalesced-empty-bullet-exit-before-sibling`：只接受唯一顶层非任务 middle/right bullet pair、一个未缩进 `<br />` 原位插入、middle 逐字不变、right 仅一字符 token 变化、两个新 gap 与旧 gap 完全相同、前缀/后缀 byte-identical、source 可见正文 pair 唯一且不在 fence；命中后作者源码完全不变，只推进 canonical baseline。该 family 不新增 semantic 例外，也不加入 generated-scratch/forced-flush allowlist。PID 258 line 331 完整长文档三态直接回放命中，后继项与目标局部字节保留；完整 markdown-preservation、source probes 39/39、source transaction、RS-51/54/63/68/82/83/84/85、structure fingerprint、异构 source-fidelity 与 desktop build 均 PASS。普通 all-`*` 物理快速双 Enter 控制组继续由 `middle-empty-block-created` 认领，专用 owner 不抢占，source/save/cold reopen 稳定。详见 `rapid-double-enter-bullet-exit-before-sibling-regression.md`。
- 0.13.130 的 RS-85 修复真实分叉长文档中“第二个顶层 ordered 父项正文已清空但仍持有 nested ordered child，再按 Backspace 并入前一项”的源码锁定。0.13.129 PID 94298 trace 在 2026-08-26 17:03:36.558 line 589 首发 `source-document-mismatch`：最后一拍 PM 删除空 `2.` 的 list-item 边界、把 nested child `如何电话` 移入 `1. 是共生共荣`，并在正文与 child 之间保留一个 Markdown 无法编码的 editor-owned 空 paragraph。旧 `empty-list-item-removed` 已正确只删除 authored `2. ` 行且 `listSlotsMatch=true`，但 strict semantic comparator 因该不可编码空段得到 `semanticOk=false`。新增严格 raw owner `preserveEmptyOrderedItemBackspaceMergeBeforeNestedList` / reason `empty-ordered-item-merged-before-nested-list`，只接受唯一顶层 ordered left、连续空 sibling、未变化 nested ordered child、next 空段与 child 同缩进、目标命中真实 change range、left 前缀和 child 后缀 byte-identical、source 唯一 compact 三元组且不在 fence；只删除 authored 空父项行。semantic gate 仅为该 reason 允许一侧全篇唯一的“非空 paragraph→空 paragraph→ordered_list” transient，且另一侧必须零候选。独立审查曾发现初版会在每个 list item 各忽略一次，发布前已收紧并补入“同一项多个候选、不同项各有候选、两侧候选错位、正文中段、bullet child”反例，全部 fail closed。PID 94298 line 591 真实三态直接回放命中；source transaction、完整 markdown-preservation、source probes 38/38、RS-56/63/68/72/82/83/84、异构 source-fidelity、desktop/mobile build 均 PASS。`test:empty-ordered-parent-before-nested-backspace-ui` 从空文档真实逐键建立现场并物理执行四次 Backspace，已在开发入口、dist 二进制和 `/Applications` 正式安装副本三次通过专用 owner、`semanticOk/listSlotsMatch/ok=true`、零 warning、精确 source/save/cold reopen。详见 `empty-ordered-parent-before-nested-backspace-regression.md`。
- 0.13.129 的 RS-84 修复真实分叉长文档中“反向选区跨 bullet→ordered→bullet，连续按两次 Backspace”的双拍事务。0.13.128 PID 90936 trace 在 2026-08-26 16:07:25.136 line 29 首发 `unmapped-diverged-list-batch`：选区从 `- 看了呢分` 正文开头跨过独立 `2. 斛律v哦` 到后续 `- u高科技` 正文末尾，PM 一次 replace 合法留下 `* <br /> / * 1\\. 色粉色分`；旧 broad mapper 却把三棵列表分别对账而无法原子认领。第一拍未推进 baseline 后，16:07:25.620 line 35 的第二拍继续使用 stale source/canonical，只删除首个 authored bullet 并触发 `source-list-structure-mismatch`。新增严格 raw owner `preserveCrossListSelectionDeleteToEmptyBullet` / reason `diverged-cross-list-selection-delete-to-empty-bullet`，仅在唯一顶层非任务 bullet→ordered→bullet 三行被一个同 token 空 bullet 原位替换、canonical 前后 byte-identical、两处 block gap、左右可见锚与 source target 唯一且不在 fence 时认领；只把三行 authored range 替换为首行作者 bullet prefix。首拍正确提交后，第二拍继续由既有 `empty-list-item-removed` 拥有。真实自动化在此还发现一个原 warning 没暴露的字节漂移：第二拍虽 `semanticOk/listSlotsMatch/ok=true`，旧 prefix collapse 会把 `正文\n\n- surviving` 静默压成单换行；0.13.129 因而收窄为空项位于普通块后新列表首项时保留作者 block gap，列表内部 placeholder 仍按旧合同压缩。PID 90936 两拍已按修复后的正确 canonical baseline 链式回放；markdown-preservation、source probes 37/37、普通/嵌套空 bullet、single-empty ordered、RS-59、RS-68 5/18/70ms、RS-72、RS-82、RS-83、dash+Space、source transaction 和异构 source-fidelity 全部 PASS。`test:cross-list-selection-delete-empty-bullet-ui` 使用真实 backward DOM selection 与两次物理 Backspace，已在开发入口、dist 二进制和 `/Applications` 正式安装副本三次通过逐拍 owner、`semanticOk/listSlotsMatch/ok=true`、零 warning、精确 source/save/cold reopen。详见 `cross-list-selection-delete-empty-bullet-regression.md`。
- 0.13.128 的 RS-83 修复真实分叉长文档中“退出有序列表后连续输入三个连字符创建 thematic break”时，零可见结构变化被通用 mapper 错粘到上一列表项正文的问题。0.13.127 PID 85614 trace line 630 在 2026-08-26 15:17:23.243 首发 `source-document-mismatch`：两次 Enter 已退出 `3. 3fresh` 列表，第一个 `-` 正确发布为独立 `\\-`，第二、第三键合并触发 PM `hr`，canonical 为独立 `***`，旧 `locally-aligned-change` 却生成 `3. 3fresh***`。新增 `preserveEscapedStandaloneThematicBreakInputRule` / reason `escaped-standalone-thematic-break-input-rule`，仅在 canonical 除唯一独立 `\\-`→thematic-break 行外 byte-identical、上下 block gap 与 source 可见邻居唯一、目标不在 fence 内时认领；只把 authored 行改为用户实际输入风格 `---`，歧义、普通 `--x` 和同 callback 其它编辑继续 fail closed。完整 PID 85614 约 5.5 MB trace line 633 三态直接回放命中；markdown-preservation、source probes 36/36、build、RS-59、dash+Space、RS-82、source transaction、异构 source-fidelity、RS-68 5/18/70ms 全部 PASS。`test:middle-thematic-break-input-rule-ui` 已在开发入口、dist 二进制和 `/Applications` 正式安装副本三次通过两次 Enter setup、独立 `\\-` 中间帧、coalesced hr、forced flush、`semanticOk/listSlotsMatch/ok=true`、零 warning、精确 source/save/cold reopen。详见 `middle-thematic-break-input-rule-regression.md`。
- 0.13.127 的 RS-82 修复真实分叉长文档中“非空 bullet 段首项 Backspace 并入左侧 ordered list”的首发 `unmapped-diverged-list-batch`。0.13.126 PID 81568 trace line 13 显示两个 non-empty bullet items 合法变为连续 `3.`/`4.`；后续独立 ordered list 的 `1.`→`1)` 是 CommonMark 冷重开保持列表边界所需的 parse-safe separator，不是可忽略 serializer drift。严格 raw owner 只改 moved markers 与必要 following delimiter，错误 ordinal、无关正文编辑、source 歧义均 fail closed，并在 `normalizeOrderedListDelimiters()` 前保留 separator 证据。专项 `test:nonempty-bullet-backspace-merge-ordered-ui` 已在开发入口、dist 二进制和 `/Applications` 安装副本三次通过 owner、semantic/list proof、零 warning、精确 source、save 与 cold reopen；相邻 empty-bullet family、RS-54、完整 list conversion、source transaction、rich-list、35/35 probes、异构 source-fidelity UI 与 RS-68 5/18/70ms 也全部通过。详见 `nonempty-bullet-backspace-merge-ordered-regression.md`。
- 0.13.126 的 RS-81 是 parser/SourceSync 边界修复：inline-code value-change 已删除直接 refs/App 写回并改走 Coordinator；整段 paragraph/heading 的精确 triple-backtick inlineCode 形状，以及无 info/meta/content 的裸第三反引号中间 fence，按 mdast 原始 byte slice 恢复为普通 text。普通 inline/fenced code 不受影响；专项见 `literal-triple-backtick-parser-regression.md`。
- 0.13.125 的 RS-80 是 legacy 列表 owner 的事务归属修复：已发布的 `\\-` marker 在
  Space input rule 中按同级 ordinal 定位对应新 item，只做局部 raw patch；它不是列表链路
  的 transaction-first 迁移。完整边界见 `transaction-source-sync-architecture.md`、
  `source-sync-save-recovery.md` 和 `rich-source-fidelity-bug-family.md`。
- **0.13.x 系列主线（自 0.12.69 之后）**：
  - **原文保真与空段落硬不变式**：空段落 `<br />` 占位绝不允许进入作者源码（`withoutStandaloneEmptyBlockLines` 在 `preserveRichMarkdownSource` 出口强制剥离）；空段落映射不得要求全文可见流相等、不得被无关空段落否决；连续空段落映射不递归。系列提交 `bb5b9f4` → `cfae66a`。
  - **可见流分叉单块回退**：源码与 canonical 可见流分叉（如行中 `* ` 使 remark 拆成列表项）时，局部对齐与行区域映射都会失败并 fail-closed。`preserveDivergedBlockTextChange()`（`lib/markdown-preservation/regions.js`）只处理单 canonical 块：先反转义 canonical 拼写（`\*`→`*`、`&#x20;`→空格），0.13.30 起优先用 source/canonical 等数量非空块的 ordinal 定位；候选数量不等才退回全文唯一子串，仍歧义则拒绝写回。初始提交 `abb6d09`，最新复盘见 `diverged-ordinary-save-regression.md`。
  - **整文档清空不再复活（0.13.14）**：富文本删除全部内容（canonical 为空）时，`preserveRichMarkdownSourceCore` 新增 `document-emptied` 分支直接清空源码，杜绝分歧源码 fail-closed 复活旧内容。详见 `full-doc-delete-caret-settle-regression.md`。
  - **模式切换光标守卫（0.13.14）**：settle 重试只重复自己上次写入的选区，选区漂移即用户接管；`followSourceCaret` 不再依赖合成事件标志（键盘/IME 路径同样聚焦跟随）。详见 `full-doc-delete-caret-settle-regression.md`。
  - **序列化转义反转义（0.13.15–0.13.16）**：remark-stringify 把行首第一个空格序列化为 `&#x20;` 实体、波浪线转义为 `\~`。所有 canonical → 源码翻译点（`adaptCanonicalRegionToSource`、scratch/new-document、列表 direct-join）统一经 `canonicalTextToSource` 还原为作者字面拼写（`&#x20;`→空格、`\~`→`~`）。**全量转义形态清单见 `canonical-escape-audit.md`——新增转义处理前必须先读它**；`\\` 因行尾硬换行语义刻意不动。
  - **缩进上下文的空格实体回归（0.13.21）**：旧版 `canonicalTextToSource` 把任何四空格或 Tab 开头的 canonical 行都当作 indented code，导致普通顶格测试通过、但列表续行/嵌套块中的 `&#x20;` 仍直接进入源码。现在只依靠 fenced code、inline code、HTML 和 source-aware literal region 判定字面区，结构缩进不再短路反转义；纯函数覆盖四空格、Tab、列表续行，UI 覆盖已有文档、清空重写、真正空文件、保存和完整重开。
  - **连续空格与模式切换共同根因（0.13.22）**：真实 CGEvent 证明第 3 个 whitespace-only canonical callback 会误走 `structural-line-change`，删除段落边界并污染后续增量。现在纯空格阶段只推进 baseline，首个可见文字才一次提交；不能直接写四个以上 ASCII 空格（会变代码块），故按本机 Typora 实测采用不可见 `U+200B` 哨兵。解析插件剥离、visible map 忽略、caret map 同步处理，保存/重开仍恢复。详见 `leading-space-mode-switch-regression.md`。
  - **数字点列表与多列表同步（0.13.17–0.13.18）**：`- 1. 甲乙` 被 remark 解析为嵌套有序列表，canonical 与 source 可见流永久分歧，列表内编辑曾 fail-closed 丢失。`preserveDivergedNestedListChange` 现在以 canonical/source 的**顶层列表块**做 ordinal 对齐，再以 `token + text + indent` 项序列执行结构级 diff；覆盖删除数字 marker、Backspace 多级提升、后续含内联加粗列表以及 Enter 拆分。延迟 `markdownUpdated` 同时包含多个 `- / + / *` 列表操作时，`preserveBatchedListBlockChanges(requireMultiple: true)` 会先做多块原子对账，避免单列表处理器提前返回、marker 被统一或编辑丢失。完整根因、事故记录和回归矩阵见 `nested-list-sync-bug-handoff.md`。
  - **跨块删除兜底（0.13.18）**：分歧文档里**跨多个 canonical 块的纯删除**（拖选删尾部、一次删多个列表树）此前 fail-closed 回退，删除静默消失、保存后重开复活。新增 `preserveDivergedVisibleDelete`（`regions.js`，diverged 分支最后）：删除区间前 24 可见字符唯一锚定 + 删除内容逐行去标记校验。详见 `canonical-escape-audit.md`。
  - **字面列表标记与反引号强制边界（0.13.25–0.13.26）**：稳定列表行用去转义语义视图 + raw boundary map 回写 `1.` / `1)` / `-` / `+` / `*` 字面正文；反引号部分删除改为读取完整 next canonical line，重复行按 ordinal，独立 `<br />` 空段落两侧按同行映射。行内代码事务从 live `view.state.doc` 序列化，失败不推进双快照。详见 `list-item-literal-marker-escape-regression.md` 与 `backtick-source-sync-lock-regression.md`。
  - **列表转换与行内代码闭合交互（0.13.27）**：列表 marker 转换的正文比较先统一 `U+200B + spaces` 与 `&#x20; + spaces` 的 canonical/source 语义，但只输出 marker 变化；行内代码不再在首个中文字符时提前激活，只在最终闭合反引号输入后创建 mark，并支持首尾方向键退出。``` + Space 恢复代码块输入规则，空代码块 Backspace 后立即对账 live doc。真实 IME、逐键 fence 删除、保存和新进程重开均有专项回归。
  - **新文档三反引号原文保真（0.13.28）**：generated scratch 与空文件首次编辑全部属于本次用户输入，改由 `canonicalFreshTextToSource` 还原 Markdown 正文 serializer punctuation；真正的 fenced/inline code 与 HTML literal 仍保持字节不动。新增 `test:literal-triple-backtick-source-ui`，逐键输入 delimiter、真实中文 IME、切源码、保存和完整进程重开。
  - **桌面外部拖入打开（0.13.29）**：Finder / 文件资源管理器拖入一个或多个文件时复用标签打开链路，拖入目录时加入多根工作区；图片落在富文本正文仍由编辑器插图链路处理。Renderer 只通过 preload 的 `webUtils.getPathForFile()` 取得路径，目录判定留在主进程，移动端 capability 明确关闭。详见 `desktop-drop-open.md`。
  - **复杂分叉文档普通保存（0.13.30）**：文档其他位置存在嵌套 `- -`、字面三反引号、空引用和重复短文本时，普通正文追加文字不再因全文子串重复而误报“保存已暂停”。`preserveDivergedBlockTextChange` 先按 source/canonical 等数量块 ordinal 对齐；数量不等仍走旧唯一匹配或 fail closed，绝不整篇覆盖。详见 `diverged-ordinary-save-regression.md`。
  - **复杂分叉列表普通保存（0.13.31）**：0.13.30 的 fixture 虽含 `- -`，但只编辑了独立正文。source 第二个 `- ` / `+ ` / `* ` / ordered marker 会被 canonical 消费为嵌套语法；`preserveDivergedNestedListChange` 现在在比较和 raw offset 中跳过恰好一层该前缀，输出仍保留作者 marker。专项必须同时编辑独立段落、嵌套项和后续兄弟项。
  - **重复引用后的 raw 位置错写（0.13.32）**：前部结构分叉后，`preserveMiddleEmptyBlock` 不得复用 canonical 的全文 visible-line index；重复“测试”引用会让错误位置伪装成有效邻接。完全对齐才可直取索引，分叉改用相邻 pair + block kind + equal-count ordinal，失败继续 fail closed。专项还必须从第三个重复引用按两次 Enter 退出并逐字输入唯一末段，直接保存后比较源码、磁盘和冷重开。禁止引入整篇 parse/stringify 语义循环，它会破坏字面列表 marker 与反引号。
  - **引用后空白直接起笔（0.13.33）**：Crepe 在末尾引用后提供的空 `<p>` 可能只序列化为 canonical terminal padding。直接点击该空白起笔是 `previous.length` 处的纯正文追加，不等同于从引用内按两次 Enter；若先走 locally-aligned 零宽 visible offset，会被前面的重复空引用误导。plain append 现提前写入物理文档末尾，结构语法明确拒绝；UI 必须真实点击空段落、逐字输入、直接保存并冷重开。
  - **保存事务 settle 与恢复副本（0.13.34）**：可见 ProseMirror transaction 可能早于 Milkdown 的 `markdownUpdated` / pending input intent 对账。保存和富文本→源码先调用同一 fail-closed flush 并有界让出事件循环重试，不用 canonical 覆盖作者源码；持续歧义时原文件不写，用户可把 live rich doc 另存为 `.horsemd-recovered.md`。专项：`test:editor-flush-settle`、`test:source-sync-recovery`，文档 `source-sync-save-recovery.md`。
  - **事务优先源码同步（0.13.35，方案一）**：新增统一 PM transaction observer、原子 plain-text mapper、真实 step trace、LF/CRLF split 和空块 block hint。专项测试可用 `window.__hmTransactionSourcePrimary = true` 证明正文/引用/列表项普通文字不经过 canonical diff；生产默认仍不接管。默认接管试验曾被完整段落测试抓到“结构 Enter 后空块首字写错相邻块”，因此新增 quarantine/checkpoint 合同并撤回放行。详见 `transaction-source-sync-architecture.md`。
  - **事务优先源码同步第二阶段（0.13.36，方案一）**：mapper 改为 BOM/CRLF/lone-CR 归一化双视图（字节证明在 LF 视图，输出保留作者拼写）；hint 槽坐标指向完整段落分隔之后；嵌套空 textblock（列表项/引用）拒绝接管；列表输入意图只在当前源快照上重建自己的块，不再覆盖延迟窗口内的跨块编辑；`preserveChangedLineRegion` 零宽行边界粘行根因修复。回归含 LF/CRLF/BOM+CRLF + undo/redo 逐字节、列表意图跨块专项（primary 构建验证、默认构建 SKIP）、全家族矩阵双构建。`test:list-intent-cross-block-ui` 与 `test:source-transaction-sync-ui`（三行尾变体）为方案一专项。
  - **多轮持久化与列表原子提交（0.13.46 候选）**：列表 input intent 在完整 slot 重建、marker 恢复或严格中间空槽列表写回后立即消费，禁止下一次正文回调复用旧快照；批量列表写回必须完整覆盖同一 callback 的后续正文，CRLF 在 `\r` 前插入，0/1 final-EOL 分别保留正确退出列表边界。新增 `test:family-multicycle-ui`（4 轮编辑保存、5 次冷打开，默认/primary 双路径）；第四轮专门在正文与 fence 之间输入“正文 → 有序列表 → 正文”。真实 `123321.md` override 与 20/20 家族矩阵均通过。
  - **斜杠菜单代码块原子同步（0.13.47，子路径完成、家族未关闭）**：稳定复现 `/code` 已写入源码后，slash 菜单先删 query、再创建空 code_block；旧尾部 mapper 只删除 `/code`，没有写入 fence，后续代码/尾文/前文编辑全部从错误基线继续。现于命令前捕获精确 authored 行，命令后只序列化当前 code_block 并验证成对 fence 后原子替换。`test:tail-fence-ui` 在 40ms 菜单选择后不做 checkpoint，连续编辑三块，再验证源码、保存和冷重开；但安装包真实长会话继续编辑后仍能再次分叉，见 RS-41，不得把该专项绿色结果描述为整体修复。
  - **源码/富文本架构迁移状态**：当前以“保留 ProseMirror、逐类迁移 transaction→source”为主线；transaction-first 已进入受限 authority 阶段，但默认发布仍由 legacy preservation 主导。CodeMirror Live Preview 仍是长期备选，不是当前 bug 修复的默认方向。迁移时必须按“分类器 → raw range → candidate → semantic/structure proof → 原子发布”推进，完成一类后再删除对应 legacy owner。
  - **代码块体验**：编辑器代码块行号（不透明背景、贴左、全高、右侧分隔竖线）、**PDF 导出代码块带行号**、表格单元格单击直接编辑。提交 `5094e0b`、`7b2e50b`、`9bc9412`、`a45f958`。
  - **原生 HTML 表格自适应**：带 `width` 属性的 HTML 表格恢复作者语义（`100%` 跟随容器、固定像素收缩），`td/th` 允许列收缩，表格内图片按单元格宽度显示，不再横向溢出。提交 `8a98b5f`。
  - **文档位置记忆（#111）**：重开文档恢复上次光标与滚动位置；按路径存 `{offset, len, scrollTop}`，长度不匹配（外部修改）不恢复。提交 `5fe4af4`。
  - **源码+预览双栏**：左源码唯一编辑、右富文本只读预览，双向滚动/光标同步（0.13.x 早期落地）。
- 最近关键提交：
  - `29fffe5 docs: record code-block fence "swallowing" investigation`
  - `5fe4af4 feat(editor): restore the last caret/viewport when reopening a document`（#111）
  - `8a98b5f fix(editor): raw-HTML tables follow the writing-area width`
  - `a45f958 style(editor): full-height code-block line numbers`
  - `9bc9412 style(editor): code-block line numbers flush against the block edge`
  - `abb6d09 fix(editor): diverged-stream rich deletions must reach authored source`
  - `5094e0b feat(editor): click-to-edit table cells and code block line numbers in PDF`
  - `cfae66a fix(editor): enforce empty-paragraph <br /> invariant at the source boundary`
  - `606bfc6 feat(editor): add source rich split preview`
- 最近完整验证：
  - **0.13.47 代码块连续编辑候选**：在真实 `123321.md` 的临时副本上分别验证 `/code` 40ms 快速选择、350ms 等待选择、三反引号 input-rule 与字面 fence。创建代码块后不做中间 checkpoint，继续修改代码、代码块后的正文和前面的列表项；源码、保存文件、冷重开均保持完整且唯一 fence，三类块结构与内容一致。`test:tail-fence-ui` 还在 `/Applications/HorseMD-0.13.47-test.app` 安装包上通过。纯函数、两时序 slash 门禁、family multicycle、transaction LF/CRLF/BOM、列表、代码围栏删除、字面反引号、空段落/空引用、raw-offset/source-map、桌面与移动构建均通过；独立 code-reviewer 复审放行。
  - **0.13.46 已安装工作区**：默认生成 fixture 和真实 `123321.md` 临时副本均完成 4 轮继续编辑/保存、5 次冷打开；release-default 与 transaction-primary 两条路径逐字一致。第四轮曾真实抓到 middle empty slot 创建有序列表时连续 `visible-stream-mismatch`，修复后加入 LF/CRLF（禁止 lone `\r`）纯函数门禁。4 个真实文件 × 5 操作的追加/保存/删除/重开矩阵 20/20；列表新建/转换、continuous、四档 chaos、反引号删除、空段落/空引用、全文删除、前导空格、source probes、LF/CRLF/BOM+CRLF transaction、raw-offset/caret/source-map 全过。桌面、移动与 `dist:dir` 构建通过；`/Applications/HorseMD.app` 已核验为 0.13.46，app.asar 含 `middle-empty-block-list-filled`，运行进程来自该路径。旧 0.13.45 备份：`/Applications/HorseMD-0.13.45-backup-1786416290.app`。
  - **0.13.33 当前工作区（未提交）**：用户真实文件稳定复现“引用后直接点击空正文 → 富文本有字 → 保存后前面出现 `>新增文字`、末尾丢字”。新增第六个复杂分叉直接保存场景后，0.13.32 先红、修复后绿；纯函数增加 diverged quote + trailing plain append 合同，并在用户当前已编辑文件副本上用真实鼠标点击、逐字输入、直接保存、切源码再次通过。源码保真、段落、空段落/空引用、全文/局部删除、所有列表输入/转换/任务、反引号/代码围栏、前导空格、真实 IME、raw-offset、continuous、mixed transaction、长文档与四组 chaos 均通过；桌面/移动/guide/dist 通过。覆盖安装 0.13.33 后，安装包再通过引用后空白直接起笔、字面 marker、反引号、前导空格、mixed transaction 与全文删除。`test:source-rich-split-ui` 的首字符自定义光标像素断言独立失败（三次一致），本轮未改 CSS/双栏逻辑，须作为单独视觉回归排查，不能为追求全绿混入本次保存修复。
  - **0.13.32 当前工作区（未提交）**：保存了 0.13.31 长会话的 live ProseMirror 与损坏磁盘证据，确认唯一末段 `ceeavvß/` 被写进较早的重复引用。修复 `preserveMiddleEmptyBlock` 在 visible stream 分叉时复用全文 ordinal 的错误；专项扩为五个独立场景，尤其包含同引用三段批量编辑和从第三个重复引用按两次 Enter 退出后逐字输入唯一末段。纯函数、source map/text、source fidelity、空段落/空引用、全文/局部删除、全部列表输入与转换、任务列表、反引号/代码围栏、前导空格、真实 IME、raw-offset、长文档、continuous、mixed transaction 和四组 chaos 均通过；桌面、移动、guide 与 dist 通过。覆盖安装 0.13.32 后，安装包可执行文件再次通过复杂分叉直接保存、字面列表 marker、反引号删除、前导空格和 raw-offset 五组高风险回归；运行进程来自 `/Applications/HorseMD.app`，app.asar 含本轮 `sourcePairs` 修复标记。
  - **0.13.31 当前工作区（未提交）**：0.13.30 的自动化 fixture 含 `- -`，但只实际编辑独立段落，用户手测继续触发保存暂停。现已稳定证明 source 第二个 `- ` 被 canonical 消费为嵌套 marker，而旧项序列只剥离数字 marker。`lists.js` 统一识别一层 ordered/bullet 嵌套前缀；纯函数覆盖嵌套项和后续兄弟项，UI 专项对独立段落/嵌套项/兄弟项分别执行直接保存、源码、磁盘和冷重开。27 组家族矩阵（含真实 IME composition）、桌面/移动/guide、dist 通过；覆盖安装 0.13.31 后，三目标复杂保存、IME、字面 marker、代码围栏四组安装包回归通过。首次 `open` 复用了安装前旧 PID，已强制结束并确认新进程路径、启动时间及 app.asar 版本/修复标记；以后仍不得只看 Info.plist。
  - **0.13.29 已发布基线**：完整富文本 ↔ 源码家族矩阵全部通过，包括纯函数映射、逐字段落/列表/反引号、空段落/空引用、模式切换光标、保存与完整重开、混合事务、长文档、源码 + 预览、连续/嵌套写作和四组 chaos；桌面拖入专项、主进程文件系统、图片拖放边界、侧栏创建、桌面/移动构建、guide 检查和三平台打包均通过。GitHub Release `v0.13.29` 已发布；后续发现的 RS-30、RS-31 分别属于 0.13.30、0.13.31 修复，不得回写 0.13.29 标签。
  - **0.13.28 当前工作区（未提交）**：新增 generated scratch / empty-file 字面三反引号回归。纯函数、真实 IME 行内代码、逐键三反引号源码/保存/完整重开、fence 删除、new source/new document list、source fidelity、raw-offset、source-map、35/35 probes、leading-space、IME、列表转换/字面 marker、continuous 与四组 chaos 全部通过；桌面、移动和 guide 构建通过。`dist/mac-arm64/HorseMD.app` 与 `/Applications/HorseMD.app` plist 均核验为 0.13.28，安装后的 app 再跑字面三反引号和行内代码 UI 回归通过，运行进程来自 `/Applications/HorseMD.app`。旧 0.13.27 备份位于 `/tmp/HorseMD-0.13.27-backup-20260809-072510.app`。
  - **0.13.27 已安装基线**：`test:markdown-preservation`、列表转换（含 `U+200B + 5 spaces`）、真实中文 IME 行内代码闭合、方向键退出、单/三反引号删除、``` + Space→Backspace→快速正文、source fidelity、raw-offset、source-map、35/35 probes、leading-space、IME、continuous 与四组 chaos 全部通过；桌面、移动和 guide 构建通过。旧 0.13.26 备份位于 `/tmp/HorseMD-0.13.26-backup-20260809-070148.app`。
  - 0.12.46–0.12.69 的历史验证（`test:mermaid-paste-ui`、`test:issue-98-ui`、`test:list-conversion-ui`、`test:source-rich-split`、`test:settings-ui`、云同步专项等）仍有效，命令见下文第 7 节。
- 真实大文档回归依赖本机文件：
  - `/Users/yangtingyi/vibe_everything/置身钉内/MinerU_markdown_置身钉内_14.34.50_2064164636132720640.md`
  - `/Users/yangtingyi/vibe_everything/电脑档案.md`

## 1. 先了解用户的工作方式

用户非常重视“真的改好”和“真实环境验证”。给他测试之前必须做到：

- 不要让用户测旧版本。每次请用户手测前，先从当前源码重新构建、安装、启动，并确认运行路径。
- 每次交付给用户测试的普通改动都必须升级 patch 版本，包括小功能、bug 修复、交互和视觉调整（例如 `0.12.0` → `0.12.1`），不能让不同源码继续使用同一个版本号。只有用户明确认定为独立“大功能/模块”时才升 minor（例如 `0.12.x` → `0.13.0`）；代理不能自行把一般功能算作 minor。
- 教程站的 `guide/package.json` 表示已发布教程与截图基准，不随本地测试包自动升级；页面可单独标注较新的测试功能版本。`npm run guide:check` 只禁止应用版本低于教程基准，避免把尚未发布的下载文件和截图伪装成新版本。
- 一个可手测的大功能完成并通过专项验证后，如用户没有要求暂停或改方向，默认立即构建、安装、启动当前源码版本交给用户验收；不要等待用户再次要求“打最新包”。
- 不要只说“理论上可以”。涉及 UI、PDF、编辑器、模式切换、表格、图片、移动端时，要用自动化或真实 app 复现。
- 自动化测试不能抢用户的 macOS 键鼠和前台窗口。通过
  `scripts/lib/electron-test-app.mjs` 启动时保持默认 `background: true`；
  只有人工观察或教程截图才显式使用可见窗口。
- 输入规则、Enter/退格、模式切换后立即输入和源码保真必须逐字符派发，优先
  使用 `scripts/lib/human-input.mjs`。批量 `Input.insertText` 只能用于粘贴、
  数据准备或与逐键行为无关的测试；中文逐字提交不能代替真实 IME composition。
- **真实人工复现源码/富文本分叉时，启动进程必须带 `--horsemd-input-trace`。**
  `ELECTRON_ENABLE_LOGGING=1` 只能补 Electron/Chromium 日志，不能替代 HorseMD 的输入/事务
  trace；没有该参数时，一旦提示“源码与富文本不一致”，事后通常无法恢复首个错误的
  `source / candidate / canonical`。以后让用户做真实操作前先确认 Electron argv 已包含该参数，
  再开始复现，优先分析第一次 integrity failure，不要只看最后的保存暂停提示。
- 不要把大文件、小文件、富文本、源码模式混为一谈。HorseMD 很多 bug 只在真实大文档、表格、代码块、LaTeX、远程图片、源码/富文本双向切换里出现。
- 不要轻易重写敏感状态机。源码/富文本切换、dirty 状态、保存、PDF 预览、编辑器生命周期都已经踩过坑。
- UI 需要“高级、优雅、和谐”。如果改视觉，至少检查浅色、深色、莫兰迪主题和窄屏，不要只看一个默认主题。
- 用户会直接指出不满意的点。接受反馈，回到代码和真实测试，不要争辩。
- 提交要聚焦。用户要求提交时再提交；不要擅自推送、发布、关闭 issue，除非他明确说。
- 发给用户验收的 macOS app 必须杀旧进程、覆盖 `/Applications/HorseMD.app`、清 quarantine、启动并验证 `app.asar` 包含本轮标记。

常用安装验证命令：

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:dir

APP_SRC="/Users/yangtingyi/vibe_everything/horseMD/dist/mac-arm64/HorseMD.app"
APP_DST="/Applications/HorseMD.app"
BACKUP="/tmp/HorseMD.app.before-$(date +%Y%m%d-%H%M%S)"
pkill -f "$APP_DST/Contents/MacOS/HorseMD" 2>/dev/null || true
if [ -e "$APP_DST" ]; then mv "$APP_DST" "$BACKUP"; fi
cp -R "$APP_SRC" "$APP_DST"
xattr -dr com.apple.quarantine "$APP_DST" 2>/dev/null || true
open -a "$APP_DST" --args --user-data-dir=/tmp/horsemd-latest --remote-debugging-port=9222
plutil -extract CFBundleShortVersionString raw "$APP_DST/Contents/Info.plist"
ps -ax | rg "HorseMD.app/Contents/MacOS/HorseMD"
```

## 2. 项目是什么

HorseMD 是一个 Typora 风格的 Markdown 编辑器：

- 桌面：Electron + Vite + React
- 编辑器：Milkdown Crepe / ProseMirror / CodeMirror
- 移动端：Capacitor，复用 renderer
- 用户教程站：`guide/`，VitePress
- 官网/下载页：`website/`

核心产品原则：

- 一个窗口内多标签，而不是每个文件一个进程。
- 富文本与源码模式都必须可用，且切换时光标/视口稳定。
- Markdown 源码要尽量可读，Review 标记、链接、图片、表格等都要能 round-trip。
- 大文档优先稳定和不卡，再谈花哨能力。
- 桌面和移动共用 renderer，平台能力通过 `window.api.capabilities` 和 `window.api.platform` 隔离。

## 3. 入口文档

建议阅读顺序：

1. [AGENTS.md](../AGENTS.md)：短规范，必须遵守。
2. [CLAUDE.md](../CLAUDE.md)：历史更长、更细的 AI/开发者指南。
3. [architecture.md](./architecture.md)：模块、进程、状态流。
4. [features.md](./features.md)：功能到具体文件的映射。
5. [manual-test-checklist.md](./manual-test-checklist.md)：人工验收基线。
6. [development.md](./development.md)：构建、CDP、发布验证。
7. [handoff-mode-switch.md](./handoff-mode-switch.md)：源码/富文本切换根因和修复历史。
8. [markdown-source-preservation.md](./markdown-source-preservation.md)：原始 Markdown 保真合同、粘贴边界与 Live Preview 远期决策。
9. [rich-dirty-indicator-regression.md](./rich-dirty-indicator-regression.md)：富文本未保存提示的 200ms 防抖根因、即时反馈合同和回归命令。
10. [source-sync-save-recovery.md](./source-sync-save-recovery.md)：保存暂停的事务稳定竞态、fail-closed 保护、恢复副本与架构根治边界。
10. [local-markdown-links-regression.md](./local-markdown-links-regression.md)：富文本本地绝对/相对链接跳转、安全 IPC 边界与回归命令。
11. [source-rich-split-view-prd.md](./source-rich-split-view-prd.md)：已实现的“左源码、右富文本”双栏实时预览用户范围、状态和验收标准。
12. [source-rich-split-view-architecture.md](./source-rich-split-view-architecture.md)：双栏同步、滚动联动、保真与性能边界；后续扩展必须遵守。
11. [editor-source-switch-regression-0.12.34.md](./editor-source-switch-regression-0.12.34.md)：段落合并、切换后即时输入、硬换行光标偏移和行内代码边界的联合根因报告。
12. [editor-refactor-strategy.md](./editor-refactor-strategy.md)：编辑器重构边界。
13. [performance-large-doc.md](./performance-large-doc.md)：大文档性能设计。
14. [user-guide-maintenance.md](./user-guide-maintenance.md)：教程站和截图规范。
15. [issue-101-pdf-images-table-density-report.md](./issue-101-pdf-images-table-density-report.md)：PDF 图片二次加载、路径双重编码与表格固定行高的根因。
16. [soft-line-break-display-report.md](./soft-line-break-display-report.md)：普通源码单换行在富文本中显示为空格的根因、显示合同和防回归测试。
17. [pdf-table-layout-fidelity-report.md](./pdf-table-layout-fidelity-report.md)：PDF 表格列宽与行距两次修复的完整事故复盘。
18. [pdf-visual-fidelity-runbook.md](./pdf-visual-fidelity-runbook.md)：所有“编辑器正常、PDF 不一致”问题的工程化排查和验收流程。
19. [long-code-copy-virtualization-regression.md](./long-code-copy-virtualization-regression.md)：长代码块复制截断的虚拟化根因、正确数据源和防回归停止条件。
20. [empty-paragraph-contract.md](./empty-paragraph-contract.md)：空段落 `<br />` 占位与可见流分叉的完整合同；0.13.x 空段落硬不变式的依据。
21. [issues-105-106-save-fidelity-regression.md](./issues-105-106-save-fidelity-regression.md)：0.12.63 保存/原文保真回归（与近期删除回退同族）。
22. [codeblock-fence-investigation.md](./codeblock-fence-investigation.md)：**当前进行中**——用户反馈「插两次代码块保存重开，最后一个代码块吞后面正文」的排查留底：解析机制已确认（` ```正文` 同行走正文会吞后续），但正常插入路径全部复现正常；需要用户提供精确步骤/文件才能定位。改代码前先读它。
23. [issue-104-long-document-mode-switch.md](./issue-104-long-document-mode-switch.md)：长文档模式切换光标偏移（行内公式 atom）根因。
24. [macos-real-input-testing.md](./macos-real-input-testing.md)：用 macOS 底层 CGEvent 在前台逐键输入的真实测试方法（疑难编辑问题的补充手段）。
25. [full-doc-delete-caret-settle-regression.md](./full-doc-delete-caret-settle-regression.md)：富文本「删除全部内容」复活 + 模式切换光标被 settle 重试覆盖 的联合根因报告（0.13.14 修复集）。
26. [canonical-escape-audit.md](./canonical-escape-audit.md)：remark 序列化转义全清单（`&#x20;`、`\~`、`\*`、`\\`、实体、`<br />`）在各保真路径的处理状态与安全边界；新增转义处理前必须先读。
27. [leading-space-mode-switch-regression.md](./leading-space-mode-switch-regression.md)：连续空格中间态如何破坏段落边界、为何 0.13.21 的普通空格方案语义不成立、Typora `U+200B` 对照、解析/映射/保存的完整修复与 CGEvent 证据。
28. [nested-list-sync-bug-handoff.md](./nested-list-sync-bug-handoff.md)：数字点列表（`- 1. xxx`）、Backspace 列表提升、后续列表 ordinal 偏移和延迟多列表批次丢失的完整根因、实现边界与回归矩阵。继续修改源码保真管道前必须先读。
29. [rich-source-fidelity-bug-family.md](./rich-source-fidelity-bug-family.md)：富文本 ↔ 源码保真 Bug 家族总账；集中记录产品合同、31 类问题、代码归属、自动化/人工回归、已知边界和后续追加模板。接手任何源码保真问题时先读这篇总索引。
30. [empty-blockquote-removal-regression.md](./empty-blockquote-removal-regression.md)：空引用块被删除后 syntax-only `>` 源码残留、保存重开复活的精确复现、零可见字符根因、局部 raw-gap 修复和验收矩阵。
31. [mixed-rich-source-transaction-regression.md](./mixed-rich-source-transaction-regression.md)：跨顶层块快速编辑时延迟 `markdownUpdated` 合并多处变化、源码保留已删内容或漏掉新增内容的事务边界根因与回归。
32. [list-item-literal-marker-escape-regression.md](./list-item-literal-marker-escape-regression.md)：列表项正文输入 `1.` / `1)` / `-` / `+` / `*` 字面文本后源码多出反斜杠，并连带格式化未编辑列表 marker/空行的根因、修复边界与验收合同。
33. [backtick-source-sync-lock-regression.md](./backtick-source-sync-lock-regression.md)：逐字输入/部分删除/全部删除反引号后，双快照分叉、保存暂停和源码切换锁死的完整事务证据、四个根因与回归合同。
34. [desktop-drop-open.md](./desktop-drop-open.md)：桌面文件/文件夹拖入打开的产品边界、preload/IPC 安全边界、图片插入冲突处理与专项测试。
35. [diverged-ordinary-save-regression.md](./diverged-ordinary-save-regression.md)：复杂既有文档中普通重复短文本编辑被误判为 `visible-stream-mismatch`、保存暂停的根因、等数量块 ordinal 修复与直接保存回归。
36. [transaction-source-sync-architecture.md](./transaction-source-sync-architecture.md)：方案一的 transaction observer、原子 mapper、影子/primary 状态机、空块事故、放行门槛和完整回归顺序。继续架构迁移前必须先读。
35. [release-v0.13.29.md](./release-v0.13.29.md)：从上一正式版 `v0.12.62` 到当前发布候选的用户更新说明、安装文件、关联 Issue 和验证证据。

历史文档说明：

- [triage-issues.md](./triage-issues.md) 是早期 issue 批处理记录，不是当前待办列表。
- `docs/release-v0.5.5.md`、`docs/release-v0.6.0.md`、`docs/release-v0.6.5.md` 是历史发布说明草稿/归档。

## 4. 目录地图

```text
src/main/
  index.js               Electron 主入口、窗口、菜单、单实例、启动参数
  documents.js           文档/对话框/PDF IPC 注册
  filesystem.js          文件读写、目录、复制、删除、图片保存
  watchers.js            chokidar watcher，必须防止系统根目录/受限目录
  security.js            外部协议、本地字体权限等安全口
  pdf-export.js          PDF 预览/保存、隐藏窗口、printToPDF、任务取消
  pdf-images.js          PDF 图片暂存、单图/总量限制、资源地址替换
  pdf-document.js        PDF HTML/目录/页眉页脚纯函数
  pdf-print-styles.js    PDF 打印 CSS
  html-export.js         HTML 预览 token、图片内嵌、保存与资源清理
  html-document.js       独立 HTML 模板、主题、目录和 CSP 纯函数
  pandoc-export.js       Pandoc 检测、选择、转换与错误映射
  pandoc-core.js         Pandoc 格式白名单、版本与参数纯函数
  subprocess.js          无 shell 子进程、超时与输出上限
  ai/                    AI 上下文快照与变更提案纯逻辑

src/preload/index.js     安全的 window.api bridge

src/renderer/src/
  App.jsx                顶层 shell，tabs/session/split/settings/pdf/source-mode 接线
  components/Editor.jsx  Crepe 生命周期拥有者，避免继续膨胀
  components/editor-*.js 编辑器专项能力
  components/settings/   设置中心模块
  hooks/                 workspace/source-mode/pdf/html/pandoc/find/sidebar 等 hooks
  lib/                   命令、菜单、纯工具
  platform/              Capacitor shim 和跨平台 API 合同
  styles/app.css         主样式和主题变量

scripts/                 CDP、纯函数和回归测试
docs/                    开发文档
guide/                   VitePress 用户教程站
website/                 官网/下载页
android/, ios/           Capacitor 原生壳
```

## 5. 最敏感的不变量

### 5.1 编辑器生命周期

- `Editor.jsx` 是 Crepe/ProseMirror 生命周期拥有者。
- 获取 ProseMirror view 必须用 `crepe.editor.ctx.get(editorViewCtx)`。
- `crepe.on(markdownUpdated)` 必须在 `crepe.create()` 前注册。
- 只有真实用户编辑可以让 tab dirty。
- 富文本 UI 的未保存提示不得等待 Milkdown 的 200ms `markdownUpdated`；使用 `pendingRichEdit` 即时提示、使用后续源码保真结果结算。所有消费方通过 `isTabDirty(tab)` 判断，不要直接比较 `content` 与 `savedContent`。
- ProseMirror DOM 可见不等于可安全编辑：初始 canonical baseline、公开 API 与 `ready` 都完成前必须保持不可编辑；完成后才标记 `data-horsemd-ready="true"`。否则极早输入可能被吞入初始化基线而无法保存或切到源码。
- Markdown 链接 Ctrl/Cmd+点击：网页链接只走 `openExternal`；本地 `file://`、POSIX 绝对路径、Windows 盘符/UNC 和相对路径都必须先规范为 file URL，再仅通过 `openFileUrl` IPC 打开。主进程必须校验发送者，不能让任意 renderer 调用系统 shell。
- 程序化初始化、源码/富文本同步、恢复内容、PDF source 生成不能标脏。
- ProseMirror 插件和 keymap 走 `prosePluginsCtx`。
- Milkdown node view 追加到 `nodeViewCtx`，不要设置 `editorViewOptionsCtx.nodeViews` 覆盖内置组件。

### 5.2 源码/富文本切换

- Crepe 在源码模式中必须保持挂载，只隐藏，不卸载。
- 源码 textarea 是非受控的，保留 `liveContentRef` / `commitLive` 流程。
- 普通源码单换行由 Milkdown 保留为 `data-is-inline="true"` 的 hardbreak 节点。默认多行显示只能通过 `hm-preserve-soft-breaks` 做视觉处理；禁止把它序列化为 `<br>`、尾随空格或空段落。Enter 与 Shift+Enter 的编辑语义不得随该偏好变化，修改后必须运行 `npm run test:soft-break-ui`、`test:paragraph-source-ui` 和 `test:mode-switch-raw-offset-ui`。
- textarea DOM 会把 CRLF 变成 LF；任何源码输入或源码命令写回 `liveContentRef` 前必须经过 `source-text-fidelity.js`，禁止直接保存 `textarea.value`。
- 只有源码真的改过，切回富文本才同步到 Crepe。
- Crepe 的 serializer 不保证原始 Markdown 写法；`lastMarkdownRef` 是用户源码，`canonicalMarkdownRef` 只用于识别局部富文本变更。普通文字只允许字符级回写；结构操作最多替换受影响列表、表格或行；映射失败必须保留原文并报告失败。唯一例外是从空白起步、全程仅富文本写作的新文档：它没有既有源码格式，嵌套列表退出的中间空项不能进入增量基线，应以完整实时 canonical 建立结构并恢复已记录 marker；一旦用户实际编辑源码，立刻关闭该例外。
- 分块大文档追加完成后必须记录完整 `canonicalMarkdownRef`，但绝不能用 canonical 重建 `lastMarkdownRef`。富文本插入类命令必须以 `tab.content` / `lastMarkdownRef` 为全文基底，不得以 `getMarkdown()` 为基底。
- 源码调用 `replaceAll` 同步到 Crepe 时可能连续发出多个 `markdownUpdated`。`programmaticReplaceRef` 必须保持到下一次明确的 `markUserEdit`，不能只跳过第一条回调，否则前一次用户编辑的 TTL 会把后续同步事务误判为用户编辑。
- Crepe canonical 始终带结尾换行，文档末尾新建的空 paragraph 又没有 visible index。不能把其后续输入映射到“最后一个可见字符”；`preserveAppendedParagraph` 必须按用户源码原有结尾换行数追加标准段落边界。修改后运行 `npm run test:paragraph-source-ui`，并确认测试包含保存、退出和全新进程重开。
- 源码 textarea 是非受控组件，`defaultValue` 只在挂载时读取。富文本→源码切换前必须调用 `editorApis[id].flushMarkdown()`，同步更新 `tabsRef` 和 tab state 后再挂载 textarea；不能只依赖异步 `markdownUpdated`，否则立即切换会显示旧内容且后续 state 更新无法回填。专项测试必须在最后一次 `Input.insertText` 后零等待切换。
- 空文档的默认“空 H1 + 空正文”只属于富文本起笔 UI，磁盘源码仍是空字符串。`canonicalForSource()` 必须在标题保持为空时剥离该骨架；用户在标题输入后才将其纳入 canonical。移除这层会使首次输入因 `#\n\n` 与空源码基线不一致而被原文保护器拒绝。`test:paragraph-source-ui` 必须同时覆盖从 H1 起笔和跳过 H1 从正文起笔。
- Enter 创建的末尾空 paragraph 会被 Crepe canonical 暂时写成独立 `<br />` 块。`preserveTrailingEmptyBlock()` 必须在创建时只推进 canonical、不改 raw source，填入文字时再调用文档末尾块追加逻辑；否则真人慢速输入会把正文并入标题并残留 `<br />`。CDP 测试必须逐字输入且每行停顿到上一条 `markdownUpdated` 已提交，高速整句输入会掩盖该问题。
- 在已有块之间按 Enter 还有两条独立路径：快速输入可能直接产生一个新 paragraph，停顿输入会先产生 `<br />` 占位。`preserveMiddleEmptyBlock()` 只可用前后未变化可见行的序号映射替换中间 raw 间隙，不能用零可见字符 affinity；并且必须把列表、表格、标题、引用和 fenced code 排除，让专用结构处理器保留原有语法风格。
- ProseMirror 的 `bullet_list` 节点不保存用户触发输入规则时键入的 `-`、`*` 或 `+`。必须在空段落输入空格前记录 marker intent，再把它恢复到刚创建的列表层级；不能全局替换 serializer 的 `*`。松散列表可跨项目间空行，但顶层有序/无序类型变化必须截断；转换后 canonical 若把相邻同类型列表合并，`replaceMarkdownListBlock()` 必须按转换前项目内容缩小到原列表子区间。详见 [0.12.45 新输入源码保真报告](./new-input-source-fidelity-report.md)。
- 正文转列表必须与“已有列表类型转换”分开：前者需要在 dispatch 前记录该普通段落的 raw offset，dispatch 后用 `serializerCtx(view.state.doc)` 取得实时 canonical，并且只向对应 authored 行写入 `- `、`1. ` 或 `- [ ] `。禁止读取 `crepe.getMarkdown()` 缓存或用全篇 canonical 覆盖；实现见 `editor-block-list-source.js`，回归为 `npm run test:block-list-source` 和 `npm run test:list-conversion-ui`。
- 新建空列表项的 Crepe `<br />` 是内部占位，不是用户 Markdown：源码只能短暂表示为用户输入的 `- ` / `* ` / `+ ` / `1. ` / `1) `，首个列表文字必须按列表树顺序填回该项，绝不能落到上一段。物理键盘必须在 Space 的 `keydown` 记录 marker；连续 Enter、marker、Space 时若原始源码尚未发布空段落，禁止使用失真的 raw offset，改以 canonical 前/后快照在前后可见内容边界插入仅该列表（末尾与中间均覆盖）。若新文档的首次 `markdownUpdated` 已合并标题、正文和嵌套列表，source/canonical 都为空时必须保留完整 canonical，不能让当前内层 selection 的输入规则补丁覆盖外层；生成的全新列表采用紧凑间距。嵌套项退出后紧接无序项时，`markdownUpdated` 和立即源码切换的 `flushMarkdown()` 必须共用完整 canonical 生成路径并恢复未发布的 `-` marker，避免中间空 `3.` 或默认 `*` 固化；用户实际编辑源码后关闭该路径。输入规则意图在首次成功重建该列表后必须立即清除；不得在后续 Enter/Tab 的嵌套列表操作中重放旧 source snapshot。初始化与 `flushMarkdown()` 必须同用 `serializerCtx(view.state.doc)`；缓存 serializer 与实时 serializer 的尾换行差异也必须视为非用户编辑。修改此边界后运行 `npm run test:rich-list-source-ui`、`npm run test:new-document-list-source-ui`、`npm run test:new-source-fidelity-ui` 和 `npm run test:list-conversion-ui`。
- 同时带 Markdown 和 HTML 的粘贴：Markdown 覆盖 HTML 语义时直接以 Markdown 插入并保留原文；网页 HTML 的纯文本回退不完整时必须保留 HTML。详见 [markdown-source-preservation.md](./markdown-source-preservation.md)。
- 光标映射不能用关键词匹配。主路径是 Markdown raw offset ↔ ProseMirror block-aware mapping。
- `npm run test:mode-switch-raw-offset-ui` 是当前的精确 UI 回归：它按 Markdown raw offset 覆盖正文、表格、列表、代码块，并执行两条连续切换链。不能只用相邻文本或关键词断言。
- 该模式切换回归还必须覆盖硬换行后的 raw offset，以及源码→富文本后零等待 Enter、跨 `90/220ms` 分段输入。首次恢复在 layout 阶段同步执行；富文本一旦收到真实键盘、输入法或鼠标交互，延迟 settle 重试必须终止，不能覆盖用户的新选区。
- `npm run test:issue-86-ui` 用真实表格手柄连续新增两行和两列，填写最后一行全部单元格、从富文本真实保存、彻底退出并以全新用户目录重开文件，保护单元格归属、表格维度、空单元格 `| |` 序列化，以及原有 `<br>` 单元格换行。表格结构变化只替换对应 canonical 表格块，禁止扩大到整篇源码；不要在序列化中途删除空单元格占位。详见 `docs/issue-86-table-save-report.md`。
- `npm run test:table-ui` 保护另一条独立的表格 UI 合同：短表自然宽度、宽表内部横向滚动和不撑开页面；列边缘的短暂悬停仍用于加行/加列，只有按住约 220ms 才实时调整列宽；宽表最右端连续 10 次悬浮/调整均不得把 `scrollLeft` 重置为 0。不要重新注册 `columnResizingPlugin`，它会与 Crepe 自定义 `TableNodeView` 竞争 hover transaction，重新引入跳回和非确定性预览。
- `npm run test:task-list-persistence-ui` 保护任务复选框的完整写盘链路：勾选、保存、退出重开、取消、保存、再次重开。Crepe 的任务标签在 `pointerdown` 阶段更新节点并阻止兼容 `mousedown`，因此根节点必须在 capture 阶段标记用户编辑；不要用全篇重新序列化或单独改文件绕过现有 `markdownUpdated` 与原文保真链路。
- `editor-block-handle-guard.js` 只负责块操作条的触发过滤和滚动隐藏；横向位置由 `Feature.BlockEdit.blockHandle.getPosition` 交给 Milkdown BlockProvider 一次性计算，禁止再用 `translate`、MutationObserver 或 ResizeObserver 二次改坐标。标题、正文和各级列表必须共用正文左边界这一条轨道。修改 BlockEdit、插件顺序或 editor gutter 时，必须同时运行 `npm run test:block-handle-gutter-ui` 与 `npm run test:inline-html-block-handle-ui`。
- 编辑状态：可见光标要跟随光标。阅读状态：光标不在可视区时保持视口。
- 回归必须覆盖：
  - 富文本 → 源码 → 富文本 → 源码
  - 源码 → 富文本 → 源码 → 富文本
  - 表格、代码块、行内代码、图片附近、大文档、重复文本

### 5.2b CodeMirror 与剪贴板

- CodeMirror 长代码块使用虚拟化 DOM，`.cm-line` 只代表当前渲染窗口，不能作为“完整代码”的数据源。
- 代码块右上角复制按钮必须解析完整 ProseMirror `code_block`；解析失败时应停止且不能显示成功反馈，禁止回退拼接 `.cm-line`。
- CodeMirror 内部的全选和部分选区复制由其文档状态负责。修复“复制整块”时不能拦截或扩大原生选区，否则选择 65 行会错误复制全文。
- 复制测试必须读取真实系统剪贴板，并在每次操作前写入 sentinel；只检查 toast、按钮颜色或未清空的旧剪贴板会产生假通过。
- 修改代码块 node view、复制事件、DOM 映射或 clipboard IPC 后，先运行 `npm run build`，再运行 `npm run test:issue-98-ui` 和 `npm run test:clipboard-ipc-ui`。构建与 UI 测试不能并行，否则测试可能加载旧 `out/`。
- 完整根因和验收数据见 [长代码块复制截断事故复盘](./long-code-copy-virtualization-regression.md)。

### 5.2c 可见流分叉、空段落硬不变式与文档位置记忆（0.13.x）

**空段落 `<br />` 硬不变式**：Crepe 的空段落序列化为独立 `<br />` 行，它只是编辑器内部占位、**永远不能进入作者源码**。`preserveRichMarkdownSource` 在所有启发式路径之后强制执行后置条件：统一剥离独立 `<br />` 占位行（保留块引用前缀 `>`），再按源文件尾部换行风格钳制（`capOutputTrailingNewlines`）。行内 `text<br>text` 与表格单元格 `<br>` 是作者内容，不受影响。任何新处理路径都不例外——不要在守卫上打补丁，边界兜底已经在 `markdown-source-preservation.js` 出口。空段落映射只要求变更区间局部对齐（`.some` 至少一个空段落行），**不得要求全文可见流相等**，也不得被无关空段落否决。

**整文档清空（document-emptied）硬不变式**：富文本删除全部内容后 canonical 为空串，这是无歧义事实，**必须清空源码**。此前所有启发式在分歧源码上 fail-closed 返回旧源码（reason `visible-stream-mismatch` / 残留 `"# "`），导致「富文本删了全部 → 切源码内容还在 → 保存写入旧内容 → 重开内容复活」。`preserveRichMarkdownSourceCore` 顶部 `if (!next) return { markdown: '', reason: 'document-emptied' }` 分支锁定该行为；任何新路径不得对空 canonical 返回旧源码。回归：`npm run test:full-doc-delete-source-ui`（Cmd+A 清空 → 切源码为空 → 保存磁盘为空 → 重开为空）+ 纯函数用例。

**模式切换 settle 重试光标守卫**：`useSourceModeSwitch` 的布局效应在切换后最长 ~3s 内重复 `apply()` 直到布局稳定，源码分支每次都会重放 `restoreSourceCaret`。重试**只能重复自己上次写入的状态**：首次恢复后若 textarea 实时选区 ≠ `__horsemdSourceSelectionBaseline`，立即停手（不依赖 React 合成事件标志——键盘/IME/辅助输入可能漏置位）。同时 `followSourceCaret = hasSourceCaretIntent && !sourceViewportMoved`（选区相对基线移动且视口未滚 = 编辑意图，回程聚焦跟随；不再要求 `sourceSelectionUser`）。回归：`npm run test:mode-switch-caret-settle-ui`（无事件程序化移动光标 → 等 2.6s 不被覆盖 → 往返映射正确）。

**数字点列表嵌套解析分歧（0.13.17–0.13.18）**：`- 1. 甲乙` 会被 remark 解析为**嵌套有序列表**，canonical 的 `1. ` 是结构 marker，源码里的 `1. ` 却是作者正文，两条可见流从该行起永久分歧。当前 `preserveDivergedNestedListChange` 不再依赖全文可见偏移，而是：只用 `indent === 0` 的顶层列表块做 document ordinal 对齐；把 canonical 列表树投影成 `token + text + indent` 项序列；把源码投影成带 raw offset 的 marker/续行序列；最后执行项级 diff。该路径覆盖数字 marker 删除、无 marker 续行、外层 bullet 提升、Enter 拆项、空项填字、后续含 `**加粗**` 的普通列表。一个延迟 `markdownUpdated` 同时含多个列表操作时，先用 `preserveBatchedListBlockChanges(requireMultiple: true)` 原子对账至少两个顶层块，禁止单列表处理器只提交批次的一部分。完整清单与安全边界见 `nested-list-sync-bug-handoff.md` 和 `canonical-escape-audit.md`；回归至少运行 `test:nested-number-list-source-ui`、`test:diverged-list-structure-ui` 与 `test:rich-source-chaos-ui`。

**跨块纯删除兜底（0.13.18）**：分歧文档里**跨多个 canonical 块的纯删除**（拖选删除文档尾部、一次删除多个列表树）会越过单块映射（nested-list、diverged-block）直接 fail-closed——删除静默消失、tab 不脏、保存写旧内容、重开复活。`preserveDivergedVisibleDelete`（`regions.js`，diverged 分支**最后**、fail-closed 之前）：canonical 删除区间**前 24 个可见字符**在 source 可见流中唯一锚定（删除起点 = 锚点后；终点 = 区间后锚点或可见流末尾），并要求**被删 raw 文本逐行去列表标记后的可见文本 == canonical 删除区间可见文本**（不一致 fail-closed）。仅纯删除（replacement 无可见文本）；替换/插入不适用。回归：纯函数 1 例（真实 canonical）+ `npm run test:diverged-partial-delete-ui`（反馈.md 形态整段删除 → 切源码 → 保存 → 重开不复活）。

**可见流分叉（visible-stream divergence）**：源码与 canonical 对同一批字节的块解析不同（典型：行中 `* ` 被 remark 拆成列表项，而作者把 `* ` 当普通文字，canonical 序列化时转义为 `\*`）时，两条可见流从分叉点永久不同。此时 `preserveLocallyAlignedTextChange`（上下文可见字符不一致）与 `preserveChangedLineRegion`（全文可见行不一致）都会失败。**fail-closed 返回原源码 = 富文本删除被静默撤销、保存后复活**——这是用户反复遇到「富文本删了内容切源码还在」的根因族。兜底 `preserveDivergedBlockTextChange()`（`lib/markdown-preservation/regions.js`）满足以下全部条件才替换：
1. 变更限定在**单个 canonical 块**内（空行分界，跨块/整块删除放弃）；
2. canonical 块文本**反转义**（`\*`→`*`、`&#x20;`→空格、命名实体）后在源码中**恰好出现一次**（重复文本绝不猜测）；
3. 替换文本不得含独立 `<br />` 占位。
任何约束不满足仍返回原源码。回归：`npm run test:diverged-delete-source-ui` + 纯函数 `test:markdown-preservation`。

**文档位置记忆（#111）**：每个文档路径独立持久化 `{offset, len, scrollTop}`（`localStorage["horsemd.docpos.v1"]`，上限 300 条）。`hooks/useDocPositions.js` 在切换标签、窗口关闭/刷新时批量捕获所有已挂载文档位置（富文本 `markdownOffsetFromSelection` 优先、视口顶部兜底；textarea 用 `selectionStart`）。打开文件时（`useFileOps`）**必须校验 `len === content.length` 才挂载恢复参数**——外部改过文件（长度变化）绝不套用旧偏移。富文本恢复用 `restoreMarkdownOffset(offset, false)`（不抢焦点）+ 同步设 `scrollTop`（**不要用 `requestAnimationFrame`**，后台窗口会被节流）；textarea 用 `setSelectionRange` + `scrollTop`。回归：`npm run test:doc-position-restore-ui`。

**原生 HTML 表格自适应**：`.hm-html-block` 必须重置 `white-space: normal`（ProseMirror 根的 `break-spaces` 会继承进来并阻止 CJK 按字断行）；表格 `max-width: 100%`；带 `width` 属性的表格 `width: unset` 恢复作者语义（`100%` 跟随容器、固定像素收缩）；`td/th` 的 `min-width: 0` 允许列收缩；**表格内图片必须 `width: 100%`**（否则 `<img width="900">` 的固有宽度参与列 min-content 计算，表格拒绝收缩，`max-width: 100%` 只约束渲染宽度救不了布局）。GFM（Markdown）表格保持独立横向滚动不受影响。回归：`npm run test:table-ui`（断言已更新为 HTML 表格贴合正文宽度）。

### 5.3 PDF 导出

- PDF 导出读取 `getPdfSource()` 生成的结构化 `{ html, headings, title }`，不是直接打印 live editor DOM。
- `getPdfSource()` 是异步快照 API；调用方必须 `await`。DOM 在异步 Mermaid 渲染前立即克隆，不能在等待期间重新读取 live editor。
- `getPdfSource()` 会把非 data URL 图片替换为唯一占位符，并附带图片清单。主进程 `pdf-images.js` 必须先把本地和网络图片暂存到 PDF 临时目录，再生成打印 HTML；不要让隔离的 `file://` 隐藏窗口按原 URL 二次加载。暂存失败才回退原地址并由真实加载结果决定是否警告。
- Markdown 图片相对路径只能解码并编码各一次。尤其要保护空格、中文、Windows 盘符和已写成 `%20` 的路径，禁止产生 `%2520`。
- 普通 CodeMirror 代码块导出为 `<pre><code>`。
- LaTeX 段落公式不能导出源码；要先把预览块物化为可打印 MathML。
- Mermaid 不能依赖 `.preview-panel` 当前是否挂载或可见；`editor-pdf-content.js` 必须主动通过 `renderMermaidForExport()` 生成并清理 SVG，再删除预览 DOM。语法错误或总截止时间耗尽时保留源码。
- 超宽行外 MathML 不得用比例缩小处理；PDF 临时文档中按顶层运算符拆成多行，编辑器内公式不变。
- PDF 预览是 latest-request-only；设置快速变化时旧任务必须取消。
- PDF 表格不能统一强制 `table-layout: fixed; width: 100%`。`editor-pdf-content.js` 在清理 DOM 前用可见表格实测总宽度和每列比例，紧凑表保留自然宽度，宽表才收敛至打印区域。`npm run test:pdf-table-layout-ui` 会同时检查 source `<colgroup>` 和最终 PDF 文字 X 坐标；只断言 HTML 存在表格不足以保护视觉一致性。
- PDF 表格单元格通常包含内层 `<p>`。必须保留 `.doc th > p, .doc td > p { margin: 0; padding: 0; line-height: inherit; }`，否则全局正文段落间距会把每一行撑高。表格回归同时检查最终 PDF 的纵向文字基线距离。
- 打印目录页和 PDF 书签大纲是两个独立功能。
- 隐藏窗口临时 HTML 禁止脚本执行，保留 Electron 默认 web security。

### 5.3b HTML、Pandoc 与 AI 基础

- HTML 与 PDF 共用异步结构化导出快照，但页面模板和设置独立。不要 clone live DOM，也不要把 PDF 打印 CSS 当网页 CSS。
- HTML 预览由主进程生成最终字节并返回 token；保存必须写 token 对应的同一份 HTML，不能在保存时重新生成。
- HTML 输出和预览必须保持无脚本：结构快照移除危险节点/属性，模板带严格 CSP，renderer iframe 使用无权限 sandbox。
- Pandoc 只接收当前聚焦标签的最新 Markdown。源码读取 live textarea，富文本先 `flushMarkdown()`；导出不得改变 dirty、光标或磁盘源文件。
- Pandoc 可执行路径必须通过绝对路径、文件名和 `--version` 验证；目标格式是白名单，参数由主进程构造，Markdown 走 stdin，`shell: false`，两分钟超时。
- `src/shared/ai-contracts.js` 与 `src/main/ai/` 是 Phase 0 基础，不代表 AI 已对用户开放。后续 Provider、密钥、网络和 UI 不能绕过 revision 校验与 ChangeProposal 直接写文档。
- 详细边界见 [document-export-architecture.md](./document-export-architecture.md)、[document-export-prd.md](./document-export-prd.md) 和 [ai-vmark-phase-plan.md](./ai-vmark-phase-plan.md)。

### 5.4 工作区和文件系统

- 工作区是单一、多根，不是多 workspace 切换系统。
- `useWorkspace.js` 管 roots 和 watcher，`useSidebarTree.js` 管树加载和展开。
- watcher 必须拒绝相对路径、系统根、受限目录。
- 已打开文件被外部程序保存时：干净标签可自动刷新；脏标签必须保留本地内容并只提示一次外部冲突，不能静默覆盖或连续弹窗。保存会覆盖外部版本，用户可另存为保留两份。
- 主进程网络调用用 Electron `net.fetch`，不要用 Node global `fetch`。
- 外部链接协议必须通过 allowlist。

### 5.5 设置、快捷键和平台

- 设置 tab 是 transient，不进 session restore。
- 偏好在 `localStorage["horsemd.settings.v1"]`。
- 快捷键配置在 `localStorage["horsemd.keybindings.v1"]`。
- Ctrl/Cmd 一般都要支持。
- 编辑器内的粗体、斜体、表格结构键、CodeMirror 结构键、输入法相关键不能随意开放改绑。
- 移动端没有桌面文件系统/PDF 能力时必须 gate UI，不要让按钮假可用。

### 5.6 云同步

- 详细产品和数据模型见 [cloud-sync-prd.md](./cloud-sync-prd.md)。当前仅桌面端开放手动同步；Capacitor shim 必须保持 `cloudSync: false`，直到 [移动端同步架构](./mobile-cloud-sync-architecture.md) 所需的原生安全凭据、文件 adapter 与网络桥接都完成真机验证。
- 普通多根工作区和云同步工作区不是一件事。`useWorkspace` 继续管理可见文件树与 watcher；`useSyncWorkspaces` 只管理用户明确开启同步的根目录，不能扫描磁盘寻找 `.horsemd`。
- 阅读 `docs/cloud-sync-v2-prd.md` 和 `docs/cloud-sync-v2-architecture.md` 后再改同步逻辑。`merge`、`push`、`pull` 是不同策略：远端 manifest 缺失或异常清空时，`merge` 必须返回 `remote-reset`，绝不能据此生成 `deleteLocal`。
- `push`/`pull` 是用户明确发起的恢复操作。方向化覆盖或删除前需归档目标端旧文件；普通双向冲突保留双方。不要把对象存储的目录扫描结果当成可信删除日志。
- 每个同步根目录只有 `.horsemd/workspace.json` 一个标记，应用数据目录另有私有 registry。标记和 registry 不得包含密码、Secret 或用户内容；`.horsemd` 永远不能作为普通内容上传或被 watcher 展示。
- 渲染层只使用窄 `window.api.sync*` 接口，不能直接调用网络；主进程网络一律使用 Electron `net.fetch`，凭据使用 `safeStorage`。
- `SyncEngine` 的 manifest 必须最后条件提交；上传、下载、删除必须校验预览时的 revision/hash。不要把冲突改成最后写入者胜出。
- WebDAV PUT 可能不带 ETag，Provider 会 `PROPFIND` 补取；S3 要使用维护中的 SigV4 实现，且必须保持工作区 prefix 隔离。更改 provider 后同时跑 mock、真实服务和双 profile Electron 测试。

## 6. 近期功能与坑位

### 0.13.x：代码块行号、HTML 表格自适应与文档位置记忆

- **编辑器代码块行号**：CodeMirror gutter 背景不透明（`--code-block-bg`）、行号列贴住代码块左边缘（`.cm-scroller` 左右 padding 移到 `.cm-content`）、行号字号 `1em` + `line-height: 1.6` 使行号元素与代码行等高、行号右侧 1px 分隔竖线。改 gutter 样式后跑 `npm run test:issue-80-ui`、`test:codeblock-scroll-stability-ui`、`test:issue-91-pdf-ui`。注意 `.cm-gutterElement` 高度异常问题：CodeMirror 默认 `height: 100%` 在 flex 下可能解析为 0，行号内容靠 `overflow: visible` 显示——测量行号用 `getBoundingClientRect` 前先确认元素本身。
- **PDF 导出代码块带行号**：`pdf-print-styles.js` 的 `.hm-code-line-num`；PDF 表格单元格单击直接编辑（`test:table-click-edit-ui`）。
- **原生 HTML 表格自适应**：见第 5.2c 节。`代码测试` 类 gov.cn 嵌套 `<table width="950">` 不再横向溢出；`html表格无法自适应.md` 是复现文件。
- **文档位置记忆（#111）**：见第 5.2c 节。已回复 issue #111 引导下载最新版。
- **已知遗留（已留底、待用户提供步骤）**：代码块围栏「吞正文」——见 `codeblock-fence-investigation.md`。排查结论：正常插入路径（斜杠菜单/真粘贴/输入规则/相同内容/多行/空块/Mermaid/中间插入/编辑内容）保存重开全部正常；用户现场文件 `代码测试.md` 显示两段代码无围栏且 `register()/import bpy` 粘连。在拿到精确复现前**不要盲改**。
- **相关边界（与 0.13.26–0.13.27 已修复路径分开）**：单/三反引号输入、部分/全部删除后保存暂停和源码锁死已修复；0.13.27 已验证 ``` + Space 可创建 fenced code block，空块一次 Backspace 后快速输入也安全。「已有结束围栏损坏后吞后文」仍按 `codeblock-fence-investigation.md` 独立跟踪，不能与正常输入规则混为一个问题。粘贴无围栏纯文本代码的行首缩进语义也属于独立路径。

### 自定义快捷键

已落地第一版：

- 统一命令注册表
- 设置页录制
- 冲突和保留键校验
- 菜单 accelerator 同步
- 命令面板 hint 同步
- 设置页阻断后台快捷键

重点文档：

- [custom-shortcuts-architecture.md](./custom-shortcuts-architecture.md)
- [custom-shortcuts-implementation-checklist.md](./custom-shortcuts-implementation-checklist.md)
- [custom-shortcuts-verification-report.md](./custom-shortcuts-verification-report.md)

### LaTeX

最近修过：

- `$$` / `/math` 块公式输入焦点不中断。
- 行内公式纯数字和中间补写能实时预览。
- 行内公式编辑框支持“清空”。
- 行内公式默认保护删除：第一次删除先选中，第二次删除才移除。
- PDF 导出中段落公式打印为渲染公式，不再打印源码。
- Crepe 的块公式位于 `.milkdown-code-block .preview` flex 容器。带 `\tag{...}` 的 KaTeX 公式必须保持 `flex-basis: 100%`，并给 `.katex-html` 的编号预留右侧空间；否则短公式会 shrink-to-fit，绝对定位编号会压到公式本体。用 `npm run test:tagged-display-math-ui` 保护这条布局合同。
- 块公式预览不能常驻 `overflow: auto`：Windows 会为即使未溢出的容器显示滚动箭头。`editor-katex-dom-prune.js` 根据实际 `scrollWidth` 标记 `data-hm-math-overflow`；仅标记为 `true` 的公式横向滚动，外层 `.preview` 不再形成第二个滚动面。用 `npm run test:display-math-scroll-ui` 同时保护短公式和长公式。
- 已渲染的块公式必须覆盖 Crepe 通用代码块的 `8px/20px` 内边距；只在 `.preview > .katex-display` 出现时压紧外层留白，不能影响普通代码块、公式源码编辑态、编号布局、横向溢出或 PDF。

### 选中文字工具栏

- 桌面端设置 `selectionToolbar` 默认开启；关闭时只以 CSS 隐藏现有 Crepe 工具栏，绝不因偏好变更重建已挂载的编辑器。
- 关闭后，富文本选区右键菜单必须以“文字格式”“审阅标记”“转换为”的悬停/焦点子菜单保持紧凑，提供粗体、斜体、删除线、行内代码、链接、高亮，以及完整审阅标记（新增、删除、替换、高亮 + 评论）；列表转换或块类型转换也必须继续保留。根菜单不能用 `overflow` 裁掉横向子菜单，靠近窗口右边时子菜单要向左展开。菜单打开时保存精确的 ProseMirror `anchor/head`，所有选区命令执行前恢复它，不能依赖浏览器在右键/菜单焦点切换后仍保留内部选区。
- 移动端仍只显示系统原生选中文字菜单。

相关文件：

- `src/renderer/src/components/editor-inline-math.js`
- `src/renderer/src/components/editor-math-preview.js`
- `src/renderer/src/components/editor-api.js`
- `src/main/pdf-print-styles.js`
- `scripts/test-pdf-latex-ui.mjs`

### PDF 导出

第一版已经具备浏览器式预览中心：

- A4/A3/Letter/自定义尺寸
- 横向/纵向
- 边距、8–24pt 正文字号、整体缩放
- 标题分页、目录页、PDF 书签
- 页眉页脚、日期、页码、页码范围
- 预览 buffer 与最终保存 buffer 一致

用户很在意 PDF 的真实预览和可配置项，不要退回简单保存对话框。
PDF 设置采用 latest-request-only，但进入 `printToPDF()` 后不能通过销毁隐藏窗口
来取消；必须等待当前打印自然结束并丢弃 stale 结果。详见
[pdf-preview-printing-race-report.md](./pdf-preview-printing-race-report.md)。

### 大纲

大纲支持折叠/展开，并默认保留前两层实际层级。近期修过：

- 父标题折叠时即使当前激活的是子标题，也要有反馈。
- 标题文字编辑后折叠状态不丢。
- 源码/富文本切换后目录层级不能跳。
- 桌面端拖动标题左侧抓手可重排**同一父级**下的章节，移动范围包含标题、后代标题和正文。必须调用 `outline-reorder.js` 的原始 Markdown 区段操作，不能取富文本 serializer 结果；不同父级或不同层级不允许落下，避免隐式重设层级。
- `FloatingOutline.jsx` 是纯渲染组件：默认只显示少量圆点，hover/focus 扩展标题列表，长标题以省略和原生 tooltip 处理。它必须复用 `useOutline.js` 的缓存 scrollspy，不能为了悬浮导航再注册 scroll listener 或逐帧读取全篇布局；移动端、无标题文档与侧栏“大纲”状态不显示。分屏时只跟随最后聚焦窗格。
- “折叠正文”不是当前大纲折叠的延伸。源码 textarea 无法隐藏局部行；富文本折叠须作为独立的、每 Tab 非持久 UI 状态设计，并先覆盖选区、查找、审阅、图片/代码块、模式切换和滚动锚点。

### 任务列表输入

近期改为 Typora 风格：

- 输入 `- [ ] ` 或 `- [x] ` 后直接转换任务列表。
- Enter 仍作兜底。

## 7. 测试策略

没有单一 `npm test`。按风险选择：

### 每次代码变更最低线

```bash
npm run build
git diff --check
```

### 共享 renderer / 设置 / 编辑器变更

```bash
npm run build:mobile
npm run test:core
```

### UI/编辑器/PDF/模式切换变更

```bash
npm run test:ui-regression
```

### 教程或用户文档变更

```bash
npm run guide:check
```

### 重点专项

```bash
npm run test:shortcuts
npm run test:settings-ui
npm run test:settings-layout-ui
npm run test:pdf-ui
npm run test:pdf-latex-ui
npm run test:math-ui        # 需要先以 scripts/fixtures/inline-math.md 启动 CDP app
npm run test:web-paste-ui
npm run test:table-ui
npm run test:lightbox-ui
npm run test:review-ui
npm run test:source-map
npm run test:markdown-preservation
npm run test:issue-77-ui
npm run test:paragraph-source-ui
npm run test:issue-79-ui
npm run test:outline-reorder
npm run test:issue-82-ui
npm run test:floating-outline-ui
npm run test:issue-98-ui
npm run test:clipboard-ipc-ui
npm run test:diverged-delete-source-ui   # 可见流分叉删除回退（0.13.9）
npm run test:doc-position-restore-ui     # 文档位置记忆 #111（0.13.13）
npm run test:step-source-mapper          # 逐键/Enter/退格重建源码（0.13.x 原型）
npm run test:full-doc-delete-source-ui   # 整文档清空不再复活（0.13.14，新增）
npm run test:mode-switch-caret-settle-ui # 模式切换光标不被重试覆盖（0.13.14，新增）
npm run test:leading-space-entity-ui     # 行首空格不再变 &#x20; 实体（0.13.14，新增）
npm run test:nested-number-list-source-ui # `- 1. …` 行内编辑不丢失（0.13.17，新增）
npm run test:diverged-partial-delete-ui   # 分歧文档整段删除不复活（0.13.18，新增）
```

`test:math-ui`、`test:pdf-ui` 等部分脚本连接已有 CDP session。单独跑时先按 fixture 启动，或参考 `scripts/run-ui-regression.mjs`。

**0.13.x 新增/变更的回归语义**：
- `test:table-ui` 已从「HTML 表格默认独立横向滚动」改为「原生 HTML 表格贴合正文宽度不溢出」（GFM 宽表仍可滚动）。
- 新增 `test:diverged-delete-source-ui`、`test:doc-position-restore-ui`；`test:markdown-preservation` 增加分叉删除/插入、重复文本拒绝、`\*`/`&#x20;` 反转义、`<br />` 拒绝等用例。
- `test:mode-switch-raw-offset-ui`、`test:empty-paragraph-caret-ui`、`test:source-fidelity-ui` 是模式切换/空段落/保真的高频回归，改动 `markdown-source-preservation.js` 或 `mode-*.js` 后必跑。

## 8. CDP 实战注意

- 启动 Electron 时要加 `--remote-debugging-port=9222` 或脚本指定的端口。
- 自动化优先使用 `launchBuiltElectron()`；它默认追加
  `--horsemd-test-background`，隐藏主窗口并避免获取 macOS 原生焦点。
- 多 tab / 分屏会有多个 `.ProseMirror`，必须用 `offsetParent` 找可见实例。
- 用真实 `Input.dispatchMouseEvent`；输入敏感路径通过
  `typeTextLikeUser()` 逐字符提交或使用 `Input.dispatchKeyEvent`，不要只改
  DOM selection，也不要一次注入整句来替代真人输入。
- `Runtime.evaluate` 取值在 `msg.result.result.value`。
- macOS 可能复用旧 app 进程；安装前必须 kill。
- 如果脚本连接了错误窗口，结果没有意义。用隔离 `--user-data-dir=/tmp/...`。

## 9. 网站与教程

### `guide/`

VitePress 用户教程站，当前有：

- 入门安装
- 界面、文件、工作区、分屏
- 格式、表格、图片、链接、公式、Mermaid、斜杠菜单
- 查找、大纲、审阅、快捷键
- 主题、字体、设置
- PDF 导出、富文本复制、移动端
- FAQ 和故障排查

用户可见功能变更必须更新对应 guide 页面。截图必须来自“重新构建并安装后的当前 app”，用隔离 profile，不能包含私人路径或旧 UI。

命令：

```bash
npm run guide:dev
npm run guide:check
npm run guide:capture
```

### `website/`

静态产品/下载官网。包含 `index.html`、`styles.css`、`app.js`、SEO 文件和截图资源。它和 `guide/` 是两套站点：

- 官网用于介绍和下载。
- 教程站用于详细图文使用说明。

官网部署时注意 `website/.env.local`、`.vercel/` 等本地配置不要误提交敏感信息。

## 10. 发布与包

- 版本号必须单调递增。不要在发过内部 `0.5.29` 后发布 `0.5.5`，自动更新会认为旧。
- 开始新功能前先升级测试包版本；不要等到功能完成才升级，确保用户每次手测的包都能从版本号辨识来源。
- GitHub release tag 用 `vX.X.X`，标题用 `HorseMD vX.X.X`。
- Release note 用中文，结构建议：
  - 新功能
  - 改进
  - 修复
  - 安装
  - 关联 issue / full changelog
- macOS 包在 macOS 构建，Windows 包在 Windows 构建，Linux `.deb` 在 Ubuntu runner 构建并 `dpkg-deb --info` 验证。
- Linux release 工作流可能需要手动 `gh release upload --clobber` 上传 `.deb`。
- `.omc` 和 `.playwright-mcp` 是本机/工具目录，不要提交。

## 11. 当前 Roadmap 判断

近期优先级：

1. 稳定核心编辑链路：保存、dirty、源码/富文本切换、查找、大纲、表格、PDF。
2. 继续补自动化测试，特别是用户真实反馈路径。
3. 完善 Windows/Linux 实机包验证。
4. AI Phase 0 的合同、上下文快照和变更提案纯逻辑已落地；下一步仍先做只读 Provider，不急着开放自动写入或 Agent 权限。
5. 插件市场难度高，先不急；优先可控的自定义快捷键、同步、AI provider 合同。
6. 源码优先 Live Preview 是远期独立架构项目，不能作为当前 Crepe 模式切换的小修；近期优先完成 transaction-first 的分类型迁移，同时维护已落地的原文保真层。
7. **代码块围栏「吞正文」**：已留底待用户提供复现（`codeblock-fence-investigation.md`）；拿到精确步骤后定位保存路径的围栏/换行丢失点。
8. **损坏围栏吞后文**：0.13.26 修复反引号删除导致的保存/源码锁死，0.13.27 验证 ``` + Space 创建代码块和空块 Backspace 快速退出；但既有文件的结束围栏已损坏后吞正文仍按 `codeblock-fence-investigation.md` 独立排查，不要退回到整篇 canonical 覆盖。

已在 Roadmap 中记录：

- 自定义快捷键第一版已落地，后续谨慎开放编辑器内部命令。
- AI 能力倾向原生体验 + provider 可插拔 + Review-first 修改；VMark 参考结论和具体分期见 [vmark-reference-review.md](./vmark-reference-review.md) 与 [ai-vmark-phase-plan.md](./ai-vmark-phase-plan.md)。
- 云同步桌面端手动闭环已完成当前阶段；自动同步、移动端同步、历史恢复、E2EE、插件市场属于后续阶段。
- 当前公开 Issue 的分流、前置条件和验收边界见 [ROADMAP.md](../ROADMAP.md#当前-issue-分流2026-07-21)。#62 已加 Windows 专属 compositor 降级，但仍必须 Windows 实机复现；#65 必须先定信息架构，#76/#23 都是原生平台项目；不要把它们当成可直接在 renderer 内完成的小修。
- 近期已回复的 issue：#111（文档位置记忆，已实现）、#107（源码+预览分屏，已实现）、#109（PDF 代码块行号/分隔竖线已实现，代码块背景可配置性待确认）、#91/#92 等历史 issue 已在发布时引导下载。回复后保持 open 等用户验收关闭。

## 12. 新 AI 开始任务前的检查清单

1. `git status --short`，确认是否有用户未提交改动。
2. 读当前用户最新一句话，不要执行旧上下文遗留目标。
3. 如果是 bug，先复现或定位现有测试是否覆盖。
4. 找相关模块和历史文档，不要猜。
5. 设计最小改动，避开敏感状态机。
6. 写或更新专项测试。
7. 跑合适验证矩阵。
8. 用户要手测时，安装当前最新 app，并明确验证运行路径。
9. 用户确认后再提交/推送/发 release/回 issue。

## 13. 常见高风险文件

- `src/renderer/src/App.jsx`：shell 状态、source/rich、PDF、session 接线。不要随意塞逻辑。
- `src/renderer/src/components/Editor.jsx`：Crepe 生命周期拥有者。新功能尽量拆到 `editor-*.js`。
- `src/renderer/src/hooks/useSourceModeSwitch.js`：源码/富文本状态机，非常敏感。
- `src/renderer/src/scrollAnchor.js` 和 `mode-*.js`：光标/视口锚点 facade 和实现。
- `src/renderer/src/markdown-source-preservation.js`：原文保真 façade（双快照 diff + 出口硬性 `<br />` 剥离 + 尾换行钳制）。`lib/markdown-preservation/` 下的 `core.js`（commonChange/lineAt/adapt）、`regions.js`（局部对齐/行区域/**分叉块回退**）、`lists.js`、`tables.js`、`paragraphs.js`、`frontmatter.js` 是它的纯函数分解。改这里必须跑 `test:markdown-preservation` + `test:source-fidelity-ui` + `test:mode-switch-raw-offset-ui`。
- `src/renderer/src/components/editor-source-map.js`：raw offset ↔ PM 映射，不能退化成关键词匹配。
- `src/renderer/src/components/editor-api.js`：PDF source、对外 editor API、source/rich restore。
- `src/renderer/src/hooks/useDocPositions.js` + `lib/doc-positions.js`：文档位置记忆（#111），长度校验与防抖写盘边界。
- `src/main/pdf-export.js` / `pdf-document.js` / `pdf-print-styles.js`：PDF 预览、生成、打印样式。
- `src/main/filesystem.js` / `watchers.js` / `security.js`：本地文件和安全边界。
- `src/renderer/src/styles/app.css`：全局样式。改 UI 时查多个主题和移动端。
- 设置页排版预览是实际编辑器的缩尺模型。页宽不能直接套用低于真实预设的固定 `max-width`；测试必须测量可见宽度，不能只检查设置值和 CSS 变量。
- `.hm-html-block`（HTML 表格）与 `.cm-lineNumbers`（代码块行号）的 CSS 都在 `app.css`；改动后分别跑 `test:table-ui` 与 `test:issue-80-ui`/`test:issue-91-pdf-ui`。

## 14. 最近一次稳定基线

截至 **2026-08-11，`0.13.47` 只是诊断候选，不是稳定基线**。自动化家族矩阵、
multicycle 和 tail-fence 都通过，但 `/Applications/HorseMD.app` 的真实长会话人工手测
仍复现 RS-41：富文本、源码和磁盘不一致。**人工结果覆盖自动化结论；在用户明确验收
前，禁止发版、关闭 issue 或声称家族问题已解决。**接手者先读
`rich-source-divergence-incident-0.13.47.md`，抓取第一次分叉的统一 transaction trace，
不要继续从最终 toast 反推字符串补丁。

当前安装与验证仍须注意：`/Applications/HorseMD.app`
是否已替换必须在每次手测前重新核验，不能只看 `dist/` 产物。除 generated-scratch
首个 `-` 列表项 marker、连续空格中间态、`&#x20;`、空引用结构删除外，本轮新增
跨块“编辑 → 删除 → 再编辑 → 立即切源码”的事务边界回归，防止源码保留已删内容或
遗漏新增内容；列表项正文中新输入的 `1.` / `1)` / `-` / `+` / `*` 字面文本不得泄漏
serializer 反斜杠或格式化未编辑列表；反引号部分/全部删除后不得保存暂停或锁住源码模式。
generated scratch 与空文件首次编辑中，同一行三反引号正文不得泄漏 serializer `\``；
完整现状见 `rich-source-fidelity-bug-family.md`、`list-item-literal-marker-escape-regression.md`、
`backtick-source-sync-lock-regression.md` 与 `leading-space-mode-switch-regression.md`。
0.13.29 新增桌面端外部文件/文件夹拖入：文件复用标签打开链路，目录加入多根工作区，
富文本正文图片仍由编辑器插入；实现与测试边界见 `desktop-drop-open.md`，专项命令为
`npm run test:drop-open-ui`。
0.13.46 候选继续修复了只在第二、第三、第四轮持久化后出现的根因：列表 input intent
在 marker 已恢复后仍残留，下一次正文回调会用旧槽重建列表；批量列表 mapper 还可能
只提交列表而丢掉同一 callback 的后续正文。现在意图只消费一次、结构事务必须完整提交，
CRLF/无末尾换行的块边界按字节处理。再次冷重开后，在已有正文与 fence 之间从空段
创建有序列表时，严格中间槽 mapper 会原子写回列表与退出后的正文，并立即消费 intent。
`test:family-multicycle-ui` 使用仓库内生成 fixture，在默认与 primary 两条路径连续执行
4 轮编辑/保存、5 次冷打开；真实 `123321.md` override 与 4×5 家族矩阵也已通过。
0.13.47 继续修复 `/code` 两阶段结构命令只删除临时 query、却没有原子写入 fence 的
RS-40。专项现在要求 40ms/350ms 两种菜单时序、完整且唯一 fence、冷重开后仍是
`.milkdown-code-block`，并在代码块创建后连续修改代码、后文和前文列表；真实
`123321.md` 临时副本与隔离安装包均通过。详见 `family-root-cause-matrix.md` 的根因 9–14
和 `slash-code-source-sync-regression.md`。

同日已重新执行 `rich-source-fidelity-bug-family.md` 与
`nested-list-sync-bug-handoff.md` 所列完整家族矩阵：纯函数映射、逐键段落/列表/反引号、
空段落/空引用、源码光标、保存重开、混合事务、长文档、源码+预览与四档 chaos
全部通过。期间发现 `test:paragraph-source-ui` 仍按旧“首字符自动激活行内代码”合同编写，
已改为真实闭合反引号触发；这是测试合同过时，不是产品数据流失败。
0.13.x 在 0.12.50 基线之上新增/更新的必测项：

```bash
npm run build
npm run build:mobile
npm run guide:check
npm run test:document-export
npm run test:document-export-ui
npm run test:ai-core
npm run test:ui-regression
node scripts/test-pdf-document.mjs
npm run test:pdf-latex-ui
npm run test:markdown-preservation
npm run test:family-multicycle-ui
npm run test:new-document-list-source-ui
npm run test:issue-77-ui
npm run test:paragraph-source-ui
npm run test:issue-79-ui
npm run test:outline-reorder
npm run test:issue-82-ui
npm run test:floating-outline-ui
npm run test:diverged-delete-source-ui
npm run test:mixed-rich-source-transaction-ui
npm run test:list-item-literal-marker-source-ui
npm run test:code-fence-delete-source-ui
npm run test:doc-position-restore-ui
npm run test:step-source-mapper
npm run test:source-fidelity-ui
npm run test:empty-paragraph-source-ui
npm run test:mode-switch-raw-offset-ui
npm run test:table-ui
npm run test:issue-91-pdf-ui
npm run test:drop-open-ui
```

`test:ui-regression` 全绿基线（7 sessions + 25 standalone）在 0.12.48 验证，0.12.5x–0.13.x 持续增量扩展。已知例外：`test:rich-source-chaos-ui` 第一子测试**基线即偶发**（点击坐标时序），单独跑可过，不代表回归。

如果后续出现“之前明明是好的”，先回到这个基线和最近提交 diff 对照。

### 真实 macOS 输入补充

疑难编辑问题除后台 CDP 回归外，可用 `CGEvent` 在前台 HorseMD 中逐键输入，并以截图、保存重开和按需 `pbpaste` 交叉核验；方法见 [macOS 真实输入测试方法](macos-real-input-testing.md)。英文原始键码与中文拼音组合输入需分别覆盖。
