# 数字点列表与多列表源码同步：根因、修复与回归

> 状态：2026-08-08 已完成代码修复与自动回归，当前工作区版本 `0.13.18`，尚未提交/发版。
> 本文记录的是「富文本中改了，源码/保存却仍是旧内容」家族里与列表有关的完整事故链。

## 1. 用户现象

真实复现文件：`/Users/yangtingyi/vibe_everything/置身钉内/反馈.md`。

- 普通文字删除可以生效，但删除或新增无序/有序列表符号、列表项后，切源码或保存重开会复活。
- `- 1. 管理层` 这类行在富文本中编辑后，正文可能消失，只留下 `- 2. ` 空壳。
- 前面的数字点列表发生过结构编辑后，后面「使用说明」中的普通列表继续输入也可能静默丢失。
- 快速连续编辑 `-`、`+`、`*` 三种相邻列表时，新增项只留下空 marker，删除项会复活，marker 还可能全部被改成 `-`。
- 早期 0.13.18 调试实现曾把 `## 目录` 写坏为 `## 目123`。用户磁盘上的复现文件已经被该旧构建损坏；测试前应先在副本中恢复标题，不能把损坏文件误判为当前版本新产生的问题。

关键源码形态：

```markdown
## 目录

- 1. 管理层（总经理）
- 2. 综合行政部
- 3. 人力资源部

## 使用说明

- 适用标准：**ISO 9001:2015**。
```

## 2. 八类相互叠加的根因

### 2.1 `- 1. 文本` 被解析成两层列表

作者意图是「无序列表项，正文以 `1. ` 开头」，remark/Crepe 却解析成「空外层无序项 + 内层有序项」：

```markdown
* <br />

  1. 管理层（总经理）
```

canonical 中 `1. ` 是结构 marker，不计入可见文本；用户源码中 `1. ` 是正文，计入可见文本。两条可见流从这里永久分叉，普通字符偏移映射必然失败并 fail-closed 回退旧源码。

### 2.2 Backspace 提升列表时，canonical 会产生无 marker 续行

在「综合行政部」开头按 Backspace，Crepe 的真实中间态依次是：

```markdown
* <br />

  2. 综合行政部
```

```markdown
* <br />

  综合行政部
```

```markdown
* 综合行政部
```

```markdown
  综合行政部
```

旧 `flatListItemRows()` 只读取带 marker 的行，把第二种状态误判为「项目正文被清空」，源码因此变成 `- 2. `；把最后一种状态误判为「整项删除」，正文会整行消失。

### 2.3 canonical 的内层块把后续列表序号推偏

`listBlocksInSourceOrder(canonical)` 不只返回顶层目录列表，还会为每个内层 `1.`、`2.` 再返回一个块。上述示例在 canonical 中可能把「使用说明」算成第 5 个列表块，而源码中它只是第 2 个顶层列表块。

旧逻辑按全部块的 ordinal 寻找源码对应项，所以前面只要出现数字点嵌套解析，后面的普通列表永远匹配不到；即使包含 `**加粗**` 的行本身没有问题，编辑也会静默回退。

### 2.4 延迟 `markdownUpdated` 会把多个列表操作合成一次

真实快速输入可能在一个回调里同时包含：

1. 把前一个 `- ` 空项填成 `- dash-three`；
2. 在后一个 `+` 列表新增 `+ ` 空项；
3. 删除第三个 `*` 列表项。

旧顺序先调用单列表处理器。它成功处理一个块后立即返回，另外两个编辑被丢弃。下一次回调又会被 `preserveEmptyListItemTextChange()` 抢先处理，并把相邻的 `- / + / *` 列表当成一棵 canonical 列表整体格式化，导致 marker 统一、紧凑列表变松散列表。

### 2.5 用“下一列表首项文本”做边界时，首项编辑会让块越界

旧批处理把下一块首项文字当作 fence。若该首项也在同一回调里变化，fence 在 `next`
中消失，前一块会一直吞到后文，随后把相邻 `+ / *` 列表重复插入并改写成 `-`。
“成功得到两个 replacement”不能证明批次完整，必须证明每个 next 区间有边界且互不重叠。

### 2.6 无 marker 续行既可能是列表提升，也可能是普通多行内容

