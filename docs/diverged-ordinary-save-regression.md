# 复杂文档普通编辑保存被暂停回归报告

> 状态：HorseMD 0.13.33 已完成源码保真家族矩阵和安装包专项，待用户手动验收
>
> 家族编号：RS-30、RS-31、RS-32、RS-33
>
> 日期：2026-08-09

## 1. 用户症状

用户在富文本中做普通编辑并点击保存，出现：

> 保存已暂停：当前富文本编辑暂时无法安全映射到源码。请返回富文本后重试，画面中的编辑仍保留在编辑器内。

编辑内容仍在富文本中，但保存按钮不会消失，磁盘文件没有写入。这个提示本身是数据保护；错误在于一个本可安全定位的普通段落编辑被误判为歧义。

## 2. 稳定复现

真实复现文件同时包含：

- `- - 测试`，remark 会把它解析为嵌套列表；
- 同行 ```` ```你好``` ````，Crepe 会按行内代码 canonical 序列化；
- 尾部仅含 `>` 的空引用语法行；
- 标题、列表和引用中多次出现“测试”；
- 一个独立正文段落也叫“测试”。

需要分别在三个位置逐字输入，不切源码直接保存：

1. 独立正文“测试”；
2. `- - 测试 1. 你好` 对应的嵌套项；
3. 它后面的 `- 测试 - 测试 1. 2. 测试` 兄弟项。
4. 同一引用中的三个不同段落连续编辑后直接保存；
5. 在多个内容相同的 `> 测试` 引用中，从最后一个引用按两次 Enter 退出，再逐字输入一个唯一末段并直接保存。
6. 不从引用内退出，直接用真实鼠标点击引用下方已经存在的空正文段落，逐字输入唯一末段并直接保存。

0.13.29 的独立正文、0.13.30 的后两项都会得到：

```text
reason: visible-stream-mismatch
preserved: false
```

专项回归：

```bash
npm run test:diverged-ordinary-save-ui
```

测试必须验证富文本直接保存、源码模式、磁盘文件和完整进程重开四处完全一致，并且未编辑区域逐字节不变。

## 3. 根因

### 3.1 独立正文（RS-30）

作者源码和 Crepe canonical 在打开文件时已经存在合法但永久的可见流差异。普通编辑发生后：

1. 全局 visible offset 因前文分叉而不能直接使用；
2. 32 字符局部上下文中“测试”重复出现，唯一上下文回退拒绝定位；
3. 旧块级回退用 `source.indexOf(blockText)` 搜索全文，短文本“测试”在标题、列表和引用中都是子串，因此也被视为重复；
4. 最终 fail closed，保存入口收到 `null` 并显示暂停提示。

问题在于旧逻辑把“全文子串不唯一”等同于“Markdown 块不唯一”。独立正文块本身可以按块边界和出现序号准确定位，即使相同文字还出现在其他语法结构中。

### 3.2 嵌套无序列表（RS-31）

0.13.30 的自动化只实际编辑了独立正文。用户在同一文件继续编辑列表后证明：

- source 行 `- - 测试 1. 你好` 的第一个 `- ` 是外层行 marker；
- 第二个 `- ` 在 source row 中仍是正文前缀，但 canonical 把它消费为嵌套 bullet marker，生成 `* <br />` 加缩进的 `* 测试 1. 你好`；
- `preserveDivergedNestedListChange()` 旧逻辑只会从作者正文剥离 `1. ` / `1) `，无法把第二个 `- ` 与 canonical nested item 对齐；
- 对齐在第二行提前失败，所以编辑嵌套项本身、甚至编辑其后的正常兄弟项都会 fail closed。

0.13.31 将“作者正文中的 canonical 嵌套前缀”扩展为恰好一层 `-`、`+`、`*`、`1.` 或 `1)` marker；同一个 prefix length 同时用于文本比较和 raw 写回位置，输出仍保留作者原始 marker。

### 3.3 重复引用后的新段落写错位置（RS-32）

0.13.31 的真实长会话又捕获到更具体的损坏：富文本末尾显示 `ceeavvß/`，但磁盘源码把 `ceeavvß` 拼进了前面一条 `> 测试afawfaef`，末尾段落反而消失。现场 ProseMirror 文档与磁盘文件已经分别留存，证明不是显示延迟，而是 raw 写回位置错误。

根因位于 `preserveMiddleEmptyBlock()`：它先在 previous canonical 中算出变更前后的可见行索引，再直接用同一个索引读取作者 source。只要文档前部已有 `- - 文本`、转义或 parser 合并/拆分，两条 visible stream 的行数和序号就不再相同；大量重复“测试”又让只比较邻近文字的错误位置看似合法，最终把末尾新文字写进更早的引用。

0.13.32 的合同是：source/canonical 可见行完全一致时才允许全文索引直取；已经分叉时，用“前后相邻可见文本 + quote/list/heading/table/plain 结构类型 + 同类 pair 的出现序号”定位，并要求 source 与 canonical 候选数量完全相等。任何一项不成立都 fail closed，不猜测 raw 位置。

### 3.4 直接点击引用后的空正文（RS-33）

0.13.32 自动化从最后一个引用段落按两次 Enter，再输入正文；用户实际操作是直接点击引用下方由 Crepe 挂载的空 `<p>` 起笔。这个空段落在 previous canonical 中没有 `<br />`，只体现为文档末尾的空行，因此不走 trailing-empty 或 middle-empty 处理器。新文字表现为 `start === previous.length` 的零宽追加，但分叉分支抢先执行 `preserveLocallyAlignedTextChange()`；多个 `>` 空行都没有可见字符，错误 ordinal 仍可通过局部文字比较，最终把末尾文字写成较早的 `>新增文字`。

