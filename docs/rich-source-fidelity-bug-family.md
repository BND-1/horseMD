# 富文本 ↔ 源码保真 Bug 家族总账

> 状态：持续维护（Living Document）
>
> 当前工作树：HorseMD `0.13.131`；legacy 四文件×五操作 family matrix 的正式基线为 **20/20**。0.13.125～0.13.130 的 RS-80～85 专项仍通过；0.13.131 的 RS-86 修复长期 mixed-marker bullet 树中“中间项末尾快速连续按两次 Enter，空项在发布前直接提升为顶层空段”时，后继列表 marker `-`→`*` 漂移扩大 change span，导致 generic empty-row owner 误删非空后继项的问题。新 raw owner 只在插入一个顶层 `<br />`、中间项逐字不变、后继项仅 bullet token 改写、source 目标唯一且不在 fence 时保持作者源码不变；source probes 已增至 **39/39**。当前架构仍是混合迁移：transaction-first authority 只对受限的 `plain-paragraph-inline-replace` 开放，syntax/split/list/code/table/generated/special 事务仍回退其明确 owner。RS-79 的 first-divergence 顺序修复和 1000 段 BOM+CRLF authority-on 自动化仍有效；clean-baseline branch checkpoint 与人工真实长文档 qualification 仍未完成，因此不能宣称架构迁移完成或长会话 P0 已关闭。RS-80～86 见下方记录，当前边界见 `transaction-source-sync-architecture.md` 与 `source-sync-coordinator-phase-a.md`。
>
> 适用范围：富文本编辑、源码模式、模式切换、保存/重开、列表、空段落、光标映射和 Markdown 原文保真。

## 1. 这份总账解决什么问题

HorseMD 同时维护两种表示：

1. 用户磁盘中的原始 Markdown；
2. Milkdown/Crepe 解析后的 ProseMirror 文档，以及它重新序列化出的 canonical Markdown。

两者语义可能相同，但字符写法不一定相同。Crepe 可能把 `-` 写成 `*`、把普通字符转义、补齐空行，或用 `<br />` 表示内部空段落。如果 HorseMD 直接用 canonical Markdown 覆盖作者源码，就会出现用户反复反馈的同一家族问题：

- 没改的源码被格式化；
- 富文本里删除的内容切到源码后仍然存在；
- 保存重开后，被删除的内容“复活”；
- `-`、`+` 被改成 `*`；
- 空段落、空列表项泄漏 `<br />`；
- 多个前导空格变成 `&#x20;`；
- 模式切换时光标跳行或卡住；
- 快速输入、删除、再输入后，源码与屏幕内容不一致。

本文件是这个问题家族的**总索引和验收合同**。专项根因报告仍保留，后续遇到同类问题必须先在这里增加条目，再补专项文档和自动化回归。

## 2. 架构事实：四份状态不能混为一谈

当前链路至少存在四份状态：

| 状态 | 作用 | 关键要求 |
| --- | --- | --- |
| 作者源码 `lastMarkdownRef` | App、源码 textarea、保存文件的权威内容 | 未编辑区域必须逐字符保留 |
| 上一次 canonical `canonicalMarkdownRef` | 判断 ProseMirror 事务改变了什么 | 只能作为 diff 基线，不能直接覆盖作者源码 |
| 当前 ProseMirror `view.state.doc` | 富文本界面当前真实内容 | 保存、切源码等强制边界必须实时序列化 |
| 源码 textarea 实时值 | 源码模式尚未提交到 React 的输入 | 保持 uncontrolled，切换/保存前必须 `commitLive` |

富文本事务的正确流程是：

1. 序列化当前 `view.state.doc` 得到新 canonical；
2. 比较旧 canonical 与新 canonical，只定位真实变更；
3. 把这个有边界的变更映射回作者源码；
4. 映射成功才同时推进作者源码和 canonical 基线；
5. 映射不安全时 fail closed，不能假装同步成功、清除 pending 状态或写盘旧内容。

## 3. 不可破坏的产品合同

1. **未触及的原文逐字符不变**：空行、CRLF、BOM、列表符号、缩进、必要转义和尾换行都属于作者内容。
2. **富文本屏幕内容、源码模式内容、磁盘内容必须一致**：尤其是删除、列表结构变化和立即保存。
3. **只读切换不得改文件**：打开后只切换模式，源码必须保持原样。
4. **只有真实用户编辑才标脏**：初始化、恢复、源码同步到富文本不能重新进入用户编辑管线。
5. **保存必须读取 live ProseMirror doc**：不能依赖可能滞后的 `crepe.getMarkdown()` 或 React state。
6. **内部 `<br />` 不得泄漏**：独立空段落、空列表项的占位符不能进入源码和磁盘；表格单元格和作者手写 `<br>` 除外。
7. **列表只修改目标层级和目标块**：保留其他层级的类型、marker、缩进、紧凑/松散间距。
8. **模式切换保持输入位置**：富文本光标与源码 raw offset 双向映射，不能按关键词猜位置。
9. **分叉文档必须局部证明安全**：全文 visible stream 不一致时，允许可靠的局部映射；不能整篇 canonical 覆盖，也不能静默丢弃用户编辑。
10. **新增行为参考成熟编辑器，但不反改旧文件**：富文本中新输入的多个前导空格采用 Typora 可往返写法；既有源码保持不变。

## 4. Bug 家族总表

状态含义：`已覆盖` 表示已有实现和自动化回归；`持续防回归` 表示当前已修，但仍是高风险组合场景；`已知边界` 表示架构仍存在天然限制。

