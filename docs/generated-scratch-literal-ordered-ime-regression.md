# Generated scratch 中字面有序 marker 被重解析成嵌套列表

> 状态：0.13.94 真实 `--horsemd-input-trace` 捕获；0.13.95 已修复并通过真实 IME、源码、保存与冷重开回归
>
> 家族编号：RS-49
>
> 修复归属版本：0.13.95
>
> 日期：2026-08-24

## 1. 首个分叉

新建文档仍处于 `generatedScratchRef=true` 时，用户在空 bullet item 中形成瞬态正文 `1. `，随后通过 IME 提交正文。Crepe 在正文真正变成字面文本后会序列化为：

```markdown
* 1\. 是各色个
```

但 0.13.94 的 `generatedScratchMarkdown()` 对整篇 canonical 调用 `canonicalFreshTextToSource()`，把 `1\.` 当成普通 fresh punctuation 还原为：

```markdown
- 1. 是各色个
```

这两份 Markdown 不等价：后一份会被 CommonMark/GFM 解析为 bullet item 内的 nested ordered list；前一份才是一个 bullet item 的字面正文 `1. 是各色个`。因此 `source-list-structure-mismatch` 是正确的 fail-closed 结果。

## 2. 根因

普通 fresh punctuation 的反转义规则不能直接套到“块/列表正文开头”的 ordered marker。`1\.` / `1\)` 在行中通常可以安全还原，但位于顶层 block、blockquote 或 list item 正文开头时，反斜杠是 Markdown 结构保护符，不是作者无意义的 serializer 噪声。

普通已打开文档早已有局部 list mapper 保护这个边界；问题只出现在 generated scratch 的全篇 canonical→source 快捷路径，因此修复必须限制在 generated scratch，不改写既有作者源码规则。

## 3. 修复

`generatedScratchMarkdown()` 现在：

- 先从 canonical 确认 quote/list 的结构前缀；
- 只在该前缀后的正文起点匹配 `N\.` / `N\)`；
- canonical fresh translation 完成后，在同一已证明位置恢复这一个结构保护反斜杠；
- 不让歧义 candidate（例如 `* 1. text`）反过来判断正文起点；
- 行中的 `abc 1\. x` 仍按 fresh punctuation 规则得到 `abc 1. x`。

integrity gate 没有放宽。

## 4. 回归证据

- 纯函数：bullet item 正文起点 `* 1\. text` 保留 escape；ordered item 正文起点 `1. 2\) text` 保留；行中 escape 仍还原。
- `test:generated-scratch-literal-ordered-ime-ui`：空文件 → bullet → `1. ` → 真实 `imeSetComposition` → `测试`，无 RS-49 integrity failure，源码为 `- 1\. 测试`，保存和冷重开后仍为一个 bullet item 的字面正文。
- `test-empty-bullet-literal-ordered-before-fence-ui.mjs`：既有文档的局部 mapper 家族回归继续通过。
- `test:new-source-fidelity-ui` 与 `test:ime-source-fidelity-ui` 继续通过。
