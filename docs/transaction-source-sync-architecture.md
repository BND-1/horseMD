# 事务优先源码同步架构（方案一）

> 状态：2026-08-27，HorseMD `0.13.133`。当前仍是**混合架构迁移状态**，但生产事务生命周期已经收敛：普通用户编辑先进入一个绑定 `SourceSyncCoordinator` revision、source、canonical 与 oldDoc 的 `SourceSyncTransactionJournal`；structural owner registry 中的列表子树 owner 与已有代码块正文 owner，以及普通段落 owner，共享同一份不可变 journal。可证明的单一顶层列表子树变化和已有 fenced code block 纯正文变化可直接 transaction-owned 发布；普通段落默认仍走 legacy，显式 shadow/authority 门禁从共享 journal 规划候选。代码块 info string/围栏结构、表格结构、引用结构、输入规则及其他未迁移 family 继续使用既有 fail-closed owner。
>
> `Editor.jsx` 已删除生产路径上的 `transactionFirstShadowPending`、逐回调 SourceRangeMap checkpoint 和私有 chain rebase。旧 `lib/transaction-first-source-sync.js` 暂时仅保留给历史策略/兼容纯测试，不再拥有生产生命周期。当前不能描述为“全部迁移完成”：完成的是 revision-bound journal、逐 Step 文档/StepMap 证据、focused family owner 与 Coordinator 原子发布；未完成的是把其余结构 family 逐个迁入同一 journal → bounded source patch 管线并删除对应 legacy 分支。
>
> `markdownUpdated` 与 forced flush 现在都先遍历共享 structural owner registry，再由严格 semantic/list-slot integrity gate 和 `SourceSyncCoordinator` 发布。journal 只在成功提交或证明 revision/source/doc 已陈旧时清空，不允许某个 family 私下重启基线。inline-code、frontmatter、Slash code/math、列表转换、paste/whole-document 等已登记入口继续共用 Coordinator snapshot/candidate/proof/validation 合同；generated scratch 与尚未迁移的结构仍保持 legacy fallback。代码块正文 family 的完整合同与 BOM 根因见 [`transaction-journal-code-block-content-family.md`](./transaction-journal-code-block-content-family.md)，Coordinator 合同见 [`source-sync-coordinator-phase-a.md`](./source-sync-coordinator-phase-a.md)。

## 1. 目标与不变量

HorseMD 保留 Milkdown/ProseMirror 的现有富文本能力，但逐步把写回模型从：

```text
ProseMirror 文档 → 整篇 Markdown serializer → canonical/source 猜测对账
```

迁移为：

```text
用户 ProseMirror transaction → 有边界的 raw source patch → 作者源码
```

必须同时满足：

1. 用户原始 Markdown 是保存、源码模式和导出的事实源；
2. 未触及字节绝不重排、转义、换 marker 或补空行；
3. 一个 transaction batch 全部成功才提交，任一步不确定则整批回滚；
4. 不支持的结构继续走现有 fail-closed 保真层，不能半接管；
5. 迁移期间保存失败仍保留原文件，并允许另存 recovery copy；
6. 富文本、源码、磁盘和冷重开必须逐字符一致。

## 2. 已落地模块

### `components/editor-source-transactions.js`

- 通过 `prosePluginsCtx` 注册只观察、不修改 ProseMirror 的插件；
- 在其他插件完成 `appendTransaction` 后取得完整 transaction batch；
- 测试可显式启用 `window.__hmSourceTransactionTrace = []`，记录真实 step、old/new doc；
- 生产环境不初始化数组，不记录用户文档内容。

### `lib/source-sync/transaction-journal.js`

