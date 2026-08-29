# Transaction Journal：nested empty bullet tail indent

## 目标

0.13.157 迁移 nested-list 阶段的第一个窄 family：顶层 plain bullet list 最后一个空 item 按物理 Tab，被 ProseMirror sink 到紧邻前一个非空 sibling 下。

本 family 名称为 `list-nested-empty-bullet-tail-indent`。它只完成 tail-empty Tab indent，不代表 nested list 的 indent/outdent/split/join 已整体迁移。

## 真实输入与事务

HorseMD 对普通列表 Tab 没有自定义 keydown 分支，实际行为来自 ProseMirror list keymap 的 `sinkListItem`。

RS-64 实机 `--horsemd-input-trace` 与最小 schema 的真实命令均得到：

- 一次 document-changing transaction；
- 一个 `ReplaceAroundStep`；
- `structure=true`；
- `sliceSize=3`；
- `openStart=1`；
- `openEnd=0`；
- `insert=1`。

对于 target tail item：

- `target.beforePos === parent.beforePos + parent.nodeSize`；
- `step.from === target.beforePos - 1`；
- `step.gapFrom === target.beforePos`；
- `step.to === target.beforePos + target.nodeSize`；
- `step.gapTo === step.to`。

Step slice 是一个 `list_item` wrapper，内部包含一个空 `bullet_list` wrapper；target item本身位于 gap中，被移动进新 nested list。

## Topology ownership

old top-level list必须满足：

- 节点是 `bullet_list`；
- 至少两个 items；
- target 是最后一个 item；
- target 是 non-task plain bullet item；
- target 只有一个空 paragraph；
- target 的前一个 sibling 是 non-task plain bullet item；
- parent 只有一个非空 plain paragraph；
- parent 尚无 nested list；
- target之前更早 siblings全部不变。

new list必须满足：

- top-level item数量减少 1；
- parent仍在原 index；
- parent首 paragraph与attrs不变；
- parent新增一个 nested `bullet_list`；
- nested list恰含一个 item；
- 该 nested item与old target精确 `.eq()`；
- 其它 top-level siblings不变。

以下明确不属于本 family：

- middle empty item；
- nonempty target；
- parent已有 nested list；
- task；
- ordered list；
- Shift+Tab / outdent；
- split/join。

## Milkdown wrapper attrs

真实 Milkdown 有一个表示层差异：

- parsed top-level `bullet_list.attrs.spread` 为字符串 `"false"`；
- `sinkListItem` 新建 nested wrapper 的 `spread` 为布尔 `false`；
- Step slice 中 nested wrapper同样为布尔 `false`。

owner只在 **list wrapper proof** 中把 `false` 和 `"false"` 视为同一 false 语义。target item、parent item与其它 attrs仍按原节点精确验证，不修改全局 attrs comparator。

## Raw source patch

旧 broad list mapper可以让RS-64功能正确，但会把作者 nested marker改成 serializer 默认 `*`。0.13.157 不复刻该行为。

Markdown parser实验验证：

- `- beta\n  - ` 不能稳定表示“beta父项 + 空nested child”；
- `- beta\n\n  - ` 可以稳定解析为目标结构；
- `- beta\n\n  * ` 也可解析，但会改变作者marker。

focused raw patch因此只做一个 insertion：

`targetRow.start` 前插入 `EOL + 两个 ASCII spaces`。

例如：

```text
- alpha
- beta
-␠
```

变为：

```text
- alpha
- beta

  -␠
```

source proof当前要求：

- source list row数等于old PM item数；
- 所有top-level source rows使用同一 bullet token；
- 每行 marker spacing恰为一个 ASCII space；
- parent body精确等于PM parent正文；
- target authored body为空；
- parent与target原本物理相邻；
- bounded list fragment EOL统一；
- source block为顶层 indent 0。

成功时不改 marker、spacing、body或既有EOL，只新增 parse-safe blank line + indent。

## CRLF 边界

`listBlockAt.end` 在该场景指向最后一行的 LF byte。若用 `slice(start, end)` 检测 EOL，会留下 terminal CR 并把纯 CRLF误判成 `CRLF + CR` mixed EOL。

focused owner在 EOL proof 中若 `source[block.end] === '\n'`，使用 `block.end + 1` 作为 physical end，保证完整物理行终止符参与检测。该修复只影响本owner的raw EOL proof。

