# 交接：松散列表项续行内的 IME 结构性段落分裂（P6e，trace-38723）

> 新会话第一件事读本文件 + 账本条目（`docs/source-rich-consistency-completion-plan.md`
> 搜 **P6e**）。本条目是用户硬性要求：**修完后今后改任何功能/修任何 bug 都不能再触发
> 这类警告**——验收里"加入常驻矩阵"就是这句话的机制化。

## 事故（2026-09-12 10:16:37，0.13.207，pid 38723）

用户在 redis 大文档（333K 字符 / 394 fence / 642 列表行，既有转义+表格填充分歧态）
的列表项**缩进续行段落**里用中文 IME 连续输入，composition 中途夹了一次结构性段落
分裂（journal `ReplaceStep from=15508 structure:true sliceSize=4`）：

1. 文字被 `locally-aligned-change` 成功发布；**段落分裂无人认领** → PM 比源码多
   顶层结构块（canonical 3540 vs source 3535；首个列表路径 972→973 错位）
2. 下一键校验 `listSlotsMatch=false` → `source-list-structure-mismatch` 警告
   （fail-closed 正确，源码/磁盘未坏，编辑器内容完好，保存写盘走 PM 序列化内容安全）
3. 4 次 Backspace 后重试 `visible-stream-mismatch` → 同步挂起

**已排除 0.13.207 性能缓存的嫌疑**：离线逐字节复现，生产端与离线端候选完全一致。

## 证据（已永久化，TMPDIR 会清所以进仓库）

`scripts/fixtures/ime-loose-item-split/`：

- `source.md` / `previous-canonical.md` / `canonical.md` — 事故三元组逐字节
- `journal.json` — 完整 evidence dump（journal 链 / preserve 链 / integrity / coordinator）
- `repro.mjs` — Node 直跑（~775ms），当前基线输出：
  `preserved=true reason=locally-aligned-change markdownLength=333602`（文本发布、结构欠账）

## 修法（focused owner，镜像 P3b 的手法）

- **形状是源码可表示的**：松散项续行段落分裂 → 终态 bounded patch = 在续行段落的
  分裂点插入作者 EOL + 项缩进（`  `）续行
- **合同**：P1 公共 pending-text 链（`source-sync/pending-text-transaction-chain.js`）
  + 终态结构 split 落在**已证明的松散 list_item 续行 paragraph** 内
- **参照**：P3b（嵌套 bullet IME→Enter split，账本有完整记录，含"链重放阶段拒绝必须
  降级为普通 rejected，只有终态结构步已定位后的拒绝才 recognized"的教训）

## 验收（硬性）

1. owner Node 合同：trace 形状正例 + 门控/fail-closed 负例（照
   `test-cross-fence-span-transaction-owner.mjs` 的样式）
2. 真实 Electron E2E：`Input.imeSetComposition` 真实 IME，在真实文档形状上复刻
   composition → split → 继续输入 → **零警告**、源码含新续行、存盘冷重开一致
3. **加入常驻矩阵**（goal-matrix / family-matrix 新增该场景）——这是"以后改什么
   都不能再触发"的机制保障，不做到这条不算完成
4. 相邻回归：cross-fence-span、list-subtree、blockquote 家族、mixed、goal-matrix
5. 版本 +1、CHANGELOG、账本条目改"已完成"

## 当前仓库状态

- main = 0.13.207 + 滚动漂移修复（`00a749d`，未发布；上一发布 v0.13.205）
- /Applications 已装 0.13.207+滚动修复，当前 pid 38723 带 `--horsemd-input-trace`
  （用户还在测试；新触发直接拉该 pid 的 trace）
- 大文档性能两根因已修（eager 封顶 + preserve O(n²) 缓存），#126 已回复
