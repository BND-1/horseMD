# HorseMD E0 会话存档（0.13.180，2026-08-31）

> 给下一个 AI 接手用的完整状态。长期进度账本仍是
> `docs/source-rich-consistency-completion-plan.md`（3.1 节 E0，P3a–P3m 全部落盘）。

## 当前状态

- **已安装版本**：`/Applications/HorseMD.app` = **0.13.180**，以 `--horsemd-input-trace` 启动（pid 39323，还在跑）
- **最后提交基线**：`348d51f fix(editor): retain scratch transaction evidence`（0.13.169）
- **本轮全部改动未提交**（19 个修改 + 19 个新增测试脚本），working tree 保持原样，**不要 `git clean`/`reset`**——大量历史 untracked 诊断文件属于之前阶段
- 全量回归绿：18 项 UI + Node 全量 + goal-matrix 42/42 + `git diff --check`

## 本轮完成（P3a–P3m，全部由用户真实触发驱动）

| 修复 | 内容 |
|---|---|
| P3a | blockquote-split 接管尾段段尾 Enter（空右段 transient）|
| P3c | 新 family `plain-paragraph-terminal-split`（顶层 IME+Enter，最小分隔字节）|
| P3d | transient 桥折叠全部连续尾空段（quote/list-item）|
| P3e | `1.`/`-`/`#` marker 瞬态 defer+hold；blockquote-paragraph 改终态 bounded patch |
| P3f | scratch 形状桥（quote-tail）→ list-item 扩展 |
| P3g | goal-matrix 自测（用户四条矩阵 42/42）+ 单段引用清空回退 legacy |
| P3h/P3i | scratch 连续空列表项对称归一；exit family range-unmapped 降为非 recognized |
| **P3j（架构性）** | **scratch 结构性兜底**：未存盘文档无作者字节，任何发布失败→序列化 canonical 兜底重试（过完整校验）→不警告；已存盘文件严格保持 fail-closed |
| P3k | 兜底直接用原样 canonical（变换产物可能自带错误）|
| P3l | 兜底 marker 拼写保留优先（`-`/`+` 互操作，原样 canonical 为底线）|
| P3m | 语义比较器合并相邻同 mark 文本串；scratch 下 raw-paste token 竞态释放；`~`→`~~` 转义确认回环 |

## 关键架构事实（本轮确立）

1. **警告分层**：已存盘文件（有作者字节）→ 任何无法证明的映射照旧 fail-closed+警告；未存盘 scratch → canonical 兜底（编辑器派生字节，无保护对象）
2. **`-`→`*` 翻转**：只在 scratch 兜底触发时发生，P3l 后 marker 保留优先，属已声明代价；已存盘文件有回归锁定
3. **`~~`/`\-` 转义**：序列化器标准转义（防重解析），渲染回原字符，校验通过即回环证明
4. **相邻文本节点拆分**：PM 在 `~` 边界拆 text run，粘贴解析不拆 → semanticJson 现已合并

## 下一步：P3b（nested bullet pending-chain）——最后一个用户触发的真缺口

**09:47:33 trace（已落盘计划文档）**：用户在**已存盘** .md（之前粘贴的大文档）里：
嵌套空 bullet IME 输入→Enter→再输入→连续 Backspace 穿越嵌套层级删除
→ legacy 候选**缩进层级真实错误**（indent 0 vs 2）+ 项子节点数 5 vs 9
→ 警告**正确履职**（fail-closed 保护了文件）

这是阶段 E 剩余核心：给嵌套列表结构删除链建 focused owner。工作量 = 一个完整 family 迁移。

## 既有失败清单（与 E0 无关，独立 worktree 在 348d51f 验证一致）

- `test:rs-41-source-sync` UI 的 raw paste（owner 认领层 `-`→`*`）
- `test:list-item-literal-marker-source-ui`（10 连击 marker 后首次切源）

## 用户工作方式（重要）

- 每轮改完必须：自测（matrix+回归）→ **版本+1** → `dist:dir` 打包 → 装到 `/Applications` → `open -a HorseMD.app --args --horsemd-input-trace`
- 用户实测触发后说“看下”→ 从 `$TMPDIR/horsemd-input-trace-<pid>.jsonl` 拉 dump（含 candidate/canonical 尾文本）归因
- 不要问用户“要不要继续”——直接修，改完自测再给最终结果
- goal-matrix（`test:goal-input-matrix-ui`）是用户的四条验收矩阵（写后删/列表全家/斜杠全格式/从头逐字删），42 检查点，零警告才绿

## UI 自动化事实（踩坑记录）

- 斜杠菜单**必须真实 keydown**（insertText 选不中）
- **Mod+Enter** 退出代码/数学块（Escape 无效）
- 表格退出：点击表格下方坐标 + 验证 selection 已离开
- task 复选框：点击 `li .label-wrapper`（真实鼠标坐标）
- 新文档首次输入需轮询落地（编辑器 ready 前输入会丢）
