# Transaction Journal：task checkbox toggle

## 目标

0.13.164 迁移 Stage E task-list 的第一个 focused family：用户点击已有 task item 的 checkbox，仅切换 ProseMirror `list_item.attrs.checked`，并让 raw Markdown 只改变 `[ ]` / `[x]` 的状态字符。

本 family 不处理 task creation/conversion、`- [ ] ` typed input rule、空 task Enter sentinel、Backspace/exit 或 ordered task。

## Scope

- parent container 必须是 `bullet_list`；
- target `list_item.attrs.checked` 在 old/new 都必须是 boolean；
- target只有一个无marks非空paragraph；
- old/new仅 `checked` 翻转，非checked attrs与content不变；
- 支持 top-level task；
- 支持 top-level plain non-task parent 下的一层 nested task；
- ordinary item `checked:null→false`、ordered task、multi-block task、sentinel/empty task均 no-hit。

## 真实 Step

真实 HorseMD 顶层与nested checkbox点击都产生单transaction / 单 `AttrStep`：

`step.pos === targetListItem.beforePos`

`step.attr === 'checked'`

`step.value === nextChecked`

Step在Journal捕获的stepDoc上apply必须精确等于live expectedDoc。

### Nested target 为什么不用 generic list_item diff

nested task的leaf attrs变化会让祖先parent list_item的`.eq()`也变化，因此按“changed list_item”枚举会同时得到ancestor与leaf。0.13.164改为先在old/new tree中找到唯一 checked boolean翻转、content与非checked attrs不变的task leaf，再用 exact `AttrStep.pos` 绑定它。这是Step-first ownership，不从canonical/list subtree形状猜target。

## Raw source patch

安全task row格式：

`indent + authored bullet token + marker spacing + [state] + task spacing + body`

成功时只改`[`和`]`之间的一个状态字符：

- ` ` → `x`；
- `x` / `X` → ` `。

其余全部逐字保持：indent、作者 `-`/`+`/`*`、marker spacing、task spacing、正文、BOM、LF/CRLF和邻项。

正文proof当前接受plain text与Markdown可转义标点的有限 `\\x → x` 对齐；entity/复杂inline不猜。

## 修复的 fidelity divergence

真实Electron诊断证明迁移前checkbox点击由legacy `list-line-change` publication：

- 作者 `+ [ ] Top task` 勾选后会变成 `* [x] Top task`；
- nested作者 `  + [x] Nested task` 取消后会变成 `  * [ ] Nested task`。

0.13.164 focused owner只改checkbox state，永久回归要求作者 `+/-` marker在source/save/disk/cold reopen都不变化。

## Retirement

owner注册为`legacyRetired:true`，位于nested join之后、ordered/broad list owners之前。

永久负例：`+ [ ] A &amp; B`。PM family的exact checked AttrStep可以证明，但raw body `A &amp; B` 不属于当前有限plain/escape proof，因此必须 `recognized:true + legacyBlocked:true`：rich checkbox切换保留、warning可见，legacy `list-line-change`、broad、Coordinator均不得publication，disk保持原字节。

## 永久回归

- `test:list-task-checkbox-toggle-transaction-owner`：top-level/nested、false→true/true→false、exact AttrStep、BOM+CRLF、作者marker与`1\\.`、entity/wrong-step fail-closed、ordinary conversion/ordered no-hit。
- `test:list-task-checkbox-toggle-transaction-ui`：top-level callback + nested forced，focused-only publication，只改checkbox state，source/save/disk/fresh-profile reopen。
- `test:list-task-checkbox-toggle-legacy-retirement-ui`：entity body recognized+legacyBlocked，rich toggle保留、disk不变。
- 原 `test:task-list-persistence-ui` 继续作为check/save/reopen/uncheck/save/reopen相邻门禁。

## 门禁

相邻已通过 RS-70 task Enter empty sibling、RS-58 generated task continuation empty、RS-60 generated empty task Backspace、0.13.162 split、0.13.163 join 与generic list-subtree。全局通过Journal、Coordinator、source transaction sync、完整preservation、39/39 probes、mixed/heterogeneous Electron fidelity、desktop/mobile build和`git diff --check`；仅有既有Vite large-chunk warning。

## 下一步

下一独立 family 是 task Enter/sentinel 生命周期。需要先对 `taskEmptyNext`、zero-width sentinel、新空task sibling填充/退出分别抓真实 transaction/Step，再决定是否可合并。task conversion、typed input rule、cross-list/coalescing仍后排，不能并入checkbox AttrStep owner。
