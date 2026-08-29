# HorseMD 源码 / 富文本一致性最终收口计划

> 建立日期：2026-08-29
> 当前源码版本：`0.13.148`
> 分支：`fix/rs-41-rich-source-divergence`
> 最终目标：任何成功持久化的 revision 都满足 `parse(committed source) ≈ committed ProseMirror doc`，源码模式、磁盘和冷重开逐字一致；无法证明的事务只能 fail closed，绝不静默写入错误源码。

## 1. 最终完成定义

项目只有同时满足以下条件，才能宣布“源码与富文本不一致 P0 已关闭”：

1. 作者 Markdown 是唯一持久化事实源；ProseMirror 只提供编辑事务和交互状态。
2. 所有用户可达的持久化操作都通过 `SourceSyncCoordinator` 原子发布，不存在直接成功写 source ref、canonical ref、host `onChange` 或磁盘的旁路。
3. 每个 recognized transaction 都只有两种结果：
   - 由唯一 owner 生成 bounded raw patch，并通过 parser、semantic、list-slot、revision 与 provenance 校验后提交；
   - fail closed，作者源码和磁盘保持不变，并提供 warning / recovery 出口。
4. 新 owner 拒绝后，旧 canonical-diff 逻辑不得重新猜测同一已识别 family。
5. 未编辑字节、BOM、LF/CRLF/lone-CR、列表 marker、ordered delimiter、围栏风格、空行和表格 spacing 保持。
6. 源码 textarea、tab mirror、host state、disk bytes 与 fresh-profile reopen 一致。
7. 正式安装包的长会话 first divergence 为零，不允许“先报错后自愈”。

这里的 `≈` 只允许明确登记的 editor-only 等价，例如 GFM 无法编码的表格列宽、光标/选区和经过精确路径证明的瞬时空段；不允许正文、结构、列表槽位、任务状态或持久化语义差异。

## 2. 全程执行规则

每个阶段都必须遵守：

- 不新增基于 delayed canonical 最终形状的专用猜测。
- family 由真实 ProseMirror Step、对应 `stepDoc`、稳定 node path、journal continuity 和 raw range 证明。
- 先写失败优先测试，再接 production owner。
- 正向测试必须覆盖 callback 与立即 save/source-mode forced flush。
- 负向测试必须证明 owner 拒绝后不会被 generic legacy 接管。
- 只有 focused、相邻、全局门禁全部通过后，才可标记 `legacyRetired` 或删除旧 mapper。
- 一个阶段一个清晰本地提交；未成熟下一阶段草稿不得混入。
- 不执行 `git reset --hard`、`git clean`、批量 checkout/restore；不破坏长期 dirty tree。
- 版本只在形成新的可验收产品行为时递增；test-only / docs-only 收口不强制升版。
- 每次本地提交后重跑该阶段最高风险 Electron smoke。

## 3. 阶段总览

| 阶段 | 目标 | 当前状态 | 完成标志 |
| --- | --- | --- | --- |
| A | 收口 `0.13.148` 代码块显式退出与首批 legacy 退役 | **进行中** | 完整工作树版本通过 focused/global/build，排除未来草稿，形成本地提交 |
| B | 完成剩余代码块生命周期 owner | 未开始正式接线 | paragraph↔code、boundary join、完整 fence lifecycle 均有 Step owner与双路径持久化 |
| C | 退役 blockquote legacy owners | 未开始 | text/split/join/exit 的旧 dedicated/generic fallback 均被 no-hit 合同覆盖并窄删除/阻断 |
| D | 退役 table legacy owners | 未开始 | cell、row、column、alignment、width 不再允许旧整表/行级猜测接管 |
| E | 退役 list legacy owners | 未开始 | list subtree、item text、Enter/Backspace、task、input rule、conversion 分 family退役 |
| F | 普通段落成为默认 transaction authority | 未开始 | insert/delete/replace/split/join/empty/undo/redo/IME 全覆盖，generic region mapper退出主路径 |
| G | marks、atoms 与特殊入口统一 | 未开始 | inline code、format marks、link/image/math、frontmatter、Slash、paste、generated scratch、whole-doc统一 publication |
| H | 消除所有持久化旁路 | 未开始 | 成功写回只能经 Coordinator；静态审计和 runtime trace 均证明无旁路 |
| I | 长会话与正式安装包资格验收 | 未开始 | clean commit→dist→安装→trace长会话→多轮保存冷重开 first divergence=0 |

