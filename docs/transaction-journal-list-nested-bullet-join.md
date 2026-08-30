# Transaction Journal：nested plain bullet sibling Backspace join

## 目标

0.13.163 迁移 Stage E nested-list 的第七个 focused family：顶层 plain bullet parent 内，任意非首 nested plain bullet sibling 在正文起始位置按物理 Backspace，经 ProseMirror `joinBackward` 与前一 sibling 合并。

本 family 只做 plain nested bullet sibling Backspace join。task、ordered、Delete、跨 list、复杂 multi-block item 与 conversion/input-rule 均继续独立处理。

## Scope

- top-level `bullet_list` 内的 plain non-task parent；
- parent direct children 为一个无marks非空paragraph + nested `bullet_list`；
- nested childCount至少2；
- targetIndex `>=1`；
- previous/target都必须non-task、只有一个无marks非空paragraph；
- final joined item attrs与old previous/target一致，并恰含两个paragraph；
- 其它nested/outer siblings保持不变，仅target后的nested index左移一位。

## 真实 Step

真实 HorseMD 与同attrs最小 `joinBackward` 对2-child second、3-child middle/last均一致：单document-changing transaction、单 `ReplaceStep(structure=true,sliceSize=0,openStart=0,openEnd=0)`。

边界公式：

`step.from === target.beforePos - 1 === previous.beforePos + previous.nodeSize - 1`

`step.to === target.contentStart`

Step在Journal捕获的stepDoc上apply必须精确等于live expectedDoc。

## Final PM topology

- nested childCount减1；
- old target sibling消失；
- old previous位置成为joined item；
- joined item childCount为2；
- child0严格等于old previous paragraph；
- child1严格等于old target paragraph；
- target后的old siblings整体左移一位并逐项 `.eq()`；
- outer top-level list、parent paragraph与邻blocks保持。

## Raw source patch

source-map分别锚定previous与target paragraph。安全合同要求两row物理相邻、nested indent都恰两个ASCII spaces、同作者 `-` / `+` / `*` marker、marker spacing恰一个ASCII space、EOL同为LF或同为CRLF，且raw正文与PM plain text逐字符等价；Markdown可转义标点允许 `\\x → x`，其它复杂inline不猜。

成功patch只替换target row的结构前缀：`  marker ` → `原EOL + 四个spaces`，target正文bytes完全不动。由此 `  + gamma\r\n  + delta\r\n` 变为 `  + gamma\r\n\r\n    delta\r\n`，即“nested marker第一paragraph + blank line + four-space continuation第二paragraph”。

## Parser / persistence proof

真实Electron callback/forced都证明该candidate直接通过生产 `validateTransactionMarkdown`，无需semantic豁免；随后 rich topology、source mode、save、disk 和 fresh-profile cold reopen 全部稳定。作者 `+/-` marker、BOM、CRLF与 `1\\.` escape保持。

## Retirement

本owner `legacyRetired:true`，registry位于nested split之后、ordered/broad list owners之前。永久负例为target marker padding两个spaces，例如 `  +  delta`。PM topology和exact ReplaceStep已分类，但byte contract无法证明时返回 `recognized:true + legacyBlocked:true`：rich join保留、warning可见，split/broad/legacy/Coordinator不得publication且disk不变。

## 永久回归

- `test:list-nested-bullet-join-transaction-owner`：2-child、3-child middle/last、exact zero-slice ReplaceStep/path、BOM+CRLF、authored escape、unsafe row/wrong-step fail-closed、task/ordered no-hit。
- `test:list-nested-bullet-join-transaction-ui`：2-child callback + 3-child middle forced，focused-only publication、source/save/disk/fresh-profile reopen。
- `test:list-nested-bullet-join-legacy-retirement-ui`：marker padding recognized+legacyBlocked，rich双paragraph join保留、disk不变。

## 门禁

相邻通过0.13.157–162 indent/outdent/split、continuous/nested 3x2 fidelity、RS-68 rapid nested parent Backspace、RS-63 nested Backspace与generic list-subtree。全局通过Journal、Coordinator、source transaction sync、完整preservation、39/39 probes、mixed/heterogeneous Electron fidelity、desktop/mobile build和`git diff --check`；仅有既有Vite large-chunk warning。

## 下一步

plain nested bullet 基础 indent/outdent/split/join 已闭环。Stage E 下一步进入 task sentinel / task-list item 特有结构的真实 Step 取证；之后处理conversion、input rules与cross-list/coalescing。不能提前进入Stage F。
