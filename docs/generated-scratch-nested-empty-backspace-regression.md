# RS-56：三级 nested bullet 连续 Backspace 触发源码不一致

## 状态

- 首次真实定位版本：HorseMD 0.13.101。
- 真实 trace：`horsemd-input-trace-75086.jsonl`，首个失败在第 925 行。
- 修复归属：0.13.102。
- 当前状态：已修复；真实快速双 Backspace 专项、源码、保存、冷重开与永久纯函数门禁已通过。

## 真实复现

generated scratch 文档中存在三级无序列表：

```md
- 了就回家快回家
  * i哦好急哦吼
    * 我
```

用户在最深项连续 Backspace：先删除最后一个正文字符 `我`，约 120ms 后再次 Backspace 退出/退层空项。

真实 PM 时序分成两个不同事务：

1. `* 我` → `* <br />`：最深 list item 仍存在，只是正文变空；
2. 再次 Backspace：最深 list layer 被移除，空 paragraph 提升为上一级 list item 的 editor-owned trailing paragraph。

0.13.101 在这两个紧邻事务/markdown callback 交错时出现 `source-document-mismatch`；后一笔正常 mapper 随后又能返回 `empty-list-item-removed`，因此只看最终日志会把首次失败误判成“退层事务本身”。

## 修复原则

- 必须以第一次分叉为准，不按最终症状补字符串。
- “正文删空但 marker 仍存在”和“marker 已消失、item 真正退出”必须是两个独立事务合同。
- 不持久化 `<br />`；不放宽普通 HTML/空 paragraph 的语义完整性。
- `empty-list-item-removed` 只能拥有真正的 list-item removal/lift，不得吞掉仍存在的空 nested item。
- 保留 RS-51 的 editor-owned trailing empty paragraph 窄语义合同。

## 修复

根因在 façade 前处理顺序：`preserveDivergedTailBlockAppend()` 用原始 canonical 能严格证明最深 nested list row 被删除，并生成正确作者源码；但 `preserveRichMarkdownSourceCore()` 先调用 `normalizeEmptyListItems()`，把原始 `    <br />` 的缩进抹掉，导致同一 mapper 退化成通用 `diverged-tail-line-delete`。generated scratch 只复用明确的 list-item removal reason，于是丢弃正确局部结果，整篇 canonical candidate 又因缺少 parent item 的 editor-owned trailing empty paragraph而被 integrity gate 拒绝。

0.13.102 在 normalize 前用原始 canonical 做一次窄证明，只在 tail mapper 严格返回 `nested-empty-list-item-removed` 时提前采用；其它 raw-tail 结果一律忽略。generated callback 和强制 flush 都只对 `empty-list-item-removed` / `nested-empty-list-item-removed` 复用局部证明；nested reason 不创建 RS-52 的 post-list transient token。semantic comparer 仍默认严格，只在这两个已证明的 removal reason 下忽略恰好一个 trailing empty list-item paragraph。

## 专项回归

`scripts/test-generated-scratch-nested-empty-backspace-ui.mjs` 复刻真实节奏：新文档建立三级 bullet，最深项只含 `我`，Backspace 删空后约 120ms 再 Backspace 退层；最终 `preservationReason=nested-empty-list-item-removed`、`ok=true`、`semanticOk=true`、`listSlotsMatch=true`、无 toast，源码无 `<br />`，保存和冷重开稳定。

永久纯函数：`test:markdown-preservation` 锁住 raw façade reason/源码；`test:source-transaction-sync` 锁住 nested trailing-empty 默认严格、显式 opt-in 才等价。
