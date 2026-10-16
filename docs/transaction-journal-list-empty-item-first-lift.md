# Transaction Journal：plain bullet first-empty Backspace

> 源码版本：HorseMD 0.13.153
> Family：`list-empty-item-first-lift`
> Owner：`createListEmptyItemFirstLiftTransactionSourceSyncOwner`
> Boundary：`transaction-list-empty-item-first-lift`

## 1. 范围

本 family 只处理顶层 plain bullet list 的 first-empty Backspace：第一 item 必须非 task、只含一个空 paragraph；至少还有一个 successor，第二 item 必须非 task、只含一个非空 paragraph。ordered first-empty、task、tail、interior、多 transaction都不属于本 family。

ordered 被刻意排除，因为 first ordered item 移除会牵涉 remaining ordered list 的 start、successor编号与作者 delimiter，必须作为下一 `ordered successor/lift` family 独立证明。

## 2. 真实 ReplaceAroundStep

真实最小 fixture：

```markdown
before

-
- right

after
```

使用 ProseMirror `joinBackward` 捕获到唯一 Step：

```text
ReplaceAroundStep
from = 8
to = 13
gapFrom = 10
gapTo = 12
insert = 0
structure = true
sliceSize = 1
openStart = 0
openEnd = 1
slice = empty bullet_list wrapper
```

old topology：

```text
paragraph before
bullet_list
  list_item
    empty paragraph
  list_item
    paragraph right
paragraph after
```

new topology：

```text
paragraph before
empty paragraph            # editor-only, top-level
bullet_list
  list_item
    paragraph right
paragraph after
```

owner 精确绑定 old list `[i]`、first item `[i,0]`、first paragraph `[i,0,0]`、successor `[i,1]`，并要求：

```text
step.from === oldList.beforePos
firstItem.beforePos === oldList.contentStart
step.gapFrom === firstParagraph.beforePos
step.gapTo === firstParagraph.endPos
step.to === successor.beforePos
```

Step 必须在捕获时 stepDoc 上 apply 后精确等于 live expectedDoc。

## 3. raw source patch

owner 用 successor paragraph `[i,1,0]` 进行 PM→Markdown source-map，分别锁定 `journal.source` 与 previous canonical 中的原列表。

要求：

- source / previous canonical 同级 marker row数等于 old list item数；
- previous canonical 第一 row 是 `<br />`；
- authored source 第一 row body 真为空；
- 第一 row 与 successor row物理连续；
- marker 只允许 bullet `- / + / *`。

成功只删除 authored 第一空 marker row及自己的 EOL。successor marker、列表前后的 block gap、BOM、LF/CRLF和全部其它字节保持。

## 4. semantic transient 不新增例外

本 family 与 interior/tail 不同：PM 的 editor-only empty paragraph 被提升到 `doc` 顶层，而不是留在 list item 内。

共享 semantic comparator 已有严格规则：只在 `doc` 顶层过滤无内容 paragraph；嵌套/列表内部空段不会被该规则忽略。因此 first-lift 不新增 validator allowlist，仍由 raw candidate + list-slot + revision/provenance gate共同验证。

当前会话里该顶层空段继续存在；保存源码后 fresh-profile cold reopen时它自然消失，因为作者 Markdown 没有该空段字节。

## 5. legacy retirement

生产 registry 顺序：

```text
list-empty-item-first-lift
→ list-empty-item-tail-remove
→ list-empty-item-remove
→ list-subtree
→ list-item-paragraph
```

本 family 设置 `legacyRetired:true`。

PM topology/Step 尚未完整证明时 `recognized:false`，让其它 owner继续。PM family已证明但 source row count、first row body、raw range或物理连续性失败时 `recognized:true`，旧 `empty-list-item-removed` / generic canonical fallback不得接管。

loose-first负例：

```markdown
-

- right
```

PM仍执行同一 `ReplaceAroundStep` lift，但作者 rows不连续。owner返回 `list-empty-item-first-authored-row-unproven`，trace为 `recognized:true / legacyBlocked:true`；rich lift保留、warning显示、无Coordinator publication，source/disk保持原字节。

## 6. RS-84 第二拍

RS-84跨列表selection delete的第一拍仍由 dedicated `diverged-cross-list-selection-delete-to-empty-bullet` owner处理，留下一个 transient first empty bullet。

第二拍物理 Backspace 的真实 transaction恰是本 family的 `ReplaceAroundStep`。0.13.153 因此升级永久回归：第二拍必须 reason=`list-empty-item-first-lifted` + exact transaction proof，且不得再出现 legacy `empty-list-item-removed` publication。源码、保存和cold reopen保持原预期。

## 7. 永久门禁

- `test:list-empty-item-first-lift-transaction-owner`
- `test:list-empty-item-first-lift-transaction-ui`
- `test:list-empty-item-first-lift-legacy-retirement-ui`
- `test:cross-list-selection-delete-empty-bullet-ui` 第二拍 transaction ownership

正向 UI覆盖 callback与立即源码 forced-flush、BOM+CRLF、source/save/disk/fresh-profile reopen；当前 rich session必须看到一个顶层 editor-only empty paragraph，cold reopen必须不再存在。

相邻门禁覆盖 0.13.152 tail、0.13.151 interior、isolated ordered lift、RS-72 successor、nested tail、task、rapid double Enter、nested Enter和generic list-subtree callback/forced。全局门禁覆盖 Journal、Coordinator、source transaction sync、完整 preservation、39/39 probes、mixed rich/source、异构 source fidelity和desktop/mobile build。

## 8. 下一 family：ordered successor/lift

ordered first-empty 没有被本 owner认领。下一步需要从现有：

- `test-isolated-empty-ordered-backspace-lift-ui.mjs`
- `test-single-empty-ordered-backspace-successor-ui.mjs`

提取真实 ordered Step/topology、remaining list `start`、作者 ordinal、`.` / `)` delimiter、renumbering和raw patch边界，再设计一个或多个更窄 owner。不能因为 Step 也是 `ReplaceAroundStep` 就复用 bullet first-lift owner。