- 每个正常用户 dispatch batch 绑定一个不可变 `baseRevision`、source/canonical digest、oldDoc 与最终 expectedDoc；
- 保存完整 transaction batch、逐 Step `stepDoc`、StepMap 和受限 step metadata，后续 family owner 可重建真实事务链而无需从 delayed canonical 反推操作；
- 后续 batch 只有在 revision、source、canonical 与 `expectedDoc → oldDoc` 连续时才可追加；任何 gap、外部发布、容量超限或 stale snapshot 都整本 journal fail closed；
- journal 自身不生成 Markdown，也不决定 family；它只提供统一生命周期和可审计证据。

### `lib/source-sync/plain-paragraph-transaction-owner.js`

- 只认领顶层、无 mark/atom、非空普通段落内的 closed plain-text `ReplaceStep`；
- 对 journal 中每个 Step 使用对应 stepDoc 重新应用并验证完整 oldDoc → finalDoc 链；
- 语法敏感插入、开放 slice、段落 split、列表内编辑、空段结果和陈旧 revision 均拒绝；
- callback 与 forced flush 均通过相同 owner + Coordinator 发布，不再维护独立 shadow checkpoint。

### `lib/source-sync/list-subtree-transaction-owner.js`

- 消费同一 journal，只在 oldDoc → finalDoc 恰有一个顶层列表子树变化且邻块完全不变时认领；
- transaction journal 负责生命周期与 StepMap 证据，owner 只负责拓扑分类、精确 source/canonical 范围和 bounded list mapper；
- callback 与立即切源码 forced flush 使用同一 ownership proof、Coordinator revision guard、保存与冷重开合同。

### `lib/source-sync/code-block-transaction-owner.js`

- 消费同一 journal，只认领已有顶层 `code_block` 内、attrs 不变的 closed plain-text `ReplaceStep` 链；
- 每个 Step 都在其捕获时 stepDoc 上验证同父节点、目标顶层序号、邻块不变和完整 oldDoc → finalDoc 连续性；
- 分别解析作者 source、previous canonical 和 next canonical 的 fenced range，只替换作者围栏内部正文；BOM、CRLF、围栏字符/长度、info string 和邻块保持 byte-stable；
- `editor-source-map.js` 统一把 remark 去除的 BOM offset 恢复为物理 raw 坐标，空代码块不再落到 opening fence 前的换行；
- callback 与立即 forced flush 均通过 structural registry + Coordinator 发布；attrs/fence 变化、跨块编辑和围栏冲突继续 fail closed。完整合同见 [`transaction-journal-code-block-content-family.md`](./transaction-journal-code-block-content-family.md)。

### `lib/source-transaction-sync.js`

- 当前接收纯文本 `ReplaceStep` 和受限的尾段 paragraph/heading split；
- 同一 batch 使用局部副本计算，最终 doc 不一致或任一步失败时返回原源码；
- 同块文字修改必须同时证明：
  - PM from/to 位于同一个无 mark、无 atom 的 textblock；
  - raw range 与 PM 被删除文字逐字符相等；
  - 整个 textblock 的 raw span 与 PM 文字逐字符相等；
- 反引号、内联语法、开放 slice、跨块删除、列表结构等均拒绝猜测；
- **字节归一化视图**：入口把 BOM 剥离、全部行尾归一化为单个 `\n`，remark/PM 的坐标只在归一化视图上精确；编辑同步应用到原始副本，出口返回作者原始 BOM/CRLF/lone-CR 拼写。这修复了 remark 剥 BOM 导致全部偏移差 1、以及旧回退把新文字插进 `\r\n` 中间产生 `\r文字\n` 的家族根因；
- **前导空格哨兵**由事务层直接维护（`U+200B + 字面空格`），不再回退到 serializer 的 `&#x20;` 拼写；
- Enter 新尾段使用临时 block hint 记录“新 PM 块 → raw 空槽”；槽坐标指向**完整段落分隔（两对换行）之后**，即使源里已存在部分换行（separator 较短）也不漂移；
- 顶层空段只有带 hint 时才可接管；**嵌套空 textblock（列表项/引用内）一律拒绝**，其容器 marker 在槽之前，写字符会落到 marker 前面，必须交给列表/引用 preservation；
- 一个 textblock 被整个删空（`textblock-emptied`）也拒绝接管：常见后继是反引号围栏或 Enter 退出列表这类结构事务，混合两套基线会污染空块；
- LF、CRLF、lone-CR 分别处理（各自保持原行尾）；mixed EOL 的结构拆分拒绝接管，普通纯文本编辑（不引入换行）允许。

