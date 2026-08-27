# RS-54：空 bullet 紧邻 ordered list 时 Backspace 被错误合并成新的 ordered item

## 状态

- 首次真实定位版本：HorseMD 0.13.99。
- 真实 trace：`horsemd-input-trace-68187.jsonl`。
- 修复归属：0.13.100。
- 当前状态：专项与相邻家族回归已通过。

## 真实复现

文档结构：

```md
# 你好

1. 测试
2. 哪里呢

- 
```

将光标放在空 bullet 中，按一次 Backspace。

0.13.99 的 ProseMirror 事务在 source preservation 之前就把结构改成：

```text
1. 测试
2. 哪里呢
3. [空项]
```

随后 mapper 仍尝试保留旧 `- `，candidate 同时包含 `3.` 与 `- `，integrity gate 以 `source-list-structure-mismatch` 正确拒绝。

## 根因边界

这不是 source mapper 首先造成的类型变化；默认 ProseMirror list Backspace 在“顶层单空 bullet 紧邻前一个 ordered list”时执行跨类型 join/lift，把空 bullet 继承为 ordered item。

HorseMD 的期望交互是：用户删除这个空 bullet 时退出/删除 bullet 容器，落到普通段落，不把列表类型从 bullet 改成 ordered。

0.13.100 的修复发生在 rich-input 层、默认 ProseMirror keymap 之前，并满足严格条件：

- 普通 Backspace，无组合键、无 composition；
- selection 折叠；
- 当前顶层节点是 bullet_list；
- bullet_list 恰好一个 list_item；
- item 只有空 paragraph，且不是 task item；
- 前一顶层 sibling 是 ordered_list；
- 删除 bullet_list 后优先复用紧随其后的空 paragraph，否则插入一个普通 paragraph；
- 不影响同类型 bullet 内部 Backspace、非空 bullet、nested bullet、task list、ordered item Backspace。

## 回归合同

`test-empty-bullet-backspace-after-ordered-ui.mjs`：

1. 打开最小真实 Markdown fixture。
2. 点击空 bullet。
3. Backspace 一次。
4. rich DOM 必须保持 ordered item 数为 2，bullet list 数为 0，并存在普通空 paragraph。
5. 不得出现 source-sync toast。
6. 切源码后 `- ` 必须消失，也不得出现 `3.`。
7. 保存、冷重开后结构和 source 保持一致。

## 验证结果

- 修复前专项稳定红：`orderedItems=3`，并出现 `source-list-structure-mismatch`。
- 输入层修复后 rich 结构稳定为 2 个 ordered item、0 个 bullet，并复用普通空 paragraph。
- 同事务还修正 `preserveEmptyListItemTextChange()` 的跨 kind 误判：empty-item fill 只允许 list kind 不变，避免把已删除 bullet slot 替换成一份 ordered block。
- 最终专项：无 toast，`semanticOk:true`、`listSlotsMatch:true`，源码无 `3.` / `- `，保存与冷重开 PASS。
- 相邻 RS-51、`test:markdown-preservation`、`test:list-marker-empty-source-ui`、`test:source-fidelity-ui` 全绿。
