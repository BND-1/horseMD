# 家族根因矩阵（2026-08-11）

> **当前结论（2026-08-26 / 0.13.125）：legacy source-fidelity baseline 的 20/20 结果来自 0.13.124 的完整矩阵，0.13.125 在此基础上通过了 RS-80 列表输入规则专项和相关列表/代码块/保存重开回归。** 这证明本轮列表 owner 修复没有破坏已覆盖家族，但不等于 transaction-first 已接管全部结构编辑，也不等于真实长会话 P0 已关闭。当前生产链路仍是 legacy preservation 主导，transaction-first authority 只对受限普通段落事务开放；下一阶段仍是按结构族迁移并逐步删除 legacy owner。RS-80 见 `rich-source-fidelity-bug-family.md`，RS-79 见 [`transaction-first-authority-first-divergence-regression.md`](./transaction-first-authority-first-divergence-regression.md)。

## 当前架构进展

这个矩阵现在承担两项不同职责，必须分开解读：

1. **legacy baseline**：验证当前发布链路对真实文件、列表、代码块、表格、保存和重开的保真边界；
2. **migration gate**：验证某个结构族能否从 legacy owner 迁移到 transaction-first authority。

矩阵通过只能说明候选源码经过现有安全门并保持一致，不能单独证明新架构已接管，也不能证明所有未覆盖事务都不会分叉。每个迁移族还必须有 transaction trace、逐字 UI、立即源码切换、保存、磁盘字节和冷重开证据。

## 为什么建这个矩阵

用户明确要求“不要一个 bug 一个 bug 地修，要找出家族根因”。为此把已报告过的症状
（保存暂停、删除复活、新增丢失、拼行、marker 覆盖、`&#x20;`/`\` 转义泄漏）与真实
用户文件、操作类型组合成 4 文件 × 5 操作的自动化矩阵，一次跑完并按失败形态聚类。

## 矩阵定义

- 文件：123321.md、引用后输入手测.md、反馈.md、11111.md（全部是用户真实文件）
- 操作：末尾输入有序列表 / 无序列表 / 普通文字 / 前导空格+文字 / 列表项空格+文字
- 断言：追加进入源码且独立成行、保存完成无暂停 toast、删除生效不复活、无
  `&#x20;`、无 `<br />` 占位、重开一致
- 命令：`npm run test:family-matrix-ui`

## 根因聚类（本轮发现并修复）

### 根因 0：段落拆分被错误当成全局可见文字变化

在已有长文档中，用户点击普通段落内部并按 Enter，ProseMirror 只是在同一段落中插入一个结构边界，前后 canonical 的可见文字完全相同。但如果文档其他位置已经存在作者 marker 与 serializer marker 的差异，旧逻辑会把这笔零可见字符事务送进全局 visible-stream mapper，得到 `visible-stream-mismatch`，随后用户输入 `1. ` 时触发保存暂停通知。

修复不是放宽全局 mismatch：新增段落拆分事务证明，要求同时满足：
- canonical 可见流前后一致；
- delta 只包含新的段落分隔符，且不触及列表、表格、标题、引用或围栏语法；
- 由拆分点前后唯一可见文本上下文在作者源码中定位到唯一 raw 边界；
- 候选只在该边界插入作者原有行尾风格的两个换行，其他源码字节保持不变。

任何一个条件不满足仍然 fail-closed。这样把“结构事务的所有权”从全文可见偏移中分离出来，避免用单个列表/字符串补丁掩盖家族根因。回归：`test:middle-ordered-marker-only-ui`、`test:markdown-preservation`。

### 根因 0B：已发布的字面 `-` 在 Space 输入规则中失去局部所有权

在分叉长文档中退出有序列表后，用户可能先让单独的 `-` 完成一次源码同步，再按空格触发无序列表输入规则。此时 canonical 已经把该段落纳入前后相邻的 bullet tree，但输入规则携带的 ProseMirror 旧位置可能落到前一个 sibling；如果按全局 offset 或整个合并 list block 重建，结果会丢掉 `-`、复制前一个列表项，或把新 item 写到错误位置。

修复采用事务所有权而不是放宽完整性：当源码在捕获位置仍是唯一的 escaped marker（例如 `\\-`）时，只在 previous canonical 中按同级 bullet 序号找到对应 literal 行，并在 next canonical 中取同 ordinal 的新 list item；前后正文、缩进和 marker 必须满足唯一性，最终只替换这个 item。任何快照漂移、重复锚点或跨层级情况继续 fail-closed，由完整 source/list integrity gate 拒绝静默提交。回归：`test-human-list-exit-dash-space-ui`、`test:fast-empty-bullet-ordered-input-rule-ui`。

### 根因 0A：代码块内部首字符被普通段落 mapper 越权处理

在已有文档中间编辑一个空 fenced code block 时，代码块的开闭围栏和前后块本身没有变化，只有围栏内部新增代码字符。但可见行映射会把围栏语法视为不可见边界；当源码前方已经存在列表 marker 或实体差异时，通用 `preserveMiddleEmptyBlock` 可能把这笔事务误判成“新增普通段落”，将首段代码插到开围栏之前，随后源码与富文本分叉。

这不是再增加一个内容关键词分支，而是同步入口的结构所有权规则：
- 先扫描 canonical 前后快照中的成对 fenced block，并要求开围栏、闭围栏、围栏外前缀和后缀都保持不变；
- 再按同序号找到作者源码中的对应围栏，并证明已有代码内容的可见流一致；
- 只有证明通过，才把 canonical 围栏内容作为一个局部替换写入作者源码的内容区；否则不让代码块处理器猜测，也不让普通段落 mapper 抢占。

