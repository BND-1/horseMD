# RS-53：空 task 冷重开后首次正文没有消费 U+200B 哨兵

## 状态

- 来源：RS-51/RS-52 家族泛化测试。
- 原始 RS-50 实现归属：0.13.96。
- RS-53 修复归属：0.13.99。
- 当前状态：完整 façade + UI 生命周期已通过。

## 真实自动化复现

`test-generated-scratch-empty-task-slash-ui.mjs`：

1. 空文件通过 `/task` 创建 unchecked 空 task。
2. generated source 保存为 `* [ ] <U+200B>`，冷重开仍是空 checkbox 且哨兵不可见。
3. 冷重开后在空 task 输入 `任务`。
4. 富文本显示 `任务`，checkbox 仍 unchecked，但立即出现源码不一致；源码模式被保护器挡住。

## 首个失败证据

已提交 checkpoint：

```text
source:    # RS50\n\n* [ ] <U+200B>\n
canonical: # RS50\n\n* [ ] <br />\n\n
```

正文输入后：

```text
candidate: # RS50\n\n* [ ] 任务<U+200B>\n
canonical: # RS50\n\n* [ ] 任务\n\n
reason:    diverged-block-change
```

Integrity 为 `semanticOk:false`、`listSlotsMatch:true`，因此保护器正确拒绝。

## 根因

`preserveDivergedBlockTextChange()` 中的 RS-50 专用 `empty-task-sentinel-filled` 分支，用原始 previous canonical `* [ ] <br />` 直接调用时能正确返回 `* [ ] 任务`。

但正式 façade `preserveRichMarkdownSourceCore()` 在计算 delta 前先执行 `normalizeEmptyListItems()`。空 task 的 `<br />` 被规范成空 body，因此专用 guard 的 `isEmptyTaskPlaceholder()`（原本只接受 `<br />`）不再成立，最终落入 generic `diverged-block-change`，把正文插在 U+200B 前而不是消费它。

## 修复边界

0.13.99 只扩展 RS-50 专用 guard 对 previous body 的定义：

- 接受 `<br />` placeholder；或
- 接受 normalize 后的纯空白 body。

其它证明条件不变：

- source 对应 task body 必须**恰好**是 U+200B；
- previous/next 必须同 task kind、checked 状态、indent/ordinal 对齐；
- next body 必须非空；
- 正文替换后哨兵必须完全消失；
- 普通 authored U+200B、非 task、非空 source body 不得进入该分支。

## 回归

现有 `scripts/test-generated-scratch-empty-task-slash-ui.mjs` 已完整通过：创建空 task → 源码 → 保存 → 冷重开 → 填正文 → `empty-task-sentinel-filled` → 源码无 U+200B → 再保存 → 第二次冷重开仍为 unchecked `任务`；过程无 source-sync toast。
