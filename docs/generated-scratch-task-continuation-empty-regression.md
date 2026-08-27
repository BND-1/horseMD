# RS-58：generated scratch 中 task continuation 清空触发源码不一致

> 状态：已修复于 HorseMD 0.13.104

## 现场症状

0.13.103 的真实 `--horsemd-input-trace` 中，已有 checked task `前端` 后出现新的列表项；Backspace 将该项提升/合并为 checked task 内的第二个 paragraph。继续逐字删除 `[ ] `，直到这个 continuation paragraph 为空时，ProseMirror 合法保留：

```text
bullet_list
└─ list_item checked=true
   ├─ paragraph(" 前端")
   └─ paragraph("")
```

Crepe canonical 用缩进 `<br />` 表示这个 editor-owned 空 paragraph，但 generated scratch candidate 删除了该行，随后 integrity 触发 `source-document-mismatch`。

## 首个分叉证据

真实 trace 的首个失败位于 0.13.103 的 line 2314。失败前一笔 canonical/source 末尾分别为：

```md
* [x] &#x20;前端

  <br />
```

与：

```md
* [x]  前端

  [
```

局部 preservation façade 实际已经能正确删除 authored continuation 行，但只返回通用 `escaped-literal-line-emptied`。因此 generated-scratch/integrity 没有证据把 live doc 中唯一的尾随空 paragraph 识别为 editor-owned transient。

另一个关键细节是 `normalizeEmptyListItems()` 会把原始 `  <br />` 归一成顶格 `<br />`。如果在 normalize 后判断 ownership，就会丢失“这个空 paragraph 属于 list item continuation”的缩进证据。

## 修复

0.13.104 增加严格的 `trailing-list-item-paragraph-emptied` proof：

1. 先由现有 `escaped-literal-line-emptied` / `paragraph-emptied` mapper 证明本次真实字节删除；
2. ownership 判断使用 **raw previous/raw next canonical**，要求前态是缩进 continuation 文本行、后态是同缩进 `<br />`；
3. 该行之外的文档必须完全不变，并且前方必须存在更浅层的 list/task marker；
4. 只有满足全部条件时才把 reason 重分类为 `trailing-list-item-paragraph-emptied`；普通顶层空段、普通 escaped punctuation 不获得该权限；
5. generated scratch 的正常 callback 与强制 flush 都接受同一个 proof；
6. integrity 仅在该专用 reason 下复用现有的“恰好一个 trailing empty list-item paragraph”语义归一化，task 的 `checked` 状态仍严格比较。

## 回归

永久门禁：

```bash
npm run test:markdown-preservation
npm run test:source-transaction-sync
npm run test:generated-scratch-task-continuation-empty-ui
```

RS-58 UI 专项在 generated scratch 中稳定构造同一 ProseMirror 状态，然后验证 continuation 删空、切源码强制 flush、保存和冷重开。0.13.104 结果：

```text
preservationReason: trailing-list-item-paragraph-emptied
ok: true
semanticOk: true
listSlotsMatch: true
toasts: []
PASS RS-58 generated scratch task continuation empty: integrity, flush, save, and reopen stable
```

相邻门禁同时通过：task checkbox 持久化、RS-57 blockquote transient、RS-56 nested-list transient、35/35 source-fidelity probes 与 source-fidelity audit UI。