## Validation

本 family **不新增 semantic exception**。

原因是 nested empty bullet有合法、parse-safe authored Markdown。owner在patch后直接调用生产 `validateTransactionMarkdown`：

- parser document必须与 live expectedDoc等价；
- strict ordered-number/list-slot gate仍运行；
- proof仍绑定snapshot/document、Step、path与source digests。

## Legacy retirement

production structural registry把 `list-nested-empty-bullet-tail-indent` 放在 broad `list-subtree` 前，并设置 `legacyRetired:true`。

PM topology/Step尚未证明时 `recognized:false`，允许其它 focused owner继续分类。

一旦 exact `sinkListItem` family已证明，而 authored source range/row/spacing/EOL无法按当前合同安全证明，则返回 `recognized:true`，共享 registry立即设置 `legacyBlocked:true`。

因此负例中：

- rich Tab sink仍保持；
- nested list仍可见；
- source不被 broad list mapper“救回”；
- legacy canonical diff不接管；
- Coordinator不发布；
- warning可见；
- disk保持原字节。

当前永久负例使用 `-  alpha / -  beta / -  ` 的两空格 marker spacing。该形状可解析成同一PM family，但raw byte合同刻意不泛化。

## 永久回归

### Pure owner

`test:list-nested-empty-bullet-tail-indent-transaction-owner`

使用真实 `sinkListItem` 生成Step，覆盖：

- exact ReplaceAroundStep参数；
- BOM+CRLF；
- authored `+` marker；
- parent/target/nested paths；
- raw insertion；
- target body mismatch -> recognized fail closed；
- 两空格 marker spacing -> recognized fail closed；
- nonempty target -> no-hit；
- parent已有nested -> no-hit；
- task -> no-hit；
- ordered -> no-hit；
- callback document mismatch。

### RS-64 full cycle

`test:empty-bullet-indent-ui`

原RS-64从 broad `list-subtree-replace / batched-list-block-changes` 迁为focused owner，并要求：

- Tab后focused transaction publication；
- broad owner无成功publication；
- source为 `  - `，不再变成 `  * `；
- 继续输入`s`后source为 `  - s`；
- save与cold reopen稳定。

继续输入阶段仍由现有 legacy `tail-empty-list-item-filled` 处理，这是另一个未迁移 family，不在0.13.157范围内。

### Callback / forced

`test:list-nested-empty-bullet-tail-indent-transaction-ui`

覆盖 BOM+CRLF + authored `+` marker 的 callback 与立即 source-toggle forced-flush：

- focused只发布一次；
- boundary分别为markdown-updated / forced-flush；
- broad无publication；
- raw insertion为 `\r\n  `；
- source textarea、save、disk、fresh-profile reopen精确。

### Legacy retirement

`test:list-nested-empty-bullet-tail-indent-legacy-retirement-ui`

两空格 authored marker spacing必须：

- focused trace `recognized:true + legacyBlocked:true`；
- no broad/legacy/Coordinator publication；
- rich indent仍在；
- warning出现；
- disk不变。

## 已通过资格门禁

focused：

- pure owner；
- RS-64 full cycle；
- callback/forced；
- retirement negative。

相邻 nested/list：

- nested Enter empty sibling；
- rapid nested parent Backspace；
- empty bullet after nested list Backspace；
- empty ordered parent before nested Backspace；
- generated nested empty Backspace；
- generated task Backspace；
- first/tail/interior empty-item；
- 0.13.154 isolated ordered；
- 0.13.155 single successor；
- 0.13.156 multi-successor chain；
- generic list-subtree；
- nested 3×2 fidelity continuous + slow。

全局：

- SourceSyncTransactionJournal；
- SourceSyncCoordinator；
- source transaction sync；
- complete Markdown preservation；
- source-fidelity probes 39/39；
- mixed rich/source Electron；
- heterogeneous source-fidelity Electron；
- desktop build；
- mobile build；
- `git diff --check`。

## 后续边界

0.13.157 只迁移一个 tail-empty Tab sink。

下一步仍属于 Stage E nested list：先捕获 nonempty/middle Tab indent 与 Shift+Tab outdent 的真实 Step/stepDoc/path，再决定各自的 focused family；nested split/join仍需独立取证。不要因为RS-64已迁移就删除generic nested list owner或宣称nested阶段完成。