因此所有块级事务都遵循同一方法：**先确定结构所有权，再做局部 raw patch；无法证明归属就 fail-closed 并通知，不用整篇 canonical 覆盖源码**。回归：`test:middle-codeblock-source-ui`、`test:markdown-preservation`、`test:code-fence-delete-source-ui`、`test:tail-fence-ui`。

### 根因 1：尾部行追加/删除没有精确的“行级锚定”映射器

旧 mapper 在分叉文档（源与序列化结果拼写不同）里把 canonical 新增行**拼到上一行**
（`   1. qefqef` + `1) 尾插验证` → `qefqef1) 尾插验证`），导致重开结构漂移、后续
删除映射失败（fail-closed → “删除复活”/“保存暂停”）。

修复：`preserveDivergedTailBlockAppend` 精确匹配“canonical 末尾行 = 源末尾行 +
续写/新行/删行”，新增行独立成行、删除行真正删除。需要同时处理：
- 源与 canonical 的列表 marker 差异（`-`/`+`/`*` 等价、`1.`/`1)` 等价）
- `&#x20;` 实体与 U+200B sentinel 等价
- 尾部空行保留/补齐的语义（续项保留、新块补 2 换行、尾换行 1 个）
- 空列表项（`- `、`* <br />`）作为锚定行保留，纯空行/占位跳过
- 新列表创建（之前是段落）让给意图 mapper 恢复 marker

### 根因 2：`<br />` 占位的缩进变化导致 visible-stream 比较失败

删除列表行后 canonical 留下 `   <br />`（空项占位），缩进还会变（`   ` → `      `），
全文可见流比较失败 → 删除 fail-closed。

修复：`normalizeEmptyListItems` 把 standalone `<br />` 行去缩进统一为 `<br />`，
两侧比较一致；专门的空块 mapper 仍能识别占位。

### 根因 3：列表行重建漏掉反转义

`diverged-nested-list-change` 重建列表行时原样写入 canonical 的 `&#x20;`。
修复：文本变化和新行都过 `canonicalTextToSource`（fresh）反转义。

### 根因 4：尾部手打代码块触发“保存已暂停”（123321.md 上报）

在分叉文档（源尾自带孤立 ` ``` ` 行，canonical 里是逐反引号转义的字面行
`\`\`\``）末尾手打 `` ``` Enter 内容 Enter ``` `` 时，旧实现全部 fail-closed：

1. `preserveDivergedTailBlockAppend` 锚定 `equivalentLine('```', '\\`\\`\\`')`
   失败，且末尾的“围栏/标题/引用”结构拒绝循环对 `remaining` 里的围栏行一律
   `return null`（当初只允许纯文本/列表续行）。
2. `nextEnd < next.length - 2` 硬守卫被 commonChange 的公共后缀骗过：公共后缀
   可包含代码块闭围栏行（3-tick → 4-tick 扩展时共享后 3 个 tick），真正在文档
   尾部的修改被误判为“中间修改”而拒绝。
3. 代码块围栏扩展（内容行出现 ` ``` ` 时 Crepe 把围栏重围为 4-tick）时修改点
   在开围栏行、锚定行是闭围栏行，`start < previousLineStart` 三个 case 全不中。

修复（全部在 `preserveDivergedTailBlockAppend`，且仍只跑 diverged 分支）：
- 放宽锚定：canonical 尾部字面 `\`\`\`` + 源尾孤立 ` ``` ` + next 尾配对围栏
  时回退锚定到倒数第二个可见行，复用源尾孤立围栏行作开围栏、跳过 canonical
  开围栏行（空块创建 ` ```\n``` `）。
- 空块内输入内容：`prevTailIsPairedFence` 用围栏状态机（`tailEmptyFencePair`）
  验证“开围栏行紧邻闭围栏行”才走 fence-content 分支，防止非空块里恰好以围栏
  样式行结尾的内容被误判；该分支保留源的开/闭围栏行，只把 canonical 新增内容
  行插到中间。
- 围栏扩展（` ``` ` → ` ```` `）：`diverged-tail-fence-extend` 检测前后最后一个
  围栏段开围栏位置相同、next 更长、内容可见一致后，用 canonical 围栏段整体
  替换源围栏段（fence 内部行经 `canonicalFreshTextToSource` 保持原样）。
- foldCase 的围栏扩展（在已有闭围栏行上追加 tick）用
  `isCompleteFenceBlock(sourceLine + continuation + remaining)` 结构化验证后放行。
- 删除 `nextEnd < next.length - 2` 硬守卫：尾部性由“start 落在最后可见行上/后”
  的锚定逻辑保证，公共后缀含闭围栏行不再误拒绝。

验证：`FILE=123321.md node scripts/test-tail-fence-ui.mjs`（手打代码块 → 切源码
无暂停 → FAB 保存落盘 → 全新 profile 重开渲染一致 → 源码与磁盘字节一致）。
回归：家族矩阵最终 20/20，`test:code-fence-delete-source-ui`、
`test:literal-triple-backtick-source-ui`、`test:markdown-preservation`、
`test:source-fidelity-probes`、`test:new-source-fidelity-ui`、
`test:leading-space-entity-ui`、`test:paragraph-source-ui`、
`test:empty-paragraph-source-ui`、`test:diverged-ordinary-save-ui`、
`test:diverged-delete-source-ui`、`test:save-reopen-smoke-ui`、
`test:rich-list-source-ui`、`test:list-marker-empty-source-ui`、
`test:list-conversion-ui` 全过。

