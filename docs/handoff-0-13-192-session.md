# HorseMD 会话存档（0.13.187 → 0.13.192，2026-09-01）

> 给压缩后的下一个 AI 接手。长期进度账本仍是
> `docs/source-rich-consistency-completion-plan.md`。本会话从 v0.13.187 发布后继续，
> 由用户真实触发驱动（全部带 `--horsemd-input-trace`）。

## 当前状态

- **已安装版本**：`/Applications/HorseMD.app` = **0.13.192**，以 `--horsemd-input-trace` 运行（pid 23324）
- **最后提交基线**：`f24815e`（main 分支，已含本轮全部修复）
- **发布**：v0.13.187 已发 GitHub Release（14 assets，含自动更新 feed）；0.13.188–0.13.192 未发布，只本地安装
- 工作区干净（仅历史 untracked 诊断脚本，勿 clean/reset）

## 本会话修复链（全部由用户触发驱动，每个先从 trace 归因）

| 版本 | 提交 | 触发 | 根因 | 修复 |
|---|---|---|---|---|
| 0.13.188 | 3eb7ef7 | 嵌套列表项退格链误报 ×5 + 空列表项填充警告 | ①嵌套项文本编辑无 owner ②零字节候选仍警告 ③有序嵌套拆分的 relabel 步被 recognized 劫持 ④visible-mismatch 重写未触碰行 marker ⑤CRLF 空项填充 CR 落行中间 | ①list-item-paragraph 放开到任意嵌套深度+终态行内补丁 ②no-op 候选静默挂起 ③降为普通拒绝 ④保留作者 marker 前缀 ⑤CR 剥离由适配器补回 |
| 0.13.189 | 1378c3c | "但凡编辑就触发"（CRLF 文件） | localized 映射插入点落在 `\r` 和 `\n` 中间，孤立 `\r` 再解析为换行拆行 | CRLF 原子守卫：映射边界落进 `\r\n` 对中间则回退到 `\r` 前 |
| 0.13.190 | 0d53b9b | 删除代码块下方文字退格进代码块 | localized 映射跨 fence 行拼接，提交奇数个 ```（未闭合 fence 吞后续内容=用户"文字融入代码块"） | fence 守卫：映射区间触碰 fence/在 fence 内/替换含 fence → fail-closed `localized-fence-crossing` |
| 0.13.191 | 2454bd5 | 框选 1146 字符跨块删除警告 | 同为 no-op 候选警告但走 `visible-stream-mismatch` 分支（无 blocked 标记） | no-op hold 泛化到**任何** preserved:false 且候选===源码 |
| 0.13.192 | f24815e | 同操作仍有 1 次警告 | ①flush 路径（Cmd+Z 触发）的 no-op 仍警告 ②localized 把整块删除当文本 delta，补丁只删一半 | ①editor-api flush 同样静默（仍 fail-closed 返回 null）②空替换跨空行块边界 → fail-closed `localized-multi-block-delete` |

## ⚠️ 未修好的：代码块相关的两个缺口（用户已知，等下处理）

### P5b：`goodsTable` 表格型 fence 吸收后续块（主要缺口）

- **症状**：` ```goodsTable ` 内的 pipe 表被 Milkdown 渲染成可编辑表格；从表格下方段落开头退格，内容被吸收进表格最后一格 → **每次按键都警告**（fail-closed 正确，文件不坏）
- **根因**：`replaceChangedTableBlock` / `preserveTableTextChange`（`src/renderer/src/lib/markdown-preservation/tables.js`）**对 fence 完全无感知**——`tableBlockAt` 把 fence 内 pipe 行当普通表；发布只替换表格区域，被吸收的段落留在候选里 → 校验失败
- **尝试过并回退**：给两个 table mapper 加"absorb-run 删除扩展"（`withAbsorbedLinesRemoved`），mid-chain 每键一次的中间状态下产生伪影（cell 文本重复片段 `以下数到以下数据`、closing fence 被误删）——已 `git checkout` 回退 tables.js。**教训：不要在 per-keystroke 的 legacy mapper 里做有界补丁，需要完整的 chain proof**
- **正确修法**：新建 focused transaction owner（mirror code-block 家族）：证明"表格吸收后续块"的完整 PM 事务链（0..N 笔 ReplaceStep + 终态结构步），终态 bounded patch = 表格区域更新 + 被吸收行整段删除，fence 行硬边界。验收样本 = E2E trace `/var/folders/.../horsemd-input-trace-12063.jsonl`（04:44–04:47 窗口）
- **注意**：普通代码 fence（```js 等）的删除链**已修好**（0.13.190 fence 守卫），零警告验证过。只有"表格渲染型 fence"（goodsTable 等）还有问题

### P5c：格式分歧文档的跨块选区删除

- **症状**：框选跨多块（含 fence）大段删除 → 现在不警告了（0.13.192），但删除**不会即时同步到源码**（靠后续回调/flush 重试累计 delta）
- **根因**：文档与 canonical 只有格式分歧（紧凑表格分隔行 vs 对齐填充、`45~60` vs `45\~60`）→ 可见流完全一致 → `preserveDivergedVisibleDelete` 的 `prevVis === srcVis` 守卫正确拒绝；无 owner 拥有此形状
- **修法**：以选区 ReplaceStep 的 from/to（PM 事务证据有精确范围）为锚建选区级 owner，在源码定位对应区间（含不可见 fence 行）整段删除，过完整校验。与 P5b 同属"选区级结构操作"家族，可一并设计

### 既有失败清单（独立于本会话，基线验证一致）

- `test:nested-number-list-source-ui` + `test:diverged-list-structure-ui`：`- 1. 甲乙` 惰性有序标记歧义家族，在干净 0.13.187 基线上同样失败
- `test:rs-41-source-sync` UI raw paste 的 `-`→`*`；`test:list-item-literal-marker-source-ui`

## 用户工作方式（重要，不变）

1. 每轮改完：自测（goal-matrix + 回归）→ **版本 +1** → `CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:dir` → 装到 `/Applications` → `open -a HorseMD.app --args --horsemd-input-trace` → **确认新 pid**（`kill -9` 旧 pid 后重开；`killall` 有时不生效）
2. 用户触发后说"看下"→ 从 `$TMPDIR/horsemd-input-trace-<pid>.jsonl` 拉 evidence dump 归因（journal 步链 + coordinator 发布序列 + integrity candidate/canonical 尾文本）
3. 直接修，改完自测再给结果，不问"要不要继续"
4. goal-matrix（`test:goal-input-matrix-ui`，42 检查点）是验收底线

## 本会话技术事实（踩坑记录）

- `tableBlockAt` 的表格 span 止于最后一个 pipe 行；fence 内表格的"下一行"是 closing fence —— absorb 类补丁极易误删 fence
- `sourceVisiblePositionAtRaw` 可见流中 fence 行零宽度；`preserveDivergedVisibleDelete` 的 `prevVis === srcVis` 守卫使**格式分歧文档**（可见流一致）永远进不了可见删除路径
- editor-api 的 flush（Cmd+Z/保存触发）与 markdownUpdated 回调是两条独立警告路径，修 no-op 警告要**两处都盖**
- E2E harness：源码切换按钮要用真实鼠标坐标点击（`Input.dispatchMouseEvent`），`.click()` 无效；toast 里 `已保存 ✓` 是保存成功提示不是警告，断言要排除
- 测试 fixture 的 canonical 要按序列化器真实输出写（表格对齐填充、`45\~60` 转义），手写近似 canonical 会让归因走偏

## 验证矩阵（0.13.192 全绿）

goal-matrix 42/42、markdown preservation、full-doc delete、diverged partial delete、mixed transactions、code-fence deletion、middle code-block、list conversion、scratch marker spelling、CRLF 五轮审计（17+8+2+2+1 形态）