| ID | 问题家族 | 典型症状 | 根因 / 正确处理 | 状态与主要回归 |
| --- | --- | --- | --- | --- |
| RS-01 | 滞后序列化与旧内容保存 | 富文本刚删除/输入就保存，重开后旧内容复活 | `crepe.getMarkdown()` 和回调可能落后于事务；保存、切源码须序列化 `view.state.doc`，并同步镜像到 `tabsRef` | 已覆盖：保存边界、完整重开、`test:rich-source-continuous-fidelity-ui` |
| RS-02 | 回车段落被合并或插入额外空行 | 富文本两段在源码变一行，或源码多出空行 | ProseMirror 段落边界与 Markdown 空行不是一一对应；按前后稳定块映射 raw 间隙，不整篇重写 | 持续防回归：`test:paragraph-source-ui`、`test:source-fidelity-ui` |
| RS-03 | 内部空段落 `<br />` 泄漏 | 输入再删除 `.`、`/` 后源码出现一个或多个 `<br />` | Crepe 用 `<br />` 表示空 paragraph；在局部映射和最终出口识别并还原为空段落语义 | 已覆盖：`test:empty-paragraph-source-ui`、`test:new-source-fidelity-ui` |
| RS-04 | 全文删除失效 | 全选删除，源码仍是旧内容，保存重开后全文复活 | 空文档无法通过普通 visible diff 定位；`document-emptied` 必须作为最高优先级边界 | 已覆盖：`test:full-doc-delete-source-ui` |
| RS-05 | 分叉文档跨块/局部删除回滚 | 删除一段或文档尾部后，切源码仍存在 | 源码与 canonical visible stream 已分叉，普通全文对齐失败；用唯一局部块、行区域或可见删除范围证明映射 | 已覆盖：`test:diverged-partial-delete-ui`、`test:diverged-delete-source-ui` |
| RS-06 | 行中 Markdown 字符导致永久分叉 | `正文。* **输入设备**` 一类内容编辑后恢复旧文本 | parser/serializer 把行中 `*` 转义或重解释；对单块 canonical 反转义后在源码唯一定位，歧义时拒绝猜测 | 已覆盖：纯函数矩阵、分叉删除 UI |
| RS-07 | 单换行显示差异 | 其他编辑器显示两行，HorseMD 富文本合成一段 | CommonMark soft break 与人的换行习惯不同；显示层保留单换行，不向源码写两个空格或 `<br>` | 已覆盖：见 `soft-line-break-display-report.md` |
| RS-08 | 列表 marker 漂移 | 作者输入 `-`，源码变成 `*`；`+` 也被统一 | ProseMirror bullet list 不保存原始 marker；输入规则消费前记录 marker，按目标列表层级和源码结构恢复 | 持续防回归：`test:new-document-list-source-ui`、`test:list-conversion-ui` |
| RS-09 | 列表转换范围扩大 | 转换一级列表时，二三级一起变化；转换后光标跳到末尾 | 用整棵 canonical list 替换作者列表，或事务后读取滞后状态；只序列化目标事务 doc，按右键锚点限制当前层级 | 已覆盖：`test:list-conversion-ui` |
| RS-10 | “数字点列表”被解析成嵌套列表 | `- 1. 管理层` 编辑后丢字、回滚或保存异常 | remark 将行内 `1.` 解析成嵌套 ordered list，源码和 canonical 的可见字符定义不同；按扁平列表项序列对齐 | 持续防回归：`test:nested-number-list-source-ui`、专项交接文档 |
| RS-11 | 相邻列表被 canonical 合并 | 独立的 `-`、`+`、`*` 列表互相污染，空行被吞 | ProseMirror 可把相邻列表合并成一棵树；按作者文字围栏拆分回写，不让一个 canonical tree 扩散到相邻列表 | 已覆盖：`test:rich-source-chaos-ui`、`test:diverged-list-structure-ui` |
| RS-12 | 删除→新增→回改的组合漂移 | 第一次操作正常，继续删除/新增列表后源码“一团糟” | 延迟回调、批量事务和错误基线推进叠加；每次成功映射后同步推进双快照，失败不得清 pending | 持续防回归：chaos、continuous、nested/list structure 测试 |
| RS-13 | serializer 转义污染 | `0~9` 变 `0\~9`，空格变 `&#x20;`，字面符号被转义 | canonical 拼写不能直接当作者源码；只把语义 delta 映射到原文，必要时做受限反转义 | 已覆盖/有边界：`canonical-escape-audit.md`、纯函数矩阵 |
| RS-14 | 多个前导空格乱码与切换卡住 | 按住空格再输入，源码出现 `&#x20;`；有时切源码显示旧快照 | whitespace-only 中间 canonical 曾被误判成结构变化并破坏分隔；把中间态视为空，首个可见字符后按 Typora 写成 `U+200B + 空格` | 已覆盖：`test:leading-space-entity-ui`、真实 CGEvent、保存重开 |
| RS-15 | 光标 raw offset 漂移 | 模式切换后上下差一行，或落到相同关键词的错误位置 | 可见字符索引不足以表达 Markdown 原始位置；使用 block-aware raw offset，snippet/context 只作 fallback，并等待编辑器 selection settle | 已覆盖：`test:mode-switch-raw-offset-ui`、`test:mode-switch-caret-settle-ui` |
| RS-16 | 源码 textarea 换行格式漂移 | 改一个字符后整篇 CRLF 变 LF，BOM/混合换行丢失 | textarea 是 uncontrolled live source；提交时按原文行尾策略映射，不能用 React 受控值全量规范化 | 已覆盖：`test:source-text-fidelity` |
| RS-17 | 新建文档骨架污染 | 新文件首行、列表或尾部出现虚假 H1、空行、`<br />` | scratch tab 有程序生成骨架，但它不是作者源码；区分 generated scratch 与用户真正编辑过的 source | 已覆盖：`test:new-document-list-source-ui`、`test:new-source-fidelity-ui` |
| RS-18 | 程序化恢复被识别成用户编辑 | 切源码再回来立即变 dirty，甚至再次改写源码 | source→rich restore、初始化和 tab 恢复必须设置同步护栏，不进入 `markdownUpdated` 的用户编辑分支 | 已覆盖：模式切换和 dirty 相关 UI 回归 |
| RS-19 | 尾换行不断累积 | 每切一次模式，文件末尾就多一行 | canonical 常带自己的 terminal newline；已有文档按作者尾换行运行钳制，新文档只保留必要结尾 | 已覆盖：纯函数矩阵、new document 回归 |
| RS-20 | 表格单元格换行误清理 | 表格中的 `<br>` 丢失，GFM 表格损坏 | 表格 cell 的 `<br>` 是合法作者内容，与独立空 paragraph 占位不同；清理逻辑必须感知表格范围 | 已覆盖：source fidelity、table/source map 测试 |
| RS-21 | 任务列表勾选不持久化 | 点击 checkbox 后保存重开仍未勾选 | Crepe checkbox 在 `pointerdown` 修改并抑制兼容 mouse event；根 capture listener 必须把事务识别为真实用户编辑 | 已覆盖：`test:task-list-persistence-ui` |
| RS-22 | 歧义映射后状态被错误确认 | 模式切换偶发卡住，下一次编辑覆盖前一次 | fail-closed 只保护源码还不够；映射失败时不能推进 canonical 基线、不能清 pending，强制边界要重新读取 live doc | 持续防回归：连续编辑、chaos、保存/切换组合矩阵 |
| RS-23 | 空引用结构删除后复活 | 清空引用文字后再删掉空引用，富文本已无引用但源码仍有 `>`，保存重开后引用回来 | `>` / `<br />` 都没有可见字符，通用映射得到零宽区间却留下 raw marker；用相邻可见锚点之间的完整 gap 删除 syntax-only quote row | 已覆盖：`test:empty-blockquote-removal-ui`、纯函数矩阵 |
| RS-24 | 跨块连续编辑后双快照分叉 | 富文本删除的旧内容仍在源码，新增内容缺失，立即切源码偶尔卡住 | Milkdown 延迟回调把多个不相邻块合成一个不可安全映射的 delta；跨顶层块输入前先提交上一块，并用稳定顶层起点避开 paragraph→list input-rule 中间态；分叉文档只允许唯一上下文局部回写 | 已覆盖：`test:mixed-rich-source-transaction-ui`、`test:rich-list-source-ui`、continuous/chaos/list 矩阵；详见 `mixed-rich-source-transaction-regression.md` |
| RS-25 | 列表项正文字面标记被 serializer 转义 | 在有序/无序项正文输入 `1. 测试`、`1) 测试`、`- 测试`、`+ 测试` 或 `* 测试`，源码多出 `\`；还可能格式化后续未编辑列表 | remark 为防嵌套列表歧义输出 serializer escape；用去转义语义视图与 raw 边界表只映射本次行文字 delta，保留作者已有转义、marker 与间距 | 已覆盖：`test:list-item-literal-marker-source-ui`、纯函数/列表/chaos 矩阵；详见 `list-item-literal-marker-escape-regression.md` |
| RS-26 | 反引号删除后保存暂停、源码切换锁死 | 逐字输入/删除一个或三个反引号后，保存提示无法安全映射，源码按钮无响应；后续文字可能留在富文本却无法写盘 | 部分删除被误判为整行删除，重复反引号行依赖全文唯一匹配，独立 `<br />` 空段落让零宽 offset 锚错，未变化列表还会抢先消费无关事务；按完整 next line、同行 ordinal、空段落邻接行和 live doc 修复，保留 fail-closed 数据保护 | 已覆盖：`test:code-fence-delete-source-ui`、`test:inline-code-ui`、`test:source-fidelity-ui`、纯函数/continuous/chaos 矩阵；详见 `backtick-source-sync-lock-regression.md` |
| RS-27 | 前导空格列表无法转换类型 | 含 `U+200B + 多空格` 的无序列表转换为有序列表时提示“无法安全转换”，如 `11111.md` | 作者源码的 `U+200B + 5 spaces` 与 canonical 的 `&#x20; + 4 spaces` 是同一语义；只在列表正文比较视图执行 `canonicalTextToSource`，输出仍只替换目标 marker | 已覆盖：`test:markdown-preservation`、`test:list-conversion-ui`；原始空格字节和其他层级保持不动 |
| RS-28 | 行内代码提前激活与代码块退出竞态 | 输入左反引号后第一个中文字符立即变 code，方向键难以退出；恢复闭合触发后，``` + Space→Backspace→快速正文可能与上一段合并 | 未闭合 delimiter 不应创建 mark；只在最后单反引号闭合时转换。空 fenced block 退出属于异步结构边界，下一任务必须立即从 live doc 对账，不能等 260ms 批处理 | 已覆盖：真实 IME `test:inline-code-ui`、`test:code-fence-delete-source-ui`、unit；详见 `backtick-source-sync-lock-regression.md` |
| RS-29 | 新文档字面三反引号泄漏 canonical 转义 | 富文本逐键输入同一行 ```` ```你好``` ````，切源码变成 ```` \`\`\`你好\`\`\` ```` | generated scratch / empty-file 首次编辑全部来自本次富文本输入，没有既有作者转义需要保护；必须使用 `canonicalFreshTextToSource` 只还原 Markdown 文本中的 serializer punctuation，fenced code、inline code 与 HTML literal 保持字节不动 | 已覆盖：`test:literal-triple-backtick-source-ui` 逐键 delimiter + 真实中文 IME + 源码/保存/完整重开，另有纯函数和 `test:inline-code-ui`；详见 `backtick-source-sync-lock-regression.md` |
| RS-30 | 复杂分叉文档的普通编辑被错误暂停保存 | 文档其他位置有嵌套列表、字面三反引号、空引用和重复“测试”时，只给独立正文追加文字也提示“保存已暂停” | 旧块级回退要求目标文字在全文只出现一次，把标题/列表/引用中的同名子串误当作当前块歧义；现在先按非空 Markdown 块和 source/canonical 等数量 ordinal 对齐，只替换当前块，候选数量不等仍 fail closed | 已覆盖：`test:diverged-ordinary-save-ui`、纯函数唯一块/重复块/数量不等三组合同，以及 diverged delete、mixed transaction、code fence、continuous 家族；详见 `diverged-ordinary-save-regression.md` |
| RS-31 | `- - 内容` 嵌套项及后续兄弟项仍暂停保存 | 0.13.30 的同一复现文档中，独立正文可保存，但编辑第二个 `-` 形成的嵌套项或其后兄弟项仍提示暂停 | 分叉列表序列只从作者行正文剥离 `1. ` / `1) ` 数字前缀，没有剥离被 canonical 消费的第二个 `- ` / `+ ` / `* `；整棵列表对齐提前失败。现在比较和 raw offset 同时识别恰好一层任意列表 marker，输出 marker 不变 | 已覆盖：纯函数嵌套项/后续兄弟项；`test:diverged-ordinary-save-ui` 三处逐字编辑、直接保存、源码、磁盘、冷重开；27 组家族矩阵 |
| RS-32 | 重复引用后的新文字写进前面旧引用 | 富文本末尾退出引用后输入的新段落仍显示正确，但保存/源码把它拼进前面某个同名引用；重开后以错误源码为准 | `preserveMiddleEmptyBlock()` 在 source/canonical 已分叉时仍复用 canonical 的全文可见行序号。前部 `- - 内容` 等结构令后续索引整体偏移，大量重复“测试”引用又掩盖了错误定位。现在仅在可见行完全一致时直接按索引；分叉时必须按相邻可见文本、结构类型和同类 pair ordinal 一一映射，候选数量不等即拒绝 | 已覆盖：`test:diverged-ordinary-save-ui` 增加同一引用内批量编辑、退出第三个重复引用后逐字输入唯一末段；直接保存、首次源码、磁盘、冷重开严格相等 |
| RS-33 | 直接点击引用后的空正文，新增文字写入前面空引用 | 富文本在引用下方显示新正文；保存后源码没有该正文，反而出现较早的 `>新增文字`，重开后新增文字丢失 | 引用后的可点击空 paragraph 在 canonical 中只表现为终端空行；填入文字是 `previous.length` 的零宽追加。分叉分支先执行 `locally-aligned-change`，重复的零可见宽度引用行碰巧通过局部比较，把末尾 raw offset 映到前面。现在纯正文物理末尾追加在分叉映射前处理，并拒绝标题/列表/引用/fence/table 等结构语法 | 已覆盖：纯函数分叉引用末尾追加；`test:diverged-ordinary-save-ui` 直接点击 trailing empty paragraph 逐字输入，验证直接保存、源码、磁盘、冷重开 |
| RS-34 | 第一次保存提示暂停，稍后重试又成功；持续失败时编辑只留在内存 | 富文本 transaction 已显示，但立即保存/切源码触发 fail-closed；等待后重试可能成功。真正歧义时用户无法正常保存 | durability boundary 早于延迟 `markdownUpdated` / pending input intent 协调运行，把暂时未稳定与永久歧义混为一类。0.13.34 先有界 settle；持续歧义仍不覆盖原文件，改为用户选择路径保存规范化恢复副本 | 已覆盖：`test:editor-flush-settle`、`test:source-sync-recovery`，并重跑全部家族矩阵；详见 `source-sync-save-recovery.md` |
| RS-35 | 事务接管后空块首字错写相邻段落 | 简单正文/列表测试通过，但在已有块前连续 Enter 后输入，源码把新字写进前一段或合并多个段落 | 空 PM paragraph 没有可见字符，普通 raw offset 会回退到相邻块；transaction batch 必须原子，结构 split 后要保存独立 block hint，任何未覆盖结构必须 quarantine 并等待旧路径建立新 checkpoint。首轮默认接管被完整段落回归否决，生产恢复影子/关闭 | 迁移进行中：`test:source-transaction-sync`、显式 primary `test:source-transaction-sync-ui`；生产基线继续由 `test:paragraph-source-ui` 等全家族门禁保护。详见 `transaction-source-sync-architecture.md` |
| RS-37 | 多轮保存后列表/正文再次分叉 | 第一次保存重开正常；继续编辑已有列表、退出列表、再建无序列表或正文后，源码少空行、丢正文，或只提交列表的一部分 | 已完成的列表 input intent 未被消费，后续正文回调拿旧槽重建；批量列表 mapper 还可能在 remainder 未映射时错误返回成功。现在 intent 只消费一次，批量事务必须完整推进到 `next`；重复文本用完整列表行 + suffix fence，通用 mapper 禁止接管多行结构 | 已覆盖：`test:family-multicycle-ui`（4 轮编辑/保存、5 次冷打开，默认与 primary 双路径）、真实 `123321.md` override、20/20 家族矩阵 |
| RS-38 | CRLF / 无末尾换行的列表边界损坏 | CRLF 续写出现 `\r文字\n`；无 final-EOL 文件退出列表后新建列表会粘回上一列表 | 行区间把 CR 当正文；terminal newline growth 固定为 1，无法表示“终止行 + 独立块”。现在在 CR 前插入并使用局部 EOL；0-EOL 退出需要 2 个换行，1-EOL 只增长 1 个 | 已覆盖：纯函数字节级 CRLF、0/1 final-EOL 链式回归，transaction CRLF/BOM+CRLF UI，多轮混合 EOL fixture |
| RS-39 | 冷重开后在中间空段输入列表，富文本有内容但源码仍停在列表前 | 在正文与后续代码块之间的空段输入正文、有序列表两项、退出列表再输入正文；富文本完整，切源码缺列表和尾文，继续保存会形成双快照分叉 | 中间空段 mapper 一律拒绝 list syntax，而中间位置的 input intent 没有 raw tail slot，两个专用路径都不拥有该事务。现在仅在前后锚、空槽和语法边界全部证明时原子写回“列表 + 后续正文”，完成后消费 intent；CRLF 从 `\r` 前替换完整 EOL | 已覆盖：纯函数 LF/CRLF（含 lone-CR 禁止断言）；`test:family-multicycle-ui` 第四轮 + 第五次冷打开；默认/primary 与真实 `123321.md` 临时副本 |
| RS-40 | `/code` 创建代码块后继续编辑，源码与富文本再次分叉 | 文档末尾输入 `/code` 选择代码块，立即编辑代码、代码块后正文和前文列表；首次切源码即锁定，或源码缺 fence/后续文字 | slash code 是“删除临时 `/code` + paragraph→code_block”两条命令。旧 mapper 把 `/code`→空 fence 误判为只删除尾行，源码没有代码块槽。现在命令前捕获精确 authored 行，命令后只序列化当前 code_block，并验证完整 fence 后原子替换；重复 query 无精确映射时拒绝，CRLF 原样保留 | 已覆盖：`test:tail-fence-ui` 的 40ms `/code`、代码/尾文/前文连续编辑、源码、保存和冷重开；纯函数 CRLF、重复 query、歧义拒绝；literal/input-rule fence 变体 |
| RS-41 | 真实长会话在 RS-40 后仍再次分叉 | 0.13.47 安装包中，真实长文档末尾建立代码块并继续多轮编辑后，富文本有新增内容但源码缺失/结构不同；保存可能暂停，也可能成功但磁盘仍与富文本不一致 | **根因尚未确认。** RS-40 只拥有 `/code` 创建瞬间；后续 transaction 仍可能在 live doc、作者源码、canonical、`tabsRef`、textarea live value 与保存边界之间失去同一所有权。必须捕获第一次分叉，不得再按最终症状补字符串 mapper | **P0 未解决，人工验收失败。** 自动化绿色不能关闭；专项见 `rich-source-divergence-incident-0.13.47.md` |
| RS-42 | 语义 AST 相同但列表源码槽位已错 | 连续 Enter 后，源码把 canonical 的 `2. ` 空项写成 `1. `，或出现/丢失一个空列表项；parser 仍可能得到相同语义树，因此旧校验错误返回 `preserved: true` | **事务提交必须双证明**：语义 AST 负责正文和结构，列表槽位指纹负责项数量、空项、列表类型、任务状态和有序编号；任一证明失败都不推进双快照、不切源码、不保存，并发出持续通知。`source-structure-fingerprint.js` 是统一门禁，不属于某个列表症状补丁 | 已覆盖：`test:source-structure-fingerprint`、表格尾部列表、重复有序列表、延迟意图和中间空段家族回归 |
| RS-43 | 已消费的列表输入意图跨越 IME/后续 Enter | 在中间输入 `1. `、提交正文后按 Enter，源码正确候选会短暂生成 `2. `，但仍存活的旧 `1.` marker 意图随后把空项恢复成 `1.`，触发结构不一致提示 | **输入意图有生命周期**：捕获只绑定同一源快照；成功认领后只允许同一 input-rule dispatch 的短尾部回调继续使用，不能沿用原 3 秒窗口跨越正文或 IME 事务。候选仍经过语义 + 列表槽位双证明 | 已覆盖：`test:middle-ordered-marker-only-ui`、`test:input-intent-staleness-ui`、`test:repeated-ordered-list-middle-ui` |
| RS-44 | 退出空有序项时，后续有序列表的标点翻转吞掉整段列表 | 有序列表填正文 → Enter 新建空项 → 空项里再 Enter 退出；下方紧跟作者用 `1)` 书写的独立有序列表时，Crepe 在同一事务把 `1)` 重序列化为 `1.`，源码把后续 `1) 斯卡洛尼快乐 / 2) 是干嘛的了；吗` 整段删除，触发 `source-list-structure-mismatch` | **标点差异是 serializer 伪差异，不能进 diff**：`1.`/`1)` 与 bullet marker 统一成 `*` 同类，作者标点以源码为准。现在 diff 前把行首有序 marker 标点归一化（只碰行首 marker、不碰列表项内字面 `1.`/`1)`，`.↔)` 等长），变更区间只剩 `2. ` → `<br />`，空项删除分支正常保留后续列表 | 已覆盖：`test:ordered-exit-delimiter-ui`（两次分开的 Enter + 源码切换 + 无 toast，字节级保留 `1)`）、纯函数 `ordered-exit-delimiter`；反证还原归一化后复现“源码切换被阻止 / 后续列表被删” |
| RS-45 | 新建文档空有序项按 Tab 后误报源码不一致 | `1. 测试` → Enter 得到空 `2. ` → Tab；富文本正确变为嵌套空 `1.`，但立即弹出源码同步不一致 | Crepe canonical 为 `1. 测试\n\n   1. <br />`。`normalizeEmptyListItems` 正确去掉 editor-only `<br />`，但 `compactGeneratedListSpacing` 又无条件删掉前面的空行，生成 `1. 测试\n   1. `；remark 会把它重解析为 parent hardbreak + 字面 `1.`，而不是 nested list。正确修复是只为“更深层且仍为空”的 generated list row 保留 parse-safe 空行；**不放宽 integrity gate** | **修复归属 0.13.91；目标专项与相邻 RS-42～44/核心保真矩阵已绿。** 专项：`generated-scratch-empty-ordered-indent-regression.md` |
| RS-46 | `- 1. 文本` Enter 拆 nested ordered item 后层级丢失 | 已有 `- 1. 甲乙` 在富文本中间 Enter，再给第二项输入内容；富文本正确，但切源码被阻止并提示不一致 | `diverged-nested-list-change` 把新增 nested ordered sibling 写成 `- 2. ...`，新建了外层 bullet；正确作者源码应沿 outer bullet content column 写 `  2. ...`，并保留作者 ordered delimiter。semantic + raw list-slot 双证明均正确拒绝旧 candidate | **修复归属 0.13.92；专项纯函数、真实 UI、源码切换、保存与冷重开已通过。** 专项：`diverged-nested-number-enter-split-regression.md`、`test:nested-number-list-source-ui` |
| RS-48 | 空 blockquote 中 IME 输入被写到引用块外 | authored source 尾部只有 `>`，canonical 为 `> <br />`；在空引用块里用 IME 输入正文后富文本仍是 quote，但立即触发源码不一致 | `trailing-empty-block-filled` 把 next quoted 内容当普通尾部段落交给 `appendBlockAtDocumentEnd()`，candidate 变成 `>\n\n正文`，而 canonical 是 `> 正文`；0.13.94 仅在 source/previous/next 同深度 quote slot 被严格证明时原位填充正文，普通空段仍沿旧路径，integrity gate 不放宽 | **修复归属 0.13.94；真实 IME、源码、保存、冷重开及 IME/quote/paragraph/source-fidelity 泛化门禁已绿。** 专项：`empty-blockquote-ime-fill-regression.md` |
| RS-49 | generated scratch 中 bullet 正文开头的字面 `1.` 被重解析成嵌套列表 | 新建文档的空 bullet item 中先形成瞬态 `1. `，随后 IME 提交正文；canonical 为 `* 1\\. 正文`，旧 generated scratch candidate 却是 `- 1. 正文`，触发 `source-list-structure-mismatch` | `canonicalFreshTextToSource()` 把结构保护 `1\\.` 当普通 fresh punctuation 去转义。0.13.95 由 canonical 先证明 quote/list 前缀，只在 item/body 起点恢复同一 `N\\.`/`N\\)` 保护符；行中 punctuation 仍正常还原，integrity gate 不放宽 | **修复归属 0.13.95；真实 generated-scratch + IME + 源码 + 保存 + 冷重开、既有 literal-marker 家族、新文档保真与全局 IME 均已绿。** 专项：`generated-scratch-literal-ordered-ime-regression.md` |
| RS-50 | Slash 创建空 task 后源码失去 checkbox 语义 | 新建文档 `/task` 创建未勾选空任务；canonical 为 `* [ ] <br />`，旧 generated scratch 写成裸 `* [ ] `，GFM 重解析后 `checked:null`，触发 `source-document-mismatch` | 空 task 需要一个 Markdown 可重解析但不可见的正文槽。0.13.96 复用 U+200B 源码哨兵：仅空 task 写 `* [ ] <U+200B>`，remark 在精确 task-empty 形状下剥离；冷重开后首个正文事务通过 `empty-task-sentinel-filled` 消费哨兵，普通正文/普通 U+200B 不受影响，integrity gate 不放宽 | **实现归属 0.13.96；纯函数、GFM parser 语义、空 task 创建/源码/保存/冷重开与哨兵消费路径已覆盖；真实长会话继续人工验收。** |
| RS-51 | generated scratch 删除空无序项时把 PM 尾随空 paragraph 当成真实分叉 | 新建文档创建 `- 离婚了`，Enter 得到空第二项，再在空项按一次 Backspace；PM 正确把第二项合并成第一 item 的尾随空 paragraph，但立即提示源码不一致 | 真实 0.13.96 trace 中 source 为 `- 离婚了\n- `，previous canonical 为 `* 离婚了\n* <br />`，next canonical 为 `* 离婚了\n\n  <br />`。generated scratch 直接重建 `- 离婚了` 并以通用 reason 校验，错过已有 `empty-list-item-removed` 合同；0.13.97 仅在现有 mapper 严格返回该 reason 时复用其 markdown/reason，使既有“恰好一个 editor-owned trailing empty paragraph”语义合同生效，不新增哨兵、不放宽其它门禁 | **修复归属 0.13.97；真实逐键专项已从稳定红转为 `semanticOk:true / listSlotsMatch:true / no toast`，candidate 保留正确 post-list 空块槽。** 专项：`generated-scratch-empty-bullet-backspace-regression.md`、`test-generated-scratch-empty-bullet-backspace-ui.mjs` |
| RS-52 | RS-51 后继空段填正文时 generated scratch 重新引入多余空行 | RS-51 Backspace 已正确删除空 bullet 后，单纯查看源码再回富文本，在列表后的空 paragraph 输入 `后续`；无 integrity toast，但源码从一个空块间距膨胀为四个换行 | 普通 preservation 层已严格返回 `trailing-empty-block-filled` 和正确源码 `- 离婚了\n\n后续`；0.13.98 用 source+canonical 双快照的一次性 transient token 绑定 RS-51 后继态，只有快照仍一致且下一事务严格返回该 reason 时才复用并消费；其它 rich transaction 自动使 token 失效，generated scratch 总体策略不变 | **修复归属 0.13.98；RS-51/RS-52 端到端专项已通过：Backspace、源码查看、后继正文、保存、冷重开严格稳定且无额外空行。** 专项：`generated-scratch-post-list-empty-fill-regression.md` |
| RS-53 | RS-50 空 task 冷重开后首次填正文时 U+200B 未被消费 | 0.13.96 的空 task 可保存并冷重开为 unchecked task；在重开的空 task 输入正文 `任务` 后立即触发源码不一致，source 模式被保护器挡住 | 完整 UI 证据：source `* [ ] <U+200B>`、canonical baseline `* [ ] <br />`、next canonical `* [ ] 任务`；façade 原先返回 `diverged-block-change` 并生成 `* [ ] 任务<U+200B>`。0.13.99 仅扩展 RS-50 专用 empty-task guard：previous body 可为原始 `<br />` 或 normalize 后纯空白；source 仍必须精确是 U+200B task，task kind/checked/indent/ordinal 与 next 非空正文证明全部保留 | **修复归属 0.13.99；完整 façade 三态、Slash 空 task → 保存 → 冷重开 → 填正文 → 源码无 U+200B → 再保存 → 第二次冷重开全部 PASS，最终 `empty-task-sentinel-filled / semanticOk:true / listSlotsMatch:true / no toast`。** 专项：`empty-task-reopen-sentinel-fill-regression.md`、`test-generated-scratch-empty-task-slash-ui.mjs` |
| RS-54 | 空 bullet 紧邻 ordered list 时 Backspace 被默认 keymap 合并成 ordered `3.` | 0.13.99 真实 trace：`1. 测试 / 2. 哪里呢 / - [空]`，空 bullet 上 Backspace 后 PM 在 source mapper 之前直接变成 ordered `3.`，随后 candidate 同时含 `3.` 与旧 `- ` 并触发 `source-list-structure-mismatch` | 0.13.100 在 DOM capture keydown 只拦截“顶层、单个、非 task、完全空 bullet 且左邻 ordered list”的普通 Backspace，删除 bullet 容器并复用/插入普通 paragraph；同时 `preserveEmptyListItemTextChange()` 只允许 before/after list kind 相同，防止删除事务被误判为 empty-item fill 并复制 ordered block | **修复归属 0.13.100；真实 UI 从稳定红转绿：orderedItems=2、bulletLists=0、无 toast、source 无 `3.` / `- `、保存/冷重开 PASS；RS-51、Markdown preservation、空 marker 与 source-fidelity audit 全绿。** 专项：`empty-bullet-backspace-after-ordered-regression.md`、`test-empty-bullet-backspace-after-ordered-ui.mjs` |
| RS-55 | ordered list 后普通尾段输入字面 `3.` 时过早变成 Markdown marker | 0.13.100 真实 trace：删除空 bullet 后在普通尾段输入 `3.`，尚未按 Space；Crepe canonical 为 `3\\.`，旧 `appended-paragraph` 却用 fresh punctuation 写成 `3.`，重解析成 ordered marker 并触发 `source-document-mismatch` | 0.13.101 在 `appendBlockAtDocumentEnd()` 只对“整块新普通段恰好是 `N\\.` / `N\\)`”保留 canonical 结构保护转义；行内 punctuation 仍照常恢复，真正按 Space 后由 list input-rule 接管 | **修复归属 0.13.101；真实字面阶段 candidate/canonical 均保留 `3\\.`，`ok/semanticOk/listSlotsMatch=true`、无 toast。** 专项：`appended-literal-ordered-marker-regression.md`、`test-appended-literal-ordered-marker-ui.mjs` |
| RS-56 | generated scratch 三级 nested bullet 快速双 Backspace 触发源码不一致 | 0.13.101 真实 trace：最深项 `* 我` 删除正文后约 120ms 再 Backspace 退层；PM 合法留下 parent nested item 的 editor-owned trailing empty paragraph，但 generated scratch candidate 缺该 transient，触发 `source-document-mismatch` | 根因是 `normalizeEmptyListItems()` 在 façade 映射前把原始 `    <br />` 的缩进抹掉，使严格 tail proof 从 nested removal 退化为通用 `diverged-tail-line-delete`。0.13.102 在 normalize 前只接受 raw tail mapper 严格返回的 `nested-empty-list-item-removed`；generated callback/flush 共用该局部 proof，semantic opt-in 仍只允许一个 trailing empty list-item paragraph，nested reason 不创建 RS-52 post-list token | **修复归属 0.13.102；真实快速双 Backspace 专项从稳定红转为 `nested-empty-list-item-removed / ok=true / semanticOk=true / listSlotsMatch=true / no toast`，源码、保存、冷重开 PASS；永久 preservation + transaction semantic 纯函数全绿。** 专项：`generated-scratch-nested-empty-backspace-regression.md`、`test-generated-scratch-nested-empty-backspace-ui.mjs` |
| RS-57 | generated scratch 引用正文末尾 Enter 新建空第二段立即触发源码不一致 | 0.13.102 真实 trace：`> 千万千万人` 末尾按 Enter 后，PM 成为同一 blockquote 的正文 paragraph + 空 paragraph；canonical 为 `> 千万千万人\n>\n> <br />`，旧 generated candidate 为 `> 千万千万人\n>\n>`，重解析无法恢复空引用 paragraph，触发 `source-document-mismatch` | Markdown 无法在不泄漏 `<br />` 的情况下持久化 quote 内独立空 paragraph。0.13.103 用文档尾部、同 quote depth、正文不变与精确 `>` + `> <br />` 形状严格证明 `trailing-empty-blockquote-paragraph-created`，此 transient 保持作者源码不变；integrity 仅在该专用 reason 下忽略恰好一个尾随空引用 paragraph，generated callback/flush 共用 proof | **修复归属 0.13.103；真实 `/quote` → 正文 → Enter 专项为 `trailing-empty-blockquote-paragraph-created / ok=true / semanticOk=true / listSlotsMatch=true / no toast`，继续填第二段、源码、保存、冷重开 PASS；RS-48、空引用删除、35/35 probes、source-fidelity 与纯函数门禁全绿。** 专项：`generated-scratch-blockquote-empty-paragraph-regression.md`、`test-generated-scratch-blockquote-empty-paragraph-ui.mjs` |
| RS-58 | generated scratch 中 task/list item 的第二 paragraph 删空后立即触发源码不一致 | 0.13.103 真实 trace：checked task `前端` 后的新项经 Backspace 合并成 task 内第二 paragraph；继续把 `[ ] ` 删空后 PM 合法保留 `paragraph(" 前端") + paragraph("")`，canonical 用缩进 `  <br />` 表示该 transient，但旧 generated candidate 直接删掉 continuation，line 2314 触发 `source-document-mismatch` | 原有 mapper 已正确返回 `escaped-literal-line-emptied` 并删除 authored continuation 行，但 reason 不携带 list ownership；而 `normalizeEmptyListItems()` 又会把 raw `  <br />` 抹成顶格 `<br />`。0.13.104 在 normalize 前用 raw canonical 严格证明“同一缩进 continuation → `<br />`、其余文档不变、前有更浅 list/task marker”，再重分类为 `trailing-list-item-paragraph-emptied`；generated callback/flush 共用 proof，integrity 仅对此 reason 允许恰好一个 trailing empty list-item paragraph，checked 状态仍严格 | **修复归属 0.13.104；generated-scratch 真实 PM 同构专项为 `trailing-list-item-paragraph-emptied / ok=true / semanticOk=true / listSlotsMatch=true / no toast`，源码强制 flush、保存、冷重开 PASS；task persistence、RS-57、RS-56、35/35 probes、source-fidelity 与纯函数门禁全绿。** 专项：`generated-scratch-task-continuation-empty-regression.md`、`test-generated-scratch-task-continuation-empty-ui.mjs` |
| RS-59 | 已有 source/canonical 拼写分歧时，中间空段先输入单独 `-` 再扩写会把该段粘到上一段 | 0.13.104 / PID 97146 trace line 70：`哈哈；` 与 `***` 之间的空 paragraph 先写成受保护的 `\\-`，继续输入 `【】` 后 canonical 为独立 `-【】` 段；旧 visible-offset raw mapper 却把 changed line 的零宽边界映到上一条 source 行尾，候选变成 `哈哈；-【】`，立即触发 `source-document-mismatch` | Markdown 段落分隔在 visible stream 中没有字符，source/canonical 前部只要已有 marker/entity 等合法拼写差异，backward affinity 就可能把某条独立行的起点落到上一条 source 行。0.13.105 在通用 `localized-change` 最终 raw patch 前验证“canonical 被编辑行的可见身份 == mapped source 行的可见身份”；不一致则 fail closed 到既有 `preserveChangedLineRegion()`，由行/块上下文重新定位。空段首个 `-` 仍由既有 `middle-empty-block-filled` 认领，不放宽 block 语义 | **修复归属 0.13.105；真实 UI 证明 `middle-empty-block-created → middle-empty-block-filled → mapped-line-change` 三步均 `ok/semanticOk/listSlotsMatch=true`、无 toast，最终 DOM 保持 `哈哈；` 与 `-【】` 两个独立段落，source、保存、冷重开 PASS；全量 markdown-preservation 纯函数门禁 PASS。** 专项：`escaped-standalone-paragraph-expand-regression.md`、`test-escaped-standalone-paragraph-expand-ui.mjs` |
| RS-60 | generated scratch 删除第二个空 task row 时，PM 合并成上一 task 的尾随空 paragraph 后立即触发源码不一致 | 0.13.105 / PID 11970 trace line 2052：第二个 task 从 `* [ ] 23日` 逐字删到空，再按一次 Backspace；PM 正确只剩第一 task，但第一 task 内保留第二个空 paragraph，canonical 为 `* [ ] 3日未日\n\n  <br />`。旧 generated candidate 直接删掉第二 task row 且没有 task-owned transient reason，触发 `source-document-mismatch` | 旧 `empty-list-item-removed` 只会剥普通 list marker，不识别 task checkbox `[ ]` / `[x]` 与 U+200B 空 task sentinel；同时 `normalizeEmptyListItems()` 会抹掉 raw canonical 中 `  <br />` 的缩进证据。0.13.106 把 task state + sentinel 纳入严格 empty-row shape，并在 normalize 前只接受 raw `preserveEmptiedParagraph()` 明确返回的 `empty-task-item-merged-to-continuation`；generated callback/flush 复用既有“恰好一个 trailing empty list-item paragraph”语义合同，但不创建 RS-52 post-list token | **修复归属 0.13.106；真实 generated-scratch UI 为 `empty-task-item-merged-to-continuation / ok=true / semanticOk=true / listSlotsMatch=true / no toast`，source 强制 flush 只保留第一 task，`<br />`/U+200B 不泄漏，保存与冷重开 PASS；全量 markdown-preservation 纯函数门禁 PASS。** 专项：`test-generated-scratch-empty-task-row-backspace-ui.mjs` |
| RS-61 | 尾部纯标点普通段在 serializer 去掉保护转义后被误判为整行删除 | 0.13.106 / PID 20800 真实 trace：普通尾段先稳定为 `-\\[ ]`，再输入一个 Space 后 PM 仍是普通文本 `-[ ] `，canonical 也保留该 raw 行；旧 `diverged-tail-line-delete` 却因 visible-line 视图把这类纯标点行视为“无可见正文”，误认前一行已成为文档尾部并从 candidate 删除整条尾段，18:11:23 首次触发 `source-document-mismatch` | **visible-empty 不等于 raw row deleted**。0.13.107 给 tail deletion proof 增加 raw 尾行反证：只有 raw 尾部确实是前一行、纯空白或 editor-owned `<br />` 才允许删除；若 raw canonical 仍有 `-[ ] `、字面转义或其它纯标点行，就禁止 deletion mapper 抢事务并交回精确行级 mapper。integrity gate 不放宽，RS-56 的 `<br />` 删除形状继续允许 | **修复归属 0.13.107；现场三态纯函数与真实 UI 均从 `diverged-tail-line-delete` 改为 `trailing-exact-line-change`，`ok/semanticOk/listSlotsMatch=true`、无 toast，源码精确保留 `-[ ] `，保存与冷重开 PASS。** 专项：`test-diverged-tail-literal-bracket-space-ui.mjs` |
| RS-63 | 前一 bullet 含 nested list 时，删除其后的空顶层 bullet 立即触发源码不一致 | 0.13.108 / PID 23485 trace line 557：源码尾部为 `- wefsfesf /  * wfewff / - [空]`；空顶层 bullet 上 Backspace 后 PM 合法把该空项变成前一 list item 内、nested list 之后的尾随空 paragraph，canonical 为 nested row 后 `  <br />`，旧 candidate 只删空 marker，23:01:23.217 首次 `source-document-mismatch` | RS-51 的 generic transient 只允许尾随空 paragraph 紧跟文字 paragraph，故意把 nested structure 后的空 paragraph 保持严格；本场景需要 raw canonical 单独证明。0.13.109 新增 `empty-list-item-merged-after-nested-list`：被删 row 必须是唯一顶层 plain empty bullet，前一非空 canonical 行必须是更深层 list row，新 `<br />` 也必须以更深缩进落入前一项；只有该 reason 才允许 nested list 后恰好一个 editor-owned 空 paragraph，不放宽其它 nested structure | **修复归属 0.13.109；现场三态纯函数、真实 UI、source、保存、冷重开 PASS；最终 `semanticOk=true / listSlotsMatch=true / no toast`。** 专项：`test-empty-bullet-after-nested-list-backspace-ui.mjs` |
| RS-64 | authored 空 bullet 按 Tab 缩进成 nested empty bullet 时立即触发源码不一致 | 0.13.109 / PID 25642 trace line 140：`- u高科技 / - 阿尔萨俄方 / - [空]` 中最后一项按 Tab 后 PM 正确变成 `阿尔萨俄方` 的 nested empty bullet，canonical 为 `* 阿尔萨俄方\n\n  * <br />`；旧 compact formatter 删除 nested marker 前空行，candidate 变成 `- 阿尔萨俄方\n  * `，23:27:46.340 首次 `source-document-mismatch`，之后继续输入才出现 `source-list-structure-mismatch` 连锁 | CommonMark 对 bare nested **空** marker 有歧义：无空行时把 `  * ` 当父 paragraph 的字面 continuation；保留父项与 nested 空 marker 之间一条空行才会解析成真正 nested list item。0.13.110 不新增 sentinel、不放宽 semantic comparator；仅在 `formatCanonicalListLikeSource()` 压缩 compact canonical padding 时识别 `depth>0 + empty` marker，并保留紧邻它的一条 parse-required 空行，其他 marker 的 serializer 空行仍删除 | **修复归属 0.13.110；现场三态纯函数与真实 Tab UI PASS，最终 `batched-list-block-changes / ok=true / semanticOk=true / listSlotsMatch=true / no toast`；Tab 后继续输入 nested 正文、源码、保存、冷重开均稳定。** 专项：`test-empty-bullet-indent-ui.mjs` |
| RS-65 | 文档中间 blockquote 正文末尾 Enter 新建空第二段时立即触发源码不一致 | 0.13.110 / PID 29289 trace line 664：`> lknlkjn.kln` 后仍有 `2. 斛律v哦` 等真实块；Enter 后 PM 正确为 quote 内 `paragraph("lknlkjn.kln") + paragraph("")`，canonical 为 `> lknlkjn.kln\n>\n> <br />`，但 RS-57 proof 写死整篇文档尾部，通用 `visible-mismatch-line-change` 生成 `> lknlkjn.kln\n\n>\n>`，23:44:26.303 首次 `source-document-mismatch` | RS-57 的“trailing”实际应表示 **blockquote 内尾随空 paragraph**，不是 document tail。0.13.111 扫描 exact quote triple，并要求从 `next` 删除新增 `>\n> <br />` 后必须逐字等于完整 `previous` canonical；再以 visible quote row ordinal + quote depth + visible text 对齐 authored source，因此长文档已有 marker/spacing 拼写分歧仍可定位，但任何同时发生的其它 canonical edit 都无法命中。仍返回专用 `trailing-empty-blockquote-paragraph-created`，integrity 只沿用原 RS-57 的“忽略恰好一个 trailing empty quote paragraph”合同 | **修复归属 0.13.111；纯函数同时覆盖普通与 source/canonical 已分歧文档；真实中间 quote UI 为 `trailing-empty-blockquote-paragraph-created / ok=true / semanticOk=true / listSlotsMatch=true / no toast`，继续填第二段由 `middle-empty-block-filled` 正常提交，后置有序列表、源码、保存、冷重开稳定。** 专项：`test-middle-blockquote-empty-paragraph-ui.mjs` |
| RS-66 | 已有 authored 文档中普通段经 Slash 菜单创建空 unchecked task 时立即触发源码不一致 | 0.13.111 / PID 31051 trace line 616：普通段内容恰好为 `/`，选择 Task 后 PM 正确变成顶层 `checked:false` 空 task，canonical 为 `- [ ] <br />`；normalize 后通用 `locally-aligned-change` 只能生成 bare `- [ ] `，该行重解析不再是稳定 GFM task，00:01:25.313 首次 `source-document-mismatch` | RS-50 已证明真正空 task 必须有一个 source-owned U+200B body sentinel，但旧实现只在 generated scratch 生成路径使用它。0.13.112 在 normalize 前新增 `empty-task-slash-created` raw proof：候选 task 必须是顶层 unchecked + `<br />`；把该 task row 替换回 `/` 后必须逐字得到完整 previous canonical；source/previous 的独立 `/` row 数量一致并按 ordinal 对齐，最终仅将这一 authored row 替换成 marker + `[ ]` + U+200B。任何其它 block 同时变化、非空/checked/nested task 都不能命中，semantic comparator 不增加例外 | **修复归属 0.13.112；现场三态纯函数含 batched/non-empty 负例 PASS。真实 existing-doc 单 `/` + pointer 选择 Task 为 `empty-task-slash-created / ok=true / semanticOk=true / listSlotsMatch=true / no toast`；source 精确保留邻接 authored `-` marker 并写入 sentinel，保存/冷重开后空 task 语义稳定；随后填“任务”由 `empty-task-sentinel-filled` 消费 sentinel，第二次重开稳定。** 专项：`test-existing-middle-empty-task-slash-ui.mjs` |
| RS-67 | 有 nested ordered child 的父 ordered item 正文删空时，broad diverged mapper 误删父 marker | 0.13.112 / PID 32752 trace line 43：`1. 啊` 下仍有 `   1. 微风`；删除父正文最后一个“啊”后 PM 正确保留父 item + 空 paragraph + nested child，canonical 为 `1. <br />\n\n   1. 微风`，但文档前部已有合法 source/canonical list divergence 时 `diverged-nested-list-change` 将父正文清空误判为整项删除，candidate 只剩 nested child，00:16:25.642 首发 `source-list-structure-mismatch`；line 50 的 document mismatch 为 fallout | 0.13.113 在 `<br />` normalization 前新增 `nested-list-parent-body-emptied` raw proof：previous→next 只能有一条 parent marker row 从非空正文变 `<br />`，恢复该 row 必须逐字得到完整 previous canonical；其下一非空 marker 必须更深且未变化；authored source 中 parent+child 的 marker kind/ordinal、层级与 canonical→source 正文组合必须唯一。命中后只删 parent body bytes，marker/separator/child 原样保留。无 nested child 的普通空 list item不能命中，semantic comparator 不放宽 | **修复归属 0.13.113；纯函数现场形状 + no-child 负例 PASS。真实 UI 为 `nested-list-parent-body-emptied / ok=true / semanticOk=true / listSlotsMatch=true / no toast`，source 精确保留 `1. ` 与 nested `1. 微风`，保存/冷重开层级稳定。** 专项：`test-nested-parent-body-empty-ui.mjs` |
| RS-68 | 快速连续 Backspace 把“父正文删空 + 空 ordered parent lift”合并到同一 callback，RS-67 的等待式测试未覆盖 | 0.13.113 / PID 34380 trace line 99：父项仍是 baseline `1. 啊额法`，用户连续 Backspace 后 final PM 已直接变成前一 bullet list 中的空 bullet parent，并继续持有 nested `1. 微风`；canonical 从 `1. 啊额法 / 1. 微风` 一步跳到 `* <br /> / 1. 微风`。通用 `visible-mismatch-line-change` 生成 `* ` 且保留 serializer 空行，`- \n\n   1. 微风` 会把 child 解析成独立顶层 ordered list，00:44:29.748 首发 `source-document-mismatch` | 0.13.114 新增 `rapid-nested-ordered-parent-backspace-lift`：raw proof 唯一定位前一同级 bullet、非空 ordered parent 与未变化 nested child；目标外仅允许 bullet marker 的 serializer-only 漂移，同步 child/body/ordered/indent 变化均 fail closed。source 改为 parse-safe `- \n   1. 微风`，保留 child 原始缩进。因为整篇 strict fingerprint 的同一 list group 还包含历史 authored/canonical divergence，mapper 返回精确局部 ranges；Editor 从真实四份文档重切 before/after 片段并分别做 strict numbering+nested slot proof，只有 `checkpointTrusted + semanticOk + localizedListProofOk` 才允许提交，不按 reason 裸放行。70ms 的最后一个瞬时失败来自 `createEditorApi().flushMarkdown()`：forced flush 在 deferred `markdownUpdated` 前重算出了同一个 RS-68 preservation result，却只把 `reason` 传入 validation、遗漏该 result 的 `integrityProof`；随后主 callback 才携带 proof 自愈。最终让 forced flush 与同 candidate 的 fallback/recheck 一样转交自己的 proof，任何已改写成其它 markdown 的 candidate 都不会继承旧 proof，integrity 规则保持原样严格 | **修复归属 0.13.114；永久 UI 使用 4 次连续 Backspace、完全不等待中间同步。5ms、18ms、70ms cadence 现均为全程零 `ok=false`、零 warning toast，目标 transaction 为 `semanticOk=true / checkpointTrusted=true / localizedListProofOk=true / ok=true`；source、save、cold reopen PASS。纯函数另覆盖 child 同时变化与 unrelated body edit 负例；RS-67/64/63、rich-list source、35/35 probes、source-fidelity UI、source-transaction-sync 全绿。** 专项：`test-rapid-nested-parent-backspace-lift-ui.mjs` |

| RS-69 | nested bullet item 末尾 Enter 新建空同层 sibling 时，源码 marker 丢失 nested indentation | 0.13.114 / PID 56855 现场 trace：`- 阿瑟费说 /   * 1\\. 额啊飞啊发` 中 nested item 按 Enter 后 PM/canonical 正确成为 `  * 1\\. 额啊飞啊发` + `  * <br />`，但 `middle-empty-block-list-filled` candidate 写成顶层 `* `，2026-08-25 03:41:15.945 首发 `source-list-structure-mismatch` | `nextChangedText` 在 middle-slot mapper 前会 trim，空 nested row 因而退成裸 `*`，旧 same-list 分支只继承 `sourceBefore` marker token、却用 trimmed `insertedMarker` 的空 indent。现在仅在左右 anchor 已唯一定位且 same list kind 的 continuation 分支中复用 `sourceBeforeMarker[1]` authored indent，同时保持既有 marker/delimiter 本地化；其它 list block 不继承该缩进，integrity 不放宽 | **修复归属 0.13.114；现场三态纯函数与 `test:nested-list-enter-empty-sibling-ui` PASS：1 个顶层 parent + 2 个 nested siblings，`middle-empty-block-list-filled / semanticOk=true / listSlotsMatch=true / ok=true / no toast`，source/save/cold reopen 稳定；RS-64、rich-list、35/35 probes、source-fidelity UI、RS-68 70ms、source-transaction-sync 全绿。** |
| RS-70 | existing task item 末尾 Enter 新建空同层 task sibling 时，candidate 发布为裸 `- [ ]` 并丢失 task 语义 | 0.13.114 / PID 58193 trace line 1050：`- [ ] 额粉色分` 在 03:58:00.803 按 Enter 后 PM 正确新增 unchecked 空 task，canonical 为 `- [ ] 额粉色分\n- [ ] <br />`；`middle-empty-block-list-filled` 却生成 `- [ ] 额粉色分\n- [ ]`，03:58:01.041 首发 `source-document-mismatch` | RS-50/66 已证明空 GFM task 不能用 bare marker 稳定持久化，必须使用 source-owned U+200B body sentinel。0.13.115 在已证明是 same-list middle-slot continuation 的分支识别 empty task placeholder，仅把新空 task body 写为 U+200B；marker、indent 与 authored list 本地化仍沿原分支，普通 empty list/非空 task 不命中。后续正文输入继续由既有 `empty-task-sentinel-filled` 消费 sentinel，integrity comparator 不增加例外 | **修复归属 0.13.115；现场三态纯函数与 `test:task-enter-empty-sibling-ui` PASS：Enter 后 2 个 unchecked tasks，`middle-empty-block-list-filled / semanticOk=true / listSlotsMatch=true / ok=true / no toast`；填入“距离近”由 `empty-task-sentinel-filled` PASS，source/save/cold reopen 稳定。RS-66、task persistence、RS-60、RS-69、35/35 probes、source-fidelity UI、RS-68 70ms、source-transaction-sync 全绿。** 专项：`test-task-enter-empty-sibling-ui.mjs` |
| RS-71 | 已有 source/canonical 分叉的长文档中，nested ordered item 快速输入标点后 Enter，新空 sibling 被写成顶层 `2. ` | 0.13.115 / PID 59363：04:11:57.082 在 `微风` 后输入 `、`，04:11:57.128（46ms 后）Enter；PM/canonical 正确得到 `   1. 微风、\n   2. <br />`，但事务走 `diverged-nested-list-change`，candidate 变成 `   1. 微风、\n2. `，04:11:57.401 trace line 22 首发 `source-list-structure-mismatch` | 新 item 分支在 ordered anchor 下已继承 authored delimiter，却没有携带 anchor raw leading whitespace。0.13.116 仅当 anchor 也是 ordered 且 `nextItem.indent === anchorRow.indent` 时继承精确 leading whitespace，再拼 authored delimiter；顶层 ordered 的 raw prefix 为空，因此行为不变；不同层和 bullet→nested-ordered 专用路径也不变，integrity comparator 无例外 | **修复归属 0.13.116；现场前缀纯函数明确命中 `diverged-nested-list-change` 并输出 nested `   2. `。永久 UI `test:diverged-nested-ordered-enter-ui` 用约 46ms `、`+Enter cadence：2 个 nested OL siblings，`semanticOk=true / listSlotsMatch=true / ok=true / no toast`，source/save/cold reopen PASS。RS-69、RS-70、35/35 probes、source-fidelity UI、RS-68 70ms、source-transaction-sync 全绿。** |
| RS-72 | globally-diverged 长文档中，单个空 ordered item 夹在两个非空 ordered siblings 之间时 Backspace，后继可能被 mapper 删除或触发 transient semantic mismatch | 0.13.116 / PID 60874：04:27:49.528 trace line 22 与 04:29:16.823 line 52 均首发 `source-list-structure-mismatch`。典型 before 为 `1. 吗。不开机；口红 / 2. <br /> / 3. 露娜了`；Backspace 后 PM 正确成为 `1. 吗。不开机；口红 / <br /> / 2. 露娜了`，其中 `<br />` 是前一 list item 的 editor-owned transient paragraph。旧 `empty-list-item-filled` 误认结构删除为“空项填正文”，可直接丢 successor；收窄后 broad `batched-list-block-changes` 又会丢 transient paragraph，形成 `semanticOk=false` toast | 0.13.117 将 `empty-list-item-filled` 所有权收紧为 row count/indent/token skeleton 完全相同、且唯一空 marker row 获得正文；新增 single-empty ordered Backspace 行级 proof，previous 必须唯一存在 consecutive ordinal 的 nonempty/empty/nonempty 三元组，next 必须唯一存在同左右正文、successor 补位以及单条 standalone transient `<br />`，source 也必须唯一对齐同三元组。命中后仅删除 authored empty row + 其后 gap，并只把 successor ordinal 改成补位值，保留 delimiter/spacing 与所有其它字节。只有这个 dedicated `diverged-empty-ordered-backspace-lift` reason 可忽略已证明的 editor-owned trailing empty list paragraph；旧 double-empty proof 仍留原 dispatcher 顺序 | **修复归属 0.13.117；`test:single-empty-ordered-backspace-successor-ui` PASS：2 个 ordered items、texts 保持 `吗。不开机；口红 / 露娜了`，dedicated reason、`semanticOk=true / listSlotsMatch=true / ok=true / no toast`，source/save/cold reopen 稳定。旧 `test-empty-ordered-backspace-lift-ui.mjs` 精确空行布局仍 PASS；纯函数门禁、RS-71/69/70、35/35 probes、source-fidelity UI、RS-68 70ms、source-transaction-sync 全绿。** 专项：`test-single-empty-ordered-backspace-successor-ui.mjs` |

| RS-73 | globally-diverged 长文档中，尾部 standalone image 在 canonical 被挂到深层 ordered item 后，rich Backspace 删除 image atom 但作者源码仍保留图片并触发 warning | `123321.md + plain` 的连续删除先正确删除测试 marker，再跨尾部空 paragraph 回到前一个深层 ordered item；下一 Backspace 删除 inline image atom。作者源码图片为顶格独立尾行，canonical 却缩进为 deepest ordered continuation；image atom 不贡献 visible characters，且全文已有合法 authored/canonical marker/Tab/spacing 分歧，因此 generic mapper 对这笔真实删除首次返回 `visible-stream-mismatch`。marker 删除本身已有 `diverged-tail-line-delete` owner，不是同一事务 | 0.13.118 新增 `preserveDivergedTailImageDelete`：previous canonical 最终非空行必须是 image；移除该行必须完整解释 previous→next（只容忍 terminal EOL 数量）；source 同 image token 必须唯一且也是最终非空行；source/canonical image 前一非空行 visible anchor 必须相同。证明成立后只删除 authored image row + 一个直接 EOL，不改周围 list marker、Tab、mixed indentation 或其它字节。该 owner 只在 diverged 分支最前执行；歧义/非尾部 image 不认领，generic visible/integrity gate 均不放宽 | **修复归属 0.13.118；永久 `test-rs73-diverged-tail-image-delete.mjs` PASS；真实 `123321.md` 连续 Backspace 中 image 删除为 `diverged-tail-image-delete / ok=true / semanticOk=true / listSlotsMatch=true / no toast`，该文件 ordered/unordered/plain/spaces/list-spaces 5/5 PASS。完整 4×5 matrix 仍有 `引用后输入手测.md` 与 `反馈.md` 的独立 baseline 红项，因此不得写成 20/20。** 专项：`diverged-tail-image-delete-regression.md` |

| RS-74 | 文档中同一行字面 ```` ```你好``` ```` 被 list-slot scanner 当成未闭合 fenced code，导致其后的真实列表槽位从 integrity fingerprint 中消失 | 真实 `HorseMD-0.13.33-引用后输入手测.md` 含同一行三反引号字面文本。0.13.118 的 scanner 见到该行即进入 fence 状态，后续 ordered/unordered append 在 source/canonical 两侧得到不同的 changed-group 视图，原始 `ordered` cell 稳定 `source-locked-after-append` / `source-list-structure-mismatch` | `source-structure-fingerprint.js` 改为结构化 fence scanner：opening fence 仍只允许 0–3 spaces + ≥3 同字符 backtick/tilde；backtick opener 的 info string 含 backtick 时不是 opener，因此 ```` ```你好``` ```` 保持普通文本；closing fence 必须同字符、run 长度 ≥ opener，且其后只能有 whitespace。真实 fence 内容仍完全排除，短 closing 和带正文 closing 都不能错误结束；integrity gate 本身未放宽 | **修复归属 0.13.119；`test-source-structure-fingerprint.mjs` 新增 literal same-line、short close、text-after-close 三组 PASS；build PASS；原始 `引用后输入手测.md + ordered` 全周期 PASS，同 fixture `unordered` 与 `spaces` PASS；35/35 probes、source-transaction-sync PASS。完整 matrix 仍非全绿：该 fixture `plain` 在 delete 阶段由 `diverged-tail-line-delete` 产生 list-slot-count mismatch，`list-spaces` delete 为 `visible-stream-mismatch`；`test:literal-triple-backtick-source-ui` 另因 candidate `# ```你好```` 被 Markdown 重新解释为 inlineCode 而失败，trace 为 `listSlotsMatch=true`，明确不是 RS-74 scanner。** 专项：`source-structure-fingerprint-fence-regression.md` |

