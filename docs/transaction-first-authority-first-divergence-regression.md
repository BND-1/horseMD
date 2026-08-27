# RS-79：transaction-first authority 必须先于 legacy integrity 发布

> 修复版本：HorseMD 0.13.124  
> 日期：2026-08-25  
> 状态：自动化闭环完成；authority 默认关闭；真实长文档人工 qualification 待执行。

## 症状

Phase 1 的 `plain-paragraph-inline-replace` 已有严格 ownership、SourceRangeMap、semantic/list proof 和显式 family allowlist。小文档 authority UI 的最终源码也正确，但在扩大到 1000 个普通段落、120KB+、UTF-8 BOM + CRLF 的 authority-on fixture 后，`window.__hmSourceIntegrityTrace` 仍记录了 4 次瞬时 `ok=false`。

失败只出现在 transaction-first 已经认领的首段 insert 与尾段 replace；每笔都先在 legacy `localized-change` 的 `primary-preserved` 与 `before-input-rule-fallback` 各失败一次，随后 callback 末尾的 transaction-first reconcile 又把最终 publication 修正为正确 transaction bytes。中间 plain Backspace 没有出现该红项。

这属于真实 first-divergence：最终自愈不能抵消中途 integrity failure，也不能作为启用 authority 的资格证明。

## 根因

问题不是 transaction candidate、BOM/CRLF、list fingerprint 或 SourceRangeMap 字节范围。parser 级差异精确落在两个被 transaction-first 拥有的目标 paragraph：

- 首段 edit：`$.content[6].content`
- 尾段 edit：`$.content[996].content`

真正的问题是 live callback 的执行顺序：

1. PM transaction 已在 dispatch 时被 Phase 1 classifier 与 mapper 拥有；
2. `markdownUpdated` 到达；
3. 代码仍先运行 legacy `preserveRichMarkdownSource()` 与 `validateSourceCandidate()`；
4. legacy candidate 产生瞬时 integrity failure；
5. callback 末尾才 `reconcileTransactionFirstSourceSync()` 并用 transaction candidate 覆盖 publication。

这仍然是“legacy-first，transaction-last”，与 transaction-first 架构目标冲突。

## 修复

`Editor.jsx` 现在在 legacy preservation 前增加严格的 early authority 分支。只有以下条件全部成立才允许提前 publication：

- 没有 paste、list conversion、whole-document replacement、generated scratch 或 pending list/input intent；
- checkpoint mode 是 `AUTHORITATIVE`；
- `checkpoint.transaction.ok === true`；
- family 精确为 allowlisted `plain-paragraph-inline-replace`；
- callback canonical 重新解析后与当前 live PM document 等价；
- `selectTransactionFirstPublication()` 最终返回 `publication.owner === 'transaction'`。

成立时用 `legacyResult: null` reconcile 并直接发布 transaction bytes；因此 authoritative trace 的 comparison 是 `legacy-unavailable`，不再要求 shadow 阶段的 `promotionEligible=byte-equal`。任何条件不成立都不消费 checkpoint，而是继续既有 fail-closed legacy path。syntax-sensitive `*`、paragraph split、list Backspace 等 rejected/structural 编辑仍在 late reconcile 中记录真实 `publicationOwner=legacy`。

## 长文档 SourceRangeMap 性能边界

同一轮 qualification 还发现 Phase 1 原始 SourceRangeMap 会对每个 plain paragraph 的 start/end 分别调用 scalar `pmPosToMarkdownOffset()`；该函数每次都会 parse Markdown 并重新收集全部 Markdown/PM blocks。1000 段文档因此接近 2000 次全文 parse。

`editor-source-map.js` 新增 `createPmPosToMarkdownOffsetMapper()`：对同一 source/doc snapshot 只 parse/collect 一次，再复用完全相同的 block correspondence 规则处理所有 PM position。`buildPlainParagraphSourceRangeMap()` 在默认 mapper 路径使用这个 prepared snapshot；原 scalar API 与自定义 mapper 注入保持兼容。

## 自动化证据

`test:transaction-first-authority-ui`：

- plain insert/delete/replace → transaction-owned；
- Markdown-sensitive `*`、Enter/split、list Backspace → legacy fallback；
- no source-sync warning；
- final source exact。

`test:transaction-first-authority-large-doc-ui`：

- 1000 paragraphs，>120KB，BOM + CRLF；
- early insert、middle Backspace、tail replace 全部 transaction-owned；
- `integrity ok=false = 0`；
- source textarea 精确；
- 保存后 BOM、CRLF 与所有未编辑字节精确保留；
- 一次通过记录的三笔 edit-to-reconcile 约为 707ms、686ms、1749ms。

同时通过：transaction-first shadow UI、authority policy、source-sync core、rapid shadow chain、11 组 editor source-map、完整 markdown-preservation、source-transaction-sync、build，以及 authority flag 关闭下的四文件×五操作 family matrix 20/20 / exit 0。

## 未完成项

这轮自动化不等同于人工真实长文档 qualification。authority flag 仍是 development-only 且默认关闭；在决定正常发布启用前，仍需要对真实长文档执行一次前/中/后普通段落编辑、源码切换、保存/重开、以及至少一笔结构/list fallback 的人工 smoke，并确认没有 warning/save-paused 或明显交互退化。

