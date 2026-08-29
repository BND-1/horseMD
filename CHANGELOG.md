# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Known Issues
- **富文本 / 源码长会话仍可能分叉（P0）** — 0.13.47 的 `/code` 原子同步修复通过了家族矩阵、多轮持久化和代码块专项，但安装包人工验收仍能在真实长文档中复现：建立代码块后继续多轮编辑，富文本新增内容可能没有完整进入源码或磁盘；保存既可能暂停，也可能执行成功但内容仍不一致。该问题尚未关闭，禁止把当前候选描述为稳定修复。接手记录见 [`docs/rich-source-divergence-incident-0.13.47.md`](./docs/rich-source-divergence-incident-0.13.47.md)。

### Changed
- **顶层普通列表尾空项 Backspace 删除迁入独立 Transaction Journal owner，并排除 nested/task 等不同拓扑** — 0.13.152 新增 `list-empty-item-tail-remove` focused owner，只认领顶层普通 bullet/ordered list 的最后一个空 item，且其前一 item 必须仅含一个非空 plain paragraph。真实物理 Backspace 为唯一 `ReplaceStep(structure=true,sliceSize=0)`；以实测 `- left / - ` 为例，Step 为 `from=16,to=18`，精确删除前一 item closing wrapper 与尾空 item opening wrapper，使一个 editor-only trailing empty paragraph 留在前一 item。owner 要求 old/new list attrs与早期 siblings不变、old preceding item只有一个非空 paragraph、new preceding item恰为原 paragraph加一个空 paragraph、Step 在捕获 stepDoc 上 apply 后等于 live expectedDoc。raw patch 用 PM source-map 证明同一顶层 list，只删除作者最后一个空 marker row及其自身 EOL，保留 BOM、LF/CRLF、marker/delimiter、列表后的 block gap和所有未编辑字节。validator 仅在 exact tail proof/path 下忽略这一处 trailing empty paragraph；registry 将 tail owner置于 interior owner之前并设置 `legacyRetired:true`，PM family已证明但 loose tail rows/body/range 不满足时 `recognized:true + legacyBlocked:true`，不允许旧 `empty-list-item-removed` 再自愈。相邻审计曾发现初版会误抢 RS-63“nested list 后空项”，发布前已收紧为 preceding item 必须 `childCount=1` 的 plain paragraph，并新增 nested negative；RS-63、task、first-empty、interior、isolated ordered lift、RS-72、cross-list、rapid double Enter和generic list-subtree均保持原 owner。永久回归覆盖纯合同、callback/forced、BOM+CRLF source/save/disk/fresh-profile reopen和 loose-tail fail-closed。专项见 [`docs/transaction-journal-list-empty-item-tail-remove.md`](./docs/transaction-journal-list-empty-item-tail-remove.md)。
- **顶层普通列表中间空项 Backspace 删除迁入 focused Transaction Journal，并阻断“新 owner 先失败、legacy 再自愈”的双重所有权** — 0.13.151 新增 `list-empty-item-remove` focused owner，只认领一个顶层非任务 bullet/ordered list 中、前后都有真实 sibling 的唯一空 `list_item`。真实物理 Backspace 是一个 closed `ReplaceStep(structure=true, sliceSize=0)`，精确删除前一 item 的 closing wrapper boundary 与空 item 的 opening wrapper boundary（实测 `left=[16,23) / empty=[23,27) / step=22→24`），使空 paragraph 成为前一 item 的 editor-only trailing paragraph；owner 逐 transaction/stepDoc 重放并要求其余 siblings、list attrs、邻块完全不变。raw patch 不经过 broad list canonical mapper，只在 source/previous-canonical 中用 PM source-map 锁定同一顶层 list，要求作者同级 marker row 数与 PM item 数一致、目标 source row 真为空且前后同类 marker 物理连续，然后只删除该作者空 marker 行及其 EOL，保留 BOM、LF/CRLF、bullet token、ordered delimiter、邻块和其它字节。validator 仅在 exact `transaction-list-empty-item-remove-proof` + 精确 removed/item/paragraph path + 单一真实 ReplaceStep + journal snapshot/document proof 全部成立时忽略这一处不可编码 trailing empty paragraph。生产 registry 将该 narrow family 放在 broad `list-subtree` 前并设置 `legacyRetired:true`；PM family 已识别但 loose rows、row count、range 或 source body 不匹配时返回 `recognized:true` 并阻断旧 `empty-list-item-removed` / generic fallback，保留富文本编辑、显示 warning、无 Coordinator publication且磁盘不变。永久回归覆盖纯正反合同、Enter→Backspace callback/forced、初始 BOM+CRLF 空项的 callback/forced source/save/disk/fresh-profile reopen，以及 loose-list recognized+legacyBlocked 真实负例；ordered lift、RS-72、cross-list、nested、generated scratch、task、rapid double Enter、generic list-subtree、mixed rich/source、39/39 probes与异构 fidelity均继续通过。专项见 [`docs/transaction-journal-list-empty-item-remove.md`](./docs/transaction-journal-list-empty-item-remove.md)。
- **非空 fenced code block 转换为普通段落接入 Transaction Journal，并退役该 family 的 legacy fallback** — 0.13.150 新增 `code-block-to-paragraph` focused owner：真实 HorseMD 右键“转换为正文”先用共享 NodeView DOM identity 唯一映射被点击的顶层 PM `code_block`，不再信任 CodeMirror wrapper 的边界 `posAtDOM`；块命令显式携带目标 PM 位置，`setNodeMarkup` 形成 `ReplaceAroundStep(structure=true)`，随后快速文字只能继续落在同一个 paragraph。owner 要求旧 code block 非空、单行、plain、opening/content/closing authored fence range 唯一且 source/previous canonical 内容与 language 精确等于旧 PM 节点，只原子替换完整 fence range为最终 paragraph，保留 BOM、LF/CRLF、邻块与所有未编辑字节。Markdown-sensitive 正文（如 `# heading`）会在 parser/semantic proof 阶段被 `recognized:true` 拒绝，并因 `legacyRetired` 阻断 generic canonical-diff 回退：富文本编辑保持可见、警告出现、无 Coordinator/legacy publication、源码 textarea 不展示陈旧内容且磁盘逐字不变。新增 NodeView identity 边界合同、focused owner 正反合同、legacy no-hit 合同和真实 Electron callback/forced/source/save/disk/fresh-profile reopen + semantic rejection 回归。专项见 [`docs/transaction-journal-code-block-paragraph.md`](./docs/transaction-journal-code-block-paragraph.md)。
- **四个已迁移 Blockquote family 的 generic legacy owner 正式退役** — 0.13.149 为 `blockquote-paragraph-text-replace`、`blockquote-paragraph-split`、`blockquote-paragraph-join` 与 `blockquote-paragraph-exit` 建立显式 recognition 边界并在 structural registry 设置 `legacyRetired`。PM Step/stepDoc、stable descendant path 与完整 replay 尚未证明 family 时保持 `recognized=false`，仍可继续后续 focused owner或空引用删除、IME填充、generated scratch transient等未迁移兼容路径；一旦事务已被完整分类，raw source range、作者 quote prefix/separator、正文一致性、Markdown-sensitive输入或semantic proof失败改为 `recognized=true`，统一阻断 `paragraph-emptied`、`middle-block-*`、`diverged-tail-block-append` 与行级 generic fallback。新增静态/控制流合同和真实语法敏感星号 Electron负例：编辑保持在富文本、trace为`recognized:true / legacyBlocked:true`、显示警告、没有legacy/Coordinator publication且作者磁盘逐字不变。四个正向callback/forced/save/reopen、空引用删除/IME/generated/middle transient、Journal/Coordinator、完整preservation、39/39 probes、异构fidelity、mixed rich/source与desktop/mobile build均通过。专项见 [`docs/transaction-journal-blockquote-legacy-owner-retirement.md`](./docs/transaction-journal-blockquote-legacy-owner-retirement.md)。
- **已迁移代码块 family 的 legacy canonical owner 正式退役** — 删除已有代码块正文的 dedicated `preserveFencedCodeBlockTextChange()`、对应 dispatcher 与旧正向 canonical-diff 合同；info string、空代码块 Backspace 解包和显式退出没有独立 legacy函数，但在真实 Step/stepDoc 已完整识别 family 后统一以 `legacyRetired + recognized` 阻断 generic fallback。分类/回放失败仍允许后续 owner继续，空块 `awaiting-content` 仍只 hold journal；只有 raw source range、正文/language、围栏冲突或 semantic proof失败才 fail closed。新增静态/行为退役门禁和真实 tilde-fence collision Electron反例，证明冲突编辑保持在富文本、显示警告、没有 legacy/Coordinator publication且源码/磁盘不变；fenced range parser作为 Transaction Journal物理范围工具继续保留。专项见 [`docs/transaction-journal-code-block-legacy-owner-retirement.md`](./docs/transaction-journal-code-block-legacy-owner-retirement.md)。
- **非空 fenced code block 的显式退出接入 provenance-bound Transaction Journal** — 0.13.148 新增固定、不可配置的 editor-owned 命令 `editor.code.exit = Mod+Enter`。CodeMirror 原本会吞掉该组合键并继续在代码块内换行；现在统一 keydown 层只在事件目标属于当前编辑器的非空 `.milkdown-code-block` 时，通过 NodeView DOM identity / `posAtDOM` 双证明唯一映射顶层 PM `code_block`，建立临时 code-end selection并调用官方 ProseMirror `exitCode`，只 dispatch 其唯一文档事务。`code-block-exit` focused owner随后要求一个 closed `ReplaceStep` 在该非空 plain code block 的精确 after position 插入空 paragraph；快速文字只能继续编辑该新段。pending 空段可先以 source byte-identical checkpoint发布，后续 staged journal只有在上一 revision 的 `owner=transaction / family=reason=code-block-exit` provenance仍绑定时才能继续；为此共享 `SourceSyncTransactionJournal` 把 snapshot owner/family/reason与revision/source/canonical一起固化并验证，同字节同revision但被重标也 fail closed。owner复用生产 `code-block-transaction-common` 的 authored source/previous-canonical fence range，要求正文与language均与PM节点一致，仅在closing fence后做bounded段落插入，保留作者tilde/backtick、fence长度、info padding、BOM、LF/CRLF、邻块和未编辑字节。空代码块、普通区域按键、无法唯一映射的DOM、直接非空段插入、marks、邻块混改、错误Step/provenance/range/content/language/semantic/stale均拒绝且不拦截原事件。真实Electron证明三条实际时序：快速物理`Mod+Enter+XY`先经forced-flush发布source不变pending，再由provenance-bound staged journal写入`XY`；自然等待经markdownUpdated发布pending后再staged；立即切源码经forced-flush发布pending后再staged。三条均覆盖source/save/CRLF disk/fresh-profile reopen和零warning；coalesced结构+文字仍由纯owner合同证明，但不是当前DOM物理默认时序。专项见 [`docs/transaction-journal-code-block-exit.md`](./docs/transaction-journal-code-block-exit.md)。
- **顶层列表项正文编辑与 RS-72 空项 Backspace 收敛到精确 Transaction Journal ownership** — 0.13.147 新增 `list-item-paragraph-text-replace` focused owner：只认领顶层 bullet/ordered list 中一个非任务 item 的单一直接 plain paragraph，完整 `ReplaceStep`/`stepDoc` journal、稳定 item/paragraph path、attrs、marks、兄弟和邻块共同证明所有权；普通替换与彻底清空正文只修改对应 raw body bytes，作者 `- / + / *`、ordered delimiter、BOM、LF/CRLF 和未编辑字节保持，nested/task/marks/多 item/结构 Step/敏感语法继续 fail closed。RS-72 的中间空 ordered item Backspace 仍由 `list-subtree-replace` 处理，但 transient empty paragraph 只能在唯一 old/new list topology 和 exact PM path 证明后抑制；候选源码不再泄漏缩进 `<br />`，错 path、多 path、多 placeholder、作者 HTML 或非空 continuation 均拒绝。`mixed-rich-source-transaction-ui` 现要求列表正文清空与后续输入分别经 `transaction-list-item-paragraph-forced-flush` 发布；RS-72 Electron 回归要求 transaction list-subtree proof、semantic/list-slot integrity、精确 source、保存与冷重开。测试基础设施同时为 `launchBuiltElectron()` 增加 CDP 端口占用预检，`tail-fence` 挂载失败会停止刚启动进程并清理 profile，避免旧 orphan 页面造成假红；两档 tail-fence 已完整通过且 9910–9913 无残留监听。专项见 [`docs/transaction-journal-empty-code-list-paragraph-families.md`](./docs/transaction-journal-empty-code-list-paragraph-families.md)。
- **空 fenced code block 的 Backspace 解包接入同一本 Transaction Journal** — 0.13.146 新增 `empty-code-block-backspace-unpack` focused owner：第一笔真实 `ReplaceStep` 必须精确把唯一空 `code_block` 的完整 node range 替换为空 plain paragraph，后续快速文字 Step 只能继续落在同一顶层 paragraph，邻块、attrs、marks、atom、跨块和非空代码正文全部 fail closed。空中间态不再通过旧的零延迟 generic reconcile 提前发布，而由 owner 返回 `holdJournal` 保留同一本 revision/source/canonical/doc journal；快速 `XY` 在自然 callback 原子发布，未输入文字就立即切源码或保存则由 forced-empty 边界删除完整 opening/content/closing fence。raw patch 保留作者 tilde/backtick、info、BOM、LF/CRLF、邻块和未编辑字节，不会残留 closing fence或写入 `<br />`。纯 owner 与双场真实 Electron 回归覆盖同 journal Step 链、callback/forced flush、精确源码、保存、磁盘、全新 profile 冷重开和零 warning；相邻 code content/info、fence delete、list subtree、journal/Coordinator、39/39 probes、desktop/mobile build均通过。专项见 [`docs/transaction-journal-empty-code-block-backspace.md`](./docs/transaction-journal-empty-code-block-backspace.md)。
- **表格物理列宽拖拽接入 PM-only Transaction Journal owner，GFM 源码保持逐字不变** — 0.13.145 新增 `table-column-width` focused owner：HorseMD 的长按列边界拖拽在鼠标释放时通过 `persistColumnWidth()` 对 header 和每条 body row 依次执行 `setNodeMarkup(..., { colwidth })`，真实 transaction 因而是同一 entry 内一行一个 `ReplaceAroundStep(structure=true)`。owner 只接受已有 simple-grid table 中唯一一个 column ordinal 的统一宽度变化；row/column 数、table/row attrs、cell type/content、colwidth 之外 attrs、其它列和邻块必须不变，所有 rows 的 previous width 与 next width 分别一致，new width 必须是正整数且不少于 25。每个 Step 必须在递进 `stepDoc` 上精确替换 `[table,row,column]` 的完整 cell wrapper，gap 原样保留 content，Step 数必须等于 row 数，完整链最终等于 live expectedDoc；单 cell、多个 columns、mixed widths、多 transaction、正文/对齐混改、colspan/rowspan、非法 width、source/canonical/doc stale 全部 fail closed。由于 GFM Markdown 没有列宽语法，成功 publication 的 source 与 canonical 都保持 byte-identical，只由 Coordinator 推进 PM expectedDoc；`notifyChange=false`，不产生 source dirty，也不伪造磁盘持久化。semantic comparator 仅在 exact `transaction-table-column-width-proof` + exact reason + 全部精确 cell paths 下忽略这些 paths 的 `colwidth`，漏 path、错 reason、伪 proof 或 alignment/content/span 变化仍严格拒绝。本轮同时修复共享 SourceSync proof 归一化把同一对象同时用于 ownership/preservation proof 时误写为 `[Circular]` 的根因，并将 callback preflight 与最终 first-divergence 诊断分离；真实循环仍安全截断。`flushMarkdown()` 现在即使 canonical 未变化也先询问 pending journal，使立即切源码可经 `transaction-table-column-width-forced-flush` 提交 PM-only checkpoint；正常 settle 经 `transaction-table-column-width-markdown-updated`。真实 Electron 覆盖 BOM+CRLF、自定义表格 spacing、物理长按拖拽、callback/forced-flush、唯一 publication、源码/磁盘/dirty 不变、当前会话宽度生效和全新 profile 冷重开恢复 GFM 自动宽度。全部 table owners/UI、table scroll、PDF layout、issue-86、相邻 list/code/blockquote、LF/CRLF/BOM transaction、完整 preservation、39/39 probes、异构 source fidelity、desktop/mobile build 全绿。专项见 [`docs/transaction-journal-table-column-width-family.md`](./docs/transaction-journal-table-column-width-family.md)。
- **GFM 简单网格整列对齐接入逐 row ReplaceAroundStep Transaction Journal owner** — 0.13.144 新增 `table-column-alignment` focused owner：真实 Milkdown 列手柄左/中/右按钮先建立整列 `CellSelection`，再由 `setCellAttr('alignment', direction)` 在同一个 transaction 中按 header→body row 生成一行一个 `ReplaceAroundStep(structure=true)`；每个 Step 在自己的递进 `stepDoc` 上精确替换同一 column ordinal 的 cell wrapper attrs，`gapFrom..gapTo` 原样保留 cell 内容。owner 只接受一个 simple-grid table、一列全部 rows 从同一旧 alignment 变为同一新 alignment，table/row/cell 内容、其它 attrs、行列 topology、其它列和邻块逐节点不变；单 cell、跨多列、alignment+正文混改、多个 transaction、marks/atoms、多 paragraph、span/colwidth、attrs 冲突、source/canonical/doc stale 均 fail closed。raw patch 不序列化整表，也不根据 next canonical 冒号形状猜归属：owner 用 PM header cell source-map 锁定作者 header 物理行，解析其下一条 delimiter row，逐列验证作者 delimiter alignment 与 previous PM attrs一致，然后只改目标 delimiter cell 的冒号，保留该 cell 原 dash 数、前后空白、其它 delimiter cells、header/body rows、BOM、LF/CRLF/lone-CR 和邻段。真实 `attrs.alignment` 与兼容 `attrs.align` 统一解析，双属性冲突或非法值拒绝。自然 settle 经 `transaction-table-column-alignment-markdown-updated`，立即切源码经 `transaction-table-column-alignment-forced-flush`；纯合同覆盖 right→center、center→left、left→right、重复列、BOM+CRLF、single/multi-column、mixed edit、marks/span、source/semantic/callback/stale 负例；真实 Electron 覆盖三个可见对齐按钮、callback/forced-flush、源码、保存、磁盘和全新 profile 冷重开。全部 table owners/UI、旧 issue-86、journal/Coordinator、完整 preservation、39/39 probes、异构 source fidelity、RS-68 5/18/70ms、desktop/mobile build 全绿。专项见 [`docs/transaction-journal-table-column-alignment-family.md`](./docs/transaction-journal-table-column-alignment-family.md)。
- **GFM 简单网格空列新增接入逐 row stepDoc Transaction Journal owner** — 0.13.143 新增 `table-column-insert` focused owner：真实 Milkdown/ProseMirror `addColumnBefore` / `addColumnAfter` 必须在同一个 journal entry 中为 header 与每条 body row 各生成一个 `from === to` 的 closed `ReplaceStep`，slice 恰含一个与该 row 类型匹配的空 cell；owner 按递进 `stepDoc` 证明所有 Step 在同一 column ordinal 插入，old/new row 数与 attrs 不变，旧表每行恰比新表少一个 cell，唯一 inserted ordinal 由全部 rows 的剩余 cell stream、Step 边界与 slice/expected cell equality 共同确定。只支持无 colspan/rowspan/colwidth、每 cell 单 paragraph 的简单矩形 grid；非空 inserted cell、插入后同 journal 输入、marks/atoms、多 paragraph、部分 rows、多个 transaction、attrs/topology混改、source/canonical/doc stale 均 fail closed。raw patch 不序列化整表，而是分别解析作者 header、delimiter/alignment row 与全部 body rows，在相同 pipe ordinal 插入空 cell segment；每一行复用相邻作者 cell 的物理 spacing，delimiter 则严格由 transaction-owned inserted cell alignment 生成，兼容真实 schema 的 `attrs.alignment` 与旧 schema 的 `attrs.align`，双属性冲突或非法 alignment 拒绝。重复 `Value` / `same` 列由 column ordinal + 多 Step paths 精确区分，BOM、LF/CRLF/lone-CR、其它列/行与邻段逐字保留。本轮同时修复共享 semantic normalization 对 Milkdown `hard_break` 与历史 `hardbreak` standalone 空段占位符命名不一致的问题；只有整段唯一内容为占位符时才等价于空 paragraph，文本包围的真实 hard break 仍严格比较。自然 settle 经 `transaction-table-column-insert-markdown-updated` 发布，立即切源码经 `transaction-table-column-insert-forced-flush` 发布；纯合同、真实 y-line add button、源码、保存、磁盘、全新 profile 冷重开、全部 table owners/UI、旧 issue-86、39/39 probes、异构 source fidelity、RS-68 5/18/70ms、desktop/mobile build 全绿。专项见 [`docs/transaction-journal-table-column-insert-family.md`](./docs/transaction-journal-table-column-insert-family.md)。
- **GFM 简单网格单列删除接入逐 row stepDoc Transaction Journal owner** — 0.13.142 新增 `table-column-delete` focused owner：真实 Milkdown/ProseMirror `deleteColumn` 必须在同一个 transaction 中为 header 与每个 body row 各生成一个 empty closed-slice `ReplaceStep`，owner 按递进 `stepDoc` 逐步证明每个 range 精确覆盖同一 column ordinal 的完整 cell node；old/new table row 数、attrs 与其它 cells 必须不变，旧表恰比新表多一列，唯一 deleted ordinal 由所有 rows 的剩余 cell stream 共同确定。只支持无 colspan/rowspan/colwidth 的简单矩形 grid，删除唯一一列时底层 command 必须不 dispatch；marks、空/多 paragraph cell、span、部分 row 删除、多 transaction、删除后继续输入、邻块混改、source/semantic/stale 全部 fail closed。raw patch 不写 canonical 整表，而是用修复后的 GFM PM→Markdown mapper 分别证明 header/body 每个 cell 的物理位置，并在作者 header、全部 body rows 与 delimiter/alignment row 中删除同一 pipe cell 区间；重复 `Value` / `same` 列由 column ordinal + 多 Step path 精确区分，BOM、LF/CRLF/lone-CR、作者每行独立 spacing、其它列/行与邻段逐字保留。本轮同时补齐真实 `table_header → paragraph` 的 source-map 分类，避免表头坐标漂移到普通段落。自然 settle 经 `transaction-table-column-delete-markdown-updated` 发布，立即切源码经 `transaction-table-column-delete-forced-flush` 发布；真实 `col-drag-handle` 四按钮菜单回归覆盖源码、保存、磁盘和全新 profile 冷重开。新 owner、source-map、共享 mapper/journal/Coordinator/preservation、相邻 table cell/row owners 与 UI、issue-86、39/39 probes 和 production build 全绿。专项见 [`docs/transaction-journal-table-column-delete-family.md`](./docs/transaction-journal-table-column-delete-family.md)。
- **GFM 表格空 body row 新增接入 exact-insertion-boundary Transaction Journal owner** — 0.13.141 新增 `table-row-insert` focused owner：oldDoc→expectedDoc 只能有一个顶层 `table` 变化，新表恰比旧表多一行；真实 Milkdown `addRowAfter` 必须形成一个 `from === to` 的 closed `ReplaceStep`，slice 恰含一个与表格等列数的空 `table_row`，唯一插入 ordinal 同时由 old/new row stream、Step 边界、slice row 与 expected inserted row 相等共同证明。header 前插入、非空 inserted row、同 transaction 或后续 transaction 立即输入、marks、空/多 paragraph template、span/列拓扑、邻块混改、source/semantic/stale 均 fail closed。生产 `addRowWithAlignment` 复制表头列 alignment；owner兼容 `table_header_row + table_header` 与标准 header schema，body 仍严格为无 span 的 `table_row + table_cell` 简单网格。raw patch 不序列化整表，而是对选中位置前一条作者 body row（header 后首行则使用原首 body row）逐 cell 做 PM→source/previous-canonical 映射，删除其正文 spans 得到完全沿用作者 pipes 与列 spacing 的空行模板，并在精确行边界插入；支持中间行、header 后首 body row、EOF 无终止换行、BOM、LF/CRLF/lone-CR，且不泄漏 `<br />`。自然 settle 经 `transaction-table-row-insert-markdown-updated` 发布，立即切源码经 `transaction-table-row-insert-forced-flush` 发布；真实 `.x-line-drag-handle .add-button` 回归覆盖重复 authored row occurrence、源码、保存、磁盘和全新 profile 冷重开，零 integrity failure / warning。专项见 [`docs/transaction-journal-table-row-insert-family.md`](./docs/transaction-journal-table-row-insert-family.md)。
- **GFM 表格已有 body row 删除接入 exact-row-range Transaction Journal owner** — 0.13.140 新增 `table-row-delete` focused owner：oldDoc→expectedDoc 必须只有一个顶层 `table` 变化，旧表恰比新表多一行，真实 Milkdown/ProseMirror `deleteRow` journal 必须只有一个 empty closed-slice `ReplaceStep`，其 `from..to` 必须精确等于唯一被删 `table_row` 的完整 node range；header row、最后一个 body row、多行/多 transaction、邻块混改、marks、空 cell、多 paragraph、colspan/rowspan/colwidth 与列拓扑变化全部 fail closed。owner 同时兼容生产 GFM 的 `table_header_row + table_header` 和纯合同的标准 header 形状，body 仍严格要求 `table_row + table_cell` 简单网格。raw patch 对被删行每个 cell 分别用现有 `pmPosToMarkdownOffset()` 证明 source/previous-canonical 文本，要求全部落在同一物理表格行，只删除该作者行及其原 EOL；重复正文行由 PM ordinal + Step range 精确区分，作者 pipe/列 spacing/alignment delimiter、BOM、LF/CRLF/lone-CR、其它 rows 和邻段逐字保留。生产 registry 提供 `transaction-table-row-delete-markdown-updated` / `transaction-table-row-delete-forced-flush`；当前真实 Milkdown 行控件会调用 rich-dirty reconcile，因此自然 settled 与立即切源码两条 UI 路径都通过 forced-flush 发布，纯合同另行证明 markdown-updated boundary 可规划。真实回归通过行拖拽柄与删除按钮操作选中的第二个重复 authored row，覆盖源码、保存、磁盘和全新 profile 冷重开，零 integrity failure / warning。专项见 [`docs/transaction-journal-table-row-delete-family.md`](./docs/transaction-journal-table-row-delete-family.md)。
- **GFM 表格单一单元格纯文字编辑接入 stable-cell-path Transaction Journal owner** — 0.13.139 新增 `table-cell-plain-text-replace` focused owner：oldDoc→expectedDoc 必须只有一个稳定 `table_cell` descendant path 发生变化，cell 的父节点必须是同一 `table_row`、祖父必须是同一 `table`，table/row/cell/paragraph attrs、row/column topology、其它 cells 与邻块全部保持；journal 每个 Step 必须是同一 cell 唯一直接 plain paragraph 内的非结构 closed-text `ReplaceStep`，逐 Step 在捕获时 `stepDoc` 上重放，空结果、marks/atoms、跨 cell、多 cell、cell/row/table attrs 与拓扑变化均 fail closed。raw patch 复用已有 `mapPlainTextTransactionsToSource()` 和 GFM `pmPosToMarkdownOffset()` occurrence mapping，只修改目标 cell text bytes；重复正文单元格按 PM path/occurrence 精确定位，作者竖线、列 spacing、alignment delimiter row、BOM、LF/CRLF、其它 cells 与后继段落逐字保留。`|` 等 Markdown-sensitive 输入由通用 mapper 返回 `syntax-sensitive-insert`，没有新增转义或 canonical 形状特判。callback 与立即切源码分别经 `transaction-table-cell-markdown-updated` / `transaction-table-cell-forced-flush` 进入同一 structural registry、完整 semantic/list-slot gate 与 Coordinator。纯合同覆盖重复单元格、header/body row、BOM+CRLF、快速双 transaction、marks、空 cell、pipe、跨 cell、attrs/topology、source/semantic/callback/stale 负例；真实 Electron 覆盖物理输入 `XY`、重复 cell path、作者列 spacing/对齐、callback/forced flush、源码、保存、磁盘和全新 profile 冷重开，零 integrity failure / warning。专项见 [`docs/transaction-journal-table-cell-family.md`](./docs/transaction-journal-table-cell-family.md)。
- **Blockquote 末尾连续两次 Enter 退出引用接入 staged/coalesced Transaction Journal owner** — 0.13.138 新增 `blockquote-paragraph-exit` focused owner：第一拍真实 `ReplaceStep` 只在稳定 blockquote path 末尾新增一个空 paragraph，source 保持不变，并复用既有严格 reason `trailing-empty-blockquote-paragraph-created` 通过 transaction proof 与 Coordinator 推进 canonical；第二拍真实 `ReplaceAroundStep` 将该空段提升为 blockquote 后同级 paragraph，随后同一 delayed callback 内的快速纯文字 `ReplaceStep` 只能落在退出段。owner 同时支持第一拍尚未发布的 coalesced journal 和第一拍已提交的 staged journal；顶层引用与列表项内引用共用稳定 parent/quote/inserted path，父类型只允许 `doc` 或 `list_item`，祖先 attrs、siblings、quote children 和邻块均必须不变。raw patch 不写入 transient 空引用行，而是在作者最后一条 quote line 后插入一个 block gap 与退出段；顶层段落不缩进，list item 内段落复用 quote indentation，作者 `>` 后 spacing、BOM、LF/CRLF、列表 marker 和其余字节保持。callback 与立即切源码分别通过 `transaction-blockquote-exit-markdown-updated` / `transaction-blockquote-exit-forced-flush` 原子发布。纯合同覆盖顶层/nested、pending/coalesced/staged、marks、空退出、邻块、unsupported parent、source/semantic/callback/stale 负例；真实 Electron 覆盖两次物理 Enter + 快速 `XY`、第一拍 transaction-owned pending checkpoint、callback/forced-flush、源码、保存、磁盘和全新 profile 冷重开，全程零 integrity failure / warning。专项见 [`docs/transaction-journal-blockquote-exit-family.md`](./docs/transaction-journal-blockquote-exit-family.md)。
- **Blockquote 段首 Backspace 合并相邻段落接入 stable-path Transaction Journal owner** — 0.13.137 新增 `blockquote-paragraph-join` focused owner：真实物理 Backspace 的 journal 必须在同一稳定 blockquote `nodePath` 上包含一个空 closed slice 的 `ReplaceStep`，范围精确从左段正文末尾跨两个 PM boundary token 到右段正文开头，目标直接子数量恰减 1，结果段落 attrs 不变且正文精确等于左右正文拼接；同一 delayed callback 内紧随的快速纯文字输入只能继续落在合并段。真实 Milkdown 证据显示该 Step 的 `structure=false`，而纯 `joinBackward` command 为 `structure=true`；owner 不依赖这个 safety hint，而由空 slice、宽度 2、parent offsets、child ordinal、childCount、merged text、stepDoc 重放、stable path 和祖先/邻块不变共同证明。raw patch 分别映射作者左右 quote paragraph，只删除左段行尾、quote-only separator 和右段前缀，将最终合并正文写回左段正文位置；作者 `>` 前 indentation/spacing、BOM、LF/CRLF、父 list item、前后列表和其它字节保持不变。callback 与立即切源码分别经 `transaction-blockquote-join-markdown-updated` / `transaction-blockquote-join-forced-flush` 进入同一 structural registry 和 Coordinator。纯合同覆盖 structure true/false、nested list path、BOM/CRLF、快速后续输入、多引用歧义、marks、邻块、缺失 separator、source mismatch、semantic false 与 stale revision；真实 Electron 覆盖物理 Backspace + 快速 `XY`、源码、保存、磁盘字节和全新 profile 冷重开，零 integrity failure / warning。专项见 [`docs/transaction-journal-blockquote-join-family.md`](./docs/transaction-journal-blockquote-join-family.md)。
- **Blockquote 中间 Enter 拆段接入稳定 descendant-path Transaction Journal owner** — 0.13.136 新增 `blockquote-paragraph-split` focused owner，并将引用所有权从“顶层节点类型必须是 blockquote”提升为通用的稳定 ProseMirror `nodePath` 证明：oldDoc→finalDoc 仍只能有一个顶层子树变化，但该子树内必须恰有一个 `blockquote` descendant 承担全部变化，祖先路径、attrs、兄弟节点和其它引用均保持不变；同一容器内多个引用同时变化会因目标不唯一而 fail closed。owner 逐 Step 在捕获时 `stepDoc` 上验证真实结构性 `ReplaceStep` 将一个非空直接子 paragraph 拆成两个非空 plain paragraphs，允许同一 delayed callback 内紧随其后的快速纯文字输入；raw patch 只替换作者原引用行，复用原 `>` 前缀、spacing、BOM 与 LF/CRLF，并插入 parse-safe quote blank line。该路径现可安全处理列表项等容器内的引用，而不是通过 Markdown 缩进或 `>` 形状猜 family；引用正文 owner 同步复用同一 anchored-path 分类。callback 与立即切源码分别通过 `transaction-blockquote-split-markdown-updated` / `transaction-blockquote-split-forced-flush` 原子发布。纯正反合同覆盖 nested list path、BOM/CRLF、多引用歧义、跨 child、marks、attrs、semantic mismatch 与 stale revision；真实 Electron 覆盖物理 Enter + 快速 `XY`、源码、保存、磁盘字节和全新 profile 冷重开，零 integrity failure / warning。专项见 [`docs/transaction-journal-blockquote-split-family.md`](./docs/transaction-journal-blockquote-split-family.md)。
- **已有 blockquote 的同段纯文字变化接入共享 Transaction Journal 与结构 owner registry** — 0.13.135 新增 `blockquote-paragraph-text-replace` focused owner：只认领一个顶层 `blockquote` 中恰好一个直接子 `paragraph` 的非空、无 mark 纯文字 `ReplaceStep` 链；引用 attrs、子节点数量、其它引用段、邻块和完整 oldDoc→finalDoc 链必须不变，每个 Step 都要在捕获时 stepDoc 上证明仍落在同一引用、同一直接子段落。通过严格路径分类后复用成熟 plain-text mapper 的 raw textblock 精确匹配与 bounded patch，只修改作者引用正文，保留作者 ` > ` 前缀/空格、BOM、CRLF、其它引用行和相邻列表；清空、Enter split、Backspace join、退出引用、marks、heading/list/nested quote、跨段/跨块、语法敏感字符、baseline mismatch 和 stale revision 全部继续 fail closed。callback 与立即切源码分别经 `transaction-blockquote-paragraph-markdown-updated` / `transaction-blockquote-paragraph-forced-flush` 进入同一 structural registry 与 `SourceSyncCoordinator`。纯正反合同、真实 Electron 逐字输入、源码、保存、磁盘字节和全新 profile 冷重开均通过；空引用删除、IME 填充、Enter 临时空段和中间引用续写等既有结构回归仍由原 owner 处理且全绿。专项见 [`docs/transaction-journal-blockquote-paragraph-family.md`](./docs/transaction-journal-blockquote-paragraph-family.md)。
- **已有 fenced code block 的语言 info string 接入共享 Transaction Journal 与结构 owner registry** — 0.13.134 的 `code-block-info-string-change` 现在只根据 revision-bound journal 中真实的 `AttrStep(language)` 链认领已有顶层代码块的语言添加、替换与清除；正文和其它 attrs 必须逐字不变，每个 Step 必须命中同一顶层 `code_block` 并在对应 stepDoc 上完整重放。owner 分别证明作者 source、previous canonical 与 next canonical 的同一 fenced range，只替换 opening fence 的物理 info range，保留作者 `~~~`/backtick、围栏长度、info 前后空格、BOM、CRLF、代码正文、邻接列表与全部其它字节。包含 metadata/多 token、非法空白或反引号语言、正文混改、其它 attrs、跨块和 stale revision 均继续 fail closed。callback 与立即切源码分别通过 `transaction-code-block-info-markdown-updated` / `transaction-code-block-info-forced-flush` 进入同一 structural registry 与 `SourceSyncCoordinator`；纯正反合同和真实 Electron 语言选择器回归均覆盖源码、保存、全新 profile 冷重开且零 integrity failure / warning。专项见 [`docs/transaction-journal-code-block-info-family.md`](./docs/transaction-journal-code-block-info-family.md)。
- **已有 fenced code block 正文接入共享 Transaction Journal 与结构 owner registry** — 0.13.133 将空/非空既有代码块内的纯文本 `ReplaceStep` 从 delayed canonical 形状推断迁入 revision-bound `SourceSyncTransactionJournal`。`code-block-content-replace` 逐 Step 验证同一顶层 `code_block`、attrs/邻块不变和完整 doc 链，只替换作者围栏内部 content range，并通过 `transaction-code-block-markdown-updated` / `transaction-code-block-forced-flush` 统一交给 `SourceSyncCoordinator`；围栏字符/长度、info string、BOM、CRLF 与前后字节保持不变，attrs/围栏结构、跨块编辑和 closing-fence 冲突继续 fail closed。真实 Electron 首轮还定位并修复了通用 BOM source-map 根因：remark AST offset 会跳过 BOM，空代码块没有 value span 可抵消，旧坐标落到 opening fence 前一字节；现在 block/text/atom 均恢复物理 raw offset。生产 build、13 组 source-map、纯 owner、callback/立即 forced flush、保存、全新 profile 冷重开、列表 structural registry、Markdown preservation、Coordinator、transaction sync 和 39/39 probes 全绿。专项见 [`docs/transaction-journal-code-block-content-family.md`](./docs/transaction-journal-code-block-content-family.md)。
- **Inline code、frontmatter 与 Slash code/math 专项写回接入统一 SourceSyncCoordinator** — 0.13.126 删除 plugin/node-view callback 和 Slash after-command 中对 source ref、canonical ref 与 App `onChange` 的直接成功写回，改为从 live ProseMirror 文档生成 canonical、构造绑定 revision 的 legacy candidate，并通过统一 validation、host commit、snapshot 与 trusted checkpoint publication。frontmatter 仍优先使用局部 YAML block raw mapper；Slash 仍保留 before/after 同 token、精确 authored query 行和完整 fence 单块 proof，无法证明时均保持 fail-closed。永久 UI 分别检查专用 boundary、零 first-divergence、源码、保存和冷重开；Slash 额外覆盖 40ms/350ms 选择后不做 checkpoint 的代码、尾文和前文连续编辑。
- **源码同步架构开始迁移** — 已加入统一 ProseMirror transaction 观察器、原子 raw-source patch 原型和真实逐字事务回归。当前发布构建仍只使用原有 fail-closed 保真链路，事务实验默认关闭；新路径只在开发/专项测试中运行，待每类结构通过完整家族门禁后再逐项放行，避免用未成熟架构修改用户文件或拖慢输入。