### `components/editor-source-transactions.js`（dispatch 边界）

- 从 `appendTransaction` 观察改为包装 `dispatchTransaction`：一次 `state.applyTransaction()` 返回**完整 root + 递归 append 链**，整批一次交给 mapper；
- batch 前缀不可能在 append 事务之后先提交，违反整批原子性的结构问题被消除；
- 测试 trace 保留完整事务链。

### 列表输入意图与跨块编辑

- 列表输入规则（`- `、`1. `）的意图捕获 mapper 建立的空槽（`sourceSlotRawStart`）；
- 意图回调延迟期间，其他块的编辑可能已被 mapper 接管；意图重建**只在当前源快照（`insertionSource`）上插入/替换自己的列表块**，绝不用捕获时的旧快照整体覆盖——否则会静默丢掉其他块的编辑；
- 槽字节验证：插入前比较捕获时与当前的槽周边字节，漂移则拒绝；
- 槽后已存在 canonical 列表（旧保真层先写入了 `* item`）时，把槽、该列表块与多余空行整体替换为作者 marker 的紧凑块；
- 列表意图未落定时，`canonical === canonicalMarkdownRef` 的快确认分支与 pending-publish 分支都让路，确保意图先完成 marker/空行修复。
- 完整 slot 重建或 marker 恢复任一成功后，意图立即从单值和队列同时消费。旧实现只在完整重建时消费，导致列表正文下一回调再次使用旧 slot，把正确空行边界覆盖掉。
- EOF slot 只属于 `depth === 1` 的顶层末尾 paragraph placeholder。最终顶层列表内部的嵌套/中间 item 即使后面没有其他顶层块，也不能把文档 EOF 当作自己的 raw slot；缺少精确 block hint 时继续 fail closed。

### `Editor.jsx` 迁移控制器

- `markdownUpdated`、强制 flush、保存和源码切换仍保留原有安全网；
- 所有普通用户 transaction batch 先进入唯一的 `pendingSourceSyncTransactionJournal`；list/code/plain focused owner 不得保留自己的生命周期 token，也不得在其他 publication 后静默 rebase；
- structural registry 依次让 list subtree 与 existing code-block content owner 处理可证明 family；普通段落 shadow/authority 再从同一 journal 规划。authority 成功时在 legacy diff 前发布，shadow 只比较 transaction 与 legacy candidate；
- `globalThis.__hmTransactionFirstAuthority = true` 仅放行已验收的普通段落 family；默认发布仍由 legacy 处理该 family。历史 broad `__hmTransactionSourcePrimary` 仅供专项测试/迁移实验；
- callback 与 forced flush 共用 journal、ownership proof 和 Coordinator revision guard，成功时原子推进 source/canonical/checkpoint，失败时保持 authored baseline；
- 不支持的结构继续走既有 legacy owner。只有 stale revision/source/doc 或成功 publication 会清空 journal，family rejection 本身不能销毁其它 owner 仍可能消费的证据；
- 通用 normalized→raw mapper 已按“边界”而非“字符”维护插入后的坐标，支持同一本 journal 中先插入、后在另一段替换而不吞掉终止换行。

### 斜杠菜单结构命令的原子边界