| RS-75 | 分叉文档尾部两个相邻空 ordered slots 让“最后一项正文清空”被误判为“最后一整行删除” | 真实 `引用后输入手测.md + plain` delete 阶段：previous 尾部为 `1. <br />` + `1) 测试`，next 为 `1. <br />` + `1) <br />`。两个空 slot 的 visible body 都为空，`deleteCase` 用 `equivalentLine()` 把 next 最后一 slot 与 previous predecessor 错认成同一行，返回 `diverged-tail-line-delete`，candidate 删除 authored `1)` row，list fingerprint `list-slot-count` 少 1 并 fail closed | whole-row delete 新增 raw slot veto：只有 previous/next 最后一 raw 行 prefix 相同、缩进/marker token/marker spacing 完全相同，并且 body 从非空变成 blank 或 `<br />` 时，判定为 same-slot body-empty，不允许 delete owner 认领。随后既有 `diverged-nested-list-change` 只清正文并原样保留 `1)`；真正 row disappearance 因 raw tail prefix 不同，仍由 `diverged-tail-line-delete` 处理，integrity gate 不放宽 | **修复归属 0.13.120；独立 `test-rs75-tail-ordered-body-empty.mjs` 同时覆盖 body-empty 正例和 genuine row-delete 反例；完整 markdown-preservation PASS、build PASS；真实 `引用后输入手测.md + plain` append/save/delete/reopen 全周期 PASS。该 fixture `list-spaces` delete-stage `visible-stream-mismatch` 仍独立待处理。** 专项：`diverged-tail-ordered-body-empty-regression.md` |

