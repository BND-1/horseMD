# Transaction Journal：nested plain bullet Enter split

## 目标

0.13.162 迁移 Stage E nested-list 的第六个 focused family：顶层 plain bullet parent 内，一个 nested plain bullet item 在正文中间或末尾按物理 Enter，经 ProseMirror `splitListItem` 拆成两个同级 nested items。

本 family 只做 split。nested sibling 起始 Backspace/Delete join 的最终 PM topology 与 raw Markdown 形状不同，继续保持独立 family。

## Scope

- top-level `bullet_list` 内的 plain non-task parent；
- parent direct children 为一个无marks非空paragraph + nested `bullet_list`；
- target 可位于nested任意index，必须是non-task plain bullet item且只有一个无marks非空paragraph；
- splitOffset `>0` 且 `<= oldText.length`；end split允许right为空；
- split后left/right attrs都等于old target，`leftText + rightText === oldText`；
- 其它nested/outer siblings不变。

item开头Enter、task/ordered、marks/atoms、多paragraph复杂item、Backspace/Delete join、Tab/Shift+Tab均不属于本family。

## 真实 Step

真实 HorseMD end/middle Enter 与同attrs `splitListItem` 一致：单document-changing transaction、单`ReplaceStep(structure=true,sliceSize=4,openStart=2,openEnd=2)`，且：

`step.from === step.to === targetParagraph.contentStart + splitOffset`

slice恰含两个空`list_item` wrappers，每个只含空paragraph，attrs与old target一致；Step在Journal捕获stepDoc上apply必须精确等于live expectedDoc。

## Raw source patch

只修改target作者row：在语义split boundary对应的raw byte位置插入 `原EOL + 原indent + 原marker + 原spacing`。成功合同要求nested indent恰两个ASCII spaces、marker spacing一个space、EOL为LF或CRLF；BOM、marker token、正文其余bytes、siblings与邻块逐字保持。

### Backslash escape 对齐

作者source可能是 `  * 1\\. 额啊飞啊发`，PM正文却是 `1. 额啊飞啊发`，因此PM字符offset不能直接当raw byte offset。

局部 `escapedPlainTextBoundary` 逐字符证明raw body与PM plain text等价，只接受原字符本身或Markdown可转义标点的 `\\x → x`，并返回splitOffset对应的raw boundary；无法完整对齐的entity/marks/复杂inline继续fail closed。

永久旧基线已证明：PM `splitOffset=8`，raw `rawSplitOffset=9`，split后作者反斜杠仍逐字存在。

## Retirement

本owner设置`legacyRetired:true`。topology+Step已完整证明但raw byte contract失败时返回`recognized:true`并统一`legacyBlocked:true`。两空格marker padding `  +  gamma` 是永久负例：rich split保留，focused/outdent/broad/legacy/Coordinator均不publication，warning可见且disk不变。

## 永久回归

- `test:list-nested-bullet-split-transaction-owner`：middle/end、任意nested index、exact ReplaceStep、BOM+CRLF、authored `1\\.` escape raw boundary、unsafe row/wrong Step fail-closed、start/task/ordered no-hit。
- `test:list-nested-bullet-split-transaction-ui`：end callback、middle forced、`+/-` marker、source/save/disk/fresh-profile reopen、focused-only publication。
- `test:list-nested-bullet-split-legacy-retirement-ui`：marker padding recognized+legacyBlocked、rich split保留、disk不变。
- `test:nested-list-enter-empty-sibling-ui`：历史 broad owner 基线升级为focused-only，并验证作者 `1\\.`、source/save/reopen。

## 门禁

相邻已通过0.13.157–161 indent/outdent、continuous/nested 3x2 fidelity、RS-68、RS-63、generic list-subtree callback/forced。全局已通过Journal、Coordinator、source transaction sync、完整preservation、39/39 probes、mixed/heterogeneous Electron fidelity、desktop/mobile build和`git diff --check`；仅有既有Vite large-chunk warning。

## 下一步：nested sibling Backspace join

真实Electron诊断已证明join不能并入split：第二nested sibling开头按Backspace后，PM用单`ReplaceStep`把两个siblings合为一个list_item内两个paragraphs；source应变成第一nested marker row + continuation paragraph。当前broad transaction candidate会因document mismatch失败，随后legacy接管。

0.13.163必须独立证明old previous/target sibling paths、exact ReplaceStep range、new single-item双paragraph topology、continuation paragraph作者indent与byte patch、BOM/EOL/marker保真、callback/forced/save/reopen与recognized fail-closed retirement。

完成join之后仍在Stage E，继续task sentinel、conversion、input rules与cross-list/coalescing；不能跳Stage F。