### 根因 5：尾部零宽插入丢失空行（块边界拼行）

分叉文件尾部（源尾 1 个换行、canonical 尾 2 个换行）创建新块（`1. ` 列表、
引用等）时，`preserveChangedLineRegion` 的零宽插入点取 `previous.length`
（canonical 长度，大于源长度），replacement 直接拼到源尾
（`测试\n` + `1. ` → `测试\n1. `）。这个坏骨架让后续每一次列表比较全部
fail-closed → 保存暂停。

修复：零宽尾部插入时，若 canonical 插入点前是块边界（`\n\n` 结尾）而源尾
只有单个换行，先在 replacement 前补一个空行。

### 根因 6：`likelyMultiListDelta` 误判单列表多行变化

在空列表项里输入内容再 Enter 新建下一项（`1. ` → `1. 瑟瑟\n2. `）是
**一个列表**的两行变化，但旧的行数判断（变化 ≥ 2 行）把它当成「多列表批量
变化」→ sticky blocked → 单列表 mapper 永远不执行 → 保存暂停。

修复：变化行之间出现**空行分隔**（用户视角的独立列表边界；CommonMark 会把
相邻 `-`/`+`/`*` 合并成一个块，所以不能靠 canonical 块判断）才算多列表。

### 根因 7：段落后新建列表被 tail mapper 拒绝后拼行

`preserveDivergedTailBlockAppend` 曾把「普通段落后新建列表」让给输入规则意图
mapper（恢复 `-` marker）。但深分叉文档里意图 mapper 会因无
`sourceSlotRawStart` 而 fail-closed，fallback 到可见流 mapper 把新行拼到段落
尾（`1231231231. 家族验证`）。

修复：tail mapper 兜底追加 canonical 块（结构正确优先）；意图 mapper 仍在
flush 链上运行并恢复 marker，两者不冲突。

### 根因 8：foldCase/追加路径把 canonical 实体原样写进源

- foldCase 的 continuation 用字节 slice（`previousLine.length`）：canonical
  把内容前导空格转义成 `&#x20;`（1 字符 vs 6 字符），切片从实体中间切开，
  残留 `0;` 碎片。改为按规范化单元（`&#x20;` 算 1 空格、backtick span 拆内
  部字符）匹配定位真实结束位置。
- `appendBlockAtDocumentEnd` 对「专用块语法」行（列表等）原样追加 canonical，
  `&#x20;` 实体泄漏进源。改为 `canonicalTextToSource`（默认模式只还原实体、
  不还原反斜杠标点，fence/HTML 上下文原样）。

### 根因 9：列表输入意图被重复消费，后一轮回调覆盖正确源码

正文后手打 `- ` 时，第一次结构回调已经把 Crepe 默认的 `*` 恢复成作者输入的
`-`，但旧实现只在“整个输入规则重建成功”时清除 pending intent，没有在“仅 marker
恢复成功”时清除。随后输入列表正文，第二次 `markdownUpdated` 又拿旧槽位重建同一
列表，把已经正确的段落/列表空行边界覆盖掉。富文本看起来正常，源码和保存结果却少
一个空行；继续编辑、保存、重开后差异继续扩大。

修复：列表 input intent 只能消费一次。完整重建、marker 恢复或 generated scratch
任一真正完成该输入规则后，都从单意图和意图队列中同时移除。`updateContent()` 同步
更新 `tabsRef`，源码 textarea 不再有机会挂载一个较旧的 React 快照。

### 根因 10：多轮保存后的“列表续写 + 新同级项 + 正文”被部分提交

旧家族矩阵只证明一次追加/删除/重开。真实文件在第二次冷重开后继续编辑列表，Crepe
可能把“修改现有项、Enter 新增同级项、再 Enter 退出并输入正文”合并成一个 canonical
delta。旧批量列表 mapper 可以只写回列表却返回 `preserved: true`，把同一事务末尾的
正文静默丢掉；重复的“测试”还可能让可见字符 offset 锚到更早的同名行。

修复：

- 新增 `diverged-list-continuation`：以完整列表行、顶层缩进、唯一出现次数和未变化右侧
  suffix 共同证明零宽插入，只写入该列表行后的新增块；
- 批量列表结果只有 `nextBaseline === next` 才能直接发布；若仍有 remainder，只允许
  已证明的空段/尾段组合原子提交，否则整体 fail closed，禁止半成功；
- 通用局部 visible mapper 明确拒绝跨多行结构插入，列表、标题、引用和 fence 必须由
  专门结构 mapper 接管。

### 根因 11：CRLF 的 `\r` 被当成正文，插入落在 `\r` 与 `\n` 之间

`markdownLines()` 的行区间包含 CRLF 中的 `\r`、不包含 `\n`。列表续写若直接在
`line.end` 插入，会生成 `- target\r继续\r\n`。此外，无末尾换行的文件退出列表时，
固定只允许增长一个换行，无法同时表达“终止上一行 + 保留独立块空行”。

修复：CRLF 续写在尾部 `\r` 之前插入，新增内容按附近行尾转换；退出末尾空列表项时
根据源文件原有 terminal-EOL 数量计算允许增长（0 个需 2 个，已有 1 个只增 1 个）。
随后创建新列表时，只有 canonical 仍在同一列表才压紧；若 previous 以空 paragraph
结束，则保留作者的独立块边界。

### 根因 12：真实风险只在第二、第三轮持久化后出现

