# 反引号删除后保存暂停与源码模式锁死回归报告

> 状态：HorseMD 0.13.26 修复同步锁死；0.13.27 补齐闭合触发与代码块快速退出边界；0.13.28 修复新文档三反引号 canonical 转义泄漏；0.13.29 发布候选完成整套家族复跑
>
> 家族编号：RS-26
>
> 日期：2026-08-09

## 1. 用户症状

用户在富文本中逐字输入一个或三个反引号，继续尝试代码块/行内代码，再删除这些反引号并编辑、保存时，偶发出现：

> 保存已暂停：当前富文本编辑暂时无法安全映射到源码，请返回富文本后重试，画面中的编辑仍保留在编辑器内。

此后点击源码模式也没有反应。它不是按钮失灵，而是保真层检测到作者源码与当前富文本 canonical 已分叉，主动 fail closed，避免把旧源码写盘。真正错误发生在更早的反引号删除事务。

## 2. 精确根因

### 2.1 把“删除两个反引号”误判成“整行已清空”

真实事务曾是：

```text
作者源码：```
previous canonical：\`\`\`
next canonical：\`
```

旧 `preserveEmptiedEscapedLiteralLine()` 只看 `commonChange()` 得到的零宽 replacement，错误地删除整条作者源码行。实际上 next canonical 仍保留一个反引号。结果双快照立即变成“源码空、canonical 有一个反引号”，后续任何输入都只能得到 `visible-stream-mismatch`。

修复后以**完整 next canonical 行**为准：部分删除写回剩余字符，只有完整行确实为空或只剩内部 `<br />` 时才清空源码行。

### 2.2 重复字面反引号行不能依赖全文唯一匹配

文档中有两条相同的单反引号行时，旧逻辑要求目标文本在全文只出现一次，第二条无法映射。现在优先使用 source / previous 的同行 ordinal；只有结构不能证明稳定时才退回唯一文本匹配。

### 2.3 独立空段落让全局可见 offset 落到上一块边界

源码用空白行表示空段落，canonical 用独立 `<br />`。两者可见字符相同，但零宽编辑位置不唯一：空段落之后输入一个反引号时，通用全局可见 offset 可能把变化锚到前一个标题末尾，造成标题和后续正文粘连。

`preserveOrdinalLineTextChange()` 只在行数稳定、previous canonical 存在对应独立 `<br />` 行、且变化局限于单行时启用，按行 ordinal 回写目标行，不跨空段落猜全局 offset。

### 2.4 未变化列表抢先消费无关编辑

回归中还发现，`preserveBatchedListBlockChanges()` 会把作者列表写法与 canonical 列表写法的既有差异误认为“本事务修改了列表”，从而先于真实标题/反引号变化返回，并格式化未编辑列表。

现在若某个列表块的 previous canonical 与 next canonical 完全相同，该列表直接跳过；只有本事务真正改变的 canonical 列表才能参与批量列表映射。

### 2.5 行内代码插件回调必须序列化 live doc

行内代码插件拥有自己的事务时序。`Editor.jsx` 的回调现在通过 `serializerCtx(view.state.doc)` 读取当前 ProseMirror 文档，不再使用可能滞后的 `crepe.getMarkdown()`。若保真映射失败，不推进 source/canonical 基线、不清 pending，等待后续强制边界重新读取 live doc。

### 2.6 行内代码不能在首个正文字符时提前激活（0.13.27）

旧插件在用户输入左反引号后，只要 IME 提交第一个中文字符，就立即删除作者输入的
反引号并创建 inline-code mark。用户尚未表达闭合意图，却已经进入 code 编辑态；
这也让连续方向键和三个反引号的代码块输入规则互相影响。

现在左反引号与中间正文保持普通字面文本。只有最后输入一个未转义、单个运行的右
反引号，且同一 textblock 中间内容非空时，才删除两个 delimiter 并给中间正文加
inline-code mark。`` 与 ``` 运行保持字面输入。闭合后清除 stored inline-code mark，
并把 DOM caret 放在 code 右侧；点击既有 code 后仍可编辑，首尾方向键可直接退出。

真实 IME 回归使用 `Input.imeSetComposition` 完成拼音 composition，再提交中文，明确
断言闭合前不存在 `<code>`，而不是用 `insertText` 冒充中文输入法。

### 2.7 ``` + Space 与快速 Backspace 的同步边界（0.13.27）

