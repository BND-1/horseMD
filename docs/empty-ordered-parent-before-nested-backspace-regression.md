# RS-85：空 ordered 父项并入前项且保留 nested child 回归

> 修复版本：HorseMD 0.13.130  
> 首发现场：正式安装版 0.13.129，PID 94298  
> Trace：`horsemd-input-trace-94298.jsonl`  
> 首处失败：2026-08-26 17:03:36.558，line 589，`source-document-mismatch`

## 1. 真实操作

用户在已经存在 source/canonical marker 与空行拼写分叉的文档中创建：

```md
1. 是共生共荣
2. 距离近
   1. 如何电话
```

随后：

1. 从 nested child 使用方向键回到第二个父项；
2. 连续 Backspace 将“距离近”删空；
3. 保留空的 `2.` 父项和其 nested ordered child；
4. 再按一次 Backspace。

最后一拍前的作者源码为：

```md
1. 是共生共荣
2. 
   1. 如何电话
```

对应 previous canonical：

```md
1. 是共生共荣
2. <br />

   1. 如何电话
```

ProseMirror 最后一拍合法删除第二个 list-item 边界，把 nested child 移入第一项，并保留一个 editor-owned 空 paragraph：

```md
1. 是共生共荣

   <br />

   1. 如何电话
```

树形结构等价于：

```text
ordered_list
└─ list_item
   ├─ paragraph("是共生共荣")
   ├─ paragraph(empty)
   └─ ordered_list
      └─ list_item
         └─ paragraph("如何电话")
```

## 2. 旧链路为什么失败

既有 `empty-list-item-removed` 已经完成正确的 raw source 修改：只删除 `2. ` 行，保留父项一与 nested child：

```md
1. 是共生共荣
   1. 如何电话
```

因此 trace 的结构指纹为：

```text
listSlotsMatch=true
```

但 Markdown 无法在不写入字面 `<br />` 的情况下表达“同一 list item 正文与 nested list 之间恰好一个空 paragraph”。重新解析正确源码后，该 editor-owned 空段消失，strict semantic comparator 得到：

```text
semanticOk=false
reason=source-document-mismatch
```

这不是 source mapper 删除错误，也不能通过把 `<br />` 写进作者源码来解决。

## 3. 专用 raw owner

新增：

```text
preserveEmptyOrderedItemBackspaceMergeBeforeNestedList
```

发布 reason：

```text
empty-ordered-item-merged-before-nested-list
```

它在 raw previous/next 阶段运行，排在 `<br />` normalization 与 generic empty-row removal 前。只有以下条件全部成立才认领：

1. previous 中存在顶层、非任务、非空 ordered left sibling；
2. left 后是连续 ordinal、同 delimiter 的顶层空 ordered sibling；
3. 空 sibling 后是非空 nested ordered child；
4. next 中空 sibling marker 原位变成缩进 `<br />`；
5. `<br />` 的精确缩进等于 child 的 authored canonical 缩进；
6. 目标行与真实 common-change range 相交；
7. previous/next 从文档开头到 left 行尾逐字相同；
8. previous/next 从 child 行起到文档结尾逐字相同；
9. source 中 parent/empty/child 三元组唯一、紧凑、编号连续；
10. target 不位于 fenced code 内；
11. child 正文、ordinal、delimiter、spacing 和 indent 全部未变。

previous 可以是 generated-scratch 的 compact spacing，也可以是已有文档的 loose canonical spacing；唯一性来自 left/child 双锚和完整前后字节证明，不依赖 serializer 空行风格。

命中后只删除 authored 空父项行：

```diff
 1. 是共生共荣
-2. 
    1. 如何电话
```

正文、child、marker、CRLF、fence、U+200B 和其它作者字节全部不动。

## 4. 为什么需要专用 semantic 证明

raw candidate 能重新解析出正确的 ordered/list-item/nested-child 槽位，但无法恢复 PM 的中间空 paragraph。0.13.130 只为专用 reason 启用以下一侧 transient：

```text
non-empty paragraph
→ one empty paragraph
→ ordered_list
```

该规则不是在每个 list item 各自放行。独立审查发现那样会在长文档中同时掩盖多个同形空段，因此最终实现采用文档两侧配对证明：

```text
一侧全篇候选数 = 1
另一侧全篇候选数 = 0
```

只有此时才移除唯一空 paragraph 后比较。以下情况全部保持 strict mismatch：

- 同一 list item 有两个候选；
- 两个不同 list items 各有一个候选；
- parsed 与 expected 两侧都各有候选；
- 候选从一个 list item 错移到另一个；
- 中间 paragraph 含真实正文；
- 后继是 bullet list 而非 ordered list。

因此语义例外由 raw owner reason 绑定，且在全篇范围内只允许一个单向 transient。

## 5. 永久回归

### 5.1 纯函数

```bash
npm run test:markdown-preservation
npm run test:source-transaction-sync
npm run test:source-fidelity-probes
```

覆盖：

- loose previous 正例；
- generated-scratch compact previous 正例；
- exact authored source；
- LF 与 CRLF；
- 错误 child 缩进拒绝；
- 非连续 parent ordinal 拒绝；
- 同 callback child 正文变化拒绝；
- source 重复 target 拒绝；
- semantic 默认严格；
- 专用一侧唯一候选放行；
- meaningful paragraph、bullet child、多候选与候选错位拒绝；
- PID 94298 真实三态 source probe。

source probes 当前为：

```text
38/38
```

### 5.2 真实 trace 回放

直接使用 trace line 591 的：

```text
source
previousCanonical
canonical
```

调用 `preserveRichMarkdownSource()`，结果：

```text
originalReason=empty-list-item-removed
fixedReason=empty-ordered-item-merged-before-nested-list
preserved=true
```

输出只删除 `2. ` 行，未泄漏 `<br />`，父项一和 `如何电话` 字节保持不变。

### 5.3 真实 Electron UI

```bash
npm run test:empty-ordered-parent-before-nested-backspace-ui
```

测试从空文档开始，不注入最终源码：

1. 逐键输入标题；
2. 物理输入 ordered marker 与父项一；
3. Enter 创建父项二；
4. Enter + Tab 创建 nested ordered child；
5. 定位父项二末尾并物理 Backspace 三次清空正文；
6. 再物理 Backspace 一次触发结构合并；
7. 检查 DOM、preservation、integrity、toast；
8. 切源码检查逐字节结果；
9. 保存；
10. 停止进程并冷重开再次检查。

验收：

```text
reason=empty-ordered-item-merged-before-nested-list
outer ordered items=1
nested ordered lists=1
child text preserved
middle editor-owned empty paragraphs=1
semanticOk=true
listSlotsMatch=true
ok=true
integrity false=0
warning toast=0
source exact
save exact
cold reopen exact
```

## 6. 相邻门禁

已通过：

```text
完整 markdown-preservation
source transaction sync 正反合同
source probes 38/38
empty ordered Backspace lift
single-empty ordered successor（RS-72）
generated deepest nested Backspace（RS-56）
empty bullet after nested list（RS-63）
rapid nested parent Backspace 5ms / 18ms / 70ms（RS-68）
non-empty bullet merge（RS-82）
middle thematic break（RS-83）
cross-list selection delete（RS-84）
heterogeneous source-fidelity UI
production build
```

本修复不拥有任意“列表项带子列表删除”。只有严格的顶层 ordered left + 连续空 ordered sibling + 未变化 nested ordered child 合并事务才由 RS-85 owner 处理；其它形状继续交给既有 owner 或 fail closed。