## 4. 阶段 A：0.13.148 可复现检查点

### 范围

- `code-block-exit` 产品命令、pending/coalesced/staged owner 与 provenance。
- `code-block-content-replace`、`code-block-info-string-change`、`empty-code-block-backspace-unpack`、`code-block-exit` 的 legacy 退役。
- `legacyRetired + recognized` 阻断 generic fallback。
- dedicated `preserveFencedCodeBlockTextChange()` 删除。

### 必须排除

以下属于阶段 B 草稿，不进入本阶段提交：

- `paragraph → code_block`；
- 非空 `code_block → paragraph`；
- code block / paragraph boundary join；
- `fenced-code-source-range.js` 草稿；
-对应 diagnostic/UI 草稿；
- 历史 `tmp-repro-rs44/73/76` 文件。

### 门禁

```text
test:code-block-legacy-owner-retirement
test:code-block-legacy-owner-retirement-ui
test:code-block-transaction-owner
test:code-block-info-transaction-owner
test:empty-code-block-unpack-transaction-owner
test:code-block-exit-transaction-owner
test:code-block-info-transaction-ui
test:empty-code-block-unpack-transaction-ui
test:code-block-exit-transaction-ui
test:code-block-exit-staged-ui
test:code-block-exit-forced-flush-ui
test:middle-codeblock-source-ui
test:source-sync-transaction-journal
test:source-sync-coordinator
test:source-transaction-sync
test:editor-api-transaction-flush
test:markdown-preservation
test:source-fidelity-probes
test:source-fidelity-ui
test:mixed-rich-source-transaction-ui
test:tail-fence-ui
build
build:mobile
```

### 完成标志

- 三处版本均为 `0.13.148`。
- 上述矩阵 exit 0。
- staged 集合只含本阶段文件。
- 本地提交后重跑 retirement UI、exit 三条 UI、middle-code、39/39 probes。

## 5. 阶段 B：剩余代码块生命周期

依次独立完成：

1. `paragraph → code_block`：真实转换 Step、作者段落唯一 raw range、fence选择与 collision拒绝。
2. 非空 `code_block → paragraph`：完整 opening/content/closing range原子替换，不允许只删一侧 fence。
3. code block / paragraph boundary join：Backspace/Delete真实边界 Step、两侧节点与邻块不变。
4. fence 创建、删除、拆分、合并和围栏字符/长度变化；不能从 canonical fence行猜操作。
5. nested、跨 block selection 和多节点批次。

每个 family 通过后立即做 legacy no-hit/negative fallback测试，不等到全部生命周期完成再统一退役。

## 6. 阶段 C：Blockquote legacy 退役

覆盖：

- `blockquote-paragraph-text-replace`；
- `blockquote-paragraph-split`；
- `blockquote-paragraph-join`；
- `blockquote-paragraph-exit`；
- pending/staged transient。

重点负例：重复引用正文、列表项内引用、多引用同批变化、空引用、marks、错误 quote prefix、source range歧义。recognized rejection必须阻断 `paragraph-emptied`、`middle-block-*`、quote line generic mapper。

## 7. 阶段 D：Table legacy 退役

覆盖：

- 单 cell正文；
- body row insert/delete；
- simple-grid column insert/delete；
- alignment；
- PM-only colwidth。