| RS-76 | globally-diverged 文档中，source-owned leading-space sentinel 列表项删除正文后只剩空格时，没有 mapper 能拥有该零可见 tail edit | 真实 `引用后输入手测.md + list-spaces`：authored 尾行为 `* U+200B    家族验证<PID>`，canonical 为 `* &#x20;   家族验证<PID>`；删除 marker + 3 spaces 后 canonical 为 `*   `。全文 earlier source/canonical 已结构分叉，generic diverged visible mappers 全部 `visible-stream-mismatch`；旧 sentinel reconcile 只在 core 已 preserved 后执行，因此无法介入 | 新增 tail-only `preserveDivergedLeadingSpaceListWhitespaceTail`：canonical previous/next 前缀必须完全相同；previous final bullet 必须 `&#x20; + spaces + non-whitespace`，next 同 indent/marker 且只剩 horizontal whitespace；source final bullet 必须持 U+200B sentinel，且去 sentinel/解码 entity 后正文与 canonical previous 完全相等。成立时只替换 source 最后一行，保留 authored bullet token、复制 next spaces-only suffix并删除 sentinel。缺 sentinel、non-whitespace next、任何 earlier canonical 变化均拒绝；integrity gate 不放宽 | **修复归属 0.13.121；`test-rs76-leading-space-list-whitespace-tail.mjs` 覆盖正例和 3 个 fail-closed 反例；解析证明 U+200B 留在 spaces-only row 会变成真实 paragraph text；build PASS；真实 `引用后输入手测.md + list-spaces` append/save/delete/reopen 全周期 PASS；随后 0.13.121 完整 matrix 中该 fixture 5/5 PASS。** 专项：`diverged-leading-space-list-whitespace-tail-regression.md` |