取消“首个字符提前变行内代码”后，``` + Space 会正确恢复 Crepe 的 fenced code-block
输入规则。空代码块按一次 Backspace 会回到空段落；若用户立刻继续输入，旧的 260ms
批处理可能把新正文与 fenced canonical 合在同一个 delta。DOM 交互层现在识别来自
CodeMirror/代码块的 Backspace，在结构命令完成后的下一任务立即从 live doc 对账，
后续快速输入不会粘到上一段，保存和重开保持一致。

### 2.8 同一行三反引号在新文档中泄漏反斜杠（0.13.28）

真实输入 ```` ```你好``` ```` 是普通正文，不是 fenced code block，也不应成为行内代码。
remark 为避免重新解析歧义，会把该段 canonical 写成六个带反斜杠的反引号。已有文件的
局部增量会走 fresh replacement 翻译，因此没有暴露；但 generated scratch 和空文件首次
编辑仍调用普通 `canonicalTextToSource`，误把 serializer 拼写当成作者原文。

新建文档的全部内容都来自本次富文本输入，不存在旧作者转义需要逐字保留。因此这两条
边界改用 `canonicalFreshTextToSource`：只在 Markdown 正文还原 serializer punctuation，
而 fenced code、真正的 inline code、HTML comment/raw block 仍由上下文扫描保持字节不动。
这不是全局删除反斜杠，也不会扫描或格式化已有文件。

## 3. 为什么不能删除“保存暂停”保护

保存暂停和源码模式拒绝切换是最后一道数据安全边界。它们阻止旧源码覆盖用户仍可见的富文本编辑。正确修复是消除更早的错误分叉，而不是：

- 映射失败后仍推进 canonical baseline；
- 清除 pending 状态；
- 强行进入源码并显示旧内容；
- 直接用整篇 canonical 覆盖作者源码。

上述做法都会把“明显暂停”变成“静默丢数据”。

## 4. 修改归属

- `src/renderer/src/lib/markdown-preservation/paragraphs.js`
  - escaped literal 行按完整 next line 回写；支持部分删除、整行删除、替换为普通文字和重复行 ordinal。
- `src/renderer/src/lib/markdown-preservation/regions.js`
  - 增加独立 `<br />` 空段落附近的同行 ordinal 映射。
- `src/renderer/src/lib/markdown-preservation/lists.js`
  - 批量列表映射跳过 previous/next canonical 未变化的列表。
- `src/renderer/src/components/Editor.jsx`
  - 行内代码事务从 live `view.state.doc` 序列化；映射失败不确认快照。
- `src/renderer/src/markdown-source-preservation.js`
  - 接入 ordinal line 路径；generated scratch / empty-file 首次编辑使用 fresh canonical 翻译；提供测试按需启用、最多 200 条的 `window.__hmPreserveLog` 诊断记录。

## 5. 自动化验收

```bash
npm run test:markdown-preservation
npm run test:code-fence-delete-source-ui
npm run test:inline-code-ui
npm run test:literal-triple-backtick-source-ui
npm run test:empty-paragraph-source-ui
npm run test:source-fidelity-ui
npm run test:new-source-fidelity-ui
npm run test:list-item-literal-marker-source-ui
npm run test:rich-source-continuous-fidelity-ui
npm run test:rich-source-chaos-ui
npm run build
npm run build:mobile
```

`test:code-fence-delete-source-ui` 必须逐键覆盖：单反引号输入/删除、三反引号输入/部分删除/全部删除、重复两轮、``` + Space 触发代码块并按一次 Backspace 后快速输入、删除后立即切源码、删除后立即保存、二次往返、完整进程重开及磁盘逐字节比较。

## 6. 人工验收

1. 新建文档，逐字输入一个反引号并删除，立即切源码；源码不得残留，切换不得卡住。
2. 逐字输入三个反引号，删掉两个，源码必须只剩一个原始反引号；再删除最后一个，源码为空。
3. 重复“输入三个反引号 → 删除 → 输入普通正文”至少两次，然后立即保存；不得出现保存暂停提示。
4. 在空段落前后各保留标题/正文，再做上述操作；其他块不得粘连或被格式化。
5. 文档包含两条相同反引号行时，分别修改第二条；不得因全文重复而锁死。
6. 同一文件保留 `-`、`+`、`*` 列表和 Setext 标题；反引号操作后这些未编辑内容逐字符不变。
7. 真正空白文件逐键输入 ```` ```你好``` ````（中文使用真实 IME），切源码后每个反引号前都不得多出 serializer 反斜杠；保存、关闭进程、重开后源码完全一致。

## 7. 防回归禁区

- 不能从零宽 `commonChange()` replacement 推断整行已删除，必须检查完整 next line。
- 存在稳定行身份时不能强制要求文本全文唯一。
- 独立 `<br />` 空段落两侧的零宽编辑不能只用全局可见 offset。
- previous/next canonical 未变化的列表不能消费无关事务。
- 映射失败不能推进双快照、清 pending 或绕过保存/源码 fail closed。
- 不能用整篇 canonical 覆盖作者源码来“让切换恢复”。
- 不能把 generated scratch 的 canonical serializer escape 当作作者源码；也不能用全局 `replace('\\`', '`')` 破坏代码/HTML literal。