一次“编辑 → 保存 → 重开”不能证明双快照仍健康。新增
`test:family-multicycle-ui`，默认使用仓库内生成的含 BOM、CRLF、重复文本和分叉列表
fixture，也可用 `FILE=...` 指向真实用户文件。它连续执行 4 轮编辑、5 次全新 profile
打开，覆盖：修改已有有序项、删除旧文字、继续列表、退出列表、手打 `-`、手打 fence、
再次续写无序列表、输入后续正文；每一轮都校验富文本结构、首次/二次源码、保存磁盘
字节和冷重开，并分别在默认发布路径与 transaction-primary 实验路径运行。

### 根因 13：重开后在文档中间把空段落改成列表，整个新增批次没有源码槽

真实 `123321.md` 的前三轮保存/重开通过后，继续在已有正文与后续 fenced code 之间
输入“正文 → `1. ` 有序列表两项 → 退出列表 → 正文”，Crepe 会把列表和退出后的正文
合并进一次 canonical 变化。此前 `preserveMiddleEmptyBlock()` 为避免抢走表格、标题和
代码围栏，拒绝所有专用块语法；而列表 input intent 在这个中间位置又没有
`sourceSlotRawStart`。结果后续每次回调都是 `visible-stream-mismatch`：富文本仍显示新
内容，源码和保存快照却停在输入列表之前。

修复：只有在 previous 明确存在独立 `<br />` 空段、左右可见行及结构类型一一对应、
source 中间仍是未被占用的空白间隙时，允许“列表 + 列表后的普通正文”原子替换该槽。
标题、引用、表格、fence、分隔线继续拒绝并交给各自 mapper。该槽完成列表创建后立即
消费 pending input intent，禁止后续回调再次拿旧意图重建。CRLF 写回从左锚正文末尾
（`
` 之前）开始替换完整 EOL，专项断言禁止出现 lone `\r`。


### 根因 14：`/code` 两阶段命令只删除查询行，没有原子写入 fence

斜杠菜单先清除临时 `/code`，再把 paragraph 改为 `code_block`。在 source/canonical
已合法分叉的复杂文档中，旧尾部路径把 `/code` → 空 fence 误判成“尾行删除”，源码
只删掉 `/code`，没有得到对应的成对围栏。之后代码内容、代码块后正文和前文修改都从
错误基线继续，第一次切源码就会锁定或显示旧内容。

修复：代码类 slash 命令执行前捕获精确 authored 行和 EOL，执行后只序列化当前
`code_block`，确认是完整 fence 后原子替换该行并一起推进双基线。重复 `/code` 没有
精确 PM 映射时拒绝；非代码 slash 命令不进入该处理器。专项 `test:tail-fence-ui` 不做
中间 checkpoint，连续编辑代码、尾部正文与前文列表，再验证源码、磁盘和冷重开。

### 根因 16：零宽插入被误判为中间结构块

普通正文中的单字符插入也满足“`previousEnd === start` 且变更片段非空”这一
表面条件。旧的中间空段 mapper 没有再确认插入点是否位于块边界，因此在前方列表/表格
已造成 canonical/source 偏移时，可能把一个字符当成新段落，插入到前一块与后一块之间；
源码看似成功提交，但富文本和源码已经分叉。

修复：只有插入点落在 canonical 行首或行尾时才允许进入 direct block insertion；普通
行内编辑交给局部文字 mapper。候选提交、源码切换和保存统一执行当前文档语义校验，校验
失败保持作者源码、保留 pending 状态并显示持续通知。这样表格尾部列表、中间列表、重复
列表、连续空段和普通正文不再各自维护一套“成功”判断。

验证：`test:markdown-preservation`、`test:table-tail-list-source-ui`、
`test:forest-middle-list-source-ui`、`test:repeated-ordered-list-middle-ui`、
`test:middle-body-list-source-ui`、`test:source-fidelity-ui`、
`test:new-source-fidelity-ui`、`test:source-transaction-sync`。

### 根因 17：已消费 marker 意图跨越 IME 与后续 Enter

列表输入意图原本按“捕获后 3 秒”存活。用户在中间输入 `1. ` 后，先提交正文再按
Enter 创建下一项时，第一次列表事务已经成功写回 `2.`，但旧 `1.` 意图仍被后续
`markdownUpdated` 认领。它按全局列表行序号恢复 marker，遇到前方已有 marker/空项
差异时会把新空项改成 `1.`；结构指纹随后正确拒绝候选，所以用户看到的是提示，根因
却发生在更早的 marker 恢复阶段。

修复：输入意图成功消费后，生命周期缩短为同一 input-rule dispatch 的 750ms 回调尾部；
正文、IME composition 和后续 Enter 不再共享旧意图。这个限制不是关闭校验，而是缩小
所有权：候选仍必须通过语义比较和列表槽位指纹，失败继续 fail-closed。验证：
`test:middle-ordered-marker-only-ui`、`test:input-intent-staleness-ui`、
`test:repeated-ordered-list-middle-ui`。

### 未闭环 15：`/code` 子路径修复后，真实长会话仍可再次分叉

0.13.47 安装包手测否决了“根因 14 修复即可关闭问题”的结论。用户在真实长文档末尾
加入代码块、编辑代码、退出后继续写正文，再继续编辑和保存，仍能看到：

- 富文本里存在的新内容没有完整进入源码；
- 保存可能暂停，也可能执行成功但源码/磁盘仍不是富文本当前内容；
- 再切源码或重开后，以旧源码为准，未同步编辑丢失。

这说明 `/code` 的空 fence source slot 只是一个已确认子根因。后续某笔事务仍可能在
`lastMarkdownRef`、`canonicalMarkdownRef`、live `view.state.doc`、`tabsRef`、源码
textarea live value 和 durability boundary 之间失去同一所有权。当前尚未抓到第一次
分叉的 transaction，**不得把它编号为已确认根因，也不得继续用局部字符串启发式猜测**。