| RS-77 | ordinary localized-change 已正确删除 leading-space list 正文，但 sentinel post-process 按 previous visible body 查找 result 行，正文变空后找不到目标并遗留 U+200B | 真实 `11111.md + list-spaces`：source `* U+200B    家族验证<PID>`，canonical previous `- &#x20;   家族验证<PID>`，next `-   `。core 返回 `localized-change` 且 candidate 为 `* U+200B  `；`reconcileLeadingSpaceSentinelTransition` 仍用 previous visible body 找 result candidate，因此 resultCandidates=0。解析 candidate 后 U+200B 成为真实 paragraph text，strict integrity `semanticOk=false / listSlotsMatch=false` | 不新增 mapper；扩展 existing reconcile 的 zero-visible fallback：source sentinel row 必须由 previous visible body 唯一证明，normal result lookup 必须为空，next visible 必须为空，source/result line count 必须相同，同一 source 行序号的 result row 仍必须含 sentinel；随后移除 sentinel 后 visible text 必须精确等于 next，才允许修正。其它 lookup/歧义场景不变 | **修复归属 0.13.122；独立 `test-rs77-localized-leading-space-sentinel-empty.mjs` PASS；完整 markdown-preservation PASS、build PASS；真实 `11111.md + list-spaces` append/save/delete/reopen 全周期 PASS；正式 0.13.122 完整 4×5 matrix 为 19/20，仅剩 `反馈.md + plain`。** 专项：`localized-leading-space-sentinel-empty-regression.md` |

| RS-78 | globally-diverged 文档尾部已有 bullet item 正文被清空时，generic visible mapper 无法从复杂历史分叉中证明同一 slot，源码停在旧正文 | 真实 `反馈.md + plain`：该文件尾部本就在 bullet list；family 的 Enter + plain marker 因此生成新的 bullet item。保存重开后 source 为 `- 而为`、canonical 为 `* 而为`；删除正文后 PM/canonical 为同一 slot 的 `* <br />`。文档更早位置已有空 blockquote、empty bullet + nested ordered continuation、marker/loose spacing 等合法结构分叉，因此 core 首次返回 `visible-stream-mismatch` 并锁住 source | 新增 final-row-only `preserveDivergedTailBulletBodyEmptied`：previous/next canonical 除最后内容行外必须 byte-identical；final 两行必须同 indent/bullet token/marker spacing，只允许 body 非空→空；authored source 必须以同 indent 的非空 bullet 结尾，且 source/canonical final body visible text 精确相等。成立时只删除 authored body，保留原 marker、spacing、EOL 和所有前文；batched earlier change 与错误 source tail 均拒绝。RS-76 sentinel owner 保持更高优先级 | **修复归属 0.13.123；永久 `test-rs78-diverged-tail-bullet-body-empty.mjs` 使用完整现场三态并覆盖两个 fail-closed 反例；完整 markdown-preservation、structure fingerprint、35/35 probes、source-transaction-sync 与 build PASS；真实 `反馈.md + plain` 全周期 PASS；正式 0.13.123 完整 4×5 matrix 20/20、exit 0。** 专项：`diverged-tail-bullet-body-empty-regression.md` |