`  beta` 既可能是 Backspace 提升产生的结构行，也可能只是 `- alpha` 的普通续行。
旧插入分支遇到 tokenless 行仍硬编码输出 `- beta`，把普通续行变成新列表项。续行必须
保留 canonical indent；只有明确带 marker 的新项才生成 marker。

### 2.7 CRLF 的 `\r` 混进可见正文，专用映射失败后落入不安全通用映射

源码投影按 `\n` split，却把行尾 `\r` 留在 `row.text`，导致 Windows 文件无法与 LF
canonical 对齐。更危险的是失败后继续调用通用可见偏移映射，曾把 `+ 1. AB` 的文字
重排损坏。比较时必须剥离 `\r`，raw offset 与删除范围仍保留真实 `\r\n`。

### 2.8 专用列表处理器只提交一个块、连续插入锚点漂移、首项提升失去入口

- 一个回调同时修改数字点分歧列表和后续普通列表时，只处理第一块就返回会丢掉第二块；
- 连续插入 X、Y 时，第二次若重新按旧 aligned index 找锚点，会插到未改 suffix 后面；
- 第一项或唯一项完全提升为普通段落后，`next` 已没有可供查找的顶层 marker。

修复必须把 callback 当作原子事务逐块推进 canonical baseline；连续插入维护写入游标；
首项提升则只接受“首项文本完全相同、其余列表项完全未变”的严格结构变换。

## 3. 修复实现

### 3.1 列表项结构投影

`src/renderer/src/lib/markdown-preservation/lists.js` 的 `preserveDivergedNestedListChange()` 现在把 canonical 顶层列表树投影为「token + text + indent」项序列：

- 跳过 Crepe 专用的空外层 wrapper；
- 保留真实空项；
- 识别 Backspace 产生的无 marker 续行；
- `2. 文本 → 文本` 只删除源码正文里的 `2. `；
- `* 文本 → 两空格续行` 只替换外层 marker，正文不删除；
- Enter 新项、填空项、删除项仍按项级 diff 写回。

源码侧 `sourceListItemRows()` 同时识别 marker 行和缩进续行，保证下一次事务仍能和已经提升过的源码对齐。

### 3.2 只按顶层列表块匹配

新增 `topLevelListBlocksInSourceOrder()`；数字点分歧路径只使用 `indent === 0` 的块做 ordinal 匹配。canonical 内层有序块不再把后续源码列表的序号推偏。

### 3.3 多列表变更原子对账

`preserveBatchedListBlockChanges()` 新增 `requireMultiple` 守卫。只有确认至少两个独立顶层列表都产生替换时，才允许它抢在单列表处理器前运行：

- 在空项快捷路径之前运行一次，防止空项处理器合并相邻 marker 风格；
- 在列表结构路径开头再运行一次，防止单列表处理器只提交批次的一部分；
- 单个列表编辑仍走原有专用路径，不扩大普通操作的覆盖面。

补充安全线：文本项数量未变时，先按顶层 row ordinal 做多行批次更新，逐行保留作者
marker 与紧凑间距；该 fast path 还要求每一行的 marker / indent / task 状态，以及相邻
顶层行之间的 raw gap skeleton 完全不变。这样“前一列表插入、后一列表删除、总行数碰巧
相等”不会按 ordinal 串错身份，删除列表间空行的结构操作也不会被文本 fast path 截走。
fence 路径不再只依赖下一块首项：它会用下一源码块中仍然存在的所有可见项寻找最近且
唯一的边界，因此“删除后一列表首项、保留第二项”仍能正确截断前一块；所有 next 区间
还必须互不重叠。没有可靠 surviving fence、首项被编辑且无法证明所有权时直接拒绝，
不能扩展到文档末尾。

对已确认存在多列表结构变化、但当前处理器无法完整归属的回调，返回带 `blocked: true`
的 `unmapped-batched-list-change`，形成 sticky fail-closed：后续通用偏移映射不得再接管并
猜测性写回。配合 Editor 不推进 canonical baseline，未知复杂操作会保留原源码并在下一次
回调重试累计事务，而不是把一次失败伪装成已同步、随后持续放大损坏。