下一位接手者应按专项事故文档建立统一 transaction trace，并把真实安装包长会话写成
新的失败回归。恢复副本只证明数据可以救援，不证明作者源码保真。

## 事务级防护方法论

这类问题不能按“表格 bug / 列表 bug / 空段 bug”分别添加字符串例外。统一提交协议是：

1. 以完整 ProseMirror transaction batch 为边界，不能把一个结构事务拆成多个回调后部分提交。
2. 源码候选同时通过 parser 语义证明和 raw Markdown 结构指纹；后者检查列表项数量、空项槽位、类型、任务状态和有序编号。
3. 证明全部通过后，才原子推进作者源码与 canonical 双快照；失败保留 pending，不能清除失败基线。
4. 源码切换、保存和重开前再次读取 live ProseMirror 文档并复核；失败只通知并阻止静默提交。
5. 日志以 physical key → transaction steps → 首次候选 → 首次证明失败为证据链，修复以首笔分叉事务建立回归，不再围绕最终错误源码补丁。

本轮新增的 `source-structure-fingerprint.js` 就是这套协议的结构门禁，覆盖连续 Enter、重复列表、表格尾部列表和延迟回调共享的空列表槽位边界。

## 矩阵当前状态

> 状态分为两层：下面的脚本结果仍然成立；产品验收状态为 **P0 未通过**。任何发布或
> issue 回复都必须同时写明这两层，禁止再用“20/20 全过”推导“用户问题已解决”。

- **20/20 全过**（4 文件 × 5 操作 × 追加/保存/删除/重开），包括：
  - 123321.md（尾部现在是普通段落）：ordered / unordered / plain / spaces /
    list-spaces 全过——根因 7（段落后新建列表）+ 根因 8（实体）+ 根因 5（空行）
  - 引用后输入手测.md：5/5（含 list-spaces 的 `&#x20;` 段）
  - 11111.md：5/5
  - 反馈.md：5/5（原 unordered / list-spaces 拼行已修——根因 6）
- 矩阵测试输入已改为真实用户行为：追加前先 Enter 换行（Markdown 列表输入规则
  只认行首），marker 逐字符输入。
- **多轮持久化回归全过**：`npm run test:family-multicycle-ui` 的 release-default 与
  transaction-primary 均通过 4 次编辑、4 次保存、5 次冷打开；第四轮专门覆盖重开后
  在已有正文与代码块之间输入“正文 → 有序列表 → 正文”；另以真实
  `123321.md` 覆盖运行通过，测试始终只操作 `/tmp` 副本。
- **slash code 连续编辑回归全过**：`npm run test:tail-fence-ui` 在 40ms 菜单选择后，
  不切源码、不保存，连续改代码块、代码块后正文和前文列表；源码、磁盘、冷重开一致，
  未编辑前缀逐字节不变。另行验证 literal fence 与 input-rule fence 变体。
- **安装包人工验收失败**：0.13.47 正式路径安装后，真实长文档继续执行代码块及后续
  多轮编辑，源码与富文本仍不对应。该结论优先级高于上述绿色脚本，家族问题保持 open。

这两个场景都需要在可见流比较前识别“实体空格段”和“canonical 多出的空列表项”，
与根因 2 同族但边界更深；已记录为后续迭代项。

### 根因 13：残留有序列表输入意图改写 Enter 自动编号的新行（0.13.66）

**现象**：空文档（scratch 路径）中先输入 `1. ` 创建有序列表、输入正文后按 Enter
新建下一项，源码里的新项被写成 `1. ` 而不是 `2. `，列表槽位校验 fail-closed 弹出
“源码与富文本不一致”，保存被暂停。

**日志证据链**：`markerRestore` trace 显示残留的 `1.` intent 把 canonical 的
`2. <br />` 行改写为 `1. `——`changedOrderedCandidate` 只判断“标点不同”（`2.` ≠
`1.`），没有判断数字相同，于是 Enter 新建的自动编号行被误判为“Crepe 默认输出”
需要恢复；`nearbyOffsetTarget`（光标在新项内）也命中同一行。

**修复（事务级，非单场景补丁）**：有序 marker 恢复建立两条不变式：
1. 恢复目标行的数字必须与用户敲入的 marker 数字相同（`1.` 只能恢复 `1)` 这类
   同数字不同标点，绝不能改写 `2.`/`3.` 行）；
2. changed-line 兜底只有在意图自身位置可信（距离 ≤ 4）且与变更行一致时才被采纳，
   Enter 后光标已移到新行、意图仍属于旧项时不再用旧 marker 污染新行。

**回归**：`npm run test:ordered-enter-next-item-ui`（空文档逐字符：`# 测试` → `1. `
→ IME 正文 → Enter），断言源码第二项保持 `2. `、无 toast、切换源码一致；同时
`markdown-preservation`、family-multicycle、middle-ordered-marker-only、重复有序
列表、表格删行删列、源码保真与结构指纹全部通过。

### 根因 14：行首转义符号被“还原”成块级语法（0.13.67）

**现象**：中间段落按 Enter 两次退出列表后，输入单个 `-`（未按空格），源码候选
变成裸 `-`（空 bullet 项），与 canonical 的 `\-`（字面量）语义不同，
`source-document-mismatch` fail-closed 弹提示。同一会话中输入 `.` 时 canonical
为 `1\.` 却正常——因为 `1` 在 `\` 前（可见文本），还原安全。

**根因**：`canonicalFreshTextToSource` 的 `restoreFreshPunctuation` 把 canonical
里所有 `\X` 都还原成物理字符。行首 `\-` 还原成 `-` 后，Markdown 把它解析为空
bullet 项；`\#`、`\>`、`\*`、`\+`、行首 `\|` 同理。`1\.` 等有可见文本前缀的
还原没有风险。