| RS-79 | transaction-first 已拥有 plain paragraph transaction，但 `markdownUpdated` 仍先运行 legacy preservation/integrity，造成瞬时 `ok=false` 后再被 authority 自愈 | 1000 段、120KB+、BOM+CRLF authority-on fixture：首段 insert 与尾段 replace 的 transaction candidate 都正确且最终 publication 为 transaction，但 legacy `localized-change` 先在 `primary-preserved` 与 `before-input-rule-fallback` 各报一次 semantic mismatch，共 4 次 first-divergence；中段 Backspace 无此红项。parser semantic diff 精确落在被 authority 拥有的目标段，证明不是全局 BOM/CRLF 或 list fingerprint 问题 | authoritative callback 的顺序改为 transaction-first：仅当无 paste/list/generated/special intent、checkpoint mode=AUTHORITATIVE、`transaction.ok=true`、family 精确为 allowlisted `plain-paragraph-inline-replace`，且 callback canonical parse-equivalent 于当前 PM doc 时，先用 `legacyResult=null` reconcile 并直接 publication；任一 proof 缺失即不消费 checkpoint，继续既有 legacy path。rejected/syntax/structural/list 编辑仍由 late reconcile 记录真实 legacy fallback。SourceRangeMap 同时使用一次 parse/collect 的 prepared PM→Markdown mapper，避免长文档每个段落两次全文 parse | **修复归属 0.13.124；`test:transaction-first-authority-ui` 覆盖 owned insert/delete/replace 与 syntax/split/list fallback；`test:transaction-first-authority-large-doc-ui` 覆盖 1000 段 BOM/CRLF 首/中/尾三笔 owned edit、first-divergence=0、source/save 精确，测得约 0.7s / 0.7s / 1.75s；shadow/policy/core/source-map/markdown-preservation/source-transaction-sync 全 PASS；默认 4×5 matrix 20/20。authority 仍默认关闭，manual 长文档资格仍待执行。** 专项：`transaction-first-authority-first-divergence-regression.md` |
| RS-80 | 退出有序列表后，单独输入并发布 `-`，再按 Space 触发 bullet input rule 时，旧 caret/whole-list 映射可能丢 marker、复制前一 sibling 或产生 source/list mismatch | 真实物理按键链：有序列表连续 Enter 退出 → 等待 `\\-` 中间帧完成 → Space；旧路径在 canonical 已合并相邻 bullet tree 后仍按旧 PM offset 或整个 list block 重建，首次分叉可表现为新 `-` 消失、前一 bullet 重复或保存/源码切换被阻止 | 0.13.125 将 exact escaped marker 行作为事务所有者：previous canonical 中按同级 bullet 序号唯一定位该 literal，next canonical 中只取对应新 item，保留 authored marker/缩进并局部替换；快照漂移、重复锚点和跨层级情况继续 fail closed，strict semantic/list-slot gate 未放宽 | **修复归属 0.13.125；`test:human-list-exit-dash-space-ui` 覆盖 `-` 单独发布帧、Space input rule、源码切换和零 toast；`test:fast-empty-bullet-ordered-input-rule-ui`、`test:list-exit-literal-ordered-before-fence-ui`、`test:ordered-enter-next-item-ui`、`test:input-intent-staleness-ui` 以及 markdown/list/code/save-reopen 回归全部 PASS。** |
| RS-81 | inline-code plugin-owned callback 接入统一 Coordinator 后，整行字面三反引号与第三个反引号中间帧首次被严格 semantic gate 拒绝；旧直接 publication 曾掩盖不可 round-trip 的 parser 结构变化 | 最终 ` ```你好``` ` 在 live PM 中是普通 paragraph/heading text，但 CommonMark/remark 将同一 raw bytes 解析成 `inlineCode`；第三个反引号刚到达、尚未按 Space 时，live PM 仍是普通文本块，而裸 ` ``` ` 被解析成无 closing 的空 `code_block`。RS-74 已只修复 list-slot scanner，trace 明确 `listSlotsMatch=true`，因此不得继续放宽 scanner 或 semantic integrity | 0.13.126 新增 parse-side exact raw proof：paragraph/heading 必须只有一个 inlineCode child，child 的 mdast position 原始切片必须是单行且恰好三个 backticks 开闭；中间 bare fence 只接受 `code` node 无 lang/meta/value，raw 精确为三个 backticks 加可选 no-EOL/LF/CRLF。命中后恢复为包含 delimiter 的普通 text；embedded triple、单/双/四 backtick、info/content/closed/tilde/六 backtick fence 全部保持标准语义。inline-code callback 同时删除 direct source/canonical/onChange 写回，改走 revision-bound legacy candidate publication | **修复归属 0.13.126；`test:literal-triple-backtick-parser` 正负合同 PASS；`test:inline-code-ui` 真实中文 IME、closing delimiter、方向键退出、Coordinator boundary、integrity false=0、source/save/cold reopen PASS；`test:literal-triple-backtick-source-ui` 空文件 H1 逐键 + IME、source/save/reopen rich `codeCount=0` PASS；build 与 editor-input PASS。** 专项：`literal-triple-backtick-parser-regression.md` |
| RS-82 | 分叉长文档中，紧跟 ordered list 的非空 bullet 段首项按 Backspace 后，PM 把整段并入左侧 ordered list，legacy mapper 返回 `unmapped-diverged-list-batch`；错误保留后续 `1.` 又会在冷重开吞并独立列表 | 0.13.126 正式安装包 PID 81568，2026-08-26 13:40:32.227 trace line 13：`2. 斛律v哦` 后的 `* u高科技 / * 1\\. 色粉色分` 变为 `3.` / `4.`，紧随其后的 `1. 啊额法色饭` 同 callback 变为 `1)`。generic diverged loop 能看见局部 marker 变化，却因全文已有 list spelling divergence 无法原子拥有；第一次修复若只改两个 bullet marker，source 看似正确但 CommonMark 将后续 `1.` 继续并入同一 `.` ordered list，冷重开边界错误 | 新增 raw family owner `preserveNonEmptyBulletListBackspaceMergeIntoOrdered`：唯一证明 top-level ordered left、完整 flat non-empty bullet segment、正文/spacing 不变、连续 ordinal、source target 唯一；紧邻 following ordered row若与 left delimiter 相同，next 必须只切换该唯一 following delimiter作为 parse-safe separator，若原本已分隔则必须保持。只改移动项 marker 与必要 separator marker，nested child、CRLF、fence、U+200B 和其余源码逐字不动；错误 ordinal、同 callback 无关正文编辑、歧义 source 均拒绝。proof 在 `normalizeOrderedListDelimiters()` 前运行，避免 `1)` 证据被归一化抹除，通用 integrity 不放宽 | **修复归属 0.13.127；真实 trace 三态、CRLF、错误编号与无关正文反例进入完整 markdown-preservation；`test:nonempty-bullet-backspace-merge-ordered-ui` 覆盖物理 Backspace、专用 reason、`semanticOk/listSlotsMatch/ok=true`、零 toast、精确 source/save/cold reopen。相邻 empty-bullet mirror、RS-54、list conversion、source transaction、rich-list、35/35 probes、异构 source-fidelity UI 与 RS-68 5/18/70ms 全部 PASS。** 专项：`nonempty-bullet-backspace-merge-ordered-regression.md` |
| RS-83 | 退出 ordered list 后在中间空段连续输入 `---`，第三键触发 hr input rule；富文本出现独立分隔线，但 source candidate 把 `***` 粘成上一项正文后缀并立即报 mismatch | 0.13.127 正式安装版 PID 85614，2026-08-26 15:17:23.243 trace line 630 首发 `source-document-mismatch`。两次 Enter 已把 `3. 3fresh` 与后续 `1. 是干嘛的了；吗` 分成两棵 ordered lists；第一键 `-` 由 `middle-empty-block-filled` 正确发布为独立 `\\-`。第二、第三键在 source callback 前合并，PM 用 `replace` 创建 `hr`，canonical 为独立 `***`。thematic break 不贡献 visible chars，旧 `locally-aligned-change` 的零宽 offset 对上一块产生 backward affinity，candidate 变为 `3. 3fresh***`；strict semantic gate 正确拒绝 | 新增 `preserveEscapedStandaloneThematicBreakInputRule` / reason `escaped-standalone-thematic-break-input-rule`，排在 generic visible mapper 前。只接受 previous 中独立 `\\-` 行原位变为 next 的独立 `***`/`---`/`___`，canonical prefix/suffix byte-identical，上下均有真实 blank block gap，source 中由未变的上下可见邻居唯一定位同一 `\\-` 行且目标不在 paired fence 内；重复目标、同 callback 无关正文变化、普通 `--x` 扩写全部拒绝。命中时仅将 authored target row 改为用户实际输入的 `---`，保留 CRLF/EOL、列表边界、marker、U+200B、fence 与全部其它字节；semantic/list integrity 不放宽 | **修复归属 0.13.128；完整 PID 85614 约 5.5 MB trace line 633 三态直接回放命中专用 reason；markdown-preservation 正反/CRLF合同 PASS，source probes 36/36；`test:middle-thematic-break-input-rule-ui` 覆盖真实两次 Enter、`\\-` 中间帧、第二/第三键 coalesced hr、forced flush、`semanticOk/listSlotsMatch/ok=true`、零 toast、精确 source/save/cold reopen。RS-59、dash+Space、RS-82、source transaction、异构 source-fidelity UI 与 RS-68 5/18/70ms 全部 PASS。** 专项：`middle-thematic-break-input-rule-regression.md` |
| RS-84 | 跨 bullet→ordered→bullet 的反向选区按 Backspace 后，PM 原子留下一个空 bullet，但 legacy broad list mapper 分块对账失败；紧接第二次 Backspace 又在 stale baseline 上只删半段 | 0.13.128 正式安装版 PID 90936：2026-08-26 16:07:25.136 trace line 29 首发 `unmapped-diverged-list-batch`。选区从 `- 看了呢分` 正文开头跨过独立 `2. 斛律v哦` 到后续 `- u高科技` 正文末尾；PM replace 合法生成 `* <br /> / * 1\\. 色粉色分`。第一拍未提交后，16:07:25.620 line 35 的第二拍仍用旧 source/canonical，`empty-list-item-removed` 只能删第一条 authored bullet并触发 `source-list-structure-mismatch`。自动化在修好第一拍后进一步发现：第二拍虽能过 strict integrity，旧 prefix collapse 仍会把 `吗；啊嗯\n\n- 1\\.` 静默压成单换行 | 新增 raw owner `preserveCrossListSelectionDeleteToEmptyBullet` / reason `diverged-cross-list-selection-delete-to-empty-bullet`，在 `<br />` normalization 与 broad list batch 前运行。只接受唯一顶层非任务 bullet→ordered→bullet 三行、两处真实 block gap、完整行正文被一个同 token 空 bullet 原位替换、前后 canonical byte-identical、左右可见锚与 source target 唯一且不在 fence；只把三行 source range 替换为首行 authored bullet prefix。第二拍继续由 `empty-list-item-removed` 拥有，但其 prefix collapse 新增严格例外：被删行是普通块后新列表的顶层空首项、其后仍有顶层 bullet且左邻非列表时，保留作者 block gap；列表内部 Enter placeholder 仍按旧合同压缩 | **修复归属 0.13.129；PID 90936 两拍按修复后的 canonical baseline 链式回放通过；纯函数覆盖 LF/CRLF、重复 source target、无关正文 edit、非空 replacement 和第二拍空行；source probes 37/37。`test:cross-list-selection-delete-empty-bullet-ui` 用真实 backward DOM selection + 两次物理 Backspace，逐拍 `semanticOk/listSlotsMatch/ok=true`、零 warning、精确 source/save/cold reopen。相邻普通/嵌套空 bullet、RS-59、RS-68 5/18/70ms、RS-72、RS-82、RS-83、dash+Space、source transaction 与异构 source-fidelity UI 全部 PASS。** 专项：`cross-list-selection-delete-empty-bullet-regression.md` |
| RS-85 | 空的第二个顶层 ordered 父项仍持有 nested ordered child，再按 Backspace 后，PM 把 child 并入前一项并在 child 前保留一个空段；正确 source 因不能编码该空段被 strict semantic gate 拒绝 | 0.13.129 正式安装版 PID 94298，2026-08-26 17:03:36.558 trace line 589 首发 `source-document-mismatch`。现场从 `1. 是共生共荣 / 2. 距离近 /    1. 如何电话` 开始，先清空第二项正文，再按一次 Backspace。line 591 显示 source 为 `1. 是共生共荣\n2. \n   1. 如何电话`，previous canonical 为 `2. <br />` + child，next canonical 为前一项正文后 `   <br />` + child；旧 `empty-list-item-removed` candidate 已只删除 `2. ` 且 `listSlotsMatch=true`，但 PM 中间空段使 `semanticOk=false` | 新增 `preserveEmptyOrderedItemBackspaceMergeBeforeNestedList` / reason `empty-ordered-item-merged-before-nested-list`，在 raw canonical 阶段证明唯一顶层 ordered left、连续空 sibling、未变 nested ordered child、next 空段与 child 同缩进、change range 相交、left prefix 与 child suffix byte-identical、source 唯一 compact 三元组且不在 fence；只删除 authored 空父项行。semantic comparator 不做通用放宽：仅该 reason 启用一侧全篇恰好一个“非空 paragraph→空 paragraph→ordered_list”候选、另一侧零候选的配对消除；两侧都有、任一侧多个、候选错位、正文中段或 bullet child 全部拒绝 | **修复归属 0.13.130；PID 94298 line 591 真实三态直接回放命中；compact/loose previous、LF/CRLF、编号/缩进/重复/无关编辑及全局语义歧义正反合同 PASS；source probes 38/38。`test:empty-ordered-parent-before-nested-backspace-ui` 从空文档真实逐键造现场并物理 Backspace，验证专用 owner、`semanticOk/listSlotsMatch/ok=true`、零 warning、精确 source/save/cold reopen。RS-56、RS-63、RS-68 5/18/70ms、RS-72、RS-82、RS-83、RS-84、source transaction 与异构 source-fidelity UI 全部 PASS。** 专项：`empty-ordered-parent-before-nested-backspace-regression.md` |
| RS-86 | 已有后继 bullet 时，在中间非空 bullet 末尾快速连续按两次 Enter；第一拍创建空 bullet，第二拍在 source callback 前把它提升为顶层空段，后继项仅因列表拆分发生 marker 重序列化，但 generic empty-row owner 把后继项误当成被删除的空行 | 0.13.130 正式安装版 PID 258：2026-08-27 04:02:31.215 line 323 在 `- 12312` 末尾按第一拍 Enter，line 324 的 PM replace 创建位于后继 `- 1\\. 色粉色分` 前的空 bullet；04:02:31.466 line 327 第二拍 Enter，line 328 replaceAround 将空 bullet 退出为顶层空 paragraph。延迟 callback 的 previous canonical 仍为 `- 12312\n\n- 1\\. 色粉色分`，next 为 `- 12312\n\n<br />\n\n* 1\\. 色粉色分`。后继正文未变，仅 marker 因新列表序列化从 `-` 变为 `*`；旧 `empty-list-item-removed` 把 marker residue 视为“删除行”，line 331 candidate 丢掉后继项，line 332 strict semantic gate 报 `source-document-mismatch` | 新增 raw owner `preserveCoalescedEmptyBulletExitBeforeSibling` / reason `coalesced-empty-bullet-exit-before-sibling`，在 `<br />` normalization 与 generic empty-row removal 前运行。previous 必须有唯一顶层、非任务、非空 middle/right bullet pair 与真实 block gap；next 必须只在两行之间插入一个未缩进 `<br />`，middle token/spacing/body 全不变，right spacing/body 全不变且 token 必须恰好变化；两个新 gap 必须逐字等于旧 gap，文档前缀到 middle 行尾及 right 行尾后的完整 suffix byte-identical；source 中同一可见正文 pair 必须唯一且不在 fence。命中后 source 完全不变，仅发布新 canonical baseline；不需要 semantic 放宽，也不进入 generated-scratch 专用 allowlist | **修复归属 0.13.131；PID 258 line 331 完整长文档 source/previousCanonical/canonical 直接回放命中专用 reason，源码逐字不变、后继 `- 1\\. 色粉色分` 保留、目标局部不新增 `<br />`。纯函数覆盖 LF/CRLF、普通 all-`*` 控制组、前项/后继正文夹带编辑、缩进空段、重复 source target、无关前文变化及 fence 负例；source probes 39/39。`test:rapid-double-enter-bullet-exit-before-sibling-ui` 物理输入三项并快速双 Enter，证明普通 all-`*` 路径继续由 `middle-empty-block-created` 拥有，专用 owner 不抢占，源码/save/cold reopen 稳定。RS-51、54、63、68 5/18/70ms、82、83、84、85、source transaction、structure fingerprint 与异构 source-fidelity UI 全部 PASS。** 专项：`rapid-double-enter-bullet-exit-before-sibling-regression.md` |

### 4.1 RS-68 真实快速 Backspace 回归：fixture、测法与注意事项

RS-68 的永久回归不是“逐拍等待同步后再按键”的功能测试，而是专门模拟真实用户连续删除时多个 ProseMirror transaction 被 deferred `markdownUpdated` 合并的情况。专项脚本为 `scripts/test-rapid-nested-parent-backspace-lift-ui.mjs`，npm 入口为 `test:rapid-nested-parent-backspace-lift-ui`。

#### Fixture

测试必须使用已有 authored 长文档，而不是从空文档临时造一个两行列表。当前 fixture 故意同时保留 marker、spacing、nested list 与 U+200B 等历史 source/canonical 拼写分歧，避免测试只在“干净 canonical”上通过：

```md
# RS68

- 可就是被科技部
- 老板老板娘
  - s 入了你看你了

- u高科技

1. 啊额法
   1. 微风

-   1. 二哥你来拿如果
  - ​     就了解了呢
  * 如果可能老顾客

后文
```

目标编辑是把光标放在 `1. 啊额法` 父项正文末尾，然后连续发送 **4 次 Backspace**：前三次删除“啊 / 额 / 法”，第四次在父正文已经空时继续 Backspace，使空 ordered parent 被 ProseMirror 提升/并入前面的 bullet list，同时 nested ordered child `1. 微风` 必须仍属于同一父项。

成功后的 authored source 必须精确为：

```md
# RS68

- 可就是被科技部
- 老板老板娘
  - s 入了你看你了

- u高科技