真实 65ms 逐键回归还暴露出一个更隐蔽的时序：在 `+ ` 空项中填字时，`<br />` 归一化后
这不再被识别为“结构变化”，旧 empty-item helper 会把后面的 `*` 列表一起套成 canonical
的 `-` 样式。现在先运行 `preserveStableListRowChanges()`：只有顶层 row 数量、marker / indent /
task 与相邻 raw gap skeleton 全部稳定，且确实是“空行填字”时，才只替换对应 row；随后
删除第三个列表项并退出列表的场景也由 `empty-list-item-removed` 精确删除作者源码行及其 EOL，
不会遗留第三个空行。

### 3.4 分歧列表按原子事务逐块推进

`preserveAllDivergedListChanges()` 使用当前 canonical 与最终 canonical 的下一处 diff，
反复调用结构投影；每成功处理一块，就同时推进 authored source 和 canonical baseline。
只有 `currentPrevious === next`、即 raw canonical delta 被逐字节全部消费后才返回成功。
可见文字相等不代表标题层级、列表类型或任务状态相等，绝不能作为完成条件。若已处理一块
但剩余变化无法证明归属，则原子回退原始 source 并返回 `unmapped-diverged-list-batch`，
禁止“半个回调成功”。`Editor.jsx` 对 `preserved: false` 不推进 canonical baseline，下一次
回调或强制 flush 会重试累计 delta，避免拿一条虚假“已同步”基线继续放大偏移。

连续新项使用 insertion cursor 保持 X、Y 的顺序；tokenless 新行按 indent 输出续行；
CRLF 行比较剥离 `\r`，插入/删除使用原始 `breakEnd` 和附近 EOL；首项/唯一项完全提升
使用严格的 leading-item 路径，不依赖 next 中已不存在的 marker，且由原 suffix 独占
列表后的分隔换行，避免提升到后续段落前时多插一行空白。

列表拆分完成后，Crepe 有时只再增加一个 canonical 末尾换行。原子循环现在仅对“除末尾
换行数量外逐字节完全相同”的剩余差异视为 serializer padding；标题层级、列表类型、任务
状态等结构差异仍不能用可见文字相同蒙混过关。强制 flush 遇到真正 fail-closed 时返回
`null`，不清 pending、不推进 baseline、不把旧源码伪装成保存成功；源码切换和保存会暂停，
而不是用旧 tab 内容覆盖画面中仍存在的编辑。

### 3.4 既有安全边界继续保留

- 整文档清空：`document-emptied`；
- 分歧文档跨块纯删除：`preserveDivergedVisibleDelete`；
- canonical 转义还原：`canonicalTextToSource`；
- canonical 转义只在 Markdown 文本上下文还原；fenced/indented/inline code、HTML raw block
  中的字面 `&#x20;` 与 `\~` 原样保留；
- standalone `<br />`：出口后置条件统一剥离；
- 映射不明确：继续 fail-closed，不允许猜测性覆盖用户源码。

### 3.5 新建文档首个无序项被改写：`-` 退化为 `*`（0.13.20）

这个问题不属于数字点列表分歧，但属于同一“列表源码拼写丢失”家族。新建文档在用户
尚未编辑源码前使用 generated-scratch：每次从完整 canonical 生成源码，再把上一份源码
里的 marker 带回。旧算法的主键是“缩进 + 项目全文”。若作者先输入 `- 第一项`、
`- 第二项`，随后回到第一项改成“第一项X”，第一行匹配失效；它又是该 bullet 列表的
第一行，无法从前一行继承，于是 canonical 默认 `*` 进入源码。

修复位于 `preserveGeneratedBulletMarkers()`：精确文字匹配仍优先；当前后 marker 行数量
相同且 ordinal 行未被其他精确锚点占用时，才以“ordinal + indent + list kind”恢复原
marker。`compatibleMarker()` 继续禁止跨有序/无序类型带回符号，因此真实列表转换不受影响。
纯函数覆盖“首项改字”和“所有项改字”；UI 覆盖有序列表后新建两项 `-` 列表、回访首项、
逐字输入、立即切源码、保存和完整重开。

## 4. 新增与修正的回归

### 4.1 纯函数

`scripts/test-markdown-source-preservation.mjs` 新增：