**修复（语义保持，非补丁）**：`translateInlineCanonicalEscapes` 在还原 `\X`
前先判断：该转义是否位于行首无可见文本区，且还原后是否成为块级语法（`[-+*]`
后接空白/行尾、数字加 `.`/`)`、`#`/`>`/`|`、三连反引号/波浪线）。若是则保留
反斜杠；否则照常还原。既有行为（如 ``` ``` ``` 围栏转义整行还原、`\~` 还原）
全部保持。

**回归**：`canonicalFreshTextToSource('\\-') === '\\-'`、`1\. → 1.`、
`middle-empty-block-filled` 保留 `\-` 的纯函数断言；UI 测试在 `1. ` 列表里
Enter 两次退出后逐字符输入 `-`，断言源码为 `\-` 且无 toast；family-multicycle、
表格、列表、源码保真与结构指纹全部通过。

### 根因 15：裸列表 marker 行对列表机制不可见导致填文本错位（0.13.69）

**现象**：文档里存在类似 `-   1. 二哥你来拿如果` 的嵌套列表字面量时，用户在中间
创建 `1. ` 有序列表并输入法填充正文，同步器把文本写成了新的 `- 1. …` 独立
bullet 行，而不是填进 `1.` 有序项；结构指纹正确拒绝错误候选，fail-closed 弹出
“源码与富文本不一致”，用户被卡住。

**日志证据链**：`source-list-structure-mismatch`（16:15:54）。canonical 是
`1. 色粉嫩绿色负能量`（有序项带文本），candidate 却是 `- 1. 色粉嫩绿色负能量`
（独立 bullet 行）。追踪 three-way 输入复现：空列表项落库时被 `.trim()` 写成
裸 `1.`（无尾随空格），而 `sourceListItemRows`/`listMarker`/`comparableListLine`
都要求 marker 后必须有 `\s+`，裸 `1.` 对列表机制完全不可见——ordinal 对齐因此
把有序项映射到了错误的分歧 bullet 块，文本被写成新 bullet 行。

**修复（三处一致性，非单场景补丁）**：
1. 列表 marker 识别兼容无尾随空格的裸行（`1.`/`-`/`*` 行尾即行末），并让
   `sourceListItemRows`/`comparableListLine`/`nestedMarkerPrefixLength` 同步；
2. 空列表项写入源码时保留尾随空格（`1. `），不再 `.trim()` 成裸 marker；
3. 分歧列表处理器填充裸行时补一个空格（避免 `1.色粉` 被解析成普通段落）。

**回归**：`test:bare-marker-fill-ui`（真实分歧文档逐字符：`啊额绿化` 段末
Enter → `1. ` → IME 填充，断言源码 `1. 色粉嫩绿色负能量`、分歧行原样保留、
无 toast）；纯函数断言覆盖“裸 `1.` 行填文本”防御路径；ordered-enter-next-item、
middle-body、forest-middle、family-multicycle、表格删行删列、源码保真与结构
指纹全部通过。

### 根因 16：中间块插入分支抢走“空列表项填充”导致 IME 文本写成独立段落（0.13.70）

**现象**：在分歧文档（含 `-   1. 二哥...` 嵌套字面量）中，`啊额绿化` 段末
Enter → `- ` + 空格（bullet 输入规则，源码写入空 `- ` 行）→ 输入法提交正文，
源码候选把正文写成 `- ` 行之前的独立段落（`text\n\n- `），而 canonical 是
`* 了海伦凯勒看`（文本在列表项内）；列表结构指纹 `source-list-structure-mismatch`
fail-closed 弹提示，保存被暂停。

**日志证据链**：`markdown-sync` 事件 145（IME compositionend 后），reason
`middle-block-inserted`。同一 three-way 输入下 `preserveMiddleEmptyBlock` 输出
`text\n\n- `（错误），而 `preserveEmptyListItemTextChange` 输出 `- text`（正确）
——调度顺序决定了结果：`preserveMiddleEmptyBlock` 在 `preserveEmptyListItemTextChange`
之前执行，前者的 `middle-block-inserted` 分支看到源码槽位里的 `- `（视为已创作
语法）就抢占把文本作为新段落插入，后者永远轮不到。

**修复（归属优先，非补丁）**：`preserveMiddleEmptyBlock` 的中间块插入分支新增
归属守卫——当源码槽位包含空列表行（`- ` / `1. ` 行尾无内容）且 canonical
变更在填充列表行（`* 文本` / `1. 文本`）时，不返回 `middle-block-inserted`，
把该事务留给 `preserveEmptyListItemTextChange`（`empty-list-item-filled`）。
既有 fence 前置插入、列表后插入普通块等场景的判定不受影响（它们没有
“源码槽位空列表行 + canonical 填充列表行”的组合）。

**回归**：`test:empty-bullet-fill-ui`（真实分歧 fixture 逐字符：`啊额绿化` 段末
Enter → `- ` → 空格 → IME 提交 `了海伦凯勒看`，断言源码 `- 了海伦凯勒看`、
文本绝不成为独立段落、分歧行原样保留、无 toast）；纯函数用真实日志
three-way 输入验证 reason 变为 `empty-list-item-filled`；bare-marker-fill、
ordered-enter-next-item、middle-body、forest-middle、family-multicycle、表格
删行删列、源码保真与结构指纹全部通过。

### 根因 17：列表槽位指纹把独立 `<br />` 空段占位当作硬分组边界（0.13.71）

**现象**：在已有文档中给有序列表填正文、Enter 新建下一项、再在空项里按 Enter
退出列表，且列表下方已有另一个列表时，弹“源码与富文本不一致”、保存被暂停。

**日志证据链**：`source-list-structure-mismatch`（17:21:24，无序列表测试.md）。
canonical 是 `1. 输入…\n2. 的人多…\n\n<br />\n\n* 看了呢分`（退出列表后在两个
列表之间留下独立的 `<br />` 空段占位），candidate 是 `…\n\n- 看了呢分`（正确
丢弃了占位、只留普通空行）。保留层本身输出正确（`empty-list-item-removed`），
失败发生在校验层：列表槽位指纹把 canonical 里的独立 `<br />` 行当作“非空普通行”
→ 硬分组边界（canonical 分成两组），而 candidate 里的空行不打破分组（合并成一组），
两边分组数量/槽位错位，指纹 fail-closed。语义校验不受影响（Milkdown 的
`remark-preserve-empty-line` 插件在解析时已经把独立 `<br />` 移除），日志确认
`semanticOk: true`、只有 `listSlotsMatch: false`。

**修复（一致性收敛，非补丁）**：`source-structure-fingerprint.js` 把独立
`<br />`（含 `> <br />` 引用前缀，与 `withoutStandaloneEmptyBlockLines` 同一
识别口径）当作空行跳过——不建分组边界、不产生槽位。它与“独立 `<br />` 是内部
空段占位、绝不进入原始源码”的不变量对齐：占位在指纹层等价于它代表的那一行空行。

**回归**：`test:ordered-exit-before-list-ui`（新回归：fixture 有序列表 → 空项
Enter 退出 → 下方已有无序列表，断言源码 `1. …\n2. …\n\n- 看了呢分`、无 `3.` 残留、
无 `<br />` 泄漏、无 toast；反证：还原守卫后该测试复现 `listSlotsMatch: false`
+ 持久通知）；纯函数断言覆盖“退出空项删除 item 与 `<br />` 占位不改列表分组”；
ordered-enter-next-item、empty-bullet-fill、bare-marker-fill、middle-body、
forest-middle、空段保真、表格尾部/删行/删列、源码保真与结构指纹全部通过。

### 根因 18：行尾字面空格被当成硬换行语法，继续输入文字插到空格前（0.13.72）

**现象**：在段落末尾打若干空格（字面空格），停顿让空格先落库到源码后继续输入
文字，同步器把新文字插到了空格之前：源码变成 `将皮机配件了；你       `，而
富文本是 `将皮机配件       了；你`（空格在中间）。语义校验 `source-document-mismatch`
fail-closed 弹“源码与富文本不一致”，保存被暂停。

**日志证据链**：`source-document-mismatch`（12:22:18，无序列表测试.md）。
source/candidate 是 `将皮机配件了；你       `，canonical 是 `将皮机配件       了；你`。
`markdown-sync` 显示两步：先 `structural-line-change` 把 7 个空格落到源码
（`将皮机配件       `），再 `localized-change` 把 `了；你` 插到空格之前。分叉点
是 `rawInsertionAtCanonicalLineEnd`：它无条件 `sourceLine.end - trailingWhitespace.length`，
把“字面空格”当成了“作者硬换行语法”（该分支本意是：源文件里 `  ` 硬换行空格不在
canonical 里，输入应插在它们之前）。

**修复（按 canonical 是否保留空格区分，非补丁）**：`rawInsertionAtCanonicalLineEnd`
新增判别——当 canonical 那一行自身以空白结尾（说明这些空格是序列化器保留的字面
文字、光标在空格之后）时插到 `sourceLine.end`（空格之后）；仅当 canonical 已丢弃
源文件的硬换行空格时，才保持原有“插在硬换行空格之前”的行为。**回归**：`test:trailing-spaces-fill-ui`（新回归：行尾 7 个空格 → 停顿 900ms 让
空格先落库 → IME 输入 `了；你`，断言源码 `将皮机配件       了；你`、无 toast；
反证：还原分支后该测试复现 `将皮机配件了；你       ` + 持久通知）；纯函数断言
覆盖“字面行尾空格后继续输入”与既有“硬换行空格前插入”两个方向；
ordered-exit-before-list、ordered-enter-next-item、empty-bullet-fill、
bare-marker-fill、middle-body、forest-middle、空段保真、表格尾部/删行/删列、
源码保真与结构指纹全部通过。

### 根因 19：退出无序列表时空项删除范围吞掉后续兄弟项（0.13.73）

**现象**：在无序列表中输入内容后按 Enter 创建空项，再按一次 Enter 退出列表，富文本
显示正常，但源码会少掉空项后面的下一条列表项（例如 `- 露娜了`），随后可能弹出
“源码与富文本不一致”。日志中该事务先出现 `middle-empty-block-created`，第二次
Enter 出现 `empty-list-item-removed`；问题发生在后者的列表块对齐，而不是保存写盘。

**根因**：canonical 在退出列表时会把空项序列化为 `* <br />`，并把后续兄弟列表以另一
个 marker 发布。旧的 `listBlockAt` 把空项前后两个列表错误合成一个 previousList，
`formatCanonicalListLikeSource` 按行数对齐时把“空 marker + 后续兄弟项”一起裁掉；同时
空项判断只接受完全裸的 `*`，没有处理 change span 泄漏的后续 marker。

**修复（局部结构所有权）**：`preserveEmptiedParagraph` 现在只在存在独立 `<br />` 空段
占位且前一行确实是列表 marker 时接管退出事务；对空 marker 与 canonical marker 做
列表类型归一化，并按 canonical/source 的实际边界收敛前缀和尾部多余空行。这样只删除
退出的那一行，不重建整棵列表，也不动后续兄弟项的内容、marker 或分隔。

**回归**：`test:bullet-exit-keeps-sibling-ui` 通过两次间隔 300ms 的 Enter 复现真实事务
顺序，并断言源码保留后续兄弟项、无 toast；还覆盖列表尾部退出和纯函数 three-way 输入。
ordered-exit-before-list、empty-bullet-fill、bare-marker-fill、middle-body、forest-middle、
repeated-ordered-list-middle、trailing-spaces-fill、表格尾部/删行/删列及结构指纹全部通过。

### 根因 20：列表前导空格 sentinel 在后续普通空格输入后未收敛（0.13.74）

**现象**：在有序列表中按回车创建新的空项，先输入一个空格，再用输入法输入正文，最后继续输入空格，富文本显示正常，但源码保留了 `U+200B + 空格`，而 canonical 已变成 marker 后的普通双空格，触发 `source-document-mismatch`。

**日志证据链**：13:59:52.795 点击第二项 → 13:59:53.374 Enter 创建第三项 → 13:59:53.938 输入首个空格 → 输入法提交“色粉色分”和“看了你快乐” → 13:59:56.737 再输入空格；13:59:56.983 首次分叉。canonical 为 `3.  色粉色分看了你快乐 `，candidate 为 `3. \\u200B 色粉色分看了你快乐 `。

**根因**：第一个行首字面空格需要通过 `&#x20;` 序列化，并在源码中暂存为 U+200B sentinel；当后续空格使 Markdown 在列表 marker 后可以直接表示普通双空格时，canonical 不再包含 `&#x20;`。原有局部可见偏移映射从 sentinel 后开始，只追加了新空格，没有重新处理 sentinel，导致旧占位符永久残留。

