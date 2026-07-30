# 源码单换行显示问题报告

> 状态：0.12.36 已修复。更新时间：2026-07-30。

## 现象

下面的 Markdown 在 Typora、Obsidian 等编辑器中通常按两行阅读：

```md
调研单位：无锡康门德咨询有限公司、浙江海康威视
调研时间：2026 年 7 月 28 日
```

HorseMD 过去会在富文本中把它们挤到同一视觉行。切换源码可以看到换行仍然存在，所以这不是文件读取失败，也不是此前“Enter 新段落被错误合并”的同一个数据问题。

## 根因

Milkdown 的 CommonMark 插件会把段落内的普通源码换行解析为 `hardbreak` 节点，并标记 `data-is-inline="true"`。该节点：

- 在 ProseMirror 文档中占一个位置；
- 序列化时仍写回单个 `\n`；
- DOM 默认却是一个只含空格的 `<span>`。

因此，原始 Markdown 和编辑器数据模型都保留了换行，问题只发生在最终视觉层。若通过修改 parser、把它改成 `<br>`，或在保存时补两个空格来解决，会改变用户源码语义和 raw offset，反而破坏原文保真与光标映射。

## 行为合同

| 用户内容或操作 | 富文本显示 | Markdown 源码 |
| --- | --- | --- |
| 已有普通单换行 `第一行\n第二行` | 默认分两行显示 | 保持单个 `\n` |
| 按 Enter | 新建独立段落 | 段落间一个空白行 |
| 按 Shift+Enter | 同段硬换行 | 显式 Markdown 硬换行 |
| 关闭“保留源码单换行” | 按 CommonMark 合并为空格显示 | 源码仍不变 |
| 导出 PDF | 按打印文档自身规则 | 不受此显示偏好影响 |

这里必须区分“已有源码单换行的显示”和“用户按 Enter 创建新段落”。前者是视觉偏好，后者是编辑语义，不能为了模仿其他编辑器而混为同一条保存规则。

## 实现

- `settings.preserveSoftBreaks` 默认开启，设置入口为“设置 → 编辑器 → 编辑 → 保留源码单换行”。
- `applySoftBreakDisplay()` 只切换 `body.hm-preserve-soft-breaks`。
- CSS 为 `span[data-type="hardbreak"][data-is-inline="true"]` 追加视觉换行；不替换原节点、不把它变成 `<br>`，也不改变节点宽度。
- 显式硬换行仍由 Milkdown 原来的 `<br>` 节点负责。
- PDF 临时打印文档不带该应用级 class，因此没有被编辑器显示偏好暗中改写。

## 禁止的修法

1. 不要在加载时把普通 `\n` 改成两个空格加换行或 `<br>`。
2. 不要在保存时自动给每行之间插入空行。
3. 不要修改 `remarkLineBreak` 或 hardbreak serializer 来实现纯显示需求。
4. 不要把 Enter 改成普通单换行；这会让重新解析后的段落结构与用户写作结构不一致。
5. 不要用关键字重新定位换行附近的光标；继续使用 raw offset ↔ ProseMirror 映射。

## 验证

```bash
npm run test:soft-break-ui
npm run test:settings-ui
npm run test:paragraph-source-ui
npm run test:mode-switch-raw-offset-ui
npm run test:markdown-preservation
npm run test:source-map
```

`test:soft-break-ui` 使用真实 Electron 打开包含普通单换行和显式硬换行的文件，检查视觉坐标、节点类型、源码模式逐字符内容、富文本往返以及磁盘文件字节。其余测试分别保护设置接线、Enter 段落语义、双向光标位置和原文保真。