- 删除内层 `2.` 后得到 `- 综合行政部`，正文不丢；
- 提升外层 bullet 后得到缩进续行，正文不丢；
- canonical 前面包含多个内层列表块时，后面的加粗列表行仍按顶层 ordinal 写回；
- 相邻列表首项和后续列表项在同一批次变化时不吸收、不重复、不改 marker；
- 普通续行保持缩进，CRLF + `+` marker 保持逐字节；
- 数字点分歧列表与后续普通列表同一回调同时提交；
- 连续插入两个同级项保持顺序；第一项/唯一项完全提升为正文；
- fenced/inline code 与 HTML raw block 内的字面转义不被全局反转义；
- 原有拆分、填空、追加、删除、跨块删除继续通过。
- generated-scratch 的首个 `-` 项及全部项目改字后仍按结构行保留 marker。

### 4.2 真实 Electron、后台逐键输入

`scripts/test-diverged-list-structure-ui.mjs` 覆盖：

1. 打开磁盘文件；
2. 在数字点列表项开头真实按 Backspace；
3. 切源码核对 marker 与正文；
4. 回富文本 Enter 新增项并逐字输入；
5. 编辑后续包含 `**加粗**` 的列表行；
6. 保存并直接读取磁盘；
7. 连续三次 Backspace 验证两层提升中间态与最终续行。

`scripts/test-rich-source-existing-chaos-ui.mjs` 的 burst 配置覆盖一个回调内跨 `- / + / *` 三个列表的新增、填充与删除，验证 marker、紧凑间距、源码视图、保存和新进程重开完全一致。

`scripts/test-new-document-list-source-preservation-ui.mjs` 还覆盖 generated-scratch 中回访
首个 dash 项：修改正文后不等待普通 callback，立即切源码、保存并新进程重开，源码
仍为 `-`。快速分支按 55ms 逐键提交；35ms 会先于 ProseMirror 自己的 input-rule
transaction，属于不真实的测试注入失败而非源码保真失败。

新文档混沌测试的文末预期同步修正为一个 terminal newline。新文档没有既有作者尾换行约定，`generatedScratchMarkdown()` 的既定契约就是只生成一个结尾换行，不保留 serializer 制造的虚假空白行。

## 5. 验证命令

```bash
npm run build
npm run test:markdown-preservation
npm run test:new-document-list-source-ui
npm run test:nested-number-list-source-ui
npm run test:diverged-list-structure-ui
npm run test:diverged-partial-delete-ui
npm run test:diverged-delete-source-ui
npm run test:full-doc-delete-source-ui
npm run test:rich-source-continuous-fidelity-ui
npm run test:rich-source-nested-3x2-fidelity-ui
npm run test:rich-source-chaos-ui
npm run test:list-conversion-ui
npm run test:paragraph-source-ui
npm run test:leading-space-entity-ui
npm run test:mode-switch-caret-settle-ui
npm run test:empty-paragraph-caret-ui
npm run test:mode-switch-raw-offset-ui
npm run test:source-fidelity-ui
npm run test:issue-77-ui
npm run test:new-source-fidelity-ui
npm run test:source-text-fidelity
npm run test:source-map
npm run test:source-fidelity-probes
```

## 6. 维护约束

1. 不得再用「全 canonical 列表块 ordinal」映射用户源码顶层列表；有嵌套解析时只能比较同层级块。
2. 无 marker 缩进行是列表提升的真实中间态，不能自动等价为“项目已删除”。
3. 一个 `markdownUpdated` 不是一个用户动作；它可能批量包含多个列表、多个结构变化。
4. 单列表处理器返回成功不代表整个回调已被提交；跨多个顶层列表时必须逐块推进 baseline，并且只在整个 callback 被消费后返回成功。
5. 可变正文不能作为无条件边界；fence 缺失、next 区间重叠或 CRLF 对齐失败时必须 fail-closed，绝不能落入已知不安全的通用偏移猜测。
6. 用户已有源码的 marker、紧凑/松散间距、BOM、CRLF 和尾换行属于作者数据；新建空文档才使用 generated-scratch 约定。
7. 自动测试必须后台运行，结构输入逐键提交；列表问题至少包含输入、删除、回访旧块、切源码、保存和新进程重开。

## 7. 架构边界

本次修复把已知列表家族从“字符偏移猜测”收敛为有明确前置条件的结构投影，并覆盖真实组合事务；它没有改变 HorseMD 仍同时维护 ProseMirror canonical 与作者源码两份表示的事实。

长期终局仍是 `docs/live-preview-migration-plan.md` 中的「源码即数据模型」。在迁移完成前，所有新结构必须先定义 canonical → authored source 的最小、安全、可回归投影，不能用全篇 serializer 输出覆盖用户文件。
