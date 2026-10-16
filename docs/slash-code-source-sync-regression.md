# `/code` 代码块连续编辑导致源码分叉：根因与回归

> 首次稳定复现：2026-08-11 / 0.13.46
> 子路径修复候选：0.13.47
> 统一 publication 迁移：0.13.126（行为保持，不表示 RS-41/P0 关闭）
> 家族编号：RS-40

> **验收更正：RS-40 的命令创建阶段已覆盖，但富文本/源码家族没有关闭。** 0.13.47
> 安装包在真实 `123321.md` 长会话中继续编辑后仍会再次分叉，现以 RS-41/P0 跟踪。
> 本文不能再作为“整体问题已修复”的证据；见
> `rich-source-divergence-incident-0.13.47.md`。

## 1. 用户可见现象

在复杂 Markdown 文档末尾通过斜杠菜单输入 `/code` 创建代码块后，不做中间保存，继续：

1. 在代码块中输入并再次编辑代码；
2. 在代码块后输入普通正文；
3. 回到前面的列表项修改文字；
4. 切换源码、保存并重新打开。

富文本中的三处修改都存在，但源码模式可能无法进入，或源码缺少代码围栏和后续编辑。
继续保存会让富文本、内存源码和磁盘文件从同一个断点开始扩大差异。

## 2. 精确根因

斜杠菜单的代码块命令原本由两个结构命令组成：

1. `clearTextInCurrentBlockCommand` 删除临时查询文字 `/code`；
2. `setBlockTypeCommand` 把当前 paragraph 改成 `code_block`。

Milkdown 可以先发布字面 `/code`，再发布空代码块 canonical（` ```\n``` `）。复杂文件的
source/canonical 可见流本来就允许存在合法拼写分歧，例如作者使用 `-`，serializer 使用
`*`。旧的尾部保真路径因此把上述结构替换误判为“删除最后一行”：它从源码删除 `/code`，
却没有原子写入成对 fence。此后 canonical 有 `code_block`，作者源码没有对应结构槽；
代码内容、尾部正文和前文修改的每个后续 callback 都只能 `visible-stream-mismatch`。

根因不是 CodeMirror 输入，也不是反引号输入规则，而是**斜杠结构命令的两阶段 UI 意图
没有作为一次原子 source 事务提交**。

## 3. 修复边界

- `editor-slash-menu.js` 在执行代码类命令前后传递同一个命令 token。
- 命令前从 live ProseMirror doc 对账 `/query`，定位并捕获精确 authored source 行、raw
  区间和原始行尾。
- 命令后只序列化当前 `code_block` 节点；验证结果是完整成对 fence 后，原子替换捕获行。
- 0.13.126 起不再由 Slash callback 直接写 source/canonical/App，而是以 `slash-code-block-atomic` legacy candidate 进入 `SourceSyncCoordinator`；只有 semantic/list proof、host commit 和 revision publication 全部成功才推进基线与 trusted checkpoint。
- 重复 `/code` 只有 PM 映射精确命中的那一行可以被替换；没有映射且不唯一时 fail closed。
- CRLF 在块内与块外均保持 CRLF；不扫描、不格式化其他行。
- 普通标题、列表、引用、表格等非代码斜杠命令不进入本处理器。

实现集中在 `components/editor-slash-source.js`，没有把命令特例塞进保存出口，也没有放宽
`visible-stream-mismatch` 安全门。

## 4. 自动化回归

`npm run test:tail-fence-ui` 使用仓库内生成的分叉 fixture，并逐字符执行：

1. `/code` 后分别等待 40ms 与 350ms，按 Enter 选择代码块；
2. 输入代码内容；
3. 不切源码、不保存，立即修改代码内容；
4. 输入代码块后的正文；
5. 修改前面的有序列表项；
6. 第一次切源码，断言三处 token 各出现一次，marker 必须被一个完整且唯一的 fence 包裹；
7. 保存、全新 profile 冷打开、再次切源码；
8. 断言磁盘和源码一致，未编辑前缀逐字节不变，冷重开后 DOM 仍是 `.milkdown-code-block` 而非普通文本。

0.13.126 的同一脚本还明确要求 `boundary=slash-code-block-atomic / owner=legacy / family=legacy-preservation`，并断言整个连续操作窗口 `integrity ok=false = 0`。同一脚本还分别验证 literal fence 与 ` ``` + Space` input-rule 变体。纯函数回归覆盖
CRLF、mixed-EOL 无 final-EOL、重复 `/code` 的精确命中与歧义拒绝。真实
`123321.md` 临时副本和 `/Applications/HorseMD-0.13.47-test.app` 隔离安装包也执行同一
连续编辑流程；测试不会写回用户原文件。

## 5. 后续维护规则

任何“临时查询文字 → 结构节点”的命令都不能只依赖最终 canonical 字符串猜测用户意图。
新增斜杠结构命令时，先决定其 source 原子事务合同；如果不能证明精确 authored 槽，必须
保持 fail closed，不能用整篇 serializer 输出覆盖用户文件。
