# 新建文档空有序项 Tab 缩进误报源码不一致

> 状态：HorseMD 0.13.90 真实输入稳定复现并通过 `--horsemd-input-trace` 定位；修复归属版本：0.13.91
>
> 家族编号：RS-45
>
> 日期：2026-08-23

## 1. 用户可见现象

在全新空 Markdown 文档中，从默认 H1 开始真实输入一个有序列表，给第一项输入正文，按 Enter 生成第二个空项，然后在这个空项上按 Tab 缩进。富文本视觉结构正确，但立即弹出“检测到富文本与源码不一致 / 保存已暂停”类保护提示。

这是富文本 ↔ 源码保真家族问题，不是普通列表 UI Bug。ProseMirror 已经完成正确结构转换，失败发生在作者源码候选的完整性门禁。

## 2. 真实复现步骤

0. 用当前构建直接启动 Electron，并确保参数真实进入 HorseMD argv：

   ```bash
   ELECTRON_RUN_AS_NODE= ELECTRON_ENABLE_LOGGING=1 ./node_modules/.bin/electron out/main/index.cjs --horsemd-input-trace
   ```

1. 新建/打开一个真正空的 `.md`。
2. 默认 H1 输入 `你好`。
3. 在正文输入 `1. ` 创建有序列表。
4. 第一项输入 `测试`。
5. 按 Enter，生成空的第二项 `2. `。
6. 在空 `2. ` 上按 Tab。
7. 不继续编辑；此时稳定出现源码同步不一致提示。

真实现场由 `horsemd-input-trace-17580.jsonl` 捕获；首个失败发生在 Tab transaction 之后，不是后续保存动作。

## 3. 首个分叉证据

Tab 前作者源码：

```markdown
# 你好

1. 测试
2. 
```

Tab 后 HorseMD 生成的作者源码候选：

```markdown
# 你好

1. 测试
   1. 
```

同一时刻 Crepe canonical：

```markdown
# 你好

1. 测试

   1. <br />
```

trace 顺序：

- Enter transaction 正确创建第二个外层 `list_item`，label 为 `2.`；
- `markdown-sync` 正确推进作者源码为 `1. 测试\n2. `；
- Tab 的 `replaceAround` transaction 正确把第二项移动到第一项下方，成为嵌套 ordered list 的第一项；
- `generated-scratch-canonical` 正确把 canonical 的内部空段落 `<br />` 去掉，得到 `   1. `；
- 紧接着 `validateSourceCandidate()` 返回 `source-document-mismatch`，fail-closed 提示弹出。

这次 reason **不是** `source-list-structure-mismatch`。因此 raw 列表槽位门禁已经认可“外层第二项 → 嵌套第一项”的槽位变化，失败来自 parser 语义比较。

## 4. 根因边界

`generatedScratchMarkdown()` 有明确不变式：内部空 paragraph 的 `<br />` 不能泄漏到作者源码。对于全新文档，`   1. ` 是 HorseMD 要保存的作者源码表示；canonical 中的 `   1. <br />` 只是 Crepe 为可编辑空 list item 使用的内部表示。

当前 `validateSourceCandidate()` 同时做：

1. parser/AST 语义比较；
2. `areMarkdownListSlotsEquivalent()` raw 列表槽位比较。

RS-45 中第 2 个证明已经通过，但第 1 个证明失败：Markdown parser 对“裸的空嵌套有序 marker”和“marker + `<br />`”得到的树并不完全相同，因此正确 candidate 被拒绝。

修复不能简单关闭 integrity gate，也不能把 `<br />` 写回作者源码。正确边界是：**只把 Crepe 的 editor-only 空列表项占位与作者源码的 bare empty list slot 视为同一个空 list-item 语义，同时继续要求列表槽位指纹严格证明 kind / nesting / item count / ordered number。** 其他正文、非空列表项、引用、表格、代码块和真实 hard break 仍保持严格语义比较。

## 5. 先红后绿的最小回归

新增专项必须真实逐键覆盖：

`空文档 → H1 → 1. 测试 → Enter 得到空 2. → Tab`

在 Tab 稳定后断言：

- 没有 `source-document-mismatch` / `source-list-structure-mismatch`；
- 没有保存暂停 toast；
- 富文本结构仍是一个外层有序项，下面一个空嵌套有序项；
- 源码为 `1. 测试\n   1. `，不得出现 `<br />`；
- 富文本 → 源码 → 富文本 → 源码稳定；
- 保存后磁盘与源码一致；
- 完整关闭并新进程重开后嵌套结构仍成立。

修复前该专项必须稳定失败，证明它真正覆盖用户现场，而不是只让 fixture “包含”相似结构。

## 6. 家族泛化门禁

目标专项通过后，至少同时覆盖以下相邻成员：

- 空嵌套 **bullet** 项（现有 `test:list-marker-empty-source-ui`）；
- 非空嵌套 ordered 项与连续快速输入（`test:rich-source-continuous-fidelity-ui`）；
- 有序列表 marker / intent 生命周期（RS-42～RS-44 相关专项）；
- parser + raw list-slot 双证明纯函数；
- 空段落、列表转换、源码切换、保存/冷重开；
- `family-multicycle` 与源码保真家族矩阵。

任何相邻场景失败都不能打包交付。

## 7. 完成标准

1. 本文先记录真实 trace 和首个分叉；
2. 新增最小失败回归并在 0.13.90 修复前证明为红；
3. 修复只调整空 list-item placeholder 的等价边界，不放宽其他 integrity 条件；
4. 目标专项绿；
5. 家族泛化矩阵绿；
6. patch 版本 +1；
7. 重新 build / dist，覆盖安装最新包并验证安装包关键用例；
8. 最终用 `--horsemd-input-trace` 启动最新包交给用户真实手测；用户确认前状态保持“待验收”。
