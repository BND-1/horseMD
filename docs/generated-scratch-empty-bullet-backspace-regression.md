# RS-51：generated scratch 空无序项 Backspace 后源码同步误报

## 状态

- 首次真实定位版本：HorseMD 0.13.96。
- 真实 trace 进程：PID `61858`，启动参数包含 `--horsemd-input-trace`。
- 当前状态：RS-51 核心修复已验证；泛化测试另发现 RS-52 空行漂移。
- RS-51 修复归属：0.13.97。

## 真实复现

在新建文档的 generated-scratch 生命周期中：

1. 创建一个无序列表项并输入 `离婚了`。
2. 按 Enter，得到第二个空无序列表项。
3. 在这个空项上按一次 Backspace。
4. 富文本结构本身正常，但立即出现“源码与富文本不一致”。

0.13.96 trace 的关键事务：

- Backspace 前 PM：`bullet_list` 有两个 item，第一个正文 `离婚了`，第二个为空。
- Backspace 后 PM：`bullet_list` 只剩一个 item，但该 item 内为两个 paragraph：第一个是 `离婚了`，第二个为空；列表后还保留顶层空 paragraph。
- 这是 ProseMirror 的合法删除/提升中间态，不是用户正文损坏。

## 首个分叉证据

Backspace 前已经成功提交的作者源码：

```md
- 离婚了
- 
```

previous canonical：

```md
* 离婚了
* <br />
```

Backspace 后 live canonical：

```md
* 离婚了

  <br />
```

旧 generated-scratch candidate：

```md
- 离婚了
```

随后 integrity gate 报：`source-document-mismatch`。

## 根因边界

项目已有一个非常窄的 `empty-list-item-removed` 合同：删除一个空 bullet 后，ProseMirror 可能在前一非空 item 尾部暂时保留**恰好一个**空 paragraph。作者 Markdown 没有独立字节可以表达这个 editor-owned transient，因此 semantic comparer 只有在 preservation reason 明确为 `empty-list-item-removed` 时，才允许忽略这一个尾随空 paragraph；多个空 paragraph、全空 item、nested list 后的空 paragraph仍保持严格。

问题在于 generated-scratch 分支直接用 `generated-scratch-canonical` 重建整份源码，绕过了这个事务分类。同一份真实 `source / previous canonical / next canonical` 交给 `preserveRichMarkdownSource()` 时，现有 mapper 已经能够严格证明并返回：

- `reason: empty-list-item-removed`
- 正确删除空列表行
- 保留一个尾部空行槽，供列表后的空 paragraph / 后续正文继续使用

因此 RS-51 不应新增 `<br />`、U+200B 或放宽全局 semantic gate；0.13.97 只让 generated-scratch 在**现有 mapper 已返回 `empty-list-item-removed`** 时复用该结果，其余事务继续走完整 generated canonical 路径。真实逐键专项已确认 Backspace 后 `preservationReason=empty-list-item-removed`、`semanticOk=true`、`listSlotsMatch=true` 且无告警。

泛化继续在该状态之后填列表外空 paragraph 时发现额外空行漂移；该后继问题单独登记为 RS-52 / 0.13.98，不回滚或扩大 RS-51 的窄合同。

## 回归合同

专项自动化必须覆盖真实逐键顺序：

1. 空文档进入正文。
2. 物理键输入 `-` + Space 创建 bullet。
3. 输入正文。
4. Enter 创建空第二项并等待它成为已提交 source/canonical baseline。
5. Backspace 删除/合并空项。
6. 断言没有 source-sync toast，最终 integrity candidate 通过。
7. 切源码：空第二项已删除，源码不含 `<br />`，并保留列表后的空块槽。
8. 保存并校验磁盘字节。
9. 冷重开后列表正文仍在，继续在列表后输入正文不得黏回列表。

泛化至少覆盖：已有 `empty-list-item-removed` 单测、RS-45 空嵌套 ordered、空 bullet/ordered Backspace、new-document/source-fidelity、family multicycle。