**修复（按序列化状态转换收敛）**：新增严格的单行转换证明：previous 行必须含 `&#x20;`、next 行必须不含 `&#x20;`，source/result 必须唯一包含对应 sentinel 行，且移除 sentinel 后的可见文本必须精确等于 next 行。证明成立才移除一个 sentinel；无法唯一证明时保持 fail-closed，不做全局替换。

**回归**：`test:leading-space-list-transition-ui` 以真实逐字 Enter → 空格 → 输入法正文 → 再空格复现并断言源码为普通双空格、无 U+200B、无 toast；纯函数还覆盖完整 three-way 输入。ordered-enter-next-item、bare-marker-fill、empty-bullet-fill、bullet-exit-keeps-sibling、trailing-spaces-fill 及源码保真回归全部通过。

### 根因 21：退出空有序项时，后续有序列表的标点翻转吞掉了整段列表（0.13.76）

**现象**：在有序列表里给一项填正文、Enter 新建空项、再在空项里 Enter 退出；下方紧跟一个作者用 `1)` 书写的有序列表时，Crepe 在同一事务里把它重新序列化成 `1.`，源码里的后续列表整段消失，触发 `source-list-structure-mismatch`。

**日志证据链**：16:46:59.873 点击 `1. 三个人过` → 16:47:01.564 Enter 新建 `2.` 空项（`middle-empty-block-list-filled`）→ 16:47:02.102 再次 Enter 退出；16:47:02.353 `source-list-structure-mismatch`。canonical 由 `1) 斯卡洛尼快乐 / 2) 是干嘛的了；吗` 翻转为 `1. / 2.`，候选却只剩 `1. 三个人过`，把后续 `1) 斯卡洛尼快乐 / 2) 是干嘛的了；吗` 整段删除。

