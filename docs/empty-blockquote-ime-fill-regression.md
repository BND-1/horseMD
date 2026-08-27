# 空 blockquote 中 IME 输入被写到引用块外

> 状态：HorseMD 0.13.93 真实输入通过 `--horsemd-input-trace` 稳定捕获；0.13.94 已修复并通过专项与相邻泛化门禁
>
> 家族编号：RS-48
>
> 修复归属版本：0.13.94
>
> 日期：2026-08-24

## 1. 用户可见现象

在富文本中留下一个空 blockquote，然后直接使用中文输入法输入正文。富文本视觉上文字仍在引用块里，但 HorseMD 随后弹出“富文本与源码不一致 / 保存已暂停”。

这不是 ProseMirror 结构错误，也不是 integrity gate 误报。trace 证明富文本 canonical 正确，而作者源码 mapper 把引用块里的新文字写到了引用块外。

## 2. 0.13.93 首个分叉证据

trace 文件：`horsemd-input-trace-29116.jsonl`。

失败前作者源码尾部：

```markdown
>
```

失败前 Crepe canonical：

```markdown
> <br />
```

IME 提交后 Crepe canonical：

```markdown
> 了就能解开了半年
```

但 `trailing-empty-block-filled` 生成的 candidate 是：

```markdown
>

了就能解开了半年
```

因此 parser 得到“一个空引用块 + 一个普通段落”，而 live ProseMirror 是“一个含正文的引用块”，统一完整性门禁随后正确报 `source-document-mismatch`。

## 3. 根因边界

`preserveTrailingEmptyBlock()` 当前把所有“尾部 empty canonical block 被填充”的情况都交给 `appendBlockAtDocumentEnd()`。这个策略只适用于独立空段落；当旧 authored slot 本身是语法容器（本例为 syntax-only `>`）时，填充必须发生在该容器内部，不能追加成新的顶层 block。

正确修复应：

- 识别 previous canonical 的 `> <br />` 与 authored source 尾部 syntax-only `>` 是同一个受信空 blockquote slot；
- 用 next canonical 的 quoted 内容替换该 authored `>` 行，而不是在文档尾追加普通段落；
- 保留作者的 quote depth / spacing 与文件 EOL；
- 普通 trailing empty paragraph 仍沿用现有 append 逻辑；
- 不放宽 semantic AST / raw list-slot integrity gate。

## 4. 回归合同

至少覆盖：

- `> <br />` → `> 中文` 时源码得到 `> 中文`，不得得到 `>\n\n中文`；
- 普通空段落填充继续得到独立普通段落；
- 两层 blockquote 的空槽填充不丢 depth；
- 真实 UI 使用 IME composition 输入后，无 integrity toast；
- 立即切源码、保存、冷重开后引用结构和字节仍正确；
- 空 blockquote 删除专项继续通过。

## 5. 0.13.94 验证结果

修复后 `preserveTrailingEmptyBlock()` 只在 authored source 尾部明确是 syntax-only quote、previous canonical 是同深度 `> <br />`、next canonical 仍是同深度非空 quote 时接管，并在原 quote slot 内填充正文；普通 trailing empty paragraph 继续走原有 append 分支，integrity gate 未放宽。

已通过：

- `test:markdown-preservation`：单层和双层空 blockquote 填充纯函数回归；
- `test:empty-blockquote-ime-fill-ui`：真实 `imeSetComposition` 的 `ceshi → 测试`，覆盖无 integrity toast、源码、保存、冷重开；
- `test:ime-source-fidelity-ui`：全局 IME composition 保真；
- `test:empty-blockquote-removal-ui`：既有空引用删除保存/重开；
- `test:paragraph-source-ui`：普通段落即时源码切换与重开；
- `test:source-fidelity-ui`：异构 Markdown 富文本编辑仍保持字节局部。
