# RS-81：字面三反引号的 parser / SourceSync 边界

> 修复版本：HorseMD `0.13.126`
> 发现方式：inline-code plugin-owned publication 接入 `SourceSyncCoordinator` 后，严格 candidate validation 捕获此前被 direct refs 写回掩盖的首个语义分叉。

## 1. 用户可见问题

HorseMD 的逐键 inline-code 合同规定：

- 单个反引号先作为字面字符出现；
- 只有有效的 closing delimiter 才建立 inline-code mark；
- 同一文本块中逐键输入 ` ```你好``` ` 时，三个反引号 run 保持普通可见文字；
- 只有后续 Space 等明确 input rule 才可能创建 fenced code block。

旧 inline-code callback 会在 plugin-owned transaction 后直接更新 `lastMarkdownRef`、`canonicalMarkdownRef` 和 App 内容，没有经过统一 semantic integrity。这样源码看似保存成功，但两处结构无法 round-trip：

1. 最终 ` ```你好``` ` 被 CommonMark/remark 解析为一个 `inlineCode` 节点，而 live ProseMirror 仍是包含六个 delimiter 的普通文字；
2. 第三个反引号刚输入、尚未按 Space 时，裸 ` ``` ` 被解析为无 closing 的空 fenced code，而 live ProseMirror 仍是普通 paragraph。

切源码时严格 flush 会拒绝这两个 candidate；旧测试若只检查源码字节、不检查 cold-reopen rich 结构，则会漏掉第二种损坏。

## 2. 与 RS-74 的边界

RS-74 只修复 `source-structure-fingerprint` 对同一行 triple-backtick literal 的 fence scanner 误判。RS-81 现场始终满足 `listSlotsMatch=true`，失败的是 `semanticOk=false`：reparsed source 多出 inlineCode mark 或 code_block。

因此本修复没有：

- 放宽 list-slot scanner；
- 忽略 inlineCode mark；
- 把 semantic integrity 改成 reason 白名单；
- 用 canonical escaped backticks 覆盖作者源码；
- 改变用户逐键输入语义。

## 3. 修复模型

新增 `components/editor-literal-backticks.js`，在 remark parse pipeline 中使用 mdast `position.start/end.offset` 从真实输入取原始字节，只接受两个精确形状。

### 3.1 完整 triple-delimited textblock

必须同时满足：

- 父节点只允许 `paragraph` 或 `heading`；
- 父节点只有一个 child；
- child 类型为 `inlineCode`；
- child 原始切片没有换行；
- 原始切片以恰好三个 backticks 开始和结束；
- opener/closer 不能是四个以上 backticks；
- 中间必须至少有一个字符。

命中后只把 child 改为包含完整原始 delimiters 的 `text`。

### 3.2 裸第三反引号中间态

必须同时满足：

- mdast node 为 `code`；
- `lang == null`、`meta == null`；
- `value === ''`；
- 原始切片精确匹配三个 backticks，后面只允许无 EOL、LF、CRLF 或 lone CR。

命中后恢复为包含字面 ` ``` ` 的普通 paragraph。该规则不接受语言、正文、closing fence、tilde 或更长 delimiter run。

## 4. 明确负例

以下仍保持标准 Markdown 语义：

- `` `single` ``；
- `` ``double`` ``；
- 四反引号 inline code；
- `before ```embedded``` after`；
- ` ```js ` 未闭合 info fence；
- 未闭合但已有代码正文的 fence；
- 完整 opening/content/closing fence；
- tilde fence；
- 六反引号 fence；
- 用户已经显式转义的 triple-backtick literal。

## 5. SourceSync 迁移

`handleInlineCodeValueChange` 不再直接推进 source/canonical/App 三份状态。它现在生成现有 legacy preservation result，并通过：

```text
boundary: inline-code-value-change
owner: legacy
family: legacy-preservation
```

进入 revision-bound `SourceSyncCoordinator`。validation、host commit、snapshot revision 和 trusted checkpoint 只在同一 publication 成功后推进。

## 6. 永久验收

```bash
npm run test:literal-triple-backtick-parser
npm run test:editor-input
npm run build
npm run test:inline-code-ui
npm run test:literal-triple-backtick-source-ui
```

当前结果：全部 PASS。

真实 UI 门禁覆盖：

- 每字符 committed input；
- 真实中文 IME composition；
- closing delimiter 激活与方向键退出；
- bare third-backtick 中间 transaction；
- Coordinator publication boundary；
- `window.__hmSourceIntegrityTrace` 中 `ok=false` 为 0；
- warning toast 为 0；
- source textarea 精确；
- 磁盘精确；
- cold reopen 后 triple backticks 仍为普通文本，内部 `<code>` 数量为 0。