**根因**：`commonChange` 把“删空项”和“后续列表标点变化”并进同一变更区间。于是 `preserveEmptiedParagraph` 的空项删除分支被 `nextChangedText` 含真实文字而拒绝，`preserveEmptyListItemTextChange` 把合并后的整块列表用只剩 `1. 三个人过` 的 next 块替换，删掉后续列表。深层原因是把有序列表标点（`1.` vs `1)`）当成了内容差异参与 diff，而它其实是序列化器会翻转的实现细节（作者标点以源码为准，和 bullet marker 统一成 `*` 是同一类）。

**修复（归一化序列化器伪差异，非场景补丁）**：在 diff 前把行首有序 marker 的标点归一化为 `.`（`normalizeOrderedListDelimiters`）。只命中行首 `\d+[.)]` + 空白，不碰列表项内的字面 `1.`/`1)`；`. ↔ )` 等长，偏移不变。归一化后变更区间只剩 `2. ` → `<br />`，`empty-list-item-removed` 分支正常删空项并保留后续列表及其作者 `1)` 标点。

**回归**：`test:ordered-exit-delimiter-ui` 以真实逐字“填正文 → 两次分开的 Enter → 源码切换”复现并断言 `1) 斯卡洛尼快乐 / 2) 是干嘛的了；吗` 字节级保留、无 toast；纯函数断言 `ordered-exit-delimiter` 覆盖 same 场景。反证：还原标点归一化后该测试复现“源码切换被阻止 / 后续列表被删”。ordered-exit-before-list、bullet-exit-keeps-sibling、middle-ordered-marker-only、list-conversion-source-fidelity、repeated-ordered-list-middle 及源码保真、结构指纹回归全部通过。