- `/code` 的用户意图由“删除临时 query”和“paragraph → code_block”两条命令共同表达，不能作为两个互不相关的 canonical diff 提交；
- `editor-slash-source.js` 在命令前捕获精确 authored 行，命令后只序列化当前 code block，验证完整 fence 后一次替换并推进双基线；
- 该处理器只覆盖已验收的代码类 slash 命令，不代表 transaction-primary 已放行任意代码块编辑；代码内容后续仍走现有保真链；
- 重复 query 无精确 PM 映射、目标不是完整 fence 或行槽无法证明时继续 fail closed。完整事故记录见 `slash-code-source-sync-regression.md`。
- **验收边界更正**：上述处理器只证明 `/code` 创建瞬间的 authored slot。0.13.47
  正式安装包在同一真实文档继续编辑代码、后文和其他结构后仍会再次分叉。接手者必须
  同时跟踪 live doc、authored、canonical、tab mirror、textarea live value 和 disk，
  找出首次失去共同所有权的 transaction；不得将 RS-40 的专项绿色结果扩张为架构完成。

## 3. 为什么没有立即全量打开

第一次尝试默认接管后，完整 `test:paragraph-source-ui` 捕获到一个真实回归：

1. 用户在已有块之前连续创建多个空段落；
2. 结构性 Enter 不属于首批 plain-text 范围；
3. 下一字符到来时，空 PM 块没有可见锚点，旧 offset mapper 把字符映射到前一段或相邻块；
4. 最终多个段落被合并。

该失败证明“单个简单 demo 通过”不能作为生产放行证据。当前实现因此恢复为**发布构建默认关闭、开发可影子、测试显式接管**：保留事务基础设施和可重放证据，但不会让未完成的 mapper 写用户文件或增加发布版逐键开销。

## 4. 当前已证明范围

`npm run test:source-transaction-sync`：

- 普通段落插入；
- 顶层尾段 Enter / 中间 split；
- split 后首字通过 block hint 定位；
- CRLF Enter 不混入 LF；
- BOM+CRLF 文档普通插入与 Enter 拆分后 BOM/CRLF 逐字节保留；
- lone-CR 文档 Enter 保持 `\r` 行尾；mixed EOL 结构拆分原子拒绝、普通编辑允许；
- hint 在“前段补字后空槽输入”双坐标同步不漂移；
- 前导空格哨兵的写入与移除；
- 列表项文字删光只留下作者 `- `，不产生 `*` 或 `<br />`；整个 textblock 删空拒绝接管；
- 跨块、反引号等结构/语法敏感事务原子拒绝。

`npm run test:source-transaction-sync-ui`：

- 后台真实 Electron；
- 每个字通过 `human-input.mjs` 逐字输入；
- 正文、引用、`-` 列表项的增加/删除；
- LF、CRLF、BOM+CRLF 三种磁盘拼写 + undo/redo 立即切源码、保存、冷重开逐字节断言；
- 测试显式打开 transaction primary；
- 断言新路径被使用且 canonical preservation 调用次数为 0；
- 立即切源码、保存、退出、全新 profile 冷重开逐字符一致。

`npm run test:list-intent-cross-block-ui`（primary 专项，非 primary 构建自动 SKIP）：

- 段落 Enter → 快速 `- item` → 列表回调未落定时立即编辑另一个块；
- 延迟列表意图不得覆盖跨块编辑（丢字回归），marker 保持 `-`，空行不重复，保存与冷重开逐字节一致。

`npm run test:family-multicycle-ui`：

- 默认使用脚本内生成的 BOM + mixed-EOL + 重复文本 + 分叉列表 fixture，不依赖个人文件；
- 连续 4 轮编辑/保存和 5 次全新 profile 打开，覆盖已有列表文字修改/删除、续项、退出、手打 sibling list、fence、再次续写和后续正文；第四轮在正文与后续 fence 之间从空段创建有序列表并再次退出，专门验证 middle-slot 原子映射；
- 默认发布路径与显式 transaction-primary 各跑一遍；每轮严格比较源码、磁盘字节和富文本列表/代码块结构；
- 可用 `FILE=/absolute/file.md node scripts/test-family-multicycle-ui.mjs` 对真实文件做同序列验证，原文件只读，操作发生在 `/tmp` 副本。

## 5. 放行顺序

