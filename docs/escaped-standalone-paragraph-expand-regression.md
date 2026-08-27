# RS-59：中间字面 `-` 段扩写粘到上一段

## 归属

- 修复版本：**0.13.105**
- 首次现场：HorseMD 0.13.104，packaged PID `97146`
- 首次失败：input trace line 70，`source-document-mismatch`
- 专项：`scripts/test-escaped-standalone-paragraph-expand-ui.mjs`

## 现场

用户在一个已经存在合法 source/canonical 拼写差异的长文档中，编辑 `哈哈；` 与 `***` 之间的空 paragraph：

1. 先输入单独 `-`；Crepe canonical 用 `\\-` 保护它，避免被 Markdown 解析成空 bullet。
2. 再继续输入 `【】`；此时 canonical 正确变成独立普通段落 `-【】`。
3. 旧 preservation 候选却把它拼到上一段，得到 `哈哈；-【】`，随后 integrity 立即 fail closed。

现场失败候选的关键形状：

```md
# source before
哈哈；

\-

***

# wrong candidate after expansion
哈哈；-【】

***

# canonical
哈哈；

-【】

***
```

## 根因

Markdown 的空行/块分隔在 visible stream 中没有字符。`sourceRawFromVisibleIndex()` 因此需要 affinity 决定零宽边界落在哪个 raw offset。

当文档前部已经有 `-`/`*` marker、表格空格、实体等**语义等价但字节不同**的 source/canonical 拼写时，ordinal visible offset 仍可能整体看起来一致，但某个独立 paragraph 的起点会以 backward affinity 落到上一条 source 行尾。旧 `localized-change` 只验证 raw offset 有效，没有验证“映到的 source 行就是 canonical 正在编辑的那一行”，于是把 sibling block 粘在一起。

## 修复

0.13.105 在通用 `localized-change` 最终 raw patch 前增加 line-identity guard：

- 取 canonical 中包含本次变更的原行；
- 取 `rawStart` 实际落到的 source 行；
- 若 canonical 原行有可见文本，而两行的 visible text 不同，则拒绝直接 raw patch；
- 转交既有 `preserveChangedLineRegion()` 用行/块上下文重新定位；
- 无法证明时继续 fail closed，不整篇覆盖源码。

这不是 `-` 特例。任何单行文字编辑只要 visible-offset 把它映到了另一条 source 行，都会被挡住。空 paragraph 首字符输入仍由已有 `preserveMiddleEmptyBlock()` 负责；本次没有放宽 `<br />`、列表、引用或其它结构等价规则。

## 回归证据

真实 UI fixture 保留了现场的右侧可见锚点：

```md
- 前文

哈哈；

***

驱动器
```

自动化执行：

1. 在 `哈哈；` 末尾按 Enter 创建中间空 paragraph；
2. 输入单独 `-`；
3. 输入 `【】`；
4. 校验 DOM 中 `哈哈；` 与 `-【】` 仍是两个 top-level paragraph；
5. 校验 integrity 无失败、无 warning toast；
6. 切源码确认字节为独立 `-【】` 行；
7. 保存并冷重开，再次确认 DOM/source/disk 一致。

通过时 preservation 顺序为：

```text
middle-empty-block-created
middle-empty-block-filled
mapped-line-change
```

三笔 integrity 均 `ok=true / semanticOk=true / listSlotsMatch=true`，且 `npm run test:markdown-preservation` 全量通过。
