# Transaction Journal：代码块显式退出

> 源码版本：HorseMD 0.13.148
> Family：`code-block-exit`
> Owner：`createCodeBlockExitTransactionSourceSyncOwner`
> Boundary：`transaction-code-block-exit`

## 1. 迁移目标

HorseMD此前没有真实代码块退出命令。CodeMirror会先消费代码块内的键盘事件，因此在非空 fenced code block 中按`Mod+Enter`只会继续在代码块内换行，测试若直接操作PM selection测到的是不存在的用户路径。

0.13.148先建立固定、不可配置的`editor.code.exit = Mod+Enter`产品入口：统一DOM keydown层仅在事件目标属于当前EditorView的非空`.milkdown-code-block`时，通过NodeView DOM identity/containment和`posAtDOM`区间证明唯一顶层PM `code_block`，在临时state中把selection置于代码正文末尾，调用官方ProseMirror `exitCode`并只dispatch其唯一doc-changing transaction。普通正文、空代码块、foreign DOM或无法唯一映射时返回false，不拦截原事件。

随后revision-bound `code-block-exit` family接管这笔真实事务，不再根据canonical fence/段落形状猜测“代码块后多了一段正文”。

## 2. 真实事务链

产品DOM bridge和永久纯合同都调用ProseMirror官方`exitCode`，捕获的第一笔文档事务是：

```text
ReplaceStep
from == to == code_block.after
slice = closed empty paragraph
```

随后真实物理输入`X`、`Y`分别形成同一新paragraph内的纯文字`ReplaceStep`。当前产品时序中，结构键调用`onRichEditPending`：快速继续输入会先通过forced-flush发布source不变的pending checkpoint，再以其provenance作为下一journal基线写入文字；自然等待由markdownUpdated发布pending；立即切源码也由forced-flush发布pending。owner仍支持结构+文字尚未分界时的coalesced journal，但它是纯合同能力，不是当前DOM物理默认时序。

逻辑完整链：

```text
code_block unchanged
→ insert empty paragraph immediately after code_block
→ insert X in that paragraph
→ insert Y in that paragraph
```

## 3. 所有权合同

Owner 只有在以下条件全部成立时才认领：

1. journal、Coordinator revision、source/canonical digest 与 live expected doc完全匹配；
2. coalesced final doc相比old doc只多一个top-level paragraph；staged final doc保持top-level数量且只把代码块后的既有空段填入正文；
3. 新 paragraph 唯一位于一个非空 `code_block` 后；
4. old code block 与 final code block节点、attrs和正文完全不变；
5. 第一笔是 closed `ReplaceStep`，在 code block 的精确 after position 插入空 paragraph；
6. 后续每一笔只编辑该新 paragraph；
7. 后续 Step 不得带 marks、atom、跨段、跨 block 或修改邻块；
8. pending阶段final paragraph可为空且source保持逐字不变；coalesced/staged文字阶段必须为非空、单行、无marks/atom；
9. PM→Markdown offset 在 authored source 和 previous canonical 中都唯一落入一个完整 fenced range；
10. bounded insertion 后的 Markdown 必须重新解析为 expected PM doc。

结构性插入与文字 Step 夹带其他编辑、空代码块、重复候选、range歧义、callback mismatch、semantic mismatch或stale revision均 fail closed。

## 4. Raw source insertion

该 family 保留作者原有代码块字节，不重写 opening fence、closing fence、info string或代码正文。

它只在 closing fence 行之后插入：

```text
blank line
final paragraph text
line ending
```

若后续已有作者空行，则复用该空行作为 paragraph 与下一块的分隔；若紧邻后续块，则补足必要空行。EOL 取自 closing fence、opening fence或当前作者源码，按顺序选择，因此可保持：

- BOM；
- LF 或 CRLF；
- tilde/backtick fence；
- fence长度和info string；
- 前后块与未编辑字节。

例如：

```md
~~~js
const n = 1
~~~

after
```

退出并输入 `XY` 后只变为：

```md
~~~js
const n = 1
~~~

XY

after
```

## 5. 永久回归

纯合同：

```bash
npm run test:code-block-exit-transaction-owner
```

覆盖：

- 真实 `exitCode` transaction；
- 两笔coalesced文字Step；
- BOM + CRLF；
- tilde与backtick fence；
- info string；
- exact insertion proof；
- structural-only pending状态；
- 空 code block；
- 邻块混改；
- offset/range无法唯一证明；
- callback mismatch、semantic rejection和stale revision。

真实 Electron（完全使用可见CodeMirror DOM、物理`Mod+Enter`和DOM段落，不访问`pmViewDesc`或测试专用PM hook）：

```bash
npm run test:code-block-exit-transaction-ui
npm run test:code-block-exit-staged-ui
npm run test:code-block-exit-forced-flush-ui
```

覆盖：

- 物理 `Mod+Enter`；
- 快速输入`XY`时的forced pending→provenance staged publication；
- 自然等待时的markdownUpdated pending→staged publication；
- 立即切源码时的forced-flush pending→staged publication；
- 专用owner reason与Coordinator boundary；
- 零integrity false、零warning toast；
- source精确；
- 保存到磁盘；
- 完整停止进程；
- 全新profile冷重开。

## 6. 架构边界

本 family只处理固定`editor.code.exit`产品命令通过官方ProseMirror `exitCode`在非空顶层代码块之后插入普通paragraph；owner仍依据Step和journal证明，而不是依据快捷键本身放行。

以下仍不归它所有：

- 空代码块Backspace解包；
- 代码块正文普通编辑；
- info string修改；
- 创建或删除fence；
- 非空代码块整体转普通段落；
- 多行或跨block paragraph编辑。

这些操作分别由已有focused owner或后续独立lifecycle family处理，不回到canonical diff特判。