1. 普通已有 textblock：插入、删除、选区替换、undo/redo；
2. Enter、Backspace/Delete 合段、连续空段和新文档 bootstrap；
3. 列表/引用结构：输入规则、续项、退出、缩进、类型转换、任务项；
4. 行内 mark/atom：粗斜体、链接、行内代码、公式、图片；
5. 代码块、表格、Mermaid、LaTeX、HTML、frontmatter、Review；
6. 大文档性能与移动端 IME。

每一类必须同时通过：纯事务测试、真实逐字 UI、立即源码切换、立即保存、磁盘字节、冷重开、家族完整回归。未完成分类继续走旧路径，不能因相邻分类通过而顺带放行。

## 6. 回归命令

```bash
npm run test:source-transaction-sync
npm run test:source-transaction-sync-ui
npm run test:list-intent-cross-block-ui
npm run test:family-multicycle-ui
npm run test:paragraph-source-ui
npm run test:empty-paragraph-source-ui
npm run test:leading-space-entity-ui
npm run test:list-item-literal-marker-source-ui
npm run test:literal-triple-backtick-source-ui
npm run test:code-fence-delete-source-ui
npm run test:mixed-rich-source-transaction-ui
npm run test:diverged-ordinary-save-ui
npm run test:mode-switch-raw-offset-ui
npm run test:mode-switch-caret-settle-ui
npm run test:list-conversion-ui
npm run test:task-list-persistence-ui
npm run test:rich-source-continuous-fidelity-ui
npm run test:rich-source-chaos-ui
npm run test:new-document-list-source-ui
npm run test:nested-number-list-source-ui
npm run test:diverged-list-structure-ui
npm run test:diverged-delete-source-ui
npm run test:diverged-partial-delete-ui
npm run test:full-doc-delete-source-ui
npm run test:empty-blockquote-removal-ui
npm run test:ime-source-fidelity-ui
npm run test:source-fidelity-probes
```

以上矩阵在 `VITE_HM_TRANSACTION_PRIMARY=1 npm run build` 的实验构建上全绿；同一组回归在默认发布构建上也全绿（primary 专项测试自动 SKIP），证明 regions/list preservation 的修复不破坏旧路径。

## 7. 本轮同时修复的旧路径家族 bug

1. **源末尾空行 + 新块粘行**（`preserveChangedLineRegion`）：零宽变化落在 previous 末尾空行/行边界时，可见字符映射把源区域拉进上一行，新列表/引用/标题行被粘到上一行尾（`正文* `）。修复：零宽且位于行边界的变化，源区域就是该空行本身。`已有正文\n\n` + 列表创建现在输出 `已有正文\n\n* \n\n` 而不是 `已有正文* \n\n`。该修复不依赖 primary，默认构建同样生效。
2. **BOM/CRLF 文档普通编辑损坏**：旧回退在 CRLF 上把新文字插进 `\r\n` 中间（`正文\r追加\n`），后续进入“保存已暂停”。primary 归一化视图接管后此类文档不再落到该回退。

## 8. 仍未放行的分类（默认关闭）

- 行内 mark/atom（粗斜体、链接、行内代码、公式、图片）；
- 代码块、表格、Mermaid、LaTeX、HTML、frontmatter、Review；
- 列表/引用结构的输入规则与退出、缩进、类型转换（仍走专门 preservation，仅空槽协调已打通）；
- 大文档逐键性能：当前成功事务仍同步执行两次全文 parse 与一次全文 serializer，未做增量索引；默认开启前必须补 100K–400K 文档的逐键延迟门禁。

## 9. 禁止回退的修法

- 不得让 serializer 结果直接覆盖作者源码；
- 不得把空 PM paragraph 序列化为独立 `<br />`；
- 不得用全文字符串查找解决重复文本或空块定位；
- 不得在 transaction batch 失败后保留前半段 source patch；
- 不得为追求“测试绿”而关闭 fail-closed 或 recovery；
- 不得在缺少全家族回归时默认打开新的接管分类。
