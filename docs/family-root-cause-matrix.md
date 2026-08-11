# 家族根因矩阵（2026-08-10）

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

## 矩阵当前状态

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

这两个场景都需要在可见流比较前识别“实体空格段”和“canonical 多出的空列表项”，
与根因 2 同族但边界更深；已记录为后续迭代项。
