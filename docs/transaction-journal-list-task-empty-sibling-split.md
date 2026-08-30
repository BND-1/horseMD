# Transaction Journal：task empty sibling split

## 目标

0.13.165 迁移 Stage E task-list 的第二个 focused family：用户在已有 task item 正文末尾按 Enter，新建一个空同层 task sibling；源码只在原 task 行后插入一个 byte-preserving 的 task sentinel row，不再由 broad/legacy list mapper重写作者 marker。

本 family 不处理 task conversion、typed `- [ ] ` input rule、正文中间 split、空 task sentinel 填充/退出、Backspace、跨列表或 ordered task。

## Scope

- container 必须是 `bullet_list`；
- target `list_item.attrs.checked` 必须为 boolean；
- target 只有一个无 marks、非空 plain paragraph；
- Enter 必须发生在 paragraph content end；
- right sibling 必须为空 task，attrs 与 old target 完全一致；
- 支持 top-level task；
- 支持 top-level plain non-task parent 下的一层 nested task；
- ordinary bullet、ordered task、middle/start split 与复杂 multi-block task no-hit。

## 真实 Step

真实 HorseMD 的 top unchecked、top checked、nested checked 都是单 transaction / 单 `ReplaceStep`：

- `structure === true`；
- `slice.size === 4`；
- `openStart === 2`、`openEnd === 2`；
- `from === to === paragraph.contentStart + text.length`；
- slice 包含两个空 `list_item` wrapper；
- 两个 wrapper 的 attrs 都与 old task attrs 完全相同。

Step 在 Journal 捕获的 `stepDoc` 上 apply 必须精确等于 live `expectedDoc`。因此新空 sibling 的 checked/unchecked 状态不是从 Markdown 猜测，而是 transaction-owned attrs 直接证明。

## Raw source patch

安全 task row 形状：

`indent + authored bullet token + marker spacing + [state] + task spacing + body`

当前合同要求：

- top-level indent 为 `''`，nested indent 恰两个 ASCII spaces；
- 作者 bullet token 可为 `-`、`+`、`*`；
- bullet marker spacing 与 task marker 后 spacing 均为一个 space；
- checked task source state 可保留作者 `x` 或 `X`，unchecked 为 space；
- body 必须能用 plain text + 有限 Markdown backslash escape 逐字符证明；
- EOL 为 LF 或 CRLF。

成功时只在原 target row 的物理 EOL 之后插入：

`same indent + same authored token + same spacing + same checkbox spelling + U+200B + same EOL`

原 task row、正文、BOM、邻项与其它 bytes 全部保持。

## 为什么需要 U+200B

裸 `- [ ] ` / `+ [x] ` 空 task row 不能稳定重建 HorseMD 的空 task sibling 语义；项目已有 source-owned U+200B sentinel 合同。0.13.165 只负责 Enter 这第一拍，把 sentinel row 原子写入；继续输入正文如何消费 sentinel 是下一独立 family `empty-task-sentinel-filled`。

## 修复的 fidelity divergence

迁移前真实诊断：

- top-level task Enter 会命中 legacy `list-line-change`，作者 `+` marker 被 canonical 改成 `*`，并曾出现 `semanticOk:false`；
- nested task Enter 会命中 legacy `middle-empty-block-list-filled`；
- broad `list-subtree-replace` 因 task metadata 拒绝。

迁移后 callback/forced 回归要求只有 `list-task-empty-sibling-split` publication，明确禁止 `list-line-change`、`middle-empty-block-list-filled` 与 broad list publication；source、save、disk、fresh-profile reopen 都必须与 expected bytes 一致。

## Retirement

owner 注册为 `legacyRetired:true`，位于 `list-task-checkbox-toggle` 之后、ordered/broad list owners 之前。

永久负例使用 entity-authored task：`+ [ ] A &amp; B`。PM topology 与 exact ReplaceStep 已足以分类 family，但 raw body 当前不猜 entity 解码，因此必须返回 `recognized:true + legacyBlocked:true`。rich Enter 保留、warning 可见，legacy/broad/Coordinator 不得 publication，disk 保持原字节。

## 永久回归

- `test:list-task-empty-sibling-split-transaction-owner`：top unchecked、top checked uppercase `X`、nested checked、exact Step/slice/path、BOM+CRLF、`1\\.` escape、entity/wrong-step fail-closed、middle/ordinary/ordered no-hit。
- `test:list-task-empty-sibling-split-transaction-ui`：top-level callback + nested forced，focused-only publication，作者 marker/state spelling/source/save/disk/fresh-profile reopen。
- `test:list-task-empty-sibling-split-legacy-retirement-ui`：entity body recognized+legacyBlocked，rich Enter 保留、disk 不变。
- `test:task-enter-empty-sibling-ui`：RS-70 已升级为 Enter 第一拍必须 focused-owned，且后续正文仍明确命中 legacy `empty-task-sentinel-filled`，用于锁定下一 family 边界。

## 门禁

相邻已通过 task checkbox toggle、task persistence、RS-58 task continuation empty、RS-60 empty-task Backspace、nested bullet split/join 与 generic list-subtree。全局已通过 Journal、Coordinator、source transaction sync、完整 Markdown preservation、39/39 source-fidelity probes、mixed/heterogeneous Electron fidelity、desktop/mobile build和 `git diff --check`；只有既有 Vite large-chunk warning。

## 下一步

下一独立 family 是 `empty-task-sentinel-filled`：从刚插入的 U+200B 空 task 中继续物理输入正文。必须先记录真实 transaction/ReplaceStep 链与 source/canonical 中 sentinel 消费的 byte boundary，再建立 focused owner 和 legacy-retirement 负例。task empty-row Backspace、task conversion、typed input rule 与 cross-list/coalescing 继续保持分离。
