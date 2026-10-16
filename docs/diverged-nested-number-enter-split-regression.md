# `- 1. 文本` 嵌套数字列表 Enter 拆项后源码层级丢失

> 状态：RS-45 泛化测试中发现；0.13.90 自动化稳定复现；修复归属版本：0.13.92
>
> 家族编号：RS-46
>
> 日期：2026-08-23

## 1. 现象

已有作者源码：

```markdown
- 1. 甲乙
- 丙丁
```

remark / Crepe 会把第一行解释成一个外层 bullet，其内部包含 ordered item `1. 甲乙`。在富文本里把 `甲乙` 中间按 Enter 拆成两个 ordered item，再给第二项输入 `新` 后，富文本结构正确，但切源码被 integrity gate 阻止并提示富文本与源码不一致。

## 2. 诊断证据

泛化回归 `test:nested-number-list-source-ui` 的诊断输出证明：

live canonical：

```markdown
* <br />

  1. 甲
  2. 新乙

* 丙丁
```

`preserveDivergedNestedListChange()` 生成的 candidate：

```markdown
- 1. 甲
- 2. 新乙
- 丙丁
```

candidate 重新解析后变成三个外层 bullet 项：前两个 bullet 各自只有一个 nested ordered item；live canonical 则是一个外层 bullet 下同一个 ordered list 的 `1/2` 两项，再加 `丙丁`。因此：

- `semanticOk: false`
- `listSlotsMatch: false`
- integrity diff 首个结构差异为外层 list item 数量 `3 != 2`
- 模式切换 fail closed，source textarea 不出现，用户收到源码不一致提示。

这说明门禁本身判断正确，错误在 source mapper。

## 3. 根因

`preserveDivergedNestedListChange()` 的 item-sequence mapper 能识别作者行 `- 1. 甲乙` 中的 `1.` 已被 canonical 消费为 nested ordered marker，但当 Enter 新增 ordered sibling 时，generic insertion 分支只看到 anchor authored row 的外层 token 是 `-`，于是把新 `2.` 写成：

```markdown
- 2. 新乙
```

这相当于新建一个外层 bullet，而不是继续同一 outer bullet 内的 ordered list。

正确的 parse-safe 作者源码必须沿 outer bullet 的 content column 缩进，例如：

```markdown
- 1. 甲
  2. 新乙
- 丙丁
```

若作者原本使用 `-   1. ...` 或 `1)`，continuation 必须沿作者 outer marker 后的实际 content column，并保留 ordered delimiter，而不能硬编码两个空格或统一成 `.`。

## 4. 修复边界

只在以下证据同时成立时，把新增 ordered item 写成 nested continuation：

1. anchor authored row 的外层 token 是 bullet；
2. 该 authored row 正文开头本身是 ordered marker（如 `1. ` / `1) `）；
3. live canonical 的新增 item 也是 ordered；
4. 新 item 的 canonical indent 明确深于 outer bullet；
5. 仍位于同一个 flattened outer-list item group。

其他真正的 top-level 新列表项、普通 bullet、新层级转换仍走原 mapper。候选最终继续经过 semantic AST + raw list-slot 双证明，不能绕开 integrity gate。

## 5. 回归合同

至少覆盖：

- `- 1. 甲乙` 中间 Enter → `甲 / 乙`；
- Enter 后立即给第二项输入正文；
- 已有两项时追加第三项；
- 空第二项填充；
- `1)` delimiter；
- outer bullet 使用多空格 content column；
- source toggle、保存、磁盘字节、冷重开；
- 原有 marker removal / lift / unrelated sibling 不回归。

专项入口继续使用 `npm run test:nested-number-list-source-ui`，纯函数由 `npm run test:markdown-preservation` 覆盖。
