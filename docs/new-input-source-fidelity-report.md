# 0.12.45 新输入 Markdown 源码保真问题报告

> 日期：2026-07-30  
> 范围：富文本中逐字创建无序列表、连续空段落、列表新增与转换

## 用户症状

1. 在富文本中手打 `- 第一项`，切到源码后变成 `* 第一项`。
2. 连续按 Enter 留出空行，再输入下一段，源码可能出现独立 `<br />`。
3. 修列表边界的早期方案曾使相邻任务列表、普通列表在转换时被复制或粘连。

这些都属于真实源码变化，不是富文本显示差异。

## 根因

### 列表 marker 在输入规则中丢失

用户键入 `- `、`* ` 或 `+ ` 后，Milkdown 输入规则会把当前段落转换为
ProseMirror `bullet_list`。该节点只表达“无序列表”，不保存触发符号。
Crepe serializer 默认输出 `*`，因此仅比较转换后的文档无法恢复用户输入。

原有保护只会从“文件中已经存在的列表”继承 marker，没有覆盖从空段落新建
列表的第一笔事务。这就是旧测试通过、真人手打仍失败的原因。

### 空 paragraph 使用内部 `<br />`

Crepe 会把没有正文的 paragraph 暂时序列化为独立 `<br />` 块。旧代码分别
处理了末尾空块和中间空块，但连续回车的直接插入分支没有统一过滤占位，
因此它可能进入 raw source。表格单元格内的 `<br>` 是合法 GFM 换行，不能
用全文替换删除。

### Markdown 文本无法区分相邻同类型列表节点

松散列表项目之间允许空行。两个相邻的无序列表在 canonical Markdown 中也
可能呈现为同一个列表块。列表转换若直接使用这个扩大后的块写回，会把相邻
任务列表一起复制到当前列表位置。反过来，若所有空行都视为边界，又会把一个
正常松散列表错误拆开，新增项无法继承 marker。

## 修复

1. `beforeinput` 在空段落 marker 后的空格进入 ProseMirror 前记录
   `-`、`*` 或 `+`。
2. canonical 更新后按列表结构序号恢复刚创建层级的 marker；该意图只在光标
   仍位于无序列表时短期有效，不修改全文默认符号。
3. 新文档和中间/末尾块写回统一移除新生成的独立 `<br />` 行；已有源码和
   表格单元格中的真实 `<br>` 保持不变。
4. 列表块允许同一顶层类型跨空行，顶层有序/无序类型变化会截断。
5. 列表转换后 canonical 合并相邻同类型块时，根据转换前项目文本在合并块中
   找到对应子区间，只替换用户操作的列表。匹配失败时返回 `null`，交给保守
   局部策略处理，禁止扩大范围。

## 失败方案

- 把 serializer 默认 marker 改为 `-`：只能让 `-` 看似正常，仍会改写手打
  `*` 和 `+`，不符合原文保真。
- 切换源码后全局把 `*` 替换成 `-`：会修改用户原有列表、代码和普通文本。
- 所有空行都断开列表：会破坏合法松散列表及新增项目。
- 所有空行都连接列表：会让列表转换覆盖相邻但独立的列表。
- 全文删除 `<br>`：会破坏表格单元格真实换行和用户原有 HTML。

## 自动化证据

```bash
npm run test:markdown-preservation
npm run test:new-source-fidelity-ui
npm run test:issue-77-ui
npm run test:list-conversion-ui
npm run test:paragraph-source-ui
npm run test:soft-break-ui
npm run test:source-fidelity-ui
npm run test:large-source-fidelity-ui
npm run test:mode-switch-raw-offset-ui
```

`test:new-source-fidelity-ui` 使用后台 Electron，通过 committed text 逐字符输入
三种 marker 和中文正文，Enter 使用原始键事件；每个场景执行三次源码检查、
真实保存并读取磁盘。批量 `insertText` 只适用于粘贴语义，不能替代本测试。

## 后续约束

- 新增 Markdown 输入规则时，先确认 ProseMirror schema 是否保留用户原始
  delimiter；不保留时必须在规则触发前记录意图。
- 列表回写必须同时测试紧凑/松散、嵌套、任务、有序、相邻同类型和相邻不同
  类型，不能只测单个列表。
- 空 paragraph 测试必须包含快速输入、停顿输入、连续 Enter、立即切源码、
  保存和全新进程重开。