-<space>
   1. 微风

-   1. 二哥你来拿如果
  - ​     就了解了呢
  * 如果可能老顾客

后文
```

这里代码块中的 `-<space>` 表示源码里的空 bullet `- `；它与 child `   1. 微风` **之间不能插入 serializer 空行**。`- \n\n   1. 微风` 会被 Markdown parser 拆成两个顶层列表，属于结构错误；源码中也不能泄漏 `<br />`。

#### 具体怎么测

1. 用独立临时 profile 打开 fixture，并启用 `--horsemd-input-trace`。编辑器挂载后清空 `__hmPreserveLog`、`__hmSourceIntegrityTrace`、`__hmSourceIntegrityDiffTrace`，避免把启动阶段数据混入断言。
2. 把 caret 精确放到 `啊额法` 父项正文末尾。随后连续发送 4 次物理 Backspace。**四个键之间只使用 `RS68_KEY_DELAY`，绝不等待 markdown/source settle。** 所有按键完成后才统一等待约 1100ms，让 deferred callback 全部落地。
3. 至少跑三档 cadence：
   - `RS68_KEY_DELAY=5 CDP_PORT=10968 npm run test:rapid-nested-parent-backspace-lift-ui`
   - `RS68_KEY_DELAY=18 CDP_PORT=10978 npm run test:rapid-nested-parent-backspace-lift-ui`
   - `RS68_KEY_DELAY=70 CDP_PORT=10988 npm run test:rapid-nested-parent-backspace-lift-ui`
4. 富文本态检查：空父项仍存在且已是 `UL`；父正文为空；child 文本仍为“微风”；child 仍为 `OL` 且 DOM 上仍嵌套于该父 `LI`，不得逃逸成顶层列表。
5. preservation 检查：至少一笔 callback 必须由 `rapid-nested-ordered-parent-backspace-lift` 认领，不能退回 broad `visible-mismatch-line-change` 后靠下一 callback 偶然修复。
6. integrity 检查：**整个 trace 中不能出现任何 `ok=false`**。目标 callback 至少满足 `semanticOk=true`，并且 `listSlotsMatch=true` 或经过 mapper 提供的真实 ranges 独立重切片后 `localizedListProofOk=true`。历史 authored/canonical divergence 可以让全组 `listSlotsMatch=false`，但不能绕过局部 strict ordered-number + strict nesting proof。
7. UI 检查：整个测试窗口内不能出现“检测到富文本与源码不一致 / 保存已暂停”等 warning toast。即使下一 callback 自动恢复，前一 callback 已经报错也仍判失败。
8. 切到源码模式，逐字比较 textarea 与上面的 expected source；额外断言没有 `<br />`，也没有 `- \n\n   1. 微风` 这种 parse-breaking 空行。
9. 切回富文本并显式保存，逐字读取磁盘文件，必须与 source textarea 完全一致。
10. 关闭测试实例，用新的临时 profile 冷重开同一文件；再次验证空 bullet parent、nested ordered child 的类型和层级，并切源码确认磁盘字节未被 reopen serializer 改写。

#### 验收标准与注意事项

- **不要在每次 Backspace 后 sleep / waitFor source。** RS-67 旧测试每拍等待约 950ms，等于人为制造中间 checkpoint，正是它漏掉 RS-68 的原因。
- **不要只看最终 source 是否正确。** 任何中途 `ok=false` 或 warning toast 都算失败；“下一 callback 自愈”不是通过。
- **不要为了让专项变绿而放宽全局 integrity gate。** RS-68 的局部 proof 必须由 mapper 唯一定位的真实 source/canonical before/after ranges 重新切片，并分别做 strict numbering + strict nesting 校验。
- **目标之外只容忍 serializer-only bullet marker 漂移。** 只有同缩进、同 spacing、同 body 的 `* / - / +` marker 单字符变化可视为非用户编辑；ordered token、正文、缩进、child 内容或层级变化都必须 fail closed。
- **端口和 profile 要隔离。** 多 cadence 连跑时使用不同 `CDP_PORT` 和临时 profile，避免前一 Electron 实例、source checkpoint 或 toast 污染下一档。
- **当前 0.13.114 的真实矩阵状态：5ms PASS；18ms PASS；70ms PASS。** 70ms 最后一个红项已定位为 forced `flushMarkdown()` 对同一 preservation result 验证时漏传 `integrityProof`，不是 mapper candidate 或局部 strict proof 本身错误。修复后首个 forced flush 就携带 `localized-list-slots` proof 并 `localizedListProofOk=true / ok=true`；三档整个 trace 均零 integrity failure、零 warning toast，source、save、cold reopen 全部通过。

## 5. 事务级防护方法论（统一提交协议）

所有富文本 → 源码的候选都遵循同一协议，不再按“表格 bug / 列表 bug / 空段 bug”分别加例外：

1. **单一提交边界**：以当前 ProseMirror transaction batch 为单位处理；未能完整映射的 batch 不允许部分提交。
2. **双重证明**：候选源码必须同时通过 parser 语义比较和 raw Markdown 结构指纹。语义相同不代表源槽位相同，尤其是 ordered-list 编号和空项。
3. **双快照原子推进**：只有候选通过全部证明，才同时推进 `lastMarkdownRef` 与 `canonicalMarkdownRef`；失败时保留旧作者源码和 pending 状态。
4. **fail-closed durability**：源码切换、保存和重开前再次验证 live ProseMirror 文档；失败只通知，不写旧源码、不清 pending、不静默恢复。
5. **证据优先定位**：日志记录 physical key、transaction steps、canonical/source 候选、首次失败 reason 和结构差异；修复必须以第一笔分叉事务为回归，而不是以最后的错误源码做字符串替换。
6. **家族门禁**：每个新结构回归必须同时覆盖普通编辑、连续输入、源码切换、保存和冷重开；任一成员失败，整个家族保持保护状态。

## 6. 代码归属

### 5.1 保真核心

- `src/renderer/src/markdown-source-preservation.js`：公共 façade、处理器优先顺序和出口合同。
- `src/renderer/src/lib/markdown-preservation/core.js`：common change、行定位、换行与 canonical/source 基础适配。
- `src/renderer/src/lib/markdown-preservation/paragraphs.js`：段落创建、填充、清空和 `<br />` 占位处理。
- `src/renderer/src/lib/markdown-preservation/lists.js`：marker、层级、列表转换、数字点列表与列表项序列映射。
- `src/renderer/src/lib/markdown-preservation/regions.js`：局部对齐、行区域、分叉块和跨块删除回退。
- `src/renderer/src/components/editor-source-transactions.js`：统一真实 transaction batch 观察器与显式测试 trace。
- `src/renderer/src/lib/source-transaction-sync.js`：方案一的原子 transaction→raw source 映射器；当前生产不默认接管。
- `src/renderer/src/lib/markdown-preservation/tables.js`：表格局部编辑与 cell `<br>` 边界。
- `src/renderer/src/lib/markdown-preservation/frontmatter.js`：YAML 文档头边界，避免正文 `---` / `Q3:` 误判。
- `src/renderer/src/lib/markdown-leading-space.js`：新增前导空格 sentinel 的写法和 parse-side 清除。

### 5.2 编辑器生命周期与强制同步

- `src/renderer/src/components/Editor.jsx`：`markdownUpdated` 注册、双快照、pending user edit 与 Crepe 生命周期。
- `src/renderer/src/components/editor-api.js`：强制序列化当前 `view.state.doc`、切换/保存调用的 editor API。
- `src/renderer/src/components/editor-crepe-setup.js`：remark/parser 插件和编辑器能力接线。
- `src/renderer/src/hooks/useSourceModeSwitch.js`：source/rich 状态机、同步方向、光标与视口意图。
- `src/renderer/src/hooks/useFileOps.js`：保存前取 live Markdown、同步 `tabsRef`、写盘边界。
- `src/renderer/src/App.jsx`：每个 tab 的 editor/source refs 和顶层接线；不要把局部修补继续堆在这里。

### 5.3 光标和源码字节

- `src/renderer/src/mode-visible-map.js`：visible stream、snippet 和 raw offset 辅助映射；前导空格 sentinel 不计入用户可见字符。
- `src/renderer/src/components/editor-source-map.js`：Markdown raw offset ↔ ProseMirror position 的主映射。
- `src/renderer/src/scrollAnchor.js` 与 `mode-*.js`：稳定 façade、caret/viewport/heading 的具体实现。
- 源码 textarea 的 `liveContentRef` / `commitLive`：保持 uncontrolled，不可改成每次键入都由 React 重绘的受控组件。

## 6. 自动化回归矩阵

### 6.1 每次修改保真核心必须运行

```bash
node scripts/test-markdown-source-preservation.mjs
npm run test:source-map
npm run test:source-text-fidelity
npm run test:source-fidelity-ui
npm run test:family-multicycle-ui
npm run test:mode-switch-raw-offset-ui
npm run test:new-source-fidelity-ui
npm run build
```

### 6.2 涉及列表、空段落、删除、前导空格时追加

```bash
npm run test:new-document-list-source-ui
npm run test:list-conversion-ui
npm run test:nested-number-list-source-ui
npm run test:diverged-list-structure-ui
npm run test:diverged-delete-source-ui
npm run test:diverged-partial-delete-ui
npm run test:full-doc-delete-source-ui
npm run test:empty-blockquote-removal-ui
npm run test:mixed-rich-source-transaction-ui
npm run test:list-item-literal-marker-source-ui
npm run test:code-fence-delete-source-ui
npm run test:diverged-ordinary-save-ui
npm run test:literal-triple-backtick-source-ui
npm run test:empty-paragraph-source-ui
npm run test:empty-paragraph-caret-ui
npm run test:mode-switch-caret-settle-ui
npm run test:leading-space-entity-ui
npm run test:rich-source-continuous-fidelity-ui
npm run test:rich-source-chaos-ui
npm run test:task-list-persistence-ui
```

### 6.3 输入测试规则

1. 输入规则、回车、列表、反引号、光标和模式切换必须通过 `scripts/lib/human-input.mjs` 逐字符提交。
2. CDP 默认后台运行，不抢用户键鼠和窗口。
3. 只有粘贴语义、fixture 初始化或与增量输入无关的场景才允许 bulk insert。
4. 涉及时序、按住空格、真实组合键或 CDP 与用户结果不一致时，追加 macOS CGEvent 前台测试；方法见 `macos-real-input-testing.md`。
5. 所有数据丢失类场景至少验证：富文本界面 → 首次源码 → 再切富文本 → 第二次源码 → 保存 → 完整关闭重开 → 磁盘原文。

## 7. 人工必测场景

### 7.1 普通段落

- 手打标题、正文、连续回车和多段正文；切换两次模式，内容和光标都不变。
- 在中间段落输入内容再删除，不能出现 `<br />`。
- 全选删除并保存，重开必须为空。
- 只删除部分段落或文档尾部，重开后不能复活。

### 7.2 列表

- 分别手打 `-`、`*`、`+`、`1.`，包括二三级嵌套；marker 和层级不变。
- 删除列表 marker、删除列表项文字、删除整项，再继续新增有序/无序列表。
- 在第一层转换列表类型，二三级不变；在第二层转换，一级和三级不变。
- 覆盖 `- 1. 文本`、空列表项、任务列表勾选、相邻不同 marker 列表。
- 在有序和无序列表项正文逐字输入 `1. 测试`、`1) 测试`、`- 测试`、`+ 测试`、`* 测试`；源码不得增加反斜杠，后续未编辑列表的 marker 和空行不得变化。自动化：`npm run test:list-item-literal-marker-source-ui`。
- 每一步都立即切源码，并在最后保存重开。
- 在同一已有文件中快速执行“改标题 → 删除中间列表文字 → 修改后文列表”，不等待回调立即切源码；旧文字必须消失，新文字必须齐全。自动化：`npm run test:mixed-rich-source-transaction-ui`。

### 7.3 特殊拼写

- `0~9`、字面 `*`、反斜杠、HTML entity、行内代码、LaTeX、中文标点。
- 按住 Space 输入多个前导空格后再打字：源码不得出现 `&#x20;`，切换不能卡住。
- 既有文件中的空格和转义不得被 HorseMD 主动改写。
- 逐字输入一个/三个反引号，分别做部分删除、全部删除、继续输入正文，并在最后一个按键后立即切源码和立即保存；不得出现保存暂停或源码切换锁死。文档含两条相同反引号行、独立空段落、Setext 标题和未编辑列表时也必须通过。自动化：`npm run test:code-fence-delete-source-ui`。
- 在同时含嵌套 `- -`、字面三反引号、空引用以及多处重复短文本的既有文件中，编辑独立重复正文后不切源码直接保存；保存不得暂停，源码、磁盘和完整重开必须一致。自动化：`npm run test:diverged-ordinary-save-ui`。
- 行内代码必须按完整 `` `正文` `` 才创建：只输入左反引号和正文时，方向键不得凭空补出右反引号；输入真实闭合反引号后，左右方向键应能从已渲染 code 边界退出。段落追加回归与专项行内代码回归必须使用同一合同，不能让旧测试继续模拟“首字符自动激活”。自动化：`npm run test:paragraph-source-ui`、`npm run test:inline-code-ui`。
- 在真正空白的新文件中逐键输入三个反引号，以真实中文 IME 提交“你好”，再逐键输入三个反引号；富文本保持普通正文，源码必须逐字为 ```` ```你好``` ````，每个反引号前不得出现 serializer 反斜杠，保存并完整重开仍一致。自动化：`npm run test:literal-triple-backtick-source-ui`。
- **RS-41 安装包长会话**：使用真实长文档临时副本，在末尾通过 `/code` 建立代码块，
  逐字编辑代码，退出后输入正文，再回到邻近列表/正文做新增、删除和改写；至少连续 10 轮，
  交替覆盖“先保存后切源码”和“先切源码后保存”。每轮必须比较 live 富文本、首次源码、
  第二次往返、磁盘和冷重开；任何一份缺内容都算失败。详见
  `rich-source-divergence-incident-0.13.47.md`。

### 7.4 光标

- 在文档开头、中间、末尾和重复关键词处切换模式。
- 在空段落、列表项、标题、行内代码前后切换。
- 执行“输入 `.` → 删除 → 输入 `/` → 删除 → 切源码”，光标仍在相同语义位置。

## 8. 已知边界与长期风险

1. **双表示同步本身复杂**：ProseMirror 不保存全部 Markdown 拼写信息，HorseMD 只能用作者源码 + canonical delta 重建局部修改。
2. **语法信息已经丢失时不能猜**：同一段文字重复出现、结构跨度不清或多种 raw 写法都可能匹配时，必须拒绝大范围覆盖并保留诊断证据。
3. **反斜杠仍是高风险字符**：它可能是作者字面字符、Markdown hard break、LaTeX 或 serializer escape，不能全局反转义。
4. **`U+200B` 只用于富文本中新写的前导空格**：它是为了让 CommonMark 往返保留可见空格；不得扫描并修改既有文件。
5. **测试通过不等于所有组合已穷尽**：必须持续把真实用户操作序列加入 chaos/continuous 回归，而不是只测单次输入。
6. **长期终局仍是源码即数据模型的 Live Preview**：它可从架构上消除双表示同步家族，但属于独立迁移项目，见 `live-preview-migration-plan.md`；当前版本仍须维护现有保真层。
7. **禁止用全局“重新解析后语义相等”作为通行证**：作者正文里的 `- - 文本`、`1. 2. 文本` 和字面反引号本就可能被 parser 重解释；整篇循环 parse/stringify 会把合法作者拼写误判为错误并引入列表、反引号和空行回归。修复必须证明本次局部 raw 映射。
8. **当前自动化存在已证实的假阴性**：4×5、multicycle 和 tail-fence 都通过，但
   0.13.47 安装包真实长会话仍失败。后续必须把安装包人工结果作为最高门禁，并补统一
   transaction trace；不能继续增加固定 sleep 来提高脚本通过率。