### Fixed
- **任意 preservation 分支新建空表格时不再把 Milkdown 的 `<br />` cell 占位符写入作者源码** — 0.13.140 将已有 `normalizeEmptyTableCells()` 提升为 `preserveRichMarkdownSource()` 的统一输出 post-condition：无论候选来自 table 专项、tail append 还是其它已证明路径，只清理“单元格唯一内容为 `<br>` / `<br />`”的内部占位符并输出 GFM 空 cell；真实 `first<br>second` 单元格换行保持不变。该安全网由 `test:table-empty-cells`、完整 markdown-preservation、旧 issue-86 行列新增/保存/冷重开、table-cell UI 和 39/39 source-fidelity probes 共同验证。
- **已有后继 bullet 时在中间项末尾快速连续按两次 Enter，不再把后继项误删并触发源码不一致** — 0.13.130 正式安装版 PID 258 的 input trace 在 2026-08-27 04:02:31.385（line 332）首发 `source-document-mismatch`：用户在长期编辑形成的 mixed-marker bullet 区域中，将光标放在 `- 12312` 末尾快速连续按两次 Enter；第一拍创建位于后继 `- 1\\. 色粉色分` 前的空 bullet，第二拍在延迟 `markdownUpdated` 发布前立即把该空 bullet 提升为顶层编辑器空段。最终 live canonical 合法变为 `- 12312\n\n<br />\n\n* 1\\. 色粉色分`：结构只新增一个 Markdown 不需写回的顶层空段，后继正文完全未变，但列表被拆分后后继 marker 从长期 PM 树保留的 `-` 重序列化为 `*`。旧 `empty-list-item-removed` 因 common-change 同时覆盖 `<br />` 插入与 marker 漂移，错误把非空后继项识别成“被删除的空列表行”，line 331 生成少掉 `- 1\\. 色粉色分` 的 candidate；严格 semantic gate 随即正确拒绝。0.13.131 新增 raw owner `preserveCoalescedEmptyBulletExitBeforeSibling` / reason `coalesced-empty-bullet-exit-before-sibling`，在空项通用删除前运行：只接受唯一顶层、非任务、非空 bullet 中间项与后继项，previous 两行之间已有真实 block gap，next 恰在两行之间插入一个未缩进 `<br />`，中间项逐字不变，后继项只允许一个字符的 bullet token 变化，两个新 gap 必须逐字等于旧 gap，前缀与后缀完全 byte-identical，source 中同一可见正文 pair 必须唯一且不在 fence。证明成立时作者源码保持逐字不变，只推进 canonical baseline；不新增 semantic 例外，也不加入 generated-scratch/forced-flush 宽松 allowlist。PID 258 line 331 完整长文档三态直接回放由旧 `empty-list-item-removed` 改为专用 owner，后继项保留且目标区域不新增 `<br />`；纯函数覆盖 LF/CRLF、普通 all-`*` 控制组、正文夹带编辑、缩进空段、重复 source target、无关前文编辑和 fence 负例；source probes 39/39。真实 Electron 物理输入三项并快速双 Enter 的普通 all-`*` 路径继续由既有 `middle-empty-block-created` 认领，专用 owner 不抢占，源码、保存和冷重开稳定。RS-51、RS-54、RS-63、RS-68 5/18/70ms、RS-82、RS-83、RS-84、RS-85、source transaction、structure fingerprint 与异构 source-fidelity UI 全部通过。专项见 [`docs/rapid-double-enter-bullet-exit-before-sibling-regression.md`](./docs/rapid-double-enter-bullet-exit-before-sibling-regression.md)。
- **空的第二个有序父项仍带嵌套子项时再次 Backspace，不再因子项前的编辑器空段锁住源码** — 0.13.129 正式安装版 PID 94298 的 input trace 在 2026-08-26 17:03:36.558（line 589）首发 `source-document-mismatch`：用户创建 `1. 是共生共荣 / 2. 距离近 /    1. 如何电话`，回到第二个父项连续 Backspace 清空“距离近”，再按一次 Backspace。ProseMirror 合法删除第二个 list-item 边界并把 nested ordered child 移入第一项，同时在第一项正文与 child 之间保留一个 editor-owned 空 paragraph；作者 Markdown 只能稳定表示为 `1. 是共生共荣\n   1. 如何电话`，无法不泄漏 `<br />` 地编码中间空段。旧 `empty-list-item-removed` 已正确删除 authored `2. ` 行且 `listSlotsMatch=true`，但 semantic comparator 仍把该不可编码空段视为真实差异，因此 `semanticOk=false` 并弹出警告。0.13.130 新增严格 raw owner `preserveEmptyOrderedItemBackspaceMergeBeforeNestedList` / reason `empty-ordered-item-merged-before-nested-list`：只接受唯一顶层非空 ordered left sibling、其后连续空 ordered sibling、未变化的 nested ordered child、next 中与 child 精确同缩进的 `<br />`、真实 change-range 相交、left 前缀与 child 后缀逐字相同、source 中唯一紧凑 parent/empty/child 三元组且不在 fence；命中后只删除 authored 空父项行。semantic gate 仅在该 reason 下允许“正文→空段→ordered child”这一种 transient，并进一步要求两侧文档中恰好一侧全篇只有一个候选、另一侧零候选；同一项多个候选、不同列表项各有候选、候选在两侧错位、正文空段、bullet child 均 fail closed。完整 PID 94298 line 591 三态直接回放命中专用 owner；纯函数覆盖 compact/loose previous、LF/CRLF、错误编号/缩进、重复 source、无关 child 编辑与全局语义歧义；source probes 38/38。真实 Electron 从空文档逐键创建现场并物理执行四次 Backspace，断言专用 owner、`semanticOk/listSlotsMatch/ok=true`、零 warning、精确 source、保存与冷重开。相邻 empty ordered lift、RS-56、RS-63、RS-68 5/18/70ms、RS-72、RS-82、RS-83、RS-84、source transaction 与异构 source-fidelity UI 全部通过。专项见 [`docs/empty-ordered-parent-before-nested-backspace-regression.md`](./docs/empty-ordered-parent-before-nested-backspace-regression.md)。
- **跨 bullet→ordered→bullet 选区连续按两次 Backspace 时，不再首拍锁住源码、次拍只删半段或吞掉作者空行** — 0.13.128 正式安装版 PID 90936 的 input trace 在 2026-08-26 16:07:25.136（line 29）首发 `unmapped-diverged-list-batch`：用户反向选中 `- 看了呢分` 正文起点到后续 `- u高科技` 正文终点，选区跨过独立 `2. 斛律v哦`，第一拍 ProseMirror 用一个 replace 合法把 bullet→ordered→bullet 三块原子替换为 surviving bullet list 的一个空首项 `* <br />`，但旧 broad list mapper 按三棵列表分别对账而无法认领；0.13.129 新增严格 raw owner `diverged-cross-list-selection-delete-to-empty-bullet`（`preserveCrossListSelectionDeleteToEmptyBullet`），只接受唯一顶层非任务 bullet→ordered→bullet 三行完整删除、canonical 前后字节完全不变、替换恰为一个空 bullet、左右可见锚和 source 目标唯一且不在 fence 的事务，仅把三行 authored range 替换为第一行作者 bullet 前缀，保留 surviving sibling、marker、CRLF、U+200B、fence 与所有其它字节。旧首拍失败使第二拍继续使用 stale source/canonical baseline，并于 16:07:25.620（line 35）触发 `source-list-structure-mismatch`；修复后首拍会推进正确基线，第二拍由既有 `empty-list-item-removed` 删除空项。自动化在此又发现一个原提示未暴露的字节漂移：第二拍虽能通过 strict integrity，却会把 `正文\n\n- surviving` 压成 `正文\n- surviving`；0.13.129 因而同时收窄 prefix collapse，只有列表内部 editor-owned gap 才压缩，若空项是普通块后新列表的首项则保留作者 block gap。完整 PID 90936 两拍已按正确基线链式回放；纯函数覆盖 LF/CRLF、重复目标、无关编辑和非空替换负例；source probes 37/37。真实 Electron 回归使用物理反向选区和两次 Backspace，逐拍断言专用/既有 owner、`semanticOk/listSlotsMatch/ok=true`、零 warning、精确 source、保存与冷重开。空 bullet、嵌套 bullet、单空 ordered、RS-59、RS-68 5/18/70ms、RS-72、RS-82、RS-83、dash+Space、source transaction 与异构 source-fidelity UI 全部通过。专项见 [`docs/cross-list-selection-delete-empty-bullet-regression.md`](./docs/cross-list-selection-delete-empty-bullet-regression.md)。
- **退出有序列表后连续输入三个连字符创建分隔线时，不再把分隔线粘到上一条有序列表正文** — 0.13.127 正式安装版 PID 85614 的 input trace 在 2026-08-26 15:17:23.243（line 630）首发 `source-document-mismatch`：用户在 `3. 3fresh` 后连续 Enter 退出有序列表，第一个 `-` 已由 `middle-empty-block-filled` 安全发布为独立 `\\-`，第二、第三个 `-` 在下一次 source callback 前到达，第三键触发 ProseMirror thematic-break input rule，Crepe 将独立 hr 序列化为 `***`。由于 thematic break 不贡献可见字符，旧 `locally-aligned-change` 对零宽变化采用向前一块的粘性，错误候选变成 `3. 3fresh***`，严格 semantic gate 因而正确拒绝。0.13.128 新增专用 owner `escaped-standalone-thematic-break-input-rule`（`preserveEscapedStandaloneThematicBreakInputRule`）：只接受 canonical 中唯一独立 `\\-` 行原位变为独立 `***` / `---` / `___`、其余 canonical 字节完全不变、上下均有真实 block gap、authored source 中由未变可见邻居唯一定位且不位于 fenced code 的事务；重复目标、同 callback 无关编辑和普通标点扩写均 fail closed。命中后只把该 authored 行改为用户实际输入风格 `---`，保留 CRLF/EOL、前后列表、U+200B、marker、fence 和全部未触及字节，通用 semantic/list integrity 未放宽。永久回归覆盖完整 PID 85614 约 5.5 MB trace 三态直接回放、CRLF、歧义/批量编辑负例、source probes 36/36；真实 Electron 覆盖两次 Enter setup、独立 `\\-` 中间帧、第二/第三键合并触发 hr、forced flush、`semanticOk/listSlotsMatch/ok=true`、零 warning、精确 source、保存和冷重开。RS-59、dash+Space、RS-82、source transaction、异构 source-fidelity UI 与 RS-68 5/18/70ms 全部通过。专项见 [`docs/middle-thematic-break-input-rule-regression.md`](./docs/middle-thematic-break-input-rule-regression.md)。
- **非空无序列表首项 Backspace 并入左侧有序列表时不再触发源码不一致，冷重开也不再吞并后续独立列表** — 0.13.126 安装包 PID 81568 的 input trace 在 2026-08-26 13:40:32.227（line 13）首发 `unmapped-diverged-list-batch`：`2. 斛律v哦` 后的 `- u高科技 / - 1\\. 色粉色分` 在首项开头按 Backspace 后，ProseMirror 合法把整段变为连续 `3.` / `4.`；紧随其后的独立 ordered list 同一 callback 将首 marker 从 `1.` 改为 `1)`。最初把该变化视为无关 serializer 漂移会导致保存源码可通过但 CommonMark 冷重开把后续列表并入前一列表；自动化因此反向发现 `1)` 实际是 parse-required 分隔语法。0.13.127 新增严格 raw family owner `diverged-nonempty-bullet-list-backspace-merge-ordered`：唯一证明左侧 ordered item、完整平级非空 bullet 段、正文与 spacing 不变、目标 ordinal 连续、source target 唯一，并在紧邻后续 ordered list 使用相同 delimiter 时同步只改该唯一首 marker 为另一 delimiter；错误编号、无关正文编辑、token/source baseline 歧义均 fail closed。该 proof 在 `normalizeOrderedListDelimiters()` 前运行，避免分隔证据被归一化抹除。永久纯函数覆盖真实长文档、CRLF 和负例；真实 Electron 回归覆盖物理 Backspace、`semanticOk/listSlotsMatch/ok=true`、零 warning、精确 source、保存与冷重开。相邻空 bullet merge、RS-54、完整列表转换、source transaction、rich-list、35/35 probes、异构 source-fidelity UI 与 RS-68 5/18/70ms 均通过。专项见 [`docs/nonempty-bullet-backspace-merge-ordered-regression.md`](./docs/nonempty-bullet-backspace-merge-ordered-regression.md)。
- **同一文本块中的字面三反引号不再在源码切换或冷重开时变成行内代码/空代码块** — inline-code plugin-owned callback 接入 `SourceSyncCoordinator` 后，严格语义校验暴露了此前被直接写回绕过的 RS-81：富文本把逐键输入的整行 `````你好``` `` 保持为普通文字，第三个反引号到达时的中间帧也仍是普通段落，但 CommonMark 会分别把最终源码解析为 `inlineCode`、把裸 ````` `` 解析为未闭合空 fenced code，导致源码切换被阻止或冷重开结构变化。0.13.126 在 remark parse pipeline 中增加原始字节证明，只将 paragraph/heading 中唯一、整段、单行、恰好三反引号开闭的 inlineCode 节点恢复为包含 delimiter 的普通文本；同时只将无 language/meta/content、原始切片精确等于三个反引号加可选单个 EOL 的中间空 fence 恢复为普通段落。单/双/四反引号、嵌入正文的 triple span、带 info/正文的未闭合 fence、完整 fence、tilde fence 与六反引号均保持标准 Markdown 语义。inline-code value-change 的成功 publication 同时改为 revision-bound Coordinator candidate，永久真实 UI 覆盖中文 IME、方向键退出、零 first-divergence、源码、保存与冷重开；专项见 [`docs/literal-triple-backtick-parser-regression.md`](./docs/literal-triple-backtick-parser-regression.md)。
- **退出有序列表后输入无序列表不再丢 marker 或复制前面的列表** — 修复真实逐键操作“有序列表连续 Enter 退出 → 单独输入 `-` → 等待源码同步 → 再按 Space”的分叉：单独 `-` 先以源码安全的 `\\-` 发布，随后空格触发无序列表输入规则时，旧逻辑可能把已经发布的 marker 映射到前一个 sibling 或重建整个合并列表，造成 `-` 丢失、列表重复或源码与富文本不一致。0.13.125 将这类事务限定为已捕获的独立 escaped-marker 行，按同级 bullet 序号在 canonical 中定位唯一新 item，只替换该 item，保留前后列表和作者 marker；无法唯一证明时继续 fail-closed。新增真实物理按键回归，覆盖 `-` 中间帧、Space 输入规则、源码切换和无 toast。
- **transaction-first authority 不再先触发 legacy integrity 红灯再自愈** — 修复 0.13.123 authority-on 的 RS-79：已被 `plain-paragraph-inline-replace` 明确认领的 PM transaction 在 `markdownUpdated` 中仍先运行 legacy `preserveRichMarkdownSource` 与 integrity，再于回调末尾由 transaction-first reconcile 覆盖最终 publication。1000 段、120KB+、BOM+CRLF 长文档因此在首段插入与尾段替换上各产生 `primary-preserved` / `before-input-rule-fallback` 的瞬时 `ok=false`，虽最终源码正确，仍违反“first divergence 一次都不能出现”的合同。0.13.124 将 exact owned + allowlisted + current-doc-matched 的 authoritative checkpoint 提前到 legacy preservation 之前发布；syntax-sensitive、structural、list、paste/generated/special 状态和任何 rejected/stale checkpoint 完全保留 legacy fallback。与此同时 SourceRangeMap 默认 PM→Markdown 映射改为一次 parse/collect 的 prepared snapshot，避免长文档每段 start/end 重复全文解析。小 authority UI、1000 段 authority-on BOM/CRLF 回归、shadow/policy/core/source-map/markdown-preservation/source-transaction-sync 与默认 4×5 family matrix 20/20 全部 PASS；大文档三次 owned edit 全程 `integrity ok=false = 0`，源码 textarea 与保存磁盘字节精确。专项见 `docs/transaction-first-authority-first-divergence-regression.md`。
- **全局已分叉文档的尾部 bullet 正文清空时不再锁住源码** — 修复 0.13.122 baseline 的 RS-78：完整 4×5 family matrix 唯一剩余红项 `反馈.md + plain` 在保存重开后把尾部 `* 而为` 正文删到 `* <br />`；该 list slot 实际仍存在，但文档前部已有空引用、empty bullet + nested ordered continuation、marker/loose-list spacing 等大量合法 authored/canonical 分叉，generic visible mapper 因而直接 `visible-stream-mismatch`，作者源码仍停在 `- 而为` 并触发 `source-locked-after-delete`。0.13.123 新增严格 `preserveDivergedTailBulletBodyEmptied`：previous/next 除最终 canonical row 外必须逐字相同；最终两行必须保持同 indent、同 bullet token、同 marker spacing，仅正文从非空变为空；authored source 也必须以同 indent 的非空 bullet 结尾，且其正文 visible text 与 previous canonical final body 精确相等。证明成立时只清 authored 最后一行正文，保留原 `-/*/+`、spacing、EOL 与此前全部字节；任何 earlier canonical 变化或 source tail 不匹配都拒绝。永久完整现场三态 core 回归、完整 markdown-preservation、build 与真实 `反馈.md + plain` append/save/delete/reopen 全周期 PASS。专项见 `docs/diverged-tail-bullet-body-empty-regression.md`。
- **普通 localized-change 将前导空格列表正文删空后不再遗留 U+200B 哨兵** — 修复 0.13.121 baseline 的 RS-77：真实 `11111.md + list-spaces` 中，`localized-change` 已能正确把 `* U+200B    家族验证<PID>` 的可见正文删到 spaces-only，但 candidate 仍残留 `* U+200B  `。facade 虽随后调用 `reconcileLeadingSpaceSentinelTransition()`，旧实现却只按“修改前可见正文”查找 result sentinel 行；正文已被删空后 lookup 必然失败，U+200B 被重新解析成真实 paragraph text，strict integrity 因 `semanticOk=false / listSlotsMatch=false` 拒绝并触发 `source-locked-after-delete`。0.13.122 不新增 mapper，只扩展现有 sentinel reconcile：仅当 source sentinel 行按 previous visible body 唯一、normal result lookup 为空、next visible body 为空、source/result 行数完全一致、同一行序号仍含 sentinel，且移除 sentinel 后该行 visible text 精确等于 next 时，才按位置 fallback 删除 sentinel；其它情况继续 fail closed。独立 `test-rs77-localized-leading-space-sentinel-empty.mjs`、完整 markdown-preservation、build 与原始 `11111.md + list-spaces` 全周期 PASS。专项见 `docs/localized-leading-space-sentinel-empty-regression.md`。
- **分叉长文档中带前导空格哨兵的列表项删到只剩空格时不再锁住源码** — 修复 0.13.120 baseline 的 RS-76：真实 `HorseMD-0.13.33-引用后输入手测.md + list-spaces` 在保存重开后，尾部 authored row 为 `* U+200B    家族验证<PID>`，canonical 为 `* &#x20;   家族验证<PID>`；测试删除 marker 与 3 个前导空格后，PM 正确保留同一 bullet slot 并序列化成 spaces-only `*   `。由于全文更早已有大量合法 authored/canonical 结构与拼写分叉，旧 generic diverged mappers 无法唯一定位这个零可见正文的 tail edit，连续返回 `visible-stream-mismatch`，导致 `source-locked-after-delete`。0.13.121 新增严格 `preserveDivergedLeadingSpaceListWhitespaceTail`：只在 previous/next 除最终 canonical row 外完全字节相同、previous final bullet 精确为 `&#x20; + spaces + non-whitespace body`、next final bullet 只剩 horizontal whitespace、且 authored final bullet 精确持有 U+200B sentinel 并在移除 sentinel/解码 `&#x20;` 后正文逐字相等时认领；只替换最后一行、保留 authored bullet token、复制 next 的 spaces-only suffix并移除 sentinel。解析验证证明 spaces-only 行若保留 U+200B 会把它重新解释为真实 paragraph text，而 plain `*   ` 才是空 list item；existing semantic/list-slot integrity gate 未放宽。独立 core 正反回归、build 与原始 `list-spaces` append/save/delete/reopen 全周期 PASS。专项见 `docs/diverged-leading-space-list-whitespace-tail-regression.md`。
- **相邻空有序项不再让尾项“清空正文”被误判为“整行删除”** — 修复 0.13.119 baseline 在真实 `HorseMD-0.13.33-引用后输入手测.md + plain` 的 delete 阶段暴露的 RS-75：尾部已有一个空 ordered slot `1. <br />`，其后的 `1) 测试` 被测试逐字删除到 `1) <br />` 后，两个 list rows 都没有可见正文；`preserveDivergedTailBlockAppend()` 的 `deleteCase` 用 `equivalentLine(previousPredecessorLine, nextRawTailLine)` 比较时把这两个不同 slot 视为同一空行，因此误返回 `diverged-tail-line-delete`，把 authored `1) 测试` 整行删除。candidate 只剩前一个 `1. `，严格 list fingerprint 随即报 `list-slot-count` 少 1 并锁住源码。0.13.120 不新增 mapper，只收窄 whole-row owner：当 previous/next raw 尾行保持同 prefix、同缩进、同 marker token 和 marker spacing，且正文仅从非空变为 blank/`<br />` 时，明确判定为同 slot body-empty edit，不允许 `deleteCase` 认领；随后既有 `diverged-nested-list-change` 正确只清正文并保留作者 `1)` marker。独立 core 回归同时证明真正整行删除仍继续由 `diverged-tail-line-delete` 拥有。`npm run test:markdown-preservation` PASS、build PASS，真实 `引用后输入手测.md + plain` append/save/delete/reopen 全周期 PASS。`list-spaces` 的 delete-stage `visible-stream-mismatch` 仍是独立下一笔 first divergence。专项见 `docs/diverged-tail-ordered-body-empty-regression.md`。
- **字面三反引号不再让后续列表从结构指纹中“消失”** — 修复 0.13.118 baseline 在真实 `HorseMD-0.13.33-引用后输入手测.md` family cell 中暴露的 RS-74：`source-structure-fingerprint.js` 过去把任何顶格三反引号起始行都当作 fenced code opener；文档中的同一行字面文本 ```` ```你好``` ```` 因而被误判为未闭合 fence，后续真实 ordered/unordered list slots 全部被 scanner 跳过。这样 source 与 canonical 在追加列表时会得到不同的 changed-group 视图，严格 integrity gate 触发 `source-list-structure-mismatch` / `source-locked-after-append`。0.13.119 将 list-slot scanner 收紧到 fenced-code 的必要边界：backtick opener 的 info string 不能再包含 backtick；closing fence 必须与 opener 同字符、长度不少于 opener，且后面只能有空白。真实 fenced code 仍完全排除，短 closing 与带正文 closing 均不能提前结束 fence；同一行字面三反引号不再吞掉后续列表。`test-source-structure-fingerprint.mjs` 新增 3 组永久反例并 PASS；build PASS；原始 `引用后输入手测.md + ordered` append/save/delete/reopen 全周期 PASS，同 fixture 的 unordered 与 spaces 也 PASS；35/35 source-fidelity probes 与 source-transaction-sync PASS。完整 4×5 matrix 仍未全绿：该 fixture 的 `plain` 删除由 `diverged-tail-line-delete` 生成少一个空 ordered slot 的 candidate，`list-spaces` 删除仍 `visible-stream-mismatch`，二者作为后续独立 first divergence 处理。另有既存 `test:literal-triple-backtick-source-ui` 在切源码前因 `# ```你好```` 重新解析成 inlineCode mark 而失败，trace 明确 `listSlotsMatch=true`，不属于本次 list fingerprint scanner 根因。专项见 `docs/source-structure-fingerprint-fence-regression.md`。
- **分叉长文档尾部 image atom Backspace 删除不再被源码保真层锁死** — 修复 0.13.117 基线在真实 `123321.md + plain` family cell 中暴露的 RS-73：测试删除尾部 marker 后继续跨结构 Backspace，PM 会先从尾部空 paragraph 回到前一个深层 ordered item，下一键再删除该 item 尾部的 inline image atom。作者源码把同一图片保留为顶格独立尾行，Crepe canonical 却把它缩进为最深 ordered item continuation；文档更早位置又已有合法 authored/canonical 拼写分歧，而 image atom 不贡献 visible characters，旧 generic mapper 因而在这笔真实删除上返回 `visible-stream-mismatch` 并弹 warning。0.13.118 新增严格 `diverged-tail-image-delete` source owner：只有“canonical 最终非空行是 image、移除该行可完整解释整个事务、source 中同 token 唯一且也是最终非空行、前一可见正文锚一致”全部成立时，才只删除该 authored image row 与一个 EOL，周围 list marker、Tab、缩进和其它字节保持不动；歧义或非尾部图片仍不认领，generic visible/integrity gate 未放宽。永久 core 回归、完整 markdown-preservation 与 build 通过；真实 `123321.md` 专项中 marker 删除为 `diverged-tail-line-delete`、image 删除为 `diverged-tail-image-delete`，两笔均 `ok=true / semanticOk=true / listSlotsMatch=true` 且全程零 toast；该文件 5 个 family cells 全部 PASS。完整 4×5 family matrix 仍有 `引用后输入手测.md` 与 `反馈.md` 的独立 baseline 红项，因此本轮不宣称 20/20。专项见 `docs/diverged-tail-image-delete-regression.md`。
- **有序列表中间空项 Backspace 后不再丢后继项或瞬时触发源码不一致** — 修复 0.13.116 / PID 60874 的 RS-72：同一长文档先后于 2026-08-25 04:27:49.528（trace line 22）和 04:29:16.823（line 52）首发 `source-list-structure-mismatch`。现场结构为非空 ordered item → 单个空 ordered item → 非空 successor（如 `1. 吗。不开机；口红 / 2. <br /> / 3. 露娜了`）；空项按 Backspace 后 PM 正确进入一拍 transient：空 marker 消失并在前项尾部保留 editor-owned `<br />` paragraph，successor 同时补位为 `2. 露娜了`。旧 `empty-list-item-filled` 只凭“previous 有空项、next 没空项”就误认这是文字填充，第一版 candidate 甚至把 successor 一起丢掉；收窄该 mapper 后，broad `batched-list-block-changes` 又会先返回一个丢掉 transient paragraph 的 candidate，导致 `semanticOk=false` 和 warning toast。0.13.117 将 `empty-list-item-filled` 收紧为“list row skeleton 完全不变且恰好一个空 marker row 获得正文”；新增严格 single-empty ordered Backspace 行级 proof，唯一验证 previous 的 nonempty/empty/nonempty 三元组、next 的同一左右正文 + 单条 transient `<br />` + successor 重编号，并在 authored source 中唯一定位同一三元组，只删除空 row、只改 successor ordinal，marker delimiter/spacing 与其它字节原样保留。该 single-empty proof 单独排在 broad multi-list batch 之前，旧 double-empty 0.13.78 proof 保持原 dispatcher 顺序和空行布局。semantic comparator 仅对这个 dedicated `diverged-empty-ordered-backspace-lift` proof 忽略已证明的 editor-owned trailing empty list paragraph，其它路径仍严格。新增 `test:single-empty-ordered-backspace-successor-ui`：DOM 后继 `露娜了` 保留并补位、`semanticOk=true / listSlotsMatch=true / ok=true / no toast`，source/save/cold reopen PASS；旧 double-empty UI 仍 PASS。RS-71、RS-69、RS-70、35/35 probes、source-fidelity UI、RS-68 70ms、source-transaction-sync 全绿。
- **已有源码分叉的长文档中，嵌套有序项快速输入标点后 Enter 不再把新 sibling 写成顶层编号** — 修复 0.13.115 / PID 59363：`1. 啊额法色饭` 下的 authored nested row 为 `   1. 微风`；2026-08-25 04:11:57.082 输入 `、`，46ms 后于 04:11:57.128 按 Enter，PM/canonical 正确生成 `   1. 微风、` 与 `   2. <br />`，但长文档其它位置已有合法 source/canonical visible-stream 分叉，因此事务进入 `diverged-nested-list-change`。旧 `sourceOrdered` insertion 分支只继承 authored `.` / `)` delimiter，没有继承 anchor leading indentation，candidate 写成顶层 `2. `，trace line 22 在 04:11:57.401 首发 `source-list-structure-mismatch`。0.13.116 仅在新增 ordered item 的 anchor 也是 ordered row 且两者 canonical indent 同层时，从 anchor raw row 同时继承精确 leading whitespace 与 delimiter；顶层 ordered、不同层级及 bullet→nested-ordered 专用路径行为不变，integrity gate 未放宽。现场前缀纯函数与新增 `test:diverged-nested-ordered-enter-ui` 均通过；真实约 46ms `、` + Enter 下保持 2 个 nested OL siblings，`semanticOk=true / listSlotsMatch=true / ok=true / no toast`，source、save、cold reopen 稳定。RS-69、RS-70、35/35 probes、source-fidelity UI、RS-68 70ms、source-transaction-sync 全绿。
- **任务列表项按 Enter 新建空同层任务不再立即触发源码不一致** — 修复 0.13.114 / PID 58193 真实长文档中的 task sibling 生命周期：已有 `- [ ] 额粉色分` 在末尾按 Enter 后，ProseMirror 正确创建第二个 unchecked 空 task，canonical 为相邻 `- [ ] <br />`，但 `middle-empty-block-list-filled` 把新项发布成裸 `- [ ]`；GFM/remark 不能用该 raw 行稳定恢复空 task 语义，因此 trace line 1050 在 2026-08-25 03:58:01.041 首发 `source-document-mismatch`。0.13.115 不新增第二套空任务表示法，而是在已由左右 anchor 唯一定位、且确认 same-list continuation 的 middle-slot 分支中复用 RS-50/RS-66 已建立的 U+200B source-owned sentinel 合同：空 task sibling 写成 `- [ ] ​`，一旦用户继续输入正文，既有 `empty-task-sentinel-filled` 精确消费 sentinel；非空 task、普通 list item 和其它 block 不受影响，integrity gate 未放宽。PID 58193 现场三态纯函数与新增 `test:task-enter-empty-sibling-ui` 均 PASS：Enter 后 2 个 unchecked tasks、`middle-empty-block-list-filled / semanticOk=true / listSlotsMatch=true / ok=true / no toast`，继续输入由 `empty-task-sentinel-filled` 正常提交，source/save/cold reopen 稳定。相邻 RS-66 slash task、task persistence、RS-60 empty-task Backspace、RS-69 nested Enter、35/35 probes、source-fidelity UI、RS-68 70ms、source-transaction-sync 全绿。
- **嵌套无序列表项按 Enter 新建空同层项不再被写成顶层 bullet** — 修复真实长文档中先创建 bullet、再把下一项用 Tab 缩进为 nested bullet，随后在该 nested item 末尾按 Enter 时，ProseMirror 正确创建同一 nested list 的空 sibling、canonical 为 `  * <br />`，但 `middle-empty-block-list-filled` 在处理 trimmed changed slice 时只继承了前一 authored row 的 marker 字符，没有继承 leading indentation，candidate 因而从应有的 `  * ` 退成顶层 `* `，PID 56855 trace 在 2026-08-25 03:41:15.945 首发 `source-list-structure-mismatch`。0.13.114 现在仅在 mapper 已用左右可见 anchor 唯一定位同一 middle slot、并确认 same list kind continuation 的分支中，同时继承 `sourceBefore` 的 authored indent 与 marker 拼写/ordered delimiter；其它新 list block 不复用该缩进，integrity gate 未放宽。现场三态纯函数与新增 `test:nested-list-enter-empty-sibling-ui` 均通过：最终 DOM 为 1 个顶层父项 + 2 个 nested siblings，`middle-empty-block-list-filled / semanticOk=true / listSlotsMatch=true / ok=true / no toast`，source 精确保留 `  * `，保存与冷重开稳定；RS-64、rich-list source、35/35 probes、source-fidelity UI、RS-68 70ms、source-transaction-sync 全绿。
- **快速连续 Backspace 清空并提升带子列表的有序父项不再触发源码不一致** — 修复 RS-67 之后仍遗漏的真实按键节奏：已有 authored 长文档中 `1. 啊额法` 仍持有 nested `1. 微风` 时，用户连续快速 Backspace 会在 deferred `markdownUpdated` 前完成“删光父正文 + 再按一次 Backspace 将空 ordered parent 提升进前面的 bullet list”。0.13.113 / PID 34380 trace line 99 在 00:44:29.748 首次触发 `source-document-mismatch`；旧测试每拍后等待约 950ms，人工制造了 RS-67 中间 checkpoint，因此没有覆盖这个 coalesced transaction。0.13.114 新增 `rapid-nested-ordered-parent-backspace-lift` raw proof：唯一定位 previous 的非空 ordered parent、相邻更深且未改动的 child 与前一同级 bullet，next 必须把该 parent 变成同 marker 的 `<br />` 空 bullet；目标之外只允许同缩进/同 spacing/同 body 的 bullet marker serializer 漂移，任何正文、ordered token、缩进或 child 编辑都 fail closed。source 只把 parent marker/body 改成空 bullet，并把 parent→child 间隔收紧为单一换行，避免 `- \n\n   1. child` 被 parser 拆成两个顶层列表。由于目标与历史 source/canonical 分歧可能落在同一连续 list group，mapper 同时返回精确 before/after 局部 ranges；Editor 不按 reason 直接放行，而是从真实 authored/candidate/previous/current canonical 重新切片，对局部前后两态分别执行 strict ordered-number + strict nesting list-slot proof。真实 UI 已改为可配置 cadence、4 次连续 Backspace 且无中间 settle。最终定位 70ms 瞬时红项并非 mapper 或 integrity 规则不足，而是 source/save 的 `createEditorApi().flushMarkdown()` 会抢在 deferred `markdownUpdated` 前对同一个 preservation candidate 做一次强制验证，却只传 `reason`、漏掉该 candidate 已生成的 `integrityProof`；因此第一次严格局部 list proof 看不到 ranges 并报错，下一次主 callback 才带 proof 自愈。0.13.114 现在让 forced flush 与同 candidate 的 fallback/recheck 一样携带其自身 `integrityProof`，proof 不会继承给已改写的 typed-marker 等其它 candidate，integrity gate 未放宽。5ms、18ms、70ms 三档均达到全程零 `ok=false`、零 warning toast，源码、保存与冷重开稳定；RS-67/64/63、rich-list source、35/35 probes、source-fidelity UI 与 source-transaction-sync 家族门禁也全部通过。详细 fixture、命令、验收条件与注意事项见 `docs/rich-source-fidelity-bug-family.md` 的 RS-68 回归说明。
- **带嵌套子列表的有序列表父项正文删空不再丢失父 marker 并触发源码不一致** — 修复已有 authored 长文档中，父 ordered item `1. 啊` 仍持有 nested child `   1. 微风` 时，把父正文最后一个“啊” Backspace 删空，ProseMirror 正确保留同一父 list item、空 paragraph 与 nested child，Crepe canonical 写成 `1. <br />\n\n   1. 微风`；但当文档更早位置已有合法 source/canonical list 拼写分歧时，旧 `diverged-nested-list-change` 会把“父正文变空”误判成“父 item 被删除”，候选只剩 `   1. 微风`，因此 0.13.112 / PID 32752 trace line 43 在 00:16:25.642 首次触发 `source-list-structure-mismatch`，随后 line 50 的 `source-document-mismatch` 只是连锁。0.13.113 在 `normalizeEmptyListItems()` 与 broad diverged-list mapper 之前新增严格 raw proof `nested-list-parent-body-emptied`：只接受 previous→next 恰好一条非空 list parent row 变成 `<br />`、将该 row 恢复即可逐字还原整个 previous canonical、其下一非空 marker 仍是更深且内容未变的 nested child，并且 authored source 中 parent+child 层级/正文组合唯一可定位的事务；最终仅删除 source parent 的正文 bytes，父 marker、分隔空格与 nested child 原始字节全部保留。普通无 child 的空 list item不会命中，semantic comparator 未放宽。真实 UI 已验证 `nested-list-parent-body-emptied / ok=true / semanticOk=true / listSlotsMatch=true / no toast`，source、保存与冷重开均保持空父项和 nested child 层级。
- **已有文档中通过 Slash 新建空任务列表不再立即触发源码不一致** — 修复已有 authored 长文档中，普通段只输入 `/` 后从 Slash 菜单选择“任务列表”时，ProseMirror 正确创建 unchecked 空 task item、Crepe canonical 写成 `- [ ] <br />`，但普通 source mapper 在 normalize 后只能写出 bare `- [ ] `；该写法不能稳定重解析成 GFM 空 task，因此 0.13.111 / PID 31051 trace line 616 在 00:01:25.313 首次触发 `source-document-mismatch`。0.13.112 在 `normalizeEmptyListItems()` 前新增严格 raw proof `empty-task-slash-created`：仅当完整 `next` 中恰好一条顶层 unchecked 空 task `<br />` row 替换回 `/` 后能逐字还原整个 `previous` canonical，并且 authored source 中同 ordinal 的独立 `/` row 可唯一对齐时，才只替换该 source row，并复用 RS-50 已验证的 U+200B source-owned sentinel 写成合法 `- [ ] ​`。同时发生其它 canonical 编辑、非空 task、checked/nested task 都不能命中；integrity comparator 未放宽。真实 existing-doc UI 已覆盖单 `/` + pointer 选择 Task、`empty-task-slash-created / ok=true / semanticOk=true / listSlotsMatch=true`、源码/保存/冷重开，以及重开后填入“任务”由既有 `empty-task-sentinel-filled` 正常消费 sentinel。
- **文档中间引用段末尾按 Enter 新建空第二段不再触发源码不一致** — 修复非尾部 blockquote（后面仍有有序列表/其它真实块）在正文末尾按 Enter 后，ProseMirror 正确生成 quote 内第二个空 paragraph、Crepe canonical 写成 `> 正文\n>\n> <br />`，但 RS-57 旧 proof 只接受“blockquote 位于整篇文档末尾”，因此 0.13.110 / PID 29289 trace line 664 在 23:44:26.303 落到 `visible-mismatch-line-change`，候选被写成两个裸 `>` 行并首次触发 `source-document-mismatch`。0.13.111 将同一 `trailing-empty-blockquote-paragraph-created` 合同解释为“尾随于 blockquote 内”而非“尾随于文档”：只有从 `next` 精确移除新生成的 `>\n> <br />` 两行后能逐字还原整个 `previous` canonical，且 source/previous/next 的可见 quote 序号、深度和正文完全一致时才保持 authored source 不变。后续任何块若同时变化，该 proof 立即 fail closed；integrity comparator 未放宽。真实中间 quote UI 覆盖 Enter、继续填第二段、后置有序列表、源码、保存和冷重开均通过。
- **无序列表空项按 Tab 缩进不再立即触发源码不一致** — 修复 authored compact bullet list 中，空顶层 bullet 按 Tab 变成 nested empty bullet 时，`batched-list-block-changes` 为保持 compact 风格把 Crepe canonical 在 nested `<br />` marker 前的结构空行删除，生成 `- parent\n  * `；CommonMark/remark 会把这个 bare nested marker 当成父项 paragraph 的字面 `*`，因此 0.13.109 / PID 25642 trace line 140 在 23:27:46.340 首次触发 `source-document-mismatch`。0.13.110 继续沿用既有 list-block mapper 和严格 integrity，只在 compact formatter 遇到 **nested + empty** marker 时保留 canonical 中紧邻它的一条 parse-required 空行，候选变成 `- parent\n\n  * `，可重新解析成真正 nested empty list item；普通 compact list 仍照旧压缩。真实 UI 进一步覆盖 Tab 后继续输入正文、源码切换、保存和冷重开，均无 toast 且 `semanticOk/listSlotsMatch=true`。
- **带嵌套子列表的无序列表末尾空项删除不再触发源码不一致** — 修复顶层 bullet 的前一项末尾含 nested list 时，再删除其后的空顶层 bullet，ProseMirror 会合法把空项合并成前一 list item 内、nested list 之后的一个 editor-owned 空 paragraph；旧 `empty-list-item-removed` 只允许空 paragraph 紧跟文字段落，因而在 0.13.108 / PID 23485 trace line 557 首次触发 `source-document-mismatch`。0.13.109 新增严格 raw proof `empty-list-item-merged-after-nested-list`：仅当被删的是唯一顶层空 bullet、前一非空 canonical 行是更深层 list row、且新 `<br />` 缩进明确移入前一项时才认领该 transient；semantic comparator 也只在这个专用 reason 下允许 nested list 后恰好一个尾随空 paragraph，其他 nested-list 结构仍严格。现场三态、真实 UI、源码切换、保存和冷重开均通过，`semanticOk/listSlotsMatch=true`、无 toast。
- **纯标点尾段追加空格不再被误删并触发源码不一致** — 修复已有 source/canonical 拼写分歧时，普通尾段从保护写法 `-\\[ ]` 过渡到字面 `-[ ] ` 后，visible-line 视图因该行没有普通可见正文而把它当成“已删除”，`diverged-tail-line-delete` 随即把整条 raw 尾段从 candidate 删除并触发 `source-document-mismatch`。0.13.107 为 tail deletion 增加 raw 尾行反证：只有 raw 尾部确实收敛到前一行、纯空白或 editor-owned `<br />` 才允许删除；仍存在的纯标点/转义 raw 行必须交给精确行级 mapper。真实单 Space UI 最终由 `trailing-exact-line-change` 接管，源码、保存和冷重开稳定，integrity gate 未放宽。
- **删除空任务列表项不再触发源码不一致** — 修复 generated scratch 中第二个 task item 被逐字删空后再按 Backspace 时，ProseMirror 会合法把该空 task row 合并为上一 task 内的尾随空 paragraph，而旧同步器不识别 `[ ]` / `[x]` task 元数据与 U+200B 空 task sentinel，且 normalize 会提前抹掉 canonical `  <br />` 的缩进证据，导致 generated candidate 直接丢掉 transient 并触发 `source-document-mismatch`。0.13.106 将 task state + sentinel 纳入严格 empty-row 证明，并在 normalize 前只接受专用 `empty-task-item-merged-to-continuation` proof；generated callback/flush 仅对此 reason 复用一个 trailing empty list-item paragraph 的语义 transient，且不会误触发 RS-52 的 post-list token。真实 generated-scratch UI、source 强制 flush、保存、冷重开与全量 markdown-preservation 纯函数门禁通过。
- **中间字面 `-` 段扩写不再粘到上一段并触发源码不一致** — 修复已有 source/canonical marker/entity 等合法拼写分歧时，在两个既有块之间的空 paragraph 先输入单独 `-`、再继续扩写成 `-【】` 等普通正文时，通用 visible-offset mapper 因 Markdown 段落分隔零宽而把该行起点错误映到上一条 source 行尾，生成 `哈哈；-【】` 并触发 `source-document-mismatch`。0.13.105 在最终 `localized-change` raw patch 前校验 canonical 被编辑行与 mapped source 行的可见身份；不一致时不再猜测 ordinal offset，而是 fail closed 到既有 line-region mapper。单独 `-` 阶段仍由 `middle-empty-block-filled` 保留结构保护 `\\-`。真实 UI、源码切换、保存、冷重开与全量 markdown-preservation 纯函数门禁通过。
- **任务列表项内的尾随段落删空不再触发源码不一致** — 修复 generated scratch 中 checked task 后的新列表项经 Backspace 合并为同一 task 的第二 paragraph，再把 `[ ] ` 等 continuation 文字逐字删空时，Crepe 用缩进 `  <br />` 保留 editor-owned 空 paragraph，而旧 generated candidate 直接删除该 continuation、触发 `source-document-mismatch` 的问题。0.13.104 先复用既有 paragraph/escaped-line mapper 证明真实字节删除，再在 normalize 前用 raw canonical 严格证明同缩进 continuation、前置更浅 list/task marker 与其余文档完全不变，专用 reason `trailing-list-item-paragraph-emptied` 才允许 generated callback/flush 复用一个 trailing empty list-item paragraph 的语义 transient；普通顶层空段和普通 escaped punctuation 不放宽。RS-58 UI、task persistence、RS-57、RS-56、35/35 probes、source-fidelity 与纯函数门禁均通过。
- **引用正文末尾按 Enter 新建空第二段不再立即触发源码不一致** — 修复 generated scratch 中 blockquote 正文末尾按 Enter 后，Crepe 用 `> <br />` 表示引用内第二个空 paragraph，而旧源码转换把它写成多个裸 `>` 行；这些 quote-only 行重解析时无法恢复独立空 paragraph，导致 `source-document-mismatch`。0.13.103 新增 `trailing-empty-blockquote-paragraph-created` 的严格尾部/quote-depth/transient proof：空段尚无正文时保持作者源码不变，integrity 仅在该专用 reason 下忽略恰好一个尾随空引用 paragraph；一旦第二段收到正文即正常写成标准多段 blockquote。generated callback/flush、真实 `/quote` 全链、RS-48、空引用删除、35/35 probes、source-fidelity 和纯函数门禁均通过。
- **三级 nested bullet 快速双 Backspace 不再触发源码不一致** — 修复 generated scratch 中最深列表项删除最后正文后紧接 Backspace 退层时，`normalizeEmptyListItems()` 先把 canonical 的缩进 `<br />` 占位抹平成顶格占位，导致原本能严格证明的 nested list-row removal 被降级为通用 tail deletion、正确局部 candidate 被 generated scratch 丢弃并触发 `source-document-mismatch`。0.13.102 在 normalize 前只接受 raw canonical tail mapper 严格返回的 `nested-empty-list-item-removed`；callback 与强制 flush 共用这条窄证明，semantic comparer 仍默认严格，nested transient 不污染 RS-52 的 post-list token。真实快速双 Backspace、源码、保存、冷重开与永久纯函数回归通过。
- **尾部普通段输入字面 `3.` 不再在按 Space 前被误解析成有序列表** — 修复 0.13.100 中 ordered list 后普通尾段输入 `3.` 时，Crepe 已用 `3\\.` 表示“仍是字面段落”，但 `appended-paragraph` 的 fresh punctuation 翻译过早写成 `3.`、导致 Markdown 重解析成 ordered marker 并触发完整性告警的问题。0.13.101 仅在整个新追加普通段恰好为 `N\\.` / `N\\)` 时保留结构保护转义；真正按 Space 后仍由列表 input-rule 正常转换，行内 punctuation 行为不变。
- **新建文档的列表正文 `1.` 不再因去转义变成嵌套列表** — 修复 generated scratch 中空 bullet item 先形成 `1. `、随后 IME/正文输入让 Crepe 序列化为 `* 1\\. 正文` 时，全篇 fresh canonical 翻译把结构保护反斜杠去掉、生成 `- 1. 正文` 并被 Markdown parser 重解释为 nested ordered list、触发 `source-list-structure-mismatch` 的问题。现在 generated scratch 先以 canonical 证明 quote/list 结构前缀，只在 block/list-item 正文起点保留同一 `N\\.` / `N\\)` 保护转义；普通行中 punctuation 仍按原规则还原，integrity gate 不放宽。真实 generated-scratch IME、源码切换、保存、冷重开、既有 literal-marker 家族、新文档保真与全局 IME 回归均通过。修复归属 0.13.95。
- **空引用块内的输入法正文不再被写到引用块外** — 修复作者源码尾部只有 `>`、Crepe canonical 为 `> <br />` 时，在空 blockquote 中通过 IME 提交正文会被 `trailing-empty-block-filled` 当成普通尾部段落追加，生成 `>\n\n正文` 而不是 `> 正文`、随即触发 `source-document-mismatch` 的问题。现在只有在 authored source、旧 canonical 和新 canonical 的 quote depth/尾部 slot 都严格对应时，才在 syntax-only `>` 行内原位填充正文；普通空段落仍沿原有 append 逻辑，semantic/list-slot integrity gate 不放宽。补充真实 IME composition、源码切换、保存、冷重开、嵌套 quote 与相邻 source-fidelity 回归。修复归属 0.13.94。
- **文档尾部输入 `- ` 不再与前一个列表粘连** — 修复字面 `-` 已先以 `\-` 写入源码、随后按 Space 触发列表输入规则时，正确的 `- ` 候选会被过宽的前缀校验拒绝，通用候选继而把 Crepe 默认的 `* ` 粘到前一个列表末尾并触发“源码与富文本不一致”的问题。现在输入意图只拥有捕获的 marker 行，行外字节必须保持不变；陈旧意图仍失败关闭。补充日志形状纯函数回归和真实逐键 UI 回归。
- **全选覆盖表格长文档不再残留空表格源码** — 修复在富文本中全选整篇文档并粘贴/输入短文本时，通用表格差异器把整篇替换误判为局部 `table-line-change`，源码残留大量 `| | |` 行并暂停保存的问题。现在仅当旧选区和单个 ReplaceStep 都明确覆盖完整 ProseMirror 文档时，当前富文本成为整篇新源码，同时保留文件级 BOM 和统一换行约定；普通结构编辑与列表输入规则不受影响。补充表格文档全选覆盖、源码切换和磁盘保存回归。
- **有序列表空项回车退出不再误删后续的有序列表** — 修复在有序列表里给一项填正文、Enter 新建空项、再在空项里 Enter 退出时，若下方紧跟一个使用了不同标点的有序列表（作者写 `1)`，Crepe 在同一事务里把它重新序列化成 `1.`），同步器把“删空项”和“后续列表标点变化”并进同一个变更区间，导致空项删除分支被拒绝、空项填充分支把整个合并后的列表块替换掉，后续 `1) 斯卡洛尼快乐 / 2) 是干嘛的了；吗` 整段消失并弹“源码与富文本不一致”。根因是有序列表标点（`1.` vs `1)`）被当成内容差异参与 diff，而它其实是序列化器会翻转的实现细节（作者标点以源码为准）。现在在 diff 前把行首有序 marker 的标点归一化（只影响行首 marker、不碰列表项内字面 `1.`/`1)`，且长度不变），使变更区间只包含真正的空项删除；补充了逐字符 UI 回归（填正文 → 两次分开的 Enter → 源码切换）与纯函数断言，并用反证确认修复前会复现“后续列表被删”。
- **中间空代码块首字符不再写到围栏外** — 修复在已有文档中间的空 fenced code block 内输入第一段代码时，因前方列表 marker 等 serializer 差异造成可见流分叉，通用中间段落 mapper 把代码内容插到开围栏之前、源码与富文本随即不一致的问题。同步入口现在先按成对的开围栏、闭围栏和前后文确认代码块事务归属，只替换该代码块的内容区；新增真实逐字输入、源码切换、保存回归，覆盖 `middle-block-inserted` 的反证场景。
- **有序列表中继续输入空格不再残留 U+200B 隐藏字符** — 修复在有序列表中按回车创建空的下一项后，先输入一个空格、再通过输入法输入正文、最后继续输入空格时，源码保留旧的 U+200B 前导空格 sentinel，而富文本已经把它收敛成普通空格，导致源码与富文本不一致的问题。现在只在同一行明确从 `&#x20;` 序列化形式过渡到普通空格、且可见内容唯一对应时移除旧 sentinel；普通 U+200B、其他列表和已有空格行为不受影响。补充了真实逐字回车、输入法和后续空格的 UI 回归。
- **无序列表空项连续回车不再误删后续兄弟项** — 修复在无序列表中按回车创建空项、再次按回车退出列表时，canonical 富文本可能发布“空项 + 后续兄弟项”的结构变化；同步器此前把后续兄弟项误当成空项删除范围的一部分，导致源码少掉后续 `- 露娜了` 等列表行，并可能弹出“源码与富文本不一致”。现在空列表项删除按列表行的实际边界和 canonical 空段占位进行局部映射，只删除用户退出的那一个空 marker，保留后续列表项及其分隔格式；覆盖两次分开的真实 Enter 事务、源码切换、保存和重开回归。
- **行尾连续空格后继续输入文字不再被插到空格前面** — 修复在段落末尾打若干空格（字面空格、非硬换行）后继续输入文字时，同步器把新文字插到了空格之前（`将皮机配件了；你       `），导致源码与富文本不一致、保存被暂停的问题。根因是行尾插入位置的辅助函数 `rawInsertionAtCanonicalLineEnd` 无条件减掉行尾空白，把“字面空格”误当成“作者硬换行语法”。现在只有当 canonical 那一行自身以空白结尾（说明这些空格是序列化器保留的字面文字、光标在空格之后）时才插到行尾之后；canonical 已丢弃的源文件硬换行空格仍插在它们之前。补充了真实逐字符 UI 回归（行尾 7 个空格 → 停顿让空格先落库 → IME 输入文字）与纯函数断言。
- **有序列表空项回车退出且下方已有列表时不再误报源码分叉** — 修复在已有文档中给有序列表填正文、Enter 新建下一项、再在空项里按 Enter 退出列表时，Crepe 在有序列表与后续列表之间留下独立的 `<br />` 空段占位行，而列表槽位指纹把该占位行当作硬分组边界、把候选源码里的普通空行当作分组延续，导致两边分组不一致并弹出“源码与富文本不一致”。根因是列表槽位指纹没有把独立 `<br />`（空段占位）等价于它实际代表的空行。现在指纹把独立 `<br />`（含 `> <br />` 引用前缀）当作空行跳过，不创建分组边界、不产生槽位；补充了“有序列表 → 空项回车退出 → 下方已有无序列表”的逐字符 UI 回归与纯函数断言。
- **空列表项内输入法提交的正文不再被写成列表外的独立段落** — 修复在分歧文档中通过 `- ` 输入规则创建空 bullet 项后，输入法提交正文时，同步器把提交文本写成新段落、留下空 `- ` 行、列表结构指纹判定不一致并弹“源码与富文本不一致”的问题。根因是 `preserveMiddleEmptyBlock` 的 `middle-block-inserted` 分支先于列表空项填充处理器执行：它看到源码槽位里的 `- ` 行（被视为已创作语法）就把文本作为新段落插到该行之前，而 `preserveEmptyListItemTextChange`（能把文本填进 `- ` 行）在调度顺序上靠后、永远轮不到。现在中间块插入分支检测到“源码槽位是空列表行且 canonical 变更在填充列表行”时不再抢占，把该事务留给空列表项填充处理器；补充了真实分歧文档中 `- ` + 空格 + IME 正文的逐字符 UI 回归，并登记为根因 16。
- **裸列表 marker 行（无尾随空格）不再被误判、后续填文本不再错位成独立列表项** — 修复文档中已存在类似 `-   1. 二哥你来拿如果` 这样嵌套列表字面量时，用户在中间创建 `1. ` 有序列表并输入法填充正文，同步器把文本写成了新的 `- 1. …` 独立 bullet 行而不是填进 `1.` 有序项、进而触发“源码与富文本不一致”的问题。根因是空列表项落库时被 `.trim()` 写成裸 `1.`（无尾随空格），而列表行解析器要求 marker 后必须有 `\s+`，导致该行对列表机制不可见、后续 ordinal 对齐错位。现在列表 marker 识别兼容无尾随空格的裸行，空列表项写入源码时保留尾随空格（`1. `），分歧列表处理器填裸行时也补空格，避免 `1.色粉` 被解析成普通段落；补充了真实分歧文档的逐字符 UI 回归与纯函数断言。
- **空列表项内按 Enter 退出列表不再残留空行或误报源码分叉** — 修复在有序/无序列表的**空**列表项（如 `3. `）内按 Enter 退出列表时，同步器把“移除空列表项 + 退出列表”的结构事务误落到通用段落清空路径：只删除 marker 行、留下多余空行，导致列表槽位指纹不一致并弹出“源码与富文本不一致”。现在空列表项移除走专门的 `empty-list-item-removed` 分支：删除唯一匹配的 marker 行，并把退出列表产生的多余空行收敛回 canonical 的空段数量（文件尾部保留一个空行槽供后续列表附着）；补充了“第二项填文本 → Enter 新建 → 空项 Enter 退出”完整逐字 UI 回归与纯函数断言。
- **行首单独输入的 `-`/`*`/`#` 等符号不再丢失转义或误报源码分叉** — 修复在中间位置输入单个 `-`（尚未按空格触发列表规则）时，同步器把 canonical 的 `\-` 还原成裸 `-`，导致源码里出现空 bullet 项、与富文本语义不一致并触发 fail-closed 提示的问题。现在行首无可见文本时，还原后可能变成列表/标题/引用/围栏/表格语法的转义符号会保留反斜杠（`\-` 保持 `\-`），行内的转义（如 `1\.` → `1.`）仍正常还原；并补充了纯函数与真实逐字符输入的 UI 回归。
- **有序列表内回车新建下一项不再改写编号或误报源码分叉** — 修复新建文档（scratch 路径）中先输入 `1.` 创建有序列表、再按 Enter 新建下一项时，残留的 `1.` 输入意图被错误复用：它会把 canonical 自动编号的 `2.` 改写回 `1.`，触发列表槽位校验并弹出“源码与富文本不一致”，导致保存被暂停。现在有序 marker 恢复只允许作用于同序数行（`1)` 恢复为 `1.` 这类同数字不同标点），Enter 自动编号的新行不再被旧意图污染；补充了空文档逐字符输入的 UI 回归。
- **中间点击回车后创建有序列表不再误报源码分叉** — 修复已有文档中鼠标点击段落内部、按 Enter 再输入 `1. ` 时，段落拆分事务因文档其他位置的列表 marker/空项差异被错误送入全局 visible-stream mapper，误报“源码与富文本不一致”的问题。现在先对“可见文字不变、仅新增段落边界、前后源码锚点唯一”的结构事务做局部证明，只插入对应段落分隔，不改写其他列表或表格，并覆盖真实鼠标点击、源码切换和保存前校验。
- **源码候选增加事务级列表槽位证明** — 语义 AST 相同不再足以提交源码：同步器现在同时校验列表项数量、空项槽位、列表类型、任务状态和有序编号，无法证明时保持 fail-closed、阻止源码切换/保存并持续通知；覆盖连续 Enter、重复列表、表格尾部列表和延迟回调共用的结构边界。
- **源码/富文本家族分叉统一收敛** — 修复中间空段、连续列表、表格尾部以及延迟回调共同触发的局部源码槽位错配；普通正文插入不再被误判为结构块，所有候选在切换源码或保存前都重新做语义校验，无法证明一致时强制通知并阻止静默提交。
- **源码/富文本分叉改为 fail-closed 并强制通知** — 修复某些列表和表格尾部编辑被错误标记为 `preserved: true`、源码静默丢内容或与富文本分叉却没有提示的问题；现在每次源码候选都会经过当前 ProseMirror 文档语义校验，无法证明一致时阻止源码切换/保存并显示持久通知，同时兼容 Markdown parser 合并相邻同类型列表的正常情况。
- **表格末尾连续创建有序/无序列表的源码同步** — 修复表格后先输入有序列表、再退出并创建无序列表时，第一段列表可能只停留在富文本，后续无序列表内容被错误写回空 marker 或被静默丢失的问题；现在会先提交表格后的首个列表块，再按局部空列表行写回后续内容，并覆盖源码切换、保存和冷重开。
- **延迟列表输入意图串到后续列表** — 修复上一次列表输入的延迟 marker 意图在源码回调队列中残留，用户随后在文档中间创建新的有序/无序列表时，旧意图会使用过期位置把源码写成裸 `1`、`-`、`*` 或多出的编号行但不触发保存保护的问题；现在只保留同一源快照、同一快速键盘批次内的意图，并覆盖源码切换、保存和重开。
- **有序列表末项回车误报源码分叉** — 修复在中间输入 `1. ` 后经过输入法提交正文，再按 Enter 创建下一项时，原列表 marker 意图仍停留在短暂回调窗口，可能把正确的 `2.` 空项恢复成 `1.` 并触发源码结构不一致提示的问题；已消费的输入意图现在只保留给同一输入规则的短尾部回调，不再跨越后续正文/IME 事务。
- **中间连续创建独立有序列表的源码同步** — 修复在复杂文档中连续输入两个 `1. ` 列表后，第二个列表可能被写成前一个列表的嵌套项、编号标点变成 `1)` 或多出空的 `2.` 项的问题；现在按相同缩进和列表项正文的局部出现序号恢复用户实际输入的 `1.` 标记，并覆盖源码切换、保存和冷重开。
- **中间空段连续输入后的源码同步** — 修复在文档中间连续按 Enter 创建空段，再输入正文、空有序列表和后续正文时，Crepe 发布的多个 `<br />` 占位行会让新段落无法映射，导致源码模式打不开或提示无法保存的问题；现在会移除这些内部占位，只把新正文写入对应的原始空行槽位，并保留后续列表边界。
- **复杂列表文档中删除表格行的源码同步** — 修复表格前方存在列表/嵌套列表时，删除表格行后因全局可见偏移找不到源码表格而进入 `unmapped-table-change`，导致富文本已删行但源码、保存和重开仍保留旧行的问题；现在按表格自身内容重新锚定局部源码结构。
- **中间正文连续创建有序/无序列表的源码同步** — 修复在已有文档中间按回车创建正文，再连续输入有序列表和无序列表时，输入的 `-` 被错误恢复为 `*`，后续列表事务可能进入 `visible-stream-mismatch` 并导致无法保存的问题；列表 marker 现在按当前新建列表块和项目文本局部恢复。
- **表格列删除后的源码同步** — 修复复杂列表格式导致源码与富文本可见流分叉时，在富文本删除 Markdown 表格列后只更新富文本、源码和磁盘仍保留旧列的问题；表格结构变更现在会按表格局部写回，删除列后可正常进入源码模式并保存。
- **表格行列悬浮按钮延迟隐藏** — 修复鼠标离开表格后行/列悬浮手柄立即消失的问题；控件现在会在鼠标离开后保留约 2 秒，方便移动到按钮或操作菜单，重新悬停和点击行为保持不变。
- **表格行悬浮按钮移出单元格** — 修复行悬浮手柄和行操作菜单压住表格第一列文字的问题；有可用编辑器留白时，行手柄与删除菜单现在停在表格左侧外部，行选择、拖动和删除操作保持不变。
- **宽表悬浮列操作保持横向位置** — 修复长表格横向滚动到最右侧后，点击表头上方的列选择按钮或列操作菜单会被 Milkdown 重建表格视图并瞬间带回第一列的问题；新表格 wrapper 会在 DOM 重建的同一轮继承原横向位置，列选择、对齐/删除操作和右键列菜单不会再出现跳回或闪跳。
- **分叉文档中有序列表续写保真** — 修复复杂文档前方存在 `- 1. ...` 等嵌套列表语法分叉时，在中间标题后连续输入有序列表会把后续项错误写成 `- 2. ...`，继而导致源码与富文本失步；新增列表项现在依据目标源码列表的实际标记类型写回，并覆盖保存与冷重开。
- **中间空段落连续输入保真** — 修复在已有文档中间按 Enter 后，继续输入标题/列表/空行等内容时，富文本已有内容但源码模式打不开或停留在旧快照的问题。映射现在同时支持“新内容位于既有空段占位前后”两种局部顺序，保留未编辑源码格式，并覆盖保存、模式往返和冷重开。
- **斜杠菜单代码块连续编辑保真** — 修复在复杂文档末尾通过 `/code` 创建代码块后，立即继续编辑代码、代码块后的正文和前文列表时，源码缺少代码围栏、切换源码被锁定或保存后内容不一致的问题。`/code` 临时查询行到 `code_block` 的转换现在作为一次原子 source 事务提交，只替换精确命中的 authored 行并保留 CRLF；重复查询无法精确定位时仍安全拒绝，不会猜测覆盖用户源码。
- **多轮保存后源码与富文本再次不一致** — 修复第一次保存重开正常、继续编辑已有列表后源码开始少空行、丢后续正文或只保存部分事务的问题。列表输入意图在 marker 恢复后立即消费，不再由下一次正文回调用旧槽重复重建；批量列表变更只有完整映射同一 callback 的列表与正文后才允许提交。
- **重开后在文档中间新建列表丢失** — 修复再次重开后，在已有正文和后续代码块之间输入“正文 → 有序列表 → 正文”时，富文本显示完整但源码停在列表之前的问题。新列表只在前后锚和空段槽位均可证明时原子写回，随后立即消费列表输入意图。
- **CRLF 与无末尾换行的列表边界** — 修复 CRLF 列表续写或中间空段写回可能把文字插进 `\r\n` 中间，以及无 final-EOL 文件退出列表后新建列表会粘回上一列表的问题。新增默认/transaction-primary 双路径的 4 轮编辑保存、5 次冷打开回归，并用真实复杂文档验证源码、磁盘和富文本结构一致。
- **保存暂停的瞬时竞态与恢复出口** — 保存或切换源码不再把 Milkdown 尚未完成的延迟结构事务立刻判为永久映射失败，而会在不推进失败基线、不覆盖作者源码的前提下做有界稳定重试。若重试后仍无法证明安全映射，原文件保持不变，并让用户把当前富文本内容另存为 `.horsemd-recovered.md` 恢复副本，避免编辑只留在内存中。
- **引用末尾直接输入后文字丢失** — 修复在复杂分叉文档中直接点击引用后的空白正文并输入，富文本显示正常，但保存/源码会把文字写进前面某个空引用行，甚至保存重开后新增文字消失的问题。文档末尾纯正文追加现在先按物理文档末尾处理，不再经过可能被重复空引用误导的全局可见字符 ordinal；标题、列表、引用、代码围栏等真实结构仍交给各自处理器。
- **长时间编辑后富文本 / 源码错位** — 修复复杂分叉文档中存在大量重复引用文本时，退出引用并继续输入的新段落可能被写进前面某个同名引用块，导致富文本、源码、磁盘和重开结果不一致的问题。空段落/中间块映射不再把 canonical 的全文可见行序号直接套到已经分叉的作者源码，而是用相邻块文本、结构类型和出现序号做局部一一证明；无法证明时继续 fail-closed，不会猜测写入位置。
- **复杂文档普通编辑保存** — 修复文档其他位置存在嵌套列表、字面三反引号、空引用和大量重复短文本时，给一个普通正文追加文字也会误报“保存已暂停”的问题。源码保真层现在按 Markdown 块及其出现序号定位本次局部编辑，不再把标题、列表和引用中的同名子串当成歧义；候选结构数量不一致时仍保持 fail-closed，不会用整篇 canonical 覆盖作者源码。
- **嵌套无序列表保存暂停** — 补全 `- - 内容` 的局部映射：源码中的第二个 `- ` 会被 remark 解释为嵌套列表语法，过去只识别 `- 1. 内容` 的数字前缀，导致编辑该嵌套项或它后面的兄弟项仍会暂停保存。现在按一层嵌套列表标记定位正文，保留作者原始两个短横线，只写回实际编辑的文字。

## [0.13.29] - 2026-08-09

`0.13.29` 汇总 `v0.12.62` 之后的桌面开发测试版本，重点收敛源码 / 富文本一致性，并补齐长文档写作与常用编辑操作。

### Added
- **源码 + 预览双栏**（[#107](https://github.com/BND-1/horseMD/issues/107)）— 桌面 Markdown 可在左侧编辑源码、右侧查看只读富文本，支持按内容锚点联动滚动、分隔线调宽和一键关闭预览。
- **桌面拖入打开** — 从 Finder / 文件资源管理器拖入一个或多个文件会分别打开为标签；拖入文件夹会加入多根工作区；富文本正文中的图片拖放仍保持插图语义。
- **文档位置记忆**（[#111](https://github.com/BND-1/horseMD/issues/111)）— 重开文档恢复上次光标与滚动位置；外部修改导致长度变化时不套用旧位置。

### Changed
- **表格和代码块操作** — Markdown 表格单击单元格即可编辑；代码块使用贴左、全高、不透明的行号栏，PDF 导出同步保留行号（[#109](https://github.com/BND-1/horseMD/issues/109) 第 1、2 点；PDF 背景可配置未纳入本次）。
- **原生 HTML 表格布局** — 固定宽度和 `width="100%"` 表格跟随正文宽度收缩，窄排版下不再裁切或撑宽页面。
- **本地链接与保存反馈** — 支持 POSIX / Windows / UNC / `file://` / 相对 Markdown 链接；富文本真实编辑后立即显示未保存状态。
- **行内代码输入** — 只有完整输入 `` `内容` `` 后才渲染，闭合后光标默认在代码外；已有代码可用方向键自然移出首尾边界。

### Fixed
- **富文本 / 源码原文保真** — 修复删除内容复活、新增内容遗漏、无序列表 `-` / `+` 被改成 `*`、空块泄漏 `<br />`、行首空格变 `&#x20;`、列表正文增加 `\.` / `\-`、空引用和多列表连续编辑不同步等问题。未编辑区域的空行、列表写法、CRLF/BOM 和紧凑/松散结构保持原样。
- **列表结构分歧** — `- 1. 内容` 等会被解析成嵌套列表的源码，在编辑、删除、拆分和列表转换后可安全写回，不再触发旧源码回退。
- **反引号与代码围栏** — 单/双/三反引号逐字输入与删除不再吞字符、泄漏 serializer 反斜杠、暂停保存或锁住源码模式；新文档同一行 ```` ```你好``` ```` 保存重开保持作者输入。
- **模式切换定位** — 源码非空行首可准确定位；空段落、列表、表格、代码块和重复文字附近切换时不再被延迟恢复任务拉到其他位置。

完整发布说明与验证记录见 [`docs/release-v0.13.29.md`](./docs/release-v0.13.29.md)。

## [0.12.69] - 2026-08-05

### Fixed
- **窄编辑区中的 HTML 表格** — “设置 → 外观 → 表格 → 宽表自动换行”现在同样作用于原生 HTML `<table>`：开启后按当前正文宽度分列并折行，不再保留横向溢出；关闭时仍只在表格自身区域横向滑动，编辑器和应用页面不会被撑宽。
- **行内代码方向键边界** — 修复行内代码首尾处的 `←` / `→` 只在内部状态退出、但可见光标仍停在 `<code>` 元素里，并继续按方向键又被边界重复拦截的问题。现在光标会落到相邻正文侧，后续方向键可继续正常移动，且不会跳过相邻字符或写入隐藏标记。

## [0.12.68] - 2026-08-04

### Fixed
- **源码非空行首鼠标定位** — 修复 Chromium 在 Markdown 标记或中文等非空行首点击时，把落点错误判为首字符后的行为。源码模式与“源码 + 预览”现在都会识别首字符的起始点击区域，并把折叠选区准确放到该行第一个字符前；`## 页面对应关系` 等标题已纳入真实鼠标回归。

## [0.12.67] - 2026-08-04

### Fixed
- **源码 + 预览的光标、滚动与退出** — 修复源码模式和“源码 + 预览”左侧在非空行首显示的加粗光标覆盖首字、看起来无法定位到第一个字符前的问题；光标现完整落在字符边界前。双栏左侧的尾部留白与右侧预览统一，滚动到底时不再比预览多出一大段空白。预览右上角新增明确的“关闭预览”入口，直接返回普通富文本视图。

## [0.12.66] - 2026-08-04

### Changed
- **双栏改为源码驱动预览** — “源码 + 预览”中仅左侧 Markdown 源码可编辑；右侧富文本是只读投影，可滚动、选中和复制，但不显示块柄/格式工具/右键操作，也不会因点击或选择产生未保存状态。退出双栏仍可使用底部“富文本 / 源码”切换。

## [0.12.65] - 2026-08-04

### Changed
- **双栏入口与面板宽度** — “源码 + 预览”从状态栏移至富文本编辑区右键菜单，避免占用常用状态栏空间；双栏两侧不再继承单栏阅读模式的居中最大宽度，源码和富文本均填满各自面板，仅保留一致的工作边距。

## [0.12.64] - 2026-08-04

### Added
- **源码 + 富文本双栏实时预览（桌面）** — 状态栏新增“源码 + 预览”：同一 Markdown 左侧显示原始源码、右侧显示富文本，左侧停止连续输入后实时刷新预览，右侧真实编辑同步回源码。两侧复用同一个标签与已挂载的 Crepe 实例，不会另建编辑器或改变保存语义；拖动中间分隔线可调宽度，滚动按当前可见内容联动。纯文本、未加载富文本的重文档、移动端以及双文件分屏期间会明确禁用该模式。

### Changed
- **查找作用域** — 在“源码 + 预览”中，Ctrl/Cmd+F 现在跟随最近点击的源码或富文本面板，而不会因源码 textarea 可见就始终错误地搜索源码。

## [0.12.63] - 2026-08-03

### Fixed
- **本地 Markdown 链接跳转** — 修复 `[文件](/绝对/本地/路径.md)` 这类裸绝对路径链接在富文本中 Cmd/Ctrl+点击无反应的问题。现支持 POSIX 绝对路径、Windows 盘符路径、UNC 路径、`file://` 和既有相对路径；本地链接只经文件专用 IPC 打开，普通网页链接仍走系统浏览器。
- **富文本未保存提示即时反馈** — 修复富文本刚输入、删除、粘贴或拖放内容后的约 200ms 内，标签灰点、底部状态和保存入口仍误显示“已保存”的问题。现在真实编辑事件会立即显示未保存状态，随后继续使用既有的源码保真序列化链路提交 Markdown；未按保存不会写入磁盘。若用户立刻把内容删回已保存版本，提示会在对账后自动清除。
- **正文转列表的源码保真** — 修复右键把多个普通段落依次转为有序、无序或待办列表时，前一次转换可能只在富文本显示、源码仍保留旧段落的问题；现在每次只修改被操作段落的列表前缀。

## [0.12.62] - 2026-08-02

### Fixed
- **富文本修改无法保存（[#105](https://github.com/BND-1/horseMD/issues/105)）** — 修复富文本中修改或删除内容后点击保存，源码视图、磁盘文件或关闭重开仍回到旧内容的问题。保存与导出现在强制从当前 ProseMirror 文档序列化，而非读取可能尚未被异步通知更新的 Markdown 缓存；已删除内容不会“复活”。
- **长文档 Mermaid 永久加载** — 修复打开含多张 Mermaid 图的 Markdown 时，长流程图可能永久停在“正在渲染图表…”的问题。CodeMirror 会虚拟化长代码块，旧实现错误地只读取当前可见的部分 `.cm-line`，导致图表源码被截断；现在预览与编辑刷新均从完整 ProseMirror `code_block` 取源，并统一处理 CRLF/LF。多图实际渲染改为串行队列，避免竞争 Mermaid 的模块级状态；原始 Markdown 不会被修改。

## [0.12.61] - 2026-08-02

### Fixed
- **Mermaid 手动编辑刷新与保存** — 修复在富文本中修改 Mermaid 源码后，预览停留在旧图或输入中间态的语法错误、保存或重开后又回到旧内容的问题。每个 Mermaid 代码块现在以自身最新源码为准，异步渲染的旧结果不会覆盖新图；保存、源码模式和重开均写入当前图表源码。
- **富文本删除持久化** — 保存和导出改为强制序列化当前 ProseMirror 文档，不再只依赖异步 Markdown 缓存。富文本中已删除的内容不会在源码模式、磁盘或关闭重开后重新出现。

## [0.12.60] - 2026-08-02

### Added
- **HTML 导出中心** — 新增独立的 HTML 预览与导出工作台，可实时选择简洁、纸张、阅读、夜间主题，调整内容宽度、字号和行高，并决定是否加入文档标题与可点击目录。最终保存复用预览生成的同一份独立 HTML；公式、Mermaid、任务列表、表格和图片使用结构化导出快照，编辑器控件与可执行脚本不会进入结果。
- **Pandoc 文档转换** — 桌面端可检测系统 Pandoc 或手动选择可执行文件，并从文件菜单、命令面板导出 Word、EPUB、LaTeX、OpenDocument、RTF 和纯文本。转换读取当前编辑状态，通过无 shell 的参数白名单子进程运行，支持相对资源目录、两分钟超时、错误反馈和安装引导。
- **AI Phase 0 工程基础** — 参考 VMark 的 Provider 与变更确认边界，新增与界面无关的 AI 请求契约、文档上下文快照、版本校验和 Review-first 变更提案核心。当前版本不开放 AI 界面，也不接收密钥；后续 Provider 接入必须沿用该边界，禁止模型绕过确认直接改写文件。
- **导出保存位置记住** — PDF / HTML / Pandoc 导出的保存对话框默认打开在当前 Markdown 文件所在目录；同一个文件一旦手动改存到别处，之后该文件会默认那个目录，不同文件互不串扰（各自回到自己的文件夹），未命名文档回退到上次保存目录。偏好按文件持久化在 `userData/export-prefs.json`。
- **PDF 紧凑导出密度** — PDF 导出中心新增「排版密度」选择（舒适 / 标准 / 紧凑）。默认「标准」与原有排版逐字一致（`standard` 密度表的每个值都等于此前硬编码的字面量，已有导出零变化）；「紧凑」收紧行高与段落、列表、引用、图片、公式、分隔线间距（实测同一文档约减少 19% 页数，搭配「窄」边距可进一步接近 Typora），「舒适」更宽松。选项按用户习惯持久化（仅记住密度选择，不持久化每篇文档的页眉/页脚/标题/页码范围）。

### Changed
- **文件右键导出子菜单** — 标签页和工作区文件的右键菜单不再随导出格式增加而不断变长；PDF、HTML、Word、EPUB、LaTeX、OpenDocument、RTF 和纯文本统一收进“导出”二级菜单。子菜单支持悬停、点击和键盘操作，靠近窗口边缘时自动向可见区域展开；对未打开文件仍会先挂载当前内容，再进入对应导出流程。
- **导出内容安全边界** — PDF 与 HTML 共用的结构化文档快照会移除脚本、内嵌网页、对象、表单、事件处理器和 `javascript:` 地址；HTML 额外使用严格 CSP 和无脚本预览沙箱。

### Fixed
- **长文档模式切换定位（[#104](https://github.com/BND-1/horseMD/issues/104)）** — 修复富文本段落含行内公式时切换源码会把光标映射到无关段落，以及在 400KB+ 文档中只滚动阅读后切源码偶发回到顶部、切换准备过慢的问题。Markdown 与 ProseMirror 现在用一致的 atom 忽略投影锁定公式所在段落，再以完整字符/atom 序列定位段内光标；无可见光标的阅读切换不再重新解析并映射整篇文档，只用可见视口锚点恢复位置。真实 489KB 长文档验证已覆盖。
- **列表转换源码丢失与内容合并** — 修复富文本中把有序列表右键转为无序列表后，切换源码可能丢失新 marker、把嵌套紧凑列表插入空行/改缩进，以及转换后立即输入的文字被合并或保存后重开结构改变的问题。转换现在在 ProseMirror dispatch 前建立确定快照，只写回当前层级真正变化的 marker；随后输入作为独立局部文字差分提交，不再用 Crepe 的整棵 canonical 列表覆盖用户原文。新增逐字符输入、源码逐字节、真实保存和全新进程重开回归。
- **长代码块复制截断** — 修复超过约 50 行的代码块点击“复制”后，只得到 CodeMirror 当前虚拟渲染的约 30–65 行、丢失后半段的问题。复制链路现在从完整 ProseMirror `code_block` 读取内容，并按文档中的代码块顺序提供完整节点兜底，不再读取虚拟 `.cm-line` DOM；新增 120 行 `settings.json` 原生系统剪贴板回归。
- **PDF 导出目录记忆链路** — 修复 PDF Studio 创建预览时遗漏源文件路径，导致 PDF 实际按“未命名文档”使用全局目录、与 HTML/Pandoc 的按文件记忆语义不一致的问题；文件树右键导出也会传递对应文件路径。导出偏好首次并发读取与连续写入改为共享加载任务和串行写队列，避免罕见的空缓存与偏好文件竞争。
- **文档导出 IPC 校验** — PDF 预览、保存和释放接口现在与 HTML/Pandoc 一样，只接受主窗口 renderer 的请求，补齐文档导出链路的统一安全边界。
- **多图导出丢图（≥10 张）** — 修复含 10 张及以上图片的文档导出 PDF / HTML 时，第 10 张之后的图片被静默丢弃、PDF 报「图片加载失败」的问题。导出快照给每张图生成 `horsemd-pdf-resource-N` 占位符，而资源暂存用子串方式替换，`-1` 是 `-10`～`-19`、`-2` 是 `-20` 的子串，处理前几张时把后续占位符一并破坏，`html.includes` 守卫随后将它们静默跳过（既不暂存也不计入未解析）。占位符改为定宽 `padStart`，互不为子串，碰撞消除；新增 20 张图的资源暂存回归。

## [0.12.47] - 2026-07-31

### Fixed
- **外部纯文本复制保真** — 修复 0.12.46 中从富文本复制正文到文本编辑器会增加段落空行、复制有序列表文字会额外带上 `1. ` 的严重回归。剪贴板现在明确分为三种用途：`text/plain` 只包含用户实际选中的可见文字，`text/html` 保留富文本样式，`text/markdown` 供 HorseMD 内部粘贴恢复 Markdown 结构；富文本中按行显示的普通源码单换行会在纯文本和 HTML 副本中物化为换行，不再粘成一行。代码块复制按钮仍输出完整原始代码。
- **排版宽度实时预览** — 修复“设置 → 外观 → 排版”中编辑区宽度预设和微调滑杆看起来没有反应的问题。旧预览被固定 `680px` 上限截断，导致 700、800、1000px 预设显示成同一宽度；现在按实际页宽比例映射预览页面，拖动期间立即改变正文和两侧留白，松手后持久化并同步到文档。

## [0.12.46] - 2026-07-30

### Added
- **PDF 正文字号** — PDF 导出中心新增 8–24pt 正文字号设置，默认 11pt、步进 0.5pt；标题、表格、代码和间距继续使用相对单位随正文等比调整。原“内容缩放”更名为“整体缩放”，用于同时缩放文字、图片、图表和页面留白，避免与正文字号混淆。
- **源码单换行显示** — 富文本默认按原位置显示 Markdown 段落内的普通单换行，适配从其他编辑器打开的紧凑报告和逐行字段，同时不插入空行、不写入 `<br>`、不修改用户源文件。“设置 → 编辑器 → 编辑”可关闭该显示偏好；Enter 仍创建标准段落，Shift+Enter 仍创建显式硬换行。
- **标题间距设置（[#96](https://github.com/BND-1/horseMD/issues/96)）** — “设置 → 外观”和底部“排版”面板新增独立标题间距控制，可在紧凑、较紧、标准和宽松档位之间切换并细调；只改变 H1–H6 周围留白，不连带修改正文、列表或代码块间距。
- **可选会话恢复（[#98](https://github.com/BND-1/horseMD/issues/98)）** — “设置 → 通用 → 启动”可关闭“恢复上次打开的文档”。关闭后不再自动恢复历史文件和未保存草稿，但 Finder、资源管理器、命令行或文件关联显式打开的文档仍会正常打开。
- **正文块转列表** — 桌面富文本中，右键正文段落并悬停“转换为”即可直接转换为有序列表、无序列表或未勾选的待办清单；操作以右键所在段落为准。
- **跟随系统主题（[#95](https://github.com/BND-1/horseMD/issues/95)）** — 可在“设置 → 外观”开启跟随系统外观，并分别指定日间和夜间使用的内置主题；默认配对为暖光与暖夜，系统切换后即时生效。

### Changed
- **表格内容自适应列宽** — 未手动调整的 Markdown 表格会综合表头和所有单元格内容分配列宽，短编号列保持紧凑、长说明列获得更多空间，不再默认等分。用户长按边界拖动后才切换为固定布局并优先使用持久化列宽；宽表滚动、自动换行设置和移动端行为保持不变。
- **设置中心分类与顺序** — 文档字体、代码字体、字号、行距、段距、标题间距、页宽、自定义 CSS、表格显示和源码字号统一归入“外观”；“编辑器”只保留校对、换行显示、选区工具栏和公式删除等编辑特性。外观页按“主题 → 排版预览 → 自定义 CSS → 表格 → 源码外观”排列，自定义 CSS 不再被表格区隔开。

### Fixed
- **Mermaid 粘贴单实例渲染** — 修复粘贴一段 Mermaid 后被误拆为两个代码块、显示两份预览的问题。历史自动拆分逻辑曾在整段源码任意位置搜索 `flowchart TD`、`sequenceDiagram` 等声明，节点标签包含同名文字时也会被当成第二张图；现在只把真正位于源码行首的声明用于旧内容兜底拆分，并在粘贴事件发生时按目标代码块精确创建第二张图。裸 Mermaid 粘贴会同步保存为一个合法的 ` ```mermaid ` 围栏块，富文本、源码、保存重开保持一一对应。
- **新输入列表与空段落源码保真** — 修复在富文本中逐字输入 `-`、`*` 或 `+` 创建无序列表后，切换源码统一变成 `*` 的问题；输入规则生效前会记录用户实际键入的符号，并只恢复刚创建的列表层级。连续按 Enter 创建空段落时，Crepe 的独立 `<br />` 仅作为编辑器内部占位，源码和磁盘改用空行表示。列表块扫描同时区分松散列表、相邻不同类型列表及 canonical 合并后的同类型列表，新增项目、层级转换和待办转换不会改写或复制相邻列表。
- **PDF 连续设置打印竞态** — 修复长文档中快速调整正文字号、页眉页脚等设置时，旧预览销毁正在打印的隐藏窗口，导致当前预览报 `Failed to generate PDF: Printing failed` 的问题。预览任务现在等待旧 worker 完整清理；进入 `printToPDF()` 后不再强杀窗口，而是自然结束并丢弃 stale 结果，只生成最后一次设置。
- **PDF 表格行距保真** — 修复 PDF 全局正文段落边距误作用于表格单元格内层 `<p>`，导致导出后的每一行比富文本预览明显更高的问题。打印样式现在与编辑器一致地清除单元格内层段落边距，只保留表格自身的字号比例、`line-height` 和单元格内边距，不改变正文段落间距。
- **PDF 表格列宽保真** — 修复富文本中已经按内容分配的短列、长列，在 PDF 预览和导出时被强制铺满页面并近似等分的问题。导出 source 现在记录当前表格的自然总宽度和每列实测比例；紧凑表保持自然宽度，超宽表才收敛到可打印区域并换行，手动调整后的列宽也沿用同一测量链路。最终 PDF 的列起点会与编辑器比例一致，不再由旧的 `table-layout: fixed; width: 100%` 覆盖。
- **任务清单勾选持久化** — 修复富文本中点击任务复选框后只更新当前界面、保存并重新打开又恢复旧状态的问题。Crepe 在 `pointerdown` 阶段更新任务节点并阻止后续兼容鼠标事件；编辑器现在于同一阶段捕获真实用户意图，使勾选和取消勾选都进入既有的原文保真、dirty 与保存链路，磁盘只改对应的 `[ ]` / `[x]` 标记。
- **Mermaid 与预览型内容 PDF 导出** — 修复 Mermaid 在富文本中正常显示、导出 PDF 却退化为源码的问题。PDF source 现在先主动把流程图、时序图、饼图、类图、状态图和 ER 图生成为经过安全清理且保留比例的 SVG，再移除编辑器预览 DOM；LaTeX、任务列表、表格、引用、HTML 和普通代码共用结构回归，语法错误或超时的图表保留源码且不阻止整篇导出。
- **PDF 图片与表格密度（[#101](https://github.com/BND-1/horseMD/issues/101)）** — PDF 生成前会把当前文档已经解析出的本地和网络图片暂存到打印文档旁边，不再要求隔离的隐藏窗口按原地址重新加载；同时修复包含空格、中文或 `%20` 的相对图片路径被二次编码而加载失败。编辑器和 PDF 中的表格内边距、行高改为随文档字号等比变化，并移除 Crepe 单元格内层段落的额外固定留白，小字号表格不再保持异常高的行。
- **模式切换后的即时输入与精确光标** — 修复源码切回富文本后，`90/220/450/700ms` 的布局稳定重试仍会覆盖用户已经开始输入的选区，导致后半段文字跳回上一行、源码段落合并以及再次切换时光标偏移的问题。首次 raw-offset 恢复现在于 layout 阶段同步完成，后续重试在任意真实键盘、输入法或鼠标交互后立即终止；硬换行和行内图片在 ProseMirror 中占用的位置也纳入逐 unit 映射，不再用 `textContent.length` 近似。
- **复杂文档中间段落保真** — 修复文档前部存在 serializer 重新对齐的表格或松散列表时，在后部硬换行段落与代码块之间按 Enter 新建正文，会因“整篇可见行必须一致”的错误前置条件而把新段直接拼到上一行并产生额外空行。结构插入现在只校验相邻两个块，并仅把 canonical 中新增的间隔写入原源码，保留代码围栏、表格和列表的原始写法。
- **行内代码方向键退出** — 输入左反引号和正文后，光标位于行内代码尾部时按 `→` 可直接退出代码格式，位于首部时按 `←` 可向前退出；方向键只跨过视觉边界，不跳过正文字符，也不会写入额外反引号或改变 Markdown 源码。输入右反引号、点击外部和失焦退出仍保持原有行为。
- **行内代码新段落边界与光标** — 修复在包含紧凑单换行、额外空行等非 canonical 写法的文档末尾按 Enter，并以行内代码作为新段首个内容时，切换源码会把整段拼到上一段末尾、光标随之偏移一行的问题。原文保真层会直接替换与 canonical 局部完全一致的最后一行，保留前文原始写法；rich→source→rich→source 均以同一 raw offset 恢复光标。
- **Markdown 字节级保真** — 修复超大文档分块加载后的首次富文本编辑可能丢失、表格单元格文字编辑连带重排整张表、源码 textarea 在 Windows CRLF 文件中只改一个字符却把整篇换行符改为 LF，以及富文本插入附件会用 Crepe serializer 结果覆盖全文的问题。新增 BOM、CRLF、混合换行、Setext 标题、引用链接、实体、HTML、硬换行、表格、代码和公式的真实写盘回归；打开、切换和编辑其他位置不得修改未触碰字节。
- **源码审阅局部写回** — 源码模式给选区添加 CriticMarkup 时只包裹当前选区，不再顺带规范化文档中已有的其他审阅标记。
- **行内代码输入（[#93](https://github.com/BND-1/horseMD/issues/93)）** — 修复按标准顺序逐字手打 `` `awdawdwa` `` 时只得到普通文本，以及输入右反引号后继续键入仍被源码吞进行内代码的问题；输入一个左反引号并继续键入正文后会进入行内代码，输入右反引号后正文可靠退出。行末增量映射现在会跨过代码、强调、链接等行内闭合语法，但保留 Markdown 硬换行空格。连续输入三个及更多普通反引号仍保持原样，编辑装饰不会进入 Markdown 源文件。
- **PDF 预览竞态与资源提示（[#97](https://github.com/BND-1/horseMD/issues/97)）** — 预览生成期间连续修改页眉、页脚、页码等设置时，被替代的旧任务按正常取消处理，不再显示导出失败；资源提示区分“图片仍在加载”和“图片加载失败”，无图片文档不会出现“0 张图片失败”。
- **代码块与富文本复制（[#98](https://github.com/BND-1/horseMD/issues/98)）** — 代码块复制按钮改用 Electron 原生剪贴板桥接并从编辑器文档节点读取完整代码，不再出现提示成功但剪贴板为空或保留旧内容；普通富文本复制的纯文本通道使用 Markdown serializer，保留粗体、行内代码等成对标记。
- **Markdown 原文保真** — 修复富文本中任意编辑后保存会把紧凑列表改成松散列表、替换列表符号，并在标题、段落和列表项之间加入空行的问题。普通文字编辑现在只写回对应字符；列表、表格和标题等结构编辑最多替换受影响的语法块或行，无法可靠映射时保留原文，禁止用 Crepe 的整篇规范化结果覆盖用户文件。源码同步回富文本时的程序化事务也不再被误判为用户编辑。
- **正文换行保存** — 修复在文档末尾按 Enter 输入新正文后，源码只写成单换行、重新解析时两个段落合并的问题。新建正文现在保存为标准 Markdown 段落边界；普通单换行正文只改文字时仍逐字符保留，不会被自动插入空行。
- **输入后立即切源码** — 修复富文本连续输入或换行后立即切换源码时，非受控源码 textarea 使用旧快照，导致刚输入内容暂时消失或落到同一段的问题。切换前现在会同步提交当前 Crepe 文档及原文保真映射，不依赖异步 `markdownUpdated` 的到达时机。
- **空文档换行同步** — 修复新建空文档从默认标题开始手打、每行停顿后按 Enter，未保存直接切源码会把正文并入标题并写入 `<br />` 的问题。仅用于起笔体验的空标题骨架不再污染源码差异基线；Crepe 为末尾空段落生成的 `<br />` 只作为 canonical 占位，不写入用户源码，输入正文后才追加真实 Markdown 段落。
- **正文中间换行同步** — 修复在已有段落与后续标题/正文之间按 Enter 新建段落，切到源码后新文字被拼到前一段、空 paragraph 泄漏为 `<br />` 的问题。现在同时覆盖“回车后立即输入”的单事务和“停顿后再输入”的两阶段事务，只按相邻块边界替换中间间隙；列表、表格、标题、引用和代码围栏仍由各自的结构映射处理。
- **源码切换后的即时输入** — 用户切到源码模式后只要移动了光标或开始输入，后续的延迟位置恢复任务立即停止，不再把光标拉回先前的富文本位置。
- **块操作条统一轨道** — 通过 Milkdown BlockProvider 的原生定位入口，把标题、正文、一级与嵌套列表的“新增段落”加号和拖拽柄统一锚定到正文左边界；不再由 HorseMD 在异步定位后用 `translate` 二次纠偏。窄、宽、全宽布局均保持横向双按钮完整可点，不遮挡文字或被侧栏裁切；滚动时旧句柄会隐藏，列表圆点仍可自然唤醒当前块。
- **块操作条误触发** — 普通文字和彩色/高亮行内 HTML 不再唤起块操作条；一级、二级、三级列表的圆点/序号只负责触发，显示位置始终是同一条编辑区轨道。
- **macOS 无窗口启动** — 关闭最后一个窗口后再次从 Dock、Finder 或关联文件启动，会重新创建窗口，并在渲染器就绪后打开传入文件。

## [0.12.10] - 2026-07-25

### Added
- **Optional selection toolbar** — Settings → Editor → Editing now lets desktop
  writers hide the floating text-selection toolbar. With it off, selecting text
  and right-clicking exposes the same common actions as labelled menu entries:
  bold, italic, strikethrough, inline code, link, highlight, and the complete
  review-markup set (addition, deletion, substitution, highlight + comment).
- **List type conversion** — In desktop rich mode, right-click an ordinary
  bullet or ordered list to convert only its current level to the other list
  type or to a task list. Task lists can also explicitly convert back to a
  bullet or ordered list, removing their checkbox state. Parent and nested list
  levels are left intact.
- **Wide-table wrap preference** — Settings → Editor now provides “Wrap wide
  tables”. It keeps Markdown table columns inside the writing area and wraps
  cell text instead of showing a horizontal scrollbar; the existing readable,
  independently scrollable layout remains the default.
- **Composable Custom CSS snippets** (#81) — Custom CSS is now a named snippet
  list. Snippets can be enabled independently, reordered, renamed, and removed;
  enabled entries layer in list order. Existing single-snippet settings migrate
  automatically. Desktop also exposes a scoped Inspect editor action for finding
  real document selectors without widening renderer privileges.
- **Floating chapter navigator** — desktop documents with headings now show a
  quiet right-edge chapter indicator. Hovering or keyboard-focusing it expands
  to a scrollable heading list; the active chapter follows reading position and
  each item jumps smoothly in both rich and source modes. Long headings truncate
  without widening the writing surface.
- **Mobile read-only mode** — iOS and Android now have a top-bar lock. When
  enabled, rich text, source text, paste, drop, CodeMirror input, block changes,
  and undo/redo cannot change the document; scrolling, selection, copying and
  opening links remain available. Desktop behavior is unchanged.
- **Optional sync User-Agent** — WebDAV and S3 connection forms can now send a
  provider-required client identifier. It is validated and stored with public
  connection settings, never with the encrypted password or S3 secret.

### Changed
- **Compact right-click hierarchy** — When the optional selection toolbar is
  hidden, the context menu now groups text formatting, review markup, and block
  or list conversion behind hover/focus submenus. This keeps the root menu short
  without removing any existing action; submenus reverse direction near the
  right window edge.
- **Editor-style preview coverage** — the Settings preview now contains the
  common inline and block selectors that custom CSS authors actually target:
  headings, emphasis, deletion, links, inline code, keyboard keys, quotes,
  ordered and task lists, tables, and code blocks. Returning from another tab
  keeps the CSS snippet that was being edited selected.

### Fixed
- **YAML front matter boundary** — YAML metadata is now recognized only in the
  standard document-header position. Body separators followed by headings such
  as `Q3:` and `Q4:` remain normal Markdown instead of being misrendered as a
  YAML card.
- **Display-formula writing rhythm** — rendered `$$...$$` blocks no longer
  inherit the generous padding of editable code blocks, so they sit closer to
  the surrounding prose without changing code-block spacing, formula editing,
  equation tags, overflow behavior, or PDF output.
- **Repeated list conversion rendering** — converting the same list back from
  ordered to bullet form now updates Crepe's cached list-item marker state as
  well as its Markdown structure, so rich text and source mode stay in sync.
- **Literal backticks and YAML front matter editing** — Multiple manually typed
  backticks no longer delete earlier delimiters. YAML metadata cards now have an
  explicit rich-mode editor whose changes stay synchronized with source mode
  and saves.
- **PDF code blocks** (#91) — PDF export now converts only blocks explicitly
  marked as LaTeX to MathML. C++, JavaScript, and other fenced code remain
  literal code even when their text resembles a formula.
- **Display-formula scroll controls** — fitting LaTeX blocks no longer expose
  Windows scrollbar arrows. Only formulas whose rendered width actually exceeds
  the preview enable a single horizontal scroll surface; PDF output remains
  editor-control-free.
- **Tagged display formulas** — a block formula containing KaTeX `\tag{...}`
  no longer lets its equation number overlap the formula in rich-text preview.
  The formula now occupies the full LaTeX preview width with a reserved number
  column; PDF export remains unchanged.
- **Windows Command Palette compositing** (#62) — the full-window blur layer is
  now disabled only on Windows, avoiding a GPU/driver-sensitive re-composite
  while hovering or scrolling command results. The dimmed backdrop, keyboard
  navigation, search, and command execution are unchanged; Windows real-device
  confirmation remains tracked in the Issue.
- **Heading letter case** (#63) — H5/H6 no longer force English text to uppercase;
  authored casing is preserved in rich text.
- **Floating outline dismissal** — clicking a right-side chapter item no longer
  leaves its panel pinned open; moving the pointer away collapses it immediately,
  while keyboard focus navigation remains available.
- **PDF resource warning** — a document without images no longer reports that
  resources may be incomplete merely because font readiness took longer than the
  preview wait.
- **Very long display formulas in PDF** — exported block MathML is fitted to the
  printable width by splitting at top-level operators during PDF generation,
  instead of being clipped or proportionally shrunk to an unreadable size.
- **Large-document code-block scroll jump** — code blocks are excluded from
  `content-visibility` height estimation, so scrolling to and selecting a code
  block no longer exposes an estimate-to-real layout jump.
- **Source/rich caret regression coverage** — exact Markdown raw-offset UI
  tests now protect table cells, paragraphs, lists, and code blocks across both
  continuous switch chains.
- **Table row/column editing and save** (#86) — repeated row and column inserts
  no longer splice text into adjacent cells, add phantom rows/columns, or leave
  `<br />` in untouched cells after source switching, saving, or reopening the
  file. Deliberate in-cell line breaks still round-trip as `<br>`.
- **Wide table interaction** (#86) — compact tables retain their natural content
  width and a subtle theme-aware surface, wide tables only scroll when needed,
  and right-clicking a far-right column control no longer snaps the table back
  to its left edge. Hovering an edge keeps the add-row/add-column action clear;
  holding a column boundary enters a thin, real-time resize preview, and release
  persists the final width without affecting ordinary clicks.
- **Inline HTML no longer triggers a block drag handle** — hovering authored
  inline `<font>` or `<span>` formatting, or ordinary paragraph text, no longer
  opens Milkdown's unrelated block handle. The left block-operation gutter
  retains drag and block actions.

## [0.7.4] - 2026-07-20

### Fixed
- **Compact rich-text code blocks** (#80) — fenced code blocks now use the
  document paragraph spacing instead of the larger callout spacing. Syntax
  highlighting, language selection, and copy controls are unchanged.

## [0.7.3] - 2026-07-20

### Fixed
- **Font picker search accepts typing** (#85) — opening either the document-font
  or code-font picker no longer clears a query as the local font list finishes
  loading. The search field keeps focus and filters normally.

## [0.7.2] - 2026-07-19

### Added
- **Cloud sync folders** — desktop Settings now includes a Cloud Sync workflow
  for explicit local-folder registration, WebDAV and S3-compatible connections,
  hidden workspace identity markers, sync previews, directional upload/download,
  bidirectional sync, and conflict-preserving behavior.
- **Outline section reordering** (#82) — on desktop, drag a heading's grip in
  the outline to reorder it together with all of its descendant headings and
  body content. Reordering is limited to siblings, so a subsection cannot be
  silently moved under another parent; untouched Markdown source travels as-is.
- **Editor style customization** (#78, #81) — source mode can now follow the document
  font size with a separate readable offset, and Settings includes a Custom CSS
  editor for small document-style tweaks layered on top of the active theme.
- **Custom keyboard shortcuts** — Settings now includes a Keyboard section with
  shortcut recording, clearing, restore-default actions, conflict warnings, and
  persisted `horsemd.keybindings.v1` overrides. Application shortcuts sync to
  the Electron menu through a restricted IPC path, while renderer shortcuts such
  as tab switching, sidebar toggling, find/replace, and heading level changes
  read the same effective keybinding map.
- **Safer inline LaTeX deletion** (#74) — inline formulas now default to a
  protected delete mode: the first Backspace/Delete selects the formula, and
  the second key press removes it. Settings keeps a fast-delete option for users
  who prefer the previous behavior, and the inline formula editor now includes a
  Clear action.

### Changed
- **Modular Settings center** — the previous monolithic Settings page is split
  into focused General, Editor, Appearance, Files & Images, Keyboard, and About
  modules, keeping existing preferences and defaults intact.
- **Cloud sync local-folder tip** — the Sync folders section now explains that
  cloud sync starts from an existing local folder before choosing or joining a
  cloud workspace.
- **Clearer shortcut conflict feedback** — when a recorded shortcut is already
  used by another command, Settings now marks the edited row and says the
  shortcut was not saved instead of relying only on a page-level warning.
- **Unified editor styling controls** — typography, source font size, and Custom
  CSS now live together under Editor settings, with a small HorseMD-style preview
  that uses the same `.milkdown .ProseMirror` document selectors as the real
  editor.
- **Readable font picker names** (#75) — font dropdown rows now prioritize the
  complete family name instead of a decorative sample; very long names expose
  the full text through the native tooltip while hover preview remains available
  in the typography preview.

### Fixed
- **Windows rich-editor scrolling regression** — medium CJK-heavy documents no
  longer enable rich `content-visibility` only because of raw character count,
  and Windows trims redundant KaTeX MathML DOM in the live editor. This fixes
  scroll and browsing jank in files such as `WhatIf因果推断详细笔记.md` while
  keeping truly huge rich documents on the fast path.
- **Long table PDF printing** — PDF table styles now constrain wide tables to
  the page, wrap long cell content, and allow rows/cells to paginate so long
  tables are not clipped to only part of their content.
- **Launch-file race** — the renderer registers the open-path listener before
  signaling app readiness, so first-launch file arguments do not get lost behind
  the restored welcome/session tabs.
- **External-save conflict warning** — when an open file is saved by another
  application, a clean HorseMD tab still reloads automatically. A tab with
  unsaved local edits now keeps those edits and shows one clear native warning
  instead of silently remaining out of sync.
- **Image descriptions survive rich-text saves** (#84) — standard Markdown image
  alt text such as `![测试图片](image/test.png)` is no longer overwritten with
  the internal default resize ratio `1.00` after switching views or saving.
  Existing resized images written by earlier HorseMD versions remain compatible.
- **List typography follows editor settings** (#79) — line height and paragraph
  spacing now apply consistently to unordered, ordered, and nested lists in
  both the editor and the Settings preview.
- **Preserved untouched Markdown spelling** (#77) — switching to rich text and
  making a local edit no longer rewrites unrelated source formatting such as
  blank lines, tight-list `-` markers, or literal single tildes. Smart Markdown
  paste in rich text now retains the clipboard's original source spelling too.
- **Rendered display LaTeX in PDF export** — paragraph formulas written with
  `$$...$$` are converted from the editor preview into printable MathML before
  PDF generation, so exported PDFs show the formula instead of the LaTeX source
  or editor code-block controls.

## [0.6.5] - 2026-07-16

### Added
- **Precise image and Mermaid lightbox controls** — previews now include
  standard zoom-out/zoom-in buttons, a live scale readout, fit-to-window, and
  1:1 actual-size viewing.
- **Configurable PDF export** (#60, #64) — desktop export now offers A4, A3, Letter,
  and validated custom page dimensions, portrait/landscape orientation, margin
  presets, content scaling, preserved print backgrounds, heading pagination, a printable table
  of contents, PDF bookmarks, headers/footers, dates, page numbers, and ranges.
- **Browser-style PDF preview** — a dedicated export studio renders the actual
  generated PDF with lazy PDF.js pages, zoom controls, live option updates, and
  saves the exact preview buffer instead of rendering a second copy.

### Changed
- **Natural inline-code editing** (#58) — typing an empty backtick pair enters
  inline code immediately, and clicking the rendered trailing edge allows text
  to be appended without making the mark inherit into following prose.
- **Quieter writing surface** — removed the floating paragraph/heading-level
  badge beside the caret while preserving every block conversion path. Its
  selection, mousemove, scroll and layout-measurement listeners were removed too.

### Fixed
- Fixed rich WeChat article paste being flattened when numbered headings were mistaken for Markdown lists; heading levels, inline formatting, paragraphs, and lazy-loaded images are now preserved.
- **Reliable long-running editor actions** — PDF export now prevents duplicate
  submissions, reports failures in-place, and preserves options for retry;
  rich-document loading state is isolated per tab, and Lightbox drag listeners
  are fully removed when the preview closes.
- **Stable PDF preview scheduling** — rapid setting changes now cancel stale
  hidden-window generation and keep only the latest request. File-tree export
  waits for the target tab's explicit editor-ready signal instead of a fixed
  polling window, and temporary preview windows retain Electron's default web
  security policy.
- **Aspect-correct diagram previews** — long or tall Mermaid diagrams and
  images keep their intrinsic proportions in the lightbox instead of being
  placed in a fixed near-square canvas with large empty areas.
- **Natural end-of-document input and web paste paragraphs** — clicking anywhere
  in the visible writing area below rich content, including below the centered
  page container, now opens a new trailing paragraph (or reuses an existing
  empty one) so writing can continue without pressing Enter. Content copied from
  WeChat-style web editors keeps separate visual
  paragraphs instead of collapsing nested `section`/`div` blocks into one.
- **Focused split-pane outline** (#66) — the outline now switches to whichever
  left or right document pane has focus, and outline jumps scroll that pane in
  both rich and source editing paths.
- **Standard bold shortcut** (#67) — `Ctrl/Cmd+B` once again toggles bold in the
  editor. The sidebar shortcut moves to `Ctrl/Cmd+Shift+B` to avoid intercepting
  ProseMirror's standard binding.
- **Stable app viewport and readable wide tables** — the application shell no
  longer rubber-bands into a blank gap, while wide Markdown and raw-HTML tables
  scroll horizontally inside the editor instead of crushing text into narrow
  columns. Markdown table row/column handles and their action menus also remain
  visible and clickable when a tall table is vertically or horizontally scrolled;
  boundary add-row/add-column buttons are no longer clipped in half.
- **Reliable inline LaTeX editing** (#68, #69) — content inserted between a
  pre-typed `$…$` pair, including pure digits, previews live and becomes inline
  math after editing. Reopening an existing inline formula now updates a KaTeX
  preview continuously before confirmation.
- **Block LaTeX focus** (#57) — `$$` and `/math` blocks no longer leave edit mode
  after the first renderable character. `/math` converts the current paragraph
  so the caret starts inside the formula instead of on the following line.
- **File-tree context menu bounds** (#59) — menus near the bottom edge are
  positioned from their measured layout size, keeping Export and Delete visible
  even during the scale-in animation or in a short window.

## [0.6.0] - 2026-07-12

### Added
- **Linux desktop package** — Ubuntu, Debian, and compatible x64 distributions
  can install the official `amd64.deb`. Linux gets its own `.is-linux` styling,
  GTK-style minimize/maximize/close controls, Markdown file association, and
  PNG application icons. The tag workflow builds on Ubuntu, validates the
  package with `dpkg-deb --info`, and uploads the verified artifact to GitHub
  Releases.
- **Feishu-style slash command search** — the `/` menu now filters by Chinese,
  English, aliases, full pinyin, and pinyin initials. Language queries such as
  `/java`, `/python`, or `/mermaid` create a code block with that language
  selected, while short prefixes rank matching languages without flooding the
  menu with unrelated results.
- **Multi-root workspace** — the single unnamed workspace can contain multiple
  folder roots. Opening a folder adds it instead of replacing the current root;
  each root can be removed independently and is protected from accidental
  rename, delete, or drag operations.

### Changed
- **Native mobile text selection** — iOS and Android now use only the system
  selection menu for copy, paste, select-all, lookup, and accessibility actions;
  HorseMD's desktop formatting toolbar no longer overlaps it after a double-tap
  or long-press.
- **Outline starts at a useful depth** — the first two actual hierarchy tiers
  remain visible by default. Documents made entirely of top-level headings stay
  fully expanded, while deeper branches start compact.
- **Workspace controls and empty state** — Add Folder is visually distinct from
  New Folder, the empty state is reduced to one clear action, and the blank tree
  area exposes workspace actions through right-click or double-click.
- **Editor architecture** — source switching, workspace state, Sidebar tree
  state, Review decorations/cards, and main-process IPC domains now live in
  focused modules with their existing public contracts preserved.

### Fixed
- **Source-mode find navigation** — `Ctrl/Cmd+F` now centers the active textarea
  match, keeps a high-contrast highlight visible, and repaints reliably when
  Electron throttles animation frames. Keeping Find open across rich/source
  switches now rebuilds the correct Range/offset backend without losing the
  active result.
- **Rich/source caret and viewport drift** — block-aware raw Markdown offsets,
  dedicated table/CodeMirror selection handling, and keep-mounted rich editors
  preserve both editing carets and reading positions across repeated two-way
  switches, including large image-heavy documents.
- **Source caret visibility** — the source-mode caret is taller, thicker, theme
  aware, and measured against the textarea's final client width so it no longer
  covers text or appears in unrelated blank space.
- **Workspace path safety** — only valid absolute, unrestricted roots are
  restored or watched; root mount points cannot be moved as ordinary folders.
- **Desktop security boundaries** — external navigation accepts only approved
  URL protocols, and local-font permission is restricted to the intended font
  enumeration flow.

### Internal
- Split main-process document, filesystem, watcher, PDF, and security concerns
  into focused modules without changing the preload contract.
- Added source-map, source-find, mode-switch, Review UI, filesystem, watcher,
  PDF, and security regression scripts; CI now runs the core suite before build.

## [0.5.5] - 2026-07-10

### Added
- **Per-tab source/rich view state** (#42) — each document tab now remembers
  whether it is in rich-text or source mode while you switch between tabs. Source
  buffers are tracked separately so switching tabs no longer drops an edited
  source textarea.
- **Attach files from Markdown** (#49) — desktop builds can pick arbitrary
  files, copy them into a sibling `assets/` folder, and insert normal Markdown
  links such as `[report.pdf](<assets/report.pdf>)`. Unsupported platforms hide
  the command through capabilities.
- **Source-readable review markup** — keeps review annotations visible in
  Markdown source, copies AI handoff prompts with the annotated full document,
  and provides Accept All / Reject All cleanup commands.

### Changed
- **Outline folding behaves more like a file tree** — one compact expand/collapse
  control replaces the separate buttons, and folding a parent while reading a
  child heading now collapses the section instead of doing nothing. If the
  active heading is hidden inside a collapsed parent, the visible parent shows a
  contained-active state.

### Fixed
- **Slash command menu clipping** — the `/` menu is clamped into the visible
  editor area and its list height shrinks on small windows, so it no longer gets
  hidden by the app frame or bottom status bar.
- **Source-mode edits after tab switches** — source textarea content is restored
  from the live buffer when remounted, and only genuinely edited source buffers
  are synced back into the rich editor.

## [0.3.1] - 2026-06-28

A big editor polish release: syntax highlighting, smart paste, YAML front
matter, outline improvements, and a batch of community-reported bug fixes.

### Added
- **`==highlight==` syntax** with a **3-color picker** (yellow / red / blue) in
  the selection toolbar. Round-trips as `==text==` (yellow) or
  `<mark class="hm-hl-…">` (red/blue) (#14).
- **Inline HTML rendering** — `<span style>`, `<sub>`, `<kbd>`, `<mark>`, etc.
  render as real DOM instead of escaped text. A remark plugin coalesces fragmented
  open/text/close html nodes into renderable fragments.
- **YAML front matter** — the `---` block at the top of a document renders as a
  structured key/value card instead of a horizontal rule + headings.
  Round-trips cleanly (#8, #15).
- **Smart Markdown paste** — pasting a Markdown document (headings, tables, math,
  code blocks, front matter, mermaid) into the editor now parses and renders it
  with full fidelity, instead of landing as flat text.
- **Adjustable font size, line height, and paragraph spacing** — in the status
  bar's "排版" (Layout) popover, alongside the existing page-width control. Sliders
  apply live (no lag) via direct CSS-variable writes.
- **Collapsible Mermaid source** — Mermaid blocks now use the built-in code-block
  preview mechanism (like LaTeX): the diagram shows by default with a Hide/Edit
  toggle in the toolbar (next to Copy). "Mermaid" is also selectable in the
  language picker.
- **Floating Save button** — appears at the bottom-right only when the active tab
  has unsaved changes; expands on hover to reveal the label.
- **Document stats popover** — word / character / character-without-spaces /
  reading-time in one status-bar button.
- **Outline follows rendered headings** — the outline now lists every heading the
  editor renders (ATX `#`, Setext, HTML `<h1>`), not just ATX, and highlights the
  one you're currently viewing.
- **Removable recent files** — hover a recent-file row on the welcome screen and
  click ✕ to remove it.
- **Slash (`/`) menu localized** — follows the app language (中文 / English),
  including all item labels and group headers.
- **`remark-frontmatter`** dependency for YAML front-matter parsing.

### Changed
- **Code blocks have a dark surface** so syntax-highlighted code reads clearly
  (~6.9:1 contrast, WCAG AAA). Plain tinted code blocks are unchanged.
- **Status bar redesigned** — block-type switcher removed (still via badge /
  toolbar / right-click / shortcuts); font + width merged into one "排版" button;
  word/char/read merged into a stats button.
- **Welcome document** rewritten to showcase highlights, code, Mermaid, and math.
- **Xiaomi / MIUI status bar** — switched Android to overlay:true + real
  StatusBar height inset, fixing the clock/battery overlap on Xiaomi (and
  unifying the approach with iOS).
- **Toolbar injection deduplicated** — shared `editorForToolbar` +
  `appendToolbarItem` helpers; `usePopover` extracted to a shared hook.

### Fixed
- **Inline code "wouldn't stop"** (#10) — text after a closing backtick kept the
  inline-code style; the mark is now non-inclusive.
- **File tree follows the open file** (#11) — auto-expands parent folders and
  highlights / scrolls to the current file.
- **Outline escaped backslashes** (#12) — heading text with `_` no longer shows
  a stray `\`.
- **Desktop white-screen crash** — `capabilities` exposed from preload, not
  assigned onto the frozen contextBridge `window.api`.
- **Mermaid multi-paste** — pasting a second diagram into a mermaid block
  auto-splits into separate blocks; flaky first-render retried once.
- **Pasted images persist** — saved docs write images to `./assets/`; unsaved
  drafts use a global paste folder, relocated on first save.
- **Save slider jank** — layout sliders write CSS variables directly during drag.
- **Slash menu scroll** — `overscroll-behavior: contain` prevents body scroll.
- **Layout popover** — closes on outside click / Escape (shared `usePopover`).

## [0.3.0] - 2026-06-19

HorseMD goes mobile, plus a batch of editor & UI improvements and an important
desktop crash fix.

### Added
- **Mobile apps — iOS & Android.** HorseMD now runs on phones and tablets
  (Capacitor): open / edit / save local Markdown, share & export files out, with
  themes, i18n, outline, and the command palette all working. Android ships as an
  APK on the release page; iOS is built from source (free Apple ID signing).
- **Adjustable font size.** A status-bar control sets the editor body font size
  (presets + fine-tune slider) — combined with the page-width control into one
  **Layout** button.
- **Document stats popover.** The word / character / reading-time counts now live
  in one status-bar button; open it for the full breakdown (words, characters,
  characters without spaces, reading time).
- **Outline follows the cursor.** The outline highlights — and scrolls to — the
  heading you're currently viewing (scrollspy), the way the file tree marks the
  open file.
- **File tree follows the open file** (#11). Opening or switching to a file
  auto-expands its parent folders and highlights / scrolls to it.

### Changed
- **Pasted images become real files, never lost** — pasting or dropping a
  screenshot into a saved document writes it into a sibling `./assets/` folder and
  inserts a short relative link; in an unsaved draft it's parked as a real file
  and moved into `./assets/` on first save (Typora-style). No more giant base64
  blobs in the Markdown, and no more screenshots vanishing after save & reopen.
- **Tidier status bar** — font-size + width merged into one **Layout** button;
  the counts merged into a **stats** button; the block-type switcher was removed
  (block type is still changeable via the floating badge, the selection toolbar,
  right-click, the slash menu, and Ctrl/Cmd+1–6 / Ctrl/Cmd+0).
- **Mobile:** the command palette no longer auto-opens the on-screen keyboard.

### Fixed
- **Inline code "wouldn't stop"** (#10) — text typed after a closing backtick kept
  inheriting the inline-code style; the mark is now non-inclusive, so the caret
  leaves code on the next character (matching Typora).
- **Desktop white-screen crash** — a frozen `window.api` (contextBridge) made the
  desktop build crash on launch; feature capabilities are now exposed from the
  preload instead of assigned at runtime.

## [0.2.0] - 2026-06-14

A big feature release: image hosting, custom themes, diagrams & math, adjustable
page width, in-cell line breaks, an Intel macOS build, and a nicer update prompt.

### Added
- **Configurable image host** — a Typora-style custom upload command. Pasting,
  dropping, or uploading an image runs your command (e.g. `picgo upload`) and
  inserts the returned URL. Configured from a top-bar button (a dot marks it as
  active). Leave it empty to keep images local.
- **Custom themes** — drop a `.css` file (or a whole downloaded theme folder) into
  the themes folder and pick it from the status-bar theme menu, under a **Custom**
  section with **Open themes folder** / **Get more themes** (theme.typora.io). The
  editor exposes Typora's `#write` / `markdown-body` hooks so **Typora themes work
  directly**; subfolders are scanned, and relative `url(...)` assets (fonts/images)
  resolve correctly.
- **Mermaid diagrams** — ` ```mermaid ` code blocks render live as diagrams below
  the editable source (Mermaid is lazy-loaded only when a diagram is present).
- **LaTeX math** — inline `$…$` and block `$$…$$` render via KaTeX.
- **Adjustable editor width** — a status-bar control with preset segments
  (Narrow / Medium / Wide / Full) plus a fine-tune slider.
- **Line breaks inside table cells** — press Enter / Shift+Enter in a cell; it
  round-trips cleanly as `<br>` (GFM tables stay single-line, never corrupted).
- **Update prompt shows what's new** — the "new version available" toast now
  displays the GitHub release notes (auto-loaded), with a slim scrollbar for long
  notes.
- **Intel macOS build** — the macOS target now ships both Apple Silicon (arm64)
  and Intel (x64).
- A project [ROADMAP.md](./ROADMAP.md) (incl. planned Android & iOS).

### Changed
- **Denser tables** — much tighter rows (cell paragraph margins removed, smaller
  padding/line-height) so a Markdown table no longer wastes vertical space.
- Redesigned the update toast (gradient icon, version pills, sectioned release
  notes).
- Website + README document the Intel download alongside Apple Silicon.

### Fixed
- **Table text overflow** — long content / inline code in a cell now wraps instead
  of overlapping the neighbouring column.
- **Long formulas no longer overlap** — display math scrolls within the column.
- **Clicking an image no longer draws a selection frame** — the tint overlay and
  the inline-image outline are removed (resize handle + caption remain the cue).
- **Switching theme no longer drops the page-width / custom-theme setting** —
  `applyTheme` preserves app-managed `hm-*` body classes.

### Internal
- New modules: `settings.js`, `customThemes.js`,
  `components/{ImageHostButton.jsx, editor-mermaid.js, editor-tablebreak.js}`.
- Editor exposes a `getMarkdown` API; theme injection scoped so a custom theme
  owns the writing area while the app chrome keeps its own styling.

## [0.1.7] - 2026-06-10

### Added
- **Split view** — two documents side by side, both fully editable. Open a tab
  into the right pane from its (or a file-tree row's) right-click menu, or toggle
  with the split button in the top bar. **Drag the divider** to resize; **click a
  pane, then a tab** to switch that pane's file (the focused pane is shown by its
  tab underline). The two panes are independent editors that never re-mount, and
  Save / Export act on whichever pane you're editing.
- **Unified right-click menus** — the tab menu and the sidebar file-tree menu now
  offer the same file actions: Copy Path, Copy Name, Reveal in Finder/Explorer,
  Open in Split, Rename, Duplicate, Export as PDF, Delete (plus Close / Close
  Others on tabs; New File / New Folder in the tree).
- **Copy feedback** — the code-block "Copy" button flashes a green ✓ and shows a
  brief "Copied" toast; its label is localized.
- **Heavy documents open instantly** — a Markdown file that would freeze the rich
  editor (a huge run of lines with no blank-line breaks, or > ~400 KB) opens in
  the fast plain-text editor, with a one-click **"Render as rich text"** to load
  the WYSIWYG view on demand.

### Changed
- **Windows installer: the install location is now selectable**, and uninstalling
  *or updating* only removes the files HorseMD shipped — any files you saved
  inside the install folder are left untouched.
- **Cleaner split UI** — a 1px hairline divider, a single faint ✕ (hover-tooltip)
  to close the split, and the focused pane marked by its tab's accent underline
  (the other pane's tab stays subtly underlined).

### Fixed
- **Crash on launch from the recursive file watcher.** A saved workspace that was
  a relative path (e.g. `"."`) or the filesystem root made the watcher recurse the
  whole filesystem — under Finder/launchd the CWD is `/`, so `"."` meant watching
  `/dev`, `/System/Volumes`, … — a flood of `EACCES`/`EAGAIN`/`EBUSY` that aborted
  the app on startup (often seen as an instant crash / black window). The watcher
  now only watches absolute paths, skips the root and system/device trees, doesn't
  follow symlinks, and swallows per-path errors; the renderer ignores a
  non-absolute restored workspace; launch args resolve to absolute (the app's own
  directory is never opened); and a process-level guard catches stray async errors.
- **Tab-menu "Rename" did nothing** — it used `window.prompt`, which Electron
  doesn't support; it now opens a small inline rename dialog.
- **Unsaved scratch / new tabs survive a restart** — untitled tabs with edits were
  silently lost on close; they're now persisted and restored (saved files are
  still reopened from disk).
- **Light-theme code-block selection was unreadable** (near-black-on-black); it now
  uses the soft accent highlight with legible syntax colors.
- **Code blocks no longer highlight the "active line"** on entry/first line — the
  caret alone marks the position.
- **The floating block badge (H1/H2/Text) no longer overlaps the block drag-handle**
  — it tucks to the handle's left so both stay visible.
- **Clicking a table cell no longer shows an out-of-place selection wireframe** — the
  hard blue node/cell outline is removed for tables (the soft cell-range fill stays);
  elsewhere the selected-node ring is a subtle theme accent.
- **Loading skeleton no longer overlaps already-rendered content** (it's cleared
  synchronously the moment content renders, before the heavy post-processing).
- **Typing lag in large / unsaved documents** — session state is no longer
  re-serialized to disk on every keystroke (debounced, flushed on close).
- Main-process update check uses Electron's `net.fetch` (Chromium stack) instead of
  Node's `fetch`, avoiding a c-ares abort on some unsigned-app launches.

### Internal
- Refactored `App.jsx` (1598 → ~1300) and `Editor.jsx` (992 → ~836): extracted pure
  helpers and leaf components (`find.js`, `paths.js`, `ui.js`,
  `components/{Welcome,WindowControls,UpdateToast,RenameModal}.jsx`,
  `components/editor-{html,images,copy}.js`) and deduplicated shared helpers. No
  behavior change.

## [0.1.6] - 2026-06-09

### Changed
- New/empty documents now start as an empty **Heading 1 plus an empty body
  paragraph** below it. The title is there if you want it, but you can skip it
  and start writing body text straight away (click the line below or press ↓).
  Previously the doc was *only* a forced H1, so you couldn't write body without
  first typing a title and pressing Enter.

### Fixed
- Creating / renaming / moving / duplicating to a name that already exists now
  shows a clear "name already exists" message instead of a raw `EEXIST` error,
  and never overwrites the existing file.

### Added
- **Loading skeleton** for large documents — pulsing gray placeholder bars while
  the editor parses/renders, so opening *or switching to* a big file isn't a
  frozen/blank pause. (Creation is deferred one paint so the skeleton actually
  shows before the parse blocks the main thread.) Small files never show it.
- **Double-click an image to view it enlarged** in a lightbox (click the backdrop,
  the ✕, or press Esc to close). Display-only — it never changes the document,
  and a single click still selects the image / edits its caption.
- **Home button** at the top of the activity bar (the app icon) — returns to the
  welcome/landing page while keeping open tabs mounted (clicking a tab goes back).
- **Version number** shown next to "HorseMD" on the welcome page, so you can tell
  which build you're running.
- **Raw HTML tables now render as tables** (like Typora). An HTML `<table>…</table>`
  written in the Markdown is shown as a real, theme-styled table instead of
  escaped source. The Markdown source is unchanged — it round-trips and saves as
  the original HTML (rendering is display-only; `<script>`/inline event handlers
  are stripped).

### Performance
- **Faster startup / session restore.** Restored tabs now mount their rich
  editor lazily — only the active document spins up an editor on launch instead
  of every restored tab parsing its whole document at once. Editors stay mounted
  after first activation, so tab switches remain instant.
- **Smoother typing in large documents.** The floating block-level badge now
  coalesces its layout measurements to one per animation frame (it previously
  forced a synchronous reflow on every caret move / keystroke), and the
  selection-toolbar observer only re-scans when DOM nodes are actually added
  (debounced per frame) instead of on every edit.

### Fixed
- **Closing the window now warns about unsaved changes** (macOS traffic light,
  the Windows close button, Cmd/Ctrl+Q) — previously only closing a tab did.
- Image **caption** text ("Write image caption") is now localized and follows
  the zh/en switch.

## [0.1.5] - 2026-06-08

### Added
- File tree: **drag and drop** files/folders into another folder to move them.
- File tree: the collapse-all button now **toggles** between collapse-all and
  expand-all (recursively expands every subfolder), with a matching icon.
- Selection toolbar buttons now show **tooltips** (Bold, Italic, Strikethrough,
  Inline code, Link).
- Always-visible **collapse / expand sidebar** toggle in the activity bar (the
  icon flips to an "expand" affordance when collapsed).

### Changed
- File-tree typography: larger, non-uppercase folder-name header and slightly
  larger row text for better legibility (especially CJK names).

### Fixed
- **Find (Ctrl+F) rewritten** to search only the editor content via the CSS
  Custom Highlight API: it no longer matches the text typed in the find box, and
  next/previous are instant (no IPC round-trip). Shows a live `x/total` count.
- **Uninstall no longer deletes user files.** The uninstaller now removes only
  the files HorseMD installed, so a document saved inside the install folder
  (e.g. a Markdown note next to the app) is preserved instead of being wiped by
  a blanket recursive delete. The install location is also fixed to a dedicated
  per-user folder so the app can't be installed into a folder of your own files.
- The title bar always keeps a draggable area to move the window, even when many
  open tabs fill the whole tab strip.

## [0.1.4] - 2026-06-08

### Added
- Floating **block-level badge** that tracks the caret, naming the current block
  (H1…H6 / 正文) beside the text.
- Sidebar right-click: **Duplicate** a file, and **Export as PDF**.
- Custom Windows caption buttons (minimize / maximize / close) with hover states
  (close turns red), replacing the native overlay.
- Explorer **"Open with HorseMD"** entry on folders — opens a directory as a
  workspace; the app now accepts a folder path on launch.
- **Notify-only update check**: on launch, looks up the latest GitHub release and
  shows a dismissible "new version available" toast.
- Inline **confirm (✓) / cancel (✗)** buttons on the create & rename fields, and
  an "empty folder" hint when an expanded directory has nothing to list.

### Changed
- Source/rich toggle now **keeps the scroll position** and no longer rebuilds the
  background editors, so switching is much faster.
- Shorter executable description ("HorseMD Markdown Editor") so the Explorer
  "Open with" name isn't a long sentence.

### Fixed
- New file/folder creation now commits on blur (clicking away no longer loses the
  typed name).
- The unsaved-close confirm dialog and a couple of error messages are now
  localized (zh/en).

## [0.1.3] - 2026-06-07

### Fixed
- Open files now reliably auto-refresh when changed by another program: the
  single-file watcher polls (surviving "atomic replace" saves used by many
  editors/tools), and the editor remounts on reload so the new content actually
  shows.

## [0.1.2] - 2026-06-06

### Added
- Export the current document to **PDF** (File → Export as PDF…, `Ctrl/Cmd+Shift+E`,
  or the command palette). Renders a clean, print-styled copy without editor
  chrome (code-block toolbar, table handles, etc.).

### Changed
- Writing font in the editor now matches the website — a sans-serif stack
  (Helvetica Neue / PingFang SC …) instead of the previous serif.
- Status bar now keeps the right-side controls (block/source toggles, theme,
  language, GitHub) fixed and visible when the window narrows — the file path
  collapses (ellipsis) instead of the buttons being hidden or pushed off-screen.

### Fixed
- New-file naming overwrote the input when typing digits (the name was reselected
  on every keystroke) — the name is now preselected once.
- Editor placeholder now follows a language switch live (was baked in at create).
- Opening a moved/deleted file no longer dumps a raw IPC error — the dead entry
  is removed from Recent with a friendly message; session restore skips missing
  files silently.

## [0.1.1] - 2026-06-05

### Added
- Top-bar `+` button to create a new file, and a GitHub link in the status bar.
- Plain-text files (`.txt`) open in a fast plain-text editor instead of the
  Markdown WYSIWYG.
- macOS packaging (dmg + zip) and a native macOS title-bar layout.
- Bilingual README (English + 简体中文) with screenshots and a theme gallery; `CLAUDE.md`.
- MIT `LICENSE`, CI build check + tag-triggered release packaging, `CONTRIBUTING.md`,
  `SECURITY.md`, and issue templates.
- Explicit Electron security flags (`contextIsolation`, `nodeIntegration`) and a navigation guard.

### Fixed
- Status-bar theme/language menus were clipped by `overflow:hidden` and looked
  unclickable — they now open correctly.
- Large `.txt` files no longer hang the editor (they bypass Markdown parsing).
- Rename now preselects the filename without its extension, like new-file.

## [0.1.0] - 2026-06-05

### Added
- Initial release: tabbed, Typora-style WYSIWYG Markdown editor.
- Folder workspace with file-tree sidebar, command palette, outline panel.
- Dark/light themes, session restore, single-instance file association.
- Windows NSIS installer and macOS dmg/zip packaging.

[Unreleased]: https://github.com/BND-1/horseMD/compare/v0.13.29...HEAD
[0.13.29]: https://github.com/BND-1/horseMD/compare/v0.12.62...v0.13.29
[0.12.46]: https://github.com/BND-1/horseMD/compare/v0.12.10...v0.12.46
[0.12.10]: https://github.com/BND-1/horseMD/compare/v0.10.4...v0.12.10
[0.7.2]: https://github.com/BND-1/horseMD/compare/v0.6.5...v0.7.2
[0.6.5]: https://github.com/BND-1/horseMD/compare/v0.6.0...v0.6.5
[0.6.0]: https://github.com/BND-1/horseMD/compare/v0.5.5...v0.6.0
[0.5.5]: https://github.com/BND-1/horseMD/compare/v0.5.2...v0.5.5
[0.2.0]: https://github.com/BND-1/horseMD/compare/v0.1.7...v0.2.0
[0.1.7]: https://github.com/BND-1/horseMD/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/BND-1/horseMD/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/BND-1/horseMD/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/BND-1/horseMD/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/BND-1/horseMD/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/BND-1/horseMD/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/BND-1/horseMD/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/BND-1/horseMD/releases/tag/v0.1.0