必须证明新 owner拒绝后不会回落为 whole-table、table-line或table-region重写。span/merge/split因GFM不可表达，保持明确 fail closed或产品级禁用，不伪造Markdown持久化。

## 8. 阶段 E：List legacy 退役

这是风险最高的阶段，按以下顺序拆分：

1. list item plain paragraph正文。
2. 单一 list subtree结构变化。
3. 空项 Enter退出、Backspace lift、successor补位。
4. nested list split/join/indent/outdent。
5. task list与空task sentinel。
6. bullet/ordered/task conversion。
7. `- `、`1. ` 等 input rules和pending intent。
8. 跨列表选区、多 transaction coalescing、generated scratch。

每一类必须有真实 physical-key Electron negative case，证明旧 broad list mapper不能在 recognized rejection后接管。

## 9. 阶段 F：普通段落默认 authority

把已有 `plain-paragraph-transaction-owner` 从显式测试门禁提升为生产默认，逐项完成：

- insert/delete/selection replace；
- Enter split；
- Backspace/Delete join；
- 连续空段和新文档 bootstrap；
- trailing spaces、hard break、BOM与三种EOL；
- IME composition；
- undo/redo；
- source-mode/save竞争。

完成后退役 generic localized/line/middle/tail正文写回主路径，只保留明确未迁移 family 的 fail-closed compatibility。

## 10. 阶段 G：Marks、Atoms 与特殊入口

依次迁移：

- strong/emphasis/strike；
- inline code；
- links；
- images、math与其它 atoms；
- frontmatter；
- Slash code/math及其它结构命令；
- paste、drop、whole-document replacement；
- generated scratch；
- source+preview和多标签隐藏editor callback。

每个入口必须与普通 dispatch共享 revision/provenance；命令级 source intent不能绕过最终 Coordinator validation。

## 11. 阶段 H：持久化旁路清零

建立静态和runtime双门禁：

- 搜索成功路径中直接赋值 source/canonical refs、host `onChange`、磁盘写入。
- 所有成功 publication trace必须含 candidate id、owner、family、reason、revision、boundary。
- 识别但拒绝的事务必须有 `legacyBlocked` 或明确未迁移状态。
- 不允许先推进 canonical/source基线再验证。
- 不允许旧 callback在新revision上rebase。

完成后，legacy preservation只能作为未识别 family 的临时兼容层，不得拥有已经迁移的任何操作。

## 12. 阶段 I：最终资格验收

### 自动化

- focused family全矩阵；
- family multicycle默认/transaction authority；
- continuous fidelity；
- chaos多档节奏；
- 100K–400K大文档性能和逐键延迟；
- LF、CRLF、lone-CR、BOM、无final-EOL；
- IME、快速按键、保存/源码切换抢跑；
- 多标签、隐藏editor、外部文件更新；
- desktop/mobile build。

### 正式安装包

1. clean本地提交；
2. `dist:dir`；
3. 核验 bundle版本；
4. 安装到 `/Applications` 前保留旧版唯一备份；
5. `--horsemd-input-trace` 启动；
6. 使用真实长文档连续交替操作段落、列表、引用、代码块、表格、输入规则、IME；
7. 多轮保存、关闭、fresh-profile冷重开并继续编辑；
8. 同时比对 PM、committed source、canonical、textarea、tab mirror和disk；
9. 首个 divergence、integrity false、warning和错误成功保存均为零。

只有该阶段通过，才能关闭 `rich-source-divergence-incident-0.13.47.md` 的P0 Known Issue。

## 13. 进度维护规则

每完成一个阶段，更新本文件：

- 状态从“未开始/进行中”改为“完成”；
- 写入版本和本地提交hash；
- 记录实际执行的focused、negative、global和post-commit smoke；
- 写明仍未覆盖的用户操作；
- 下一阶段只从本文件确定，不从聊天记录或临时 `/tmp` 状态文件推断。
