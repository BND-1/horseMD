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
回归：家族矩阵 17/20 不变，`test:code-fence-delete-source-ui`、
`test:literal-triple-backtick-source-ui`、`test:markdown-preservation`、
`test:source-fidelity-probes`、`test:new-source-fidelity-ui`、
`test:leading-space-entity-ui`、`test:paragraph-source-ui`、
`test:empty-paragraph-source-ui`、`test:diverged-ordinary-save-ui`、
`test:diverged-delete-source-ui`、`test:save-reopen-smoke-ui`、
`test:rich-list-source-ui`、`test:list-marker-empty-source-ui`、
`test:list-conversion-ui` 全过。

## 矩阵当前状态

- 123321.md、引用后输入手测.md：5/5 全过
- 反馈.md：ordered / plain / spaces 过；unordered / list-spaces 剩余
- 11111.md：4/5（spaces 删除剩余）

## 剩余场景（已知边界，待后续）

1. **前导空格段删除到只剩空格**：`&#x20;   家族验证` → ` `（canonical 剩 1 空格）。
   源保留完整 sentinel 段（删除未反映）。`trailing-empty-block-created` 不识别
   `&#x20;`→` ` 形态；tail mapper 因 visible 相同不走 diverged 分支。
2. **分叉文档里 canonical 末尾是空列表项（源无）时的无序列表追加**：追加内容拼到
   上一行（`负责家族验证人 /`）。canonical 末尾 `* <br />` 与源末尾 `- 而为` 锚定
   不匹配，tail mapper 放弃。

这两个场景都需要在可见流比较前识别“实体空格段”和“canonical 多出的空列表项”，
与根因 2 同族但边界更深；已记录为后续迭代项。
