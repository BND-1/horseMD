# 交接：分歧大文档的 transition 等价性墙（trace-62663 第三族，未修）

> 状态：**已完整归因，未修**。这是 2026-09-12 晚用户实机连续触发的第三族；
> 前两族（P6e 填充 owner 的 callbackDocumentEquivalent 硬门、mermaid
> StreamLanguage spec 误用）已在 0.13.208/0.13.209 修复并各自有常驻回归。
> 证据在 `scripts/fixtures/redis-transition-wall/`（source / candidate /
> canonical / previous-canonical / published-markdown + meta.json）。

## 事故（trace-62663 = 0.13.209 带日志实机会话）

用户在 redis 大文档连续真实编辑，两簇触发（13:55:57Z 与 16:46Z）：

1. **手势**：嵌套列表项内删字（`diverged-nested-list-change` 发布 ✓）→ 空项
   Backspace 删除（`empty-list-item-removed` 发布 ✓）→ **再一次 Backspace =
   joinBackward**（journal：单笔 `ReplaceStep 13479→13481 structure:true
   slice=0` + 后续打字步骤持续并入同一本 journal）→ 无 owner 认领 → legacy
   候选（`empty-paragraph-before-fence-removed` / `middle-block-before-authored-fence`）
   **被 integrity 拒绝**：`source-document-mismatch` 警告，重复多次。
2. 晚间簇的失败候选 === source（no-op 拒绝，走 no-op hold 但警告先由校验点发出）；
   00:46 簇是真实候选被拒。

## 归因（已离线验证到机制层）

`ok = semanticProofOk && listProofOk`：

- `listSlotsMatch=true`（两簇都是）→ `listProofOk=true`，**不是**列表槽问题。
- `semanticOk=false` 是该文档**慢性**状态：作者字节与序列化字节在内联层解析
  不同（`huangz(https://…)` 纯文本 vs `huangz(<https://…>)` autolink；strong
  拆分形态等，散布全文几十处）。
- 分歧文档的唯一通过通道是 **transitionOk**：`areSourceDocumentTransitionsEquivalent`
  证明「作者侧变更窗口 ≡ 期望侧变更窗口」。但 `semanticTransition` 的窗口内容
  仍是**内联形态敏感**的 JSON 比对——变更窗口一旦触碰任何不对称位置，
  两侧窗口的链接/标记形态不同 → transition 不等 → `semanticProofOk=false`
  → `ok=false` → 警告。窗口在干净区域的编辑（当晚早些的
  `diverged-nested-list-change` ok:true）照常通过。
- 已排除：checkpoint 投毒（coordinator 成功发布后会 `checkpointStore.trust`
  重建）；PM 里积累的 5 个散落编辑器空段（`<br />`，doc 顶层归一化已滤除，
  非驱动因素——但注意它们的**序列化形态**让 canonical 与 source 的块数错位，
  是内联不对称的伴生现象）。

## 修法方向（下一会话决策，二选一或组合）

- **A（推荐先评估）：transition 比较的内联归一化**——在 `semanticTransition`
  的窗口比对里对内联标记做"文本等价"折叠（link/autolink/emphasis 拆分 → 比
  较可见文本序列而非 marks 形态），仅限 transition 通道（全文 semanticOk 通道
  保持严格，避免掩盖真实样式分歧）。需要合同锁：折叠除外情形（真实加粗/链接
  变化不得被误判等价——用"两侧窗口**相对**变化一致"的语义而不是绝对形态）。
- **B：joinBackward+文字合并 journal 的 focused owner**（终态 bounded patch =
  删空行 + 新行），把本手势移出 legacy——只能治本族手势，治不了其它窗口撞墙
  的手势（用户乱测会继续开出新族）。

## 验收（沿用 P6e 标准）

Node 合同（transition 折叠正反例）+ 真实 E2E（本 fixture 重放删字→删项→join→
打字，零警告）+ goal-matrix 常驻 + 相邻回归。版本 +1、CHANGELOG、账本。

## 现场注意

- 用户正在此文档上验收，0.13.209 已装（含 P6e 两层修复 + mermaid 修复）。
- 触发时 trace 自动落盘（带 `--horsemd-input-trace` 运行），新触发直接读
  `$(getconf DARWIN_USER_TEMP_DIR)/horsemd-input-trace-<pid>.jsonl`。