0.13.33 把“物理文档末尾的纯正文追加”放到可见流分叉判断之前：必须是 previous 末尾零宽插入、replacement 有可见正文且不含标题、列表、引用、fence、table 等专用块语法，再用 `appendBlockAtDocumentEnd()` 写入作者源码末尾。结构新增仍由各自处理器负责，不扩大这条确定性规则。

## 4. 修复设计

`preserveDivergedBlockTextChange()` 仍只处理单个 canonical 块内的文字变化，但定位顺序改为：

1. 按空白行边界提取 source 和 previous canonical 的非空块；
2. 仅为比较生成反转义、统一换行的块 key，不修改输出字节；
3. 找到当前 canonical 目标块在同 key 块中的 ordinal；
4. 只有 source 与 canonical 的同 key 块数量完全相等时，才替换 source 中相同 ordinal 的块；
5. 数量不等说明 remark 可能合并或拆分了某个候选块，拒绝猜测并回到旧的“全文唯一子串”保守路径；
6. 跨块变化、结构变化和独立 `<br />` 继续 fail closed。

因此四个完全相同的正文段落也可以准确修改第三个；但“canonical 有两个候选、source 只保留一个完整候选，另一个被合并进其他块”的旧歧义场景仍会拒绝写回。

## 5. 为什么旧测试全绿仍漏掉

- 反引号专项只对部分删除场景立即保存，没有覆盖复杂既有文档中的普通重复正文。
- chaos 测试在保存前先切换源码，两次强制 flush 可能提前暴露或消化 pending 状态。
- 纯函数测试已有“重复全文子串必须拒绝”的合同，却没有区分“重复子串”和“等数量、可按块 ordinal 对齐的重复块”。
- UI 总回归没有包含这一真实 fixture 的“最后一键后直接保存”。

本次保障扩为：

- 纯函数：唯一独立块但全文子串重复；四个相同独立块修改第三个；候选数量不等仍拒绝。
- UI：分别逐字编辑复杂分叉文件中的独立正文、`- -` 嵌套项和其后兄弟项；每项都不切源码直接保存，再检查源码、磁盘和冷重开。
- 真实 IME composition 加入家族矩阵，避免用逐字 committed Chinese 冒充中文输入法生命周期。
- UI 专项再增加同一引用内三段连续编辑，以及从第三个重复引用退出后逐字输入唯一末段；两项都在**不先切源码修复状态**的前提下直接保存，并比较源码、磁盘和冷重开。

曾验证并撤销过“每次候选源码都整篇重新解析，循环到与 ProseMirror 语义相等”的方案。该方案会把作者的字面 `- - 文本`、`1. 2. 文本` 和三反引号当作另一层 Markdown 结构，造成列表 marker、反引号和空行回归。它不是安全兜底，后续禁止重新引入；当前保真层只能接受可证明的局部 raw 映射。

## 6. 修改范围

- `src/renderer/src/lib/markdown-preservation/regions.js`
- `src/renderer/src/lib/markdown-preservation/lists.js`
- `src/renderer/src/lib/markdown-preservation/paragraphs.js`
- `scripts/test-markdown-source-preservation.mjs`
- `scripts/test-diverged-ordinary-save-ui.mjs`
- `docs/rich-source-fidelity-bug-family.md`
- `docs/markdown-source-preservation.md`
- `docs/manual-test-checklist.md`

没有删除保存时的 fail-closed 保护，没有在保存出口使用 canonical 覆盖整篇源码，也没有推进失败事务的 canonical baseline。

## 7. 验证要求

最低专项：

```bash
node scripts/test-markdown-source-preservation.mjs
npm run test:diverged-ordinary-save-ui
npm run test:diverged-delete-source-ui
npm run test:diverged-partial-delete-ui
npm run test:mixed-rich-source-transaction-ui
npm run test:code-fence-delete-source-ui
npm run test:rich-source-continuous-fidelity-ui
```

交付前仍须执行 `rich-source-fidelity-bug-family.md` 第 6 节完整家族矩阵、桌面/移动构建和安装包内回归。

历史注意：0.13.30 曾完成 26 组矩阵和安装包验证，但 `test:diverged-ordinary-save-ui`
只编辑了 fixture 中的独立段落；“fixture 含 `- -`”不等于“测试真的编辑了 `- -`”。用户手测
因此仍能触发 RS-31。0.13.31 把三个目标块分别做完整保存与冷重开，并将家族矩阵扩为
27 组；安装包验证结果须在重新打包后追加，不能沿用 0.13.30 证据。

0.13.31 最终自动验证：桌面构建、移动构建、guide 与 diff 检查通过；覆盖安装
`/Applications/HorseMD.app` 后，用安装包可执行文件通过三目标复杂分叉直接保存、真实中文
IME composition、列表正文五种字面 marker、反引号/代码围栏删除四组高风险回归。三目标专项
每次都检查源码、磁盘与完整冷重开，不以“fixture 含某语法”代替真正编辑该语法。
安装后首次 `open` 曾复用安装前的旧 PID；最终强制结束旧进程并确认新进程从
`/Applications/HorseMD.app/Contents/MacOS/HorseMD` 启动，`app.asar` 同时包含
`0.13.31` 与本轮 `nestedMarkerPrefixLength` 标记，不能仅凭 Info.plist 判断运行版本。