## 9. 新问题追加模板

遇到同一家族的新问题时，在本节下方增加条目，禁止只在代码里打补丁：

```markdown
### RS-XX：问题标题

- 首次发现日期 / 版本：
- 测试平台与输入方式：macOS / Windows / CDP 逐字 / CGEvent / IME / 粘贴
- 原始磁盘源码（必须给精确 fixture）：
- 完整复现步骤（每次按键、删除、切换和保存顺序）：
- 富文本实际结果：
- 第一次源码实际结果：
- 第二次往返结果：
- 保存重开结果：
- 预期结果：
- previous canonical / next canonical：
- 作者源码 before / after：
- 根因：
- 修改文件与边界：
- 新增自动化测试：
- 全家族回归结果：
- 专项文档：
- 状态：复现中 / 已定位 / 已修复待验收 / 已验收
```

## 10. 标准修复流程

1. 保存用户原始 fixture 的副本，不在唯一文件上反复试错。
2. 用逐字输入复现；需要时临时记录每一步 previous canonical、next canonical、source 和 reason。
3. 先写会失败的最小回归，再修改实现。
4. 修复必须落在明确处理器中，不能在 App 或保存出口做全局字符串替换。
5. 跑目标测试，再跑第 6 节全家族矩阵；任何旧测试失败都不能交付。
6. 更新本总账、专项根因文档、`manual-test-checklist.md` 和 `ai-handoff.md`。
7. 普通修复版本号增加 `0.0.1`。
8. 重新 build、打当前包、杀死旧 HorseMD 进程、覆盖安装、清 quarantine、重新启动。
9. 验证运行进程确实来自 `/Applications/HorseMD.app`，并对安装后的 App 再跑关键用例。
10. 用户手测通过后再发布；不能用“测试脚本通过”代替保存重开和真实输入验收。

## 11. 专项文档索引

- [Markdown 原文保真与 Live Preview 架构决策](./markdown-source-preservation.md)
- [空段落占位合同](./empty-paragraph-contract.md)
- [全文删除与光标 settle 回归](./full-doc-delete-caret-settle-regression.md)
- [Canonical 转义审计](./canonical-escape-audit.md)
- [数字点嵌套列表同步交接](./nested-list-sync-bug-handoff.md)
- [复杂文档普通编辑保存被暂停](./diverged-ordinary-save-regression.md)
- [前导空格、实体编码与模式切换回归](./leading-space-mode-switch-regression.md)
- [源码单换行显示问题报告](./soft-line-break-display-report.md)
- [Issue #105/#106 富文本保存保真报告](./issues-105-106-save-fidelity-regression.md)
- [富文本源码保真：混乱编辑回归计划](./rich-source-chaos-regression-plan.md)
- [0.12.34 编辑器源码保真与模式切换疑难问题报告](./editor-source-switch-regression-0.12.34.md)
- [源码优先 Live Preview 迁移计划](./live-preview-migration-plan.md)
- [macOS 真实输入测试方法](./macos-real-input-testing.md)
- [人工测试清单](./manual-test-checklist.md)
- [空引用删除后复活回归报告](./empty-blockquote-removal-regression.md)
- [跨块连续编辑事务回归报告](./mixed-rich-source-transaction-regression.md)
- [列表项正文字面标记自动转义回归报告](./list-item-literal-marker-escape-regression.md)
- [反引号删除后保存暂停与源码模式锁死回归报告](./backtick-source-sync-lock-regression.md)
- [事务优先源码同步架构（方案一）](./transaction-source-sync-architecture.md)
- [非空 bullet Backspace 并入 ordered 列表回归（RS-82）](./nonempty-bullet-backspace-merge-ordered-regression.md)
- [中间独立 thematic break 输入规则回归（RS-83）](./middle-thematic-break-input-rule-regression.md)
- [跨列表选区删除为单个空 bullet 回归（RS-84）](./cross-list-selection-delete-empty-bullet-regression.md)
- [空 ordered 父项并入前项且保留 nested child 回归（RS-85）](./empty-ordered-parent-before-nested-backspace-regression.md)
- [快速双 Enter 退出空 bullet 且保留后继项回归（RS-86）](./rapid-double-enter-bullet-exit-before-sibling-regression.md)
- [0.13.47 富文本 / 源码持续分叉事故（P0 未解决）](./rich-source-divergence-incident-0.13.47.md)

## 12. 维护记录

- 2026-08-08 / 0.13.22：建立家族总账；汇总删除复活、空段落 `<br />`、列表 marker、数字点列表、分叉映射、前导空格 `&#x20;`、模式切换与光标等问题。
- 2026-08-08 / 0.13.23：增加 RS-23；空引用块第二次 Backspace 后，syntax-only `>` 必须同步从源码、磁盘和重开结果中删除。
- 2026-08-08 / 0.13.24：增加 RS-24；跨顶层块快速编辑在下一块输入前提交上一块，避免一个延迟 callback 同时携带多处不相邻变化；顶层 key 特别保护 paragraph→list input rule，不得让 `-` 回退为 `*` 或黏回上一行。
- 2026-08-09 / 0.13.25：增加 RS-25；列表项正文中的 `数字. 文本` 不再泄漏 serializer `\.`，稳定行文字编辑也不得格式化未编辑列表的 marker 与紧凑间距。
- 2026-08-09 / 0.13.26：扩展 RS-25 到 `数字)`、`-`、`+`、`*` 字面标记；增加 RS-26，修复反引号部分/重复删除造成的双快照分叉、保存暂停和源码切换锁死，并保护空段落后的零宽编辑与未变化列表。
- 2026-08-09 / 0.13.27：增加 RS-27、RS-28；列表转换比较统一反转义 `U+200B / &#x20;` 语义，行内代码改为闭合反引号触发，恢复标准 fenced code-block 输入并补快速退出同步边界。
- 2026-08-09 / 0.13.28：增加 RS-29；generated scratch 与空文件首次编辑改走 fresh canonical 翻译，修复同一行 ```` ```你好``` ```` 切源码后出现六个 serializer 反斜杠；增加逐键 delimiter、真实中文 IME、保存和完整重开回归。
- 2026-08-09 / 0.13.29：未新增家族分支；在加入桌面拖入打开后重新执行纯函数、逐字段落/列表/反引号、空段落/空引用、模式切换光标、保存重开、源码 + 预览、连续/嵌套写作与四组 chaos 的完整矩阵，全部通过。同步把 `test:paragraph-source-ui` 从旧“首字符自动激活”改为当前“闭合反引号触发”合同。
- 2026-08-09 / 0.13.30：增加 RS-30；复杂分叉文档中的普通重复短文本不再因全文子串重复而暂停保存。单块回退改为 source/canonical 等数量块的 ordinal 映射，候选数量不等仍 fail closed；新增富文本直接保存、源码、磁盘和冷重开专项。完整家族矩阵 26 组、桌面/移动/教程构建通过；覆盖安装后又通过六组高风险安装包回归。
- 2026-08-09 / 0.13.31：增加 RS-31。用户手测证明 0.13.30 的 fixture 虽包含 `- -`，自动化却只编辑独立段落，属于场景存在但断言未触达的低级覆盖缺口。分叉列表现识别作者正文开头的一层 ordered/bullet marker；专项扩为独立段落、嵌套项、后续兄弟项三次独立直接保存，完整家族矩阵增至 27 组并加入真实 IME composition。桌面/移动/guide 构建通过，覆盖安装后再通过三目标复杂保存、IME、字面 marker 和反引号四组安装包专项。
- 2026-08-09 / 0.13.32：增加 RS-32。0.13.31 用户长时间编辑证明，前部结构分叉会让 `preserveMiddleEmptyBlock` 的 canonical 全文可见行序号错套到 source；重复引用文本使末尾新段落被写入较早引用。改为“完全对齐才直取索引，分叉则相邻 pair + 结构类型 + 等数量 ordinal”映射；专项增至五个真实编辑位置，并明确拒绝整篇 parse/stringify 语义循环方案。
- 2026-08-10 / 0.13.33：增加 RS-33。用户直接点击引用后由 Crepe 提供的 trailing empty paragraph 输入，与“在引用内按两次 Enter 退出”不是同一事务；旧测试只覆盖后者。新增真实鼠标点击空段落逐字输入后稳定复现文字被写进前面空引用，修复为文档末尾 plain append 优先；专项增至六个场景，保存、源码、磁盘与冷重开逐字一致。
- 2026-08-10 / 0.13.34：增加 RS-34。现场证明保存暂停可在同一文档稍后重试时消失，定位为 durability boundary 与延迟 `markdownUpdated` / pending intent 的稳定窗口差异；保存和源码切换改为有界 settle。持续歧义继续 fail closed，但新增用户选址的 `.horsemd-recovered.md` 恢复副本，原文件绝不覆盖。完整家族矩阵重新执行通过。
- 2026-08-10 / 0.13.35：增加 RS-35，正式启动方案一。统一 transaction observer、原子 plain-text mapper、真实 step trace 和显式 primary UI 已落地；一次默认接管被 `test:paragraph-source-ui` 捕获空块首字错写，随即恢复生产影子/关闭，并把“结构失败后 quarantine 到下一 checkpoint”写进状态机。专项 primary 证明正文/引用/列表项文字可完全绕过 canonical diff；生产家族回归继续通过。
- 2026-08-10 / 0.13.36：增加 RS-36。方案一第二阶段，四个根因修复落地：

  1. **BOM/CRLF 映射错位**：remark 剥 BOM 使全部坐标差 1；旧回退还会把新文字插进 `\r\n` 中间（`正文\r追加\n`），随后“保存已暂停”。mapper 改为字节归一化视图（BOM 剥离 + 行尾归一化）做全部字节证明，编辑同步应用回原始副本，出口保留作者 BOM/CRLF/lone-CR 拼写；mixed EOL 结构拆分原子拒绝。
  2. **源末尾空行 + 新块粘行**（旧路径，非 primary 同样触发）：`preserveChangedLineRegion` 零宽变化在行边界被可见映射拉进上一行，`已有正文\n\n` + 列表创建输出 `已有正文* \n\n`。修复：零宽且位于行边界的变化，源区域就是该空行本身。
  3. **延迟列表意图覆盖跨块编辑（静默丢字）**：列表输入规则回调延迟期间另一块已被 mapper 接管，旧意图用捕获快照整体重建会丢掉该编辑。改为意图只在当前源快照上插入/替换自己的列表块，槽字节验证 + 已存在 canonical 列表的替换/压缩分支。
  4. **嵌套空 textblock 错写**：列表项/引用内的空段带 hint 时会把首字符写到容器 marker 之前。嵌套空块一律拒绝，交给列表/引用 preservation。

  回归：LF/CRLF/BOM+CRLF 的正文/引用/列表/undo-redo 立即切源码、保存、冷重开逐字节；列表意图跨块丢字专项（primary 构建验证、默认构建 SKIP）；家族全矩阵在 primary 实验构建与默认构建均通过。仍默认关闭，未放行 mark/atom、代码块、表格与性能门禁。
- 2026-08-10 / 0.13.46 候选：增加 RS-37～RS-39。真实 `123321.md` 继续编辑证明“一次保存重开通过”仍不足：列表 marker 已恢复后 pending intent 没有消费，下一次正文回调会用旧槽覆盖正确空行；批量列表 mapper 还可能只提交列表、丢掉同 callback 的正文；再次冷重开后在正文与代码块之间从空段创建有序列表时，列表和退出后的正文没有任何 mapper 拥有。修复 intent 一次性所有权、完整 canonical baseline 原子提交、唯一列表行 + suffix fence、严格中间空槽原子列表写回，并补 CRLF 的 CR 前插入、lone-CR 禁止断言与 0/1 final-EOL 退出列表边界。新增默认/primary 双路径的 4 轮编辑保存、5 次冷打开专项；真实文件 override、20/20 家族矩阵、continuous/chaos/列表转换/反引号/空段落/空引用/光标矩阵全过。
- 2026-08-11 / 0.13.47 候选：增加 RS-40。稳定复现 `/code` 的两阶段结构命令先删除查询行、却没有把空 fence 原子写入 authored source；后续代码、尾文和前文编辑因此全部建立在错误基线上。新增 slash code 命令级 source intent、精确 raw 行槽与单 code_block 序列化，禁止通用尾部删除分支抢走该结构事务。`test:tail-fence-ui` 固化 40ms/350ms 两种菜单时序，连续完成代码、尾文和前文列表三块编辑，并断言源码/磁盘中完整且唯一 fence、冷重开后仍为 `.milkdown-code-block`；真实 `123321.md` 临时副本与隔离安装包均通过。
- 2026-08-11 / 0.13.47 人工否决：增加 RS-41。用户在正式路径安装包上继续编辑真实
  `123321.md`，确认代码块后的长会话仍会让富文本与源码不一致；保存暂停与“保存成功但
  内容不同”都存在。此前所有绿色矩阵只保留为已覆盖路径证据，不再作为家族关闭结论。
  新增 P0 事故文档，要求捕获 live doc / authored / canonical / tab / textarea / disk
  第一次分叉的统一 trace，并以安装包 10 轮长会话作为最终验收。
- 2026-08-21 / 0.13.76：增加 RS-44。日志定位第一笔分叉为 `source-list-structure-mismatch`：有序列表填正文 → Enter 新建空项 → 空项再 Enter 退出时，下方作者用 `1)` 书写的独立有序列表被 Crepe 在同一事务重序列化为 `1.`，把“删空项”与“标点翻转”并进同一变更区间，`empty-list-item-removed` 分支被拒、`empty-list-item-filled` 用只剩第一项的 next 块替换整个合并列表，后续 `1) 斯卡洛尼快乐 / 2) 是干嘛的了；吗` 整段被删。修复为 diff 前归一化行首有序 marker 标点（`normalizeOrderedListDelimiters`），使变更区间只含真正的空项删除；`test:ordered-exit-delimiter-ui` 固化并反证。
- 2026-08-23 / 0.13.90：增加 RS-45。真实 `--horsemd-input-trace` 首次分叉证明：新建文档 `1. 测试` → Enter 空 `2.` → Tab 后 ProseMirror 正确形成嵌套空有序项，generated scratch 也正确输出不含 `<br />` 的 `   1. `，但 parser 语义门禁把 bare empty nested slot 与 Crepe `   1. <br />` 占位判成不同文档并报 `source-document-mismatch`。当前先登记案例并要求新增真实逐键失败回归，修复后必须跑完整家族门禁再打包。
