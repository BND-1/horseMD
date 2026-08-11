# 富文本 ↔ 源码保真 Bug 家族总账

> 状态：持续维护（Living Document）
>
> 当前基线：HorseMD 0.13.47 候选已完成源码保真家族矩阵、多轮持久化和代码块连续编辑专项，待用户手动验收，2026-08-11
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

## 5. 代码归属

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
