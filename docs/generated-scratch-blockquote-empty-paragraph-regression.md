# RS-57：generated scratch 引用内空第二段 Enter 回归

- 首次真实定位版本：HorseMD 0.13.102。
- 真实 trace：`horsemd-input-trace-80801.jsonl`，首次完整性失败发生在引用正文末尾按 Enter 后。
- 修复归属：0.13.103。
- 当前状态：已修复；真实 `/quote` 全链、引用家族与 source-fidelity 门禁均通过。

## 真实触发

用户在 generated scratch 文档尾部通过引用样式建立 blockquote，输入 `千万千万人`，随后在引用正文末尾按一次 Enter。ProseMirror 合法变成同一个 blockquote 中的两个 paragraph：第一段有正文，第二段为空。

Crepe canonical 用下面的内部形式表达该状态：

```md
> 千万千万人
>
> <br />
```

旧 generated scratch 把 `<br />` 去掉后写成：

```md
> 千万千万人
>
>
```

但 quote-only 行不能在 Markdown 重解析后恢复“引用内第二个空 paragraph”，因此 candidate 与 live canonical 的 AST 不等价，触发 `source-document-mismatch`。

## 根因

普通 Markdown 空行无法持久化 blockquote 内一个独立的空 paragraph；`> <br />` 是 Crepe 的 editor-owned 占位，也不能泄漏进作者源码。旧 preservation 层只把这笔事务归入通用 `structural-line-change`，生成了不可重解析的多余 `>` 行；generated scratch 又没有专门的 transient ownership proof。

## 修复

0.13.103 新增严格的 `trailing-empty-blockquote-paragraph-created` 合同：只有在文档尾部、同一 quote depth、原引用正文完全不变、next canonical 恰好新增 `>` + `> <br />` 两行时才命中。命中后作者源码保持不变，直到该空 paragraph 真正收到正文。

Integrity 默认仍对 blockquote 内空 paragraph 严格；只有上述专用 reason 才允许忽略 **恰好一个**、位于非空引用 paragraph 后的尾随空 paragraph。generated scratch 的正常 callback 与强制 flush 使用同一 proof，普通 blockquote、多个空段和真实正文都不放宽。

当第二段真正输入文字后，generated canonical 可正常落成标准 Markdown：

```md
> 引用正文
>
> 第二段
```

## 回归证据

`scripts/test-generated-scratch-blockquote-empty-paragraph-ui.mjs` 覆盖：空文件 → `/quote` → 输入引用正文 → Enter 创建空第二段 → `trailing-empty-blockquote-paragraph-created / ok=true / semanticOk=true / listSlotsMatch=true / no toast` → 第二段填正文 → 源码 → 保存 → 冷重开。

相邻门禁：RS-48 空引用 IME 填充、空引用删除、35/35 source-fidelity probes、全量 source-fidelity UI、Markdown preservation、source transaction semantic 均通过。
