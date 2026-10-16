# RS-82：非空 bullet 段 Backspace 并入左侧 ordered list

> 修复版本：HorseMD 0.13.127  
> 首发现场：正式安装包 0.13.126，PID 81568  
> 首发时间：2026-08-26 13:40:32.227  
> Trace：`horsemd-input-trace-81568.jsonl` line 13  
> 首发 reason：`unmapped-diverged-list-batch`

## 1. 用户操作与首发结构

用户在真实、已存在 source/canonical 合法分叉的长文档中，把光标放在紧随有序列表之后的第一个非空 bullet 正文开头，按一次 Backspace。

操作前 canonical 局部结构：

```md
2. 斛律v哦

* u高科技

* 1\. 色粉色分

1. 啊额法色饭

   1. 微风
```

作者源码使用紧凑 bullet 与 `-` marker：

```md
2. 斛律v哦

- u高科技
- 1\. 色粉色分

1. 啊额法色饭
   1. 微风
```

ProseMirror 的 Backspace 是合法结构事务：完整两项 bullet 段并入左侧 ordered list，成为连续的第三、第四项；后面的 `啊额法色饭` 仍是另一棵 ordered list，并继续拥有 nested child：

```md
2. 斛律v哦
3. u高科技
4. 1\. 色粉色分

1) 啊额法色饭

   1. 微风
```

## 2. 为什么旧链路失败

旧 diverged-list 原子循环能识别目标区域存在 marker/type 变化，但真实长文档其它位置已经有大量合法 authored/canonical 拼写与结构表示差异。它无法证明整个 callback 的全部 list delta，因此返回 `unmapped-diverged-list-batch`，随后 integrity gate 正确 fail closed，并显示富文本/源码不一致警告。

这不是正文删除，也不是空列表项 family，而是完整结构 join：

```text
ordered list on the left
+ flat non-empty bullet segment
→ one longer ordered list
```

## 3. 自动化揭示的第二层根因

第一版 candidate 只把两个 authored bullet marker 改成 `3.`、`4.`，并保留后续作者写的 `1.`。该 candidate 在当前窗口中看似保留正文，但完整保存/冷重开测试失败：CommonMark 会把紧邻且同样使用 `.` delimiter 的后续 `1.` 继续并入前面的 ordered list。

因此 callback 中的 `1. 啊额法色饭` → `1) 啊额法色饭` 不是可忽略 serializer drift，而是保持两棵 ordered lists 独立的 parse-required separator。正确源码必须同步写入这个唯一 delimiter 变化，同时保留 nested child 的 authored `1.`。

## 4. 0.13.127 的严格 owner

新增 family `diverged-nonempty-bullet-list-backspace-merge-ordered`，实现为 `preserveNonEmptyBulletListBackspaceMergeIntoOrdered`。只有以下证明全部成立才认领：

1. previous 中唯一存在顶层 ordered left item，后接一段顶层、非空、同 marker 的 flat bullet items；
2. 该段与 canonical change range 相交；
3. next 中 left item正文、ordinal、delimiter、spacing 不变；
4. 每个 moved item正文与 spacing 不变，只变为与 left 同 delimiter 的连续 ordinal；
5. source 中相同 left + bullet body 组合唯一；
6. 若紧随另一条顶层 ordered row，其 body、ordinal、spacing 必须不变；
7. following row 原本与 left 使用相同 delimiter 时，next 必须仅切换为另一 delimiter；原本已经不同则不得再改；
8. 目标外 prefix/suffix 只能有 same-kind marker spelling，正文、缩进、spacing、ordered ordinal 均不得改变；
9. 错误编号、同 callback 无关正文编辑、source target 歧义、嵌套或 task/bullet shape 不符时全部 fail closed。

输出只修改 moved marker tokens 与必要时唯一 following ordered delimiter token。正文、nested child、fence、U+200B、BOM、LF/CRLF、空行和其它作者字节保持不变。

## 5. 为什么必须在 normalization 前运行

`normalizeOrderedListDelimiters()` 会把 canonical 的 `1.` / `1)` 差异归一化，以避免普通 serializer 标点漂移扩大 diff；但这会抹掉 RS-82 的 parse-safe separator 证据。因此 RS-82 使用严格 raw prepass：

```text
raw previous / raw next
→ RS-82 proof
→ 命中后直接返回 candidate
→ 未命中才进入 ordered delimiter normalization 与原 dispatcher
```

没有按 reason 放宽 semantic 或 list integrity。

## 6. 永久回归

纯函数 `npm run test:markdown-preservation` 覆盖 PID 81568 真实长文档三态、exact reason、authored CRLF、非连续 ordinal 反例和同 callback 无关正文编辑反例。

真实 Electron `npm run test:nonempty-bullet-backspace-merge-ordered-ui` 覆盖：真实 Backspace、专用 owner、`semanticOk=true`、`listSlotsMatch=true`、`ok=true`、零 warning、moved items 并入 left list、following list 独立、nested child 归属、精确 source、save 与 cold reopen。

## 7. 泛化门禁

修复后已通过：旧 isolated empty bullet→ordered mirror、RS-54、完整 list conversion UI/source fidelity、source transaction sync、rich-list end/middle、source-fidelity probes 35/35、异构 source-fidelity UI，以及 RS-68 5/18/70ms。

验收标准不是“最终自愈”，而是从首个 callback 起零 integrity false、零 warning、源码/保存/冷重开全部一致。
