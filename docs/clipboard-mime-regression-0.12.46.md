# 0.12.46 剪贴板 MIME 回归报告

## 现象

0.12.46 在富文本中复制正文并粘贴到外部纯文本编辑器时，段落前后会出现额外回车或空行；只复制有序列表中的文字时，外部结果会额外带上 `1. `。这会让普通复制变成 Markdown 导出，属于阻断日常使用的严重回归。

## 根因

Issue #98 要求复制加粗、行内代码等内容时保留 Markdown 标记。旧修复把选区的 ProseMirror slice 交给 Milkdown serializer，再把结果写入 `text/plain`。

serializer 的职责是生成合法 Markdown，而不是复刻用户在屏幕上选中的文字：

- 段落是块节点，序列化时会增加块间分隔换行。
- 有序列表是结构节点，序列化时会生成 `1. ` 等 marker。
- 粗体和行内代码会生成 `**`、反引号等源码字符。

因此，这不是换行 trim 不完整，也不是列表 CSS 问题，而是剪贴板 MIME 语义用错。继续对 serializer 输出做删换行、删 marker 的字符串清理，会破坏真正需要的 Markdown 结构，并产生更多语法特判。

## 修复合同

富文本复制必须同时维护三个互不替代的通道：

| MIME | 内容 | 使用方 |
| --- | --- | --- |
| `text/plain` | 可见选区文字；CSS 视觉软换行物化为 `\n` | 记事本、终端、普通输入框 |
| `text/html` | 选区 DOM 加安全内联样式 | Word、邮件、公众号、Notion |
| `text/markdown` | Milkdown serializer 的结构化 Markdown | HorseMD 内部粘贴 |

HorseMD 粘贴时优先读取 `text/markdown`，仅当它确实包含 Markdown 结构时才走 Markdown parser；否则继续使用普通文本或 HTML 路径。代码块自己的复制按钮不经过该选区合同，仍通过原生剪贴板 IPC 复制完整代码。

普通源码单换行在 HorseMD DOM 中是内容为空格、通过 CSS 伪元素换行的 inline hardbreak。直接使用 `Selection.toString()` 会把视觉上的多行合并为空格。复制处理因此只在克隆片段中把这些节点替换为 `<br>`：纯文本探针读为 `\n`，HTML 保留 `<br>`，Markdown 通道仍是原始单换行。编辑器节点和磁盘文件均不改变。

## 禁止方案

- 不得再把 Markdown serializer 输出写入 `text/plain`。
- 不得通过 `trim()` 掩盖块级换行；它无法解决多段落和列表 marker。
- 不得用正则从纯文本中删除 `1. `，因为用户可能真的选中了这段文字。
- 不得为修外部复制而取消内部 Markdown 通道，否则 HorseMD 内部列表粘贴会退化成普通段落。

## 自动化验证

`scripts/test-issue-98-copy-undo-ui.mjs` 在后台 Electron 中直接检查 copy 事件的三个 MIME：

1. 正文段落的 `text/plain` 与可见文字完全相等，前后没有块级换行。
2. 有序列表的 `text/plain` 不包含生成的 `1. `。
3. 加粗内容的 `text/html` 保留 `<strong>`，`text/markdown` 保留 `**`。
4. 普通源码单换行在 `text/plain` 中是一个 `\n`，在 `text/html` 中是一个 `<br>`。
5. 将同一列表 payload 粘回 HorseMD 时仍创建有序列表。
6. 代码块按钮仍写入完整代码，`Cmd+Z` 仍使用原生编辑历史。

发布前还需按 `docs/manual-test-checklist.md` 将段落和列表分别粘贴到真实外部纯文本编辑器，确认目标应用得到的字符与选区一致。
