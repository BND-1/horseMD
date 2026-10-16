# HorseMD、Typora、Obsidian 换行行为对照

> 测试日期：2026-07-30  
> 版本：HorseMD 0.12.47、Typora 0.11.18、Obsidian 1.12.7

## 测试方法

三款编辑器读取同一份 fixture，覆盖：

- 连续四行普通源码单换行。
- 空行分隔的标准 Markdown 段落。
- 两个尾随空格的显式硬换行。
- HTML `<br>`。
- 紧凑与松散的有序、无序列表。

HorseMD 使用已安装应用和隔离 profile，通过后台 CDP 读取 ProseMirror 节点及文字坐标。Typora 使用其安装包内同一套 `TypeMark/appsrc/main.js` 解析器，在隐藏 BrowserWindow 中调用 `File.reloadContent()`。Obsidian 使用隔离 vault 和后台 CDP 切到 Reading view。测试不操作系统键鼠。

## 结果

| 场景 | HorseMD | Typora | Obsidian |
| --- | --- | --- | --- |
| 普通单换行 | 1 个段落，4 条视觉行 | 1 个段落，4 条视觉行 | 1 个段落，4 条视觉行 |
| 标准段落 | 2 个段落 | 2 个段落 | 2 个段落 |
| 显式硬换行 | 同段换行 | 同段换行 | 同段换行 |
| 紧凑列表 | 保持列表结构 | 保持列表结构 | 保持列表结构 |
| 松散列表 | 保持列表结构 | 保持列表结构 | 保持列表结构 |

普通单换行的相邻文字 Y 坐标间隔分别约为 HorseMD 30.4px、Typora 20px、Obsidian 24px。这是当前主题字号和行高差异，不是段落结构差异。HorseMD 查看、切换源码和等待均未改变 fixture 字节。

## 保存语义

HorseMD 当前没有把每次输入实时写入原文件。对已安装 0.12.47 后台逐字输入一个字符并等待 1.8 秒：

- 文件字节保持不变。
- 界面出现未保存状态。
- 点击保存后，文件才写入该字符。

源码 textarea 的 400ms debounce 和应用会话草稿属于内存/恢复状态同步，不是源文件自动保存。Typora 的 macOS 版本使用系统 document autosave，这是产品保存策略差异，不能据此把 HorseMD 的 dirty/save 合同暗中改成实时写盘。

## 发现的问题

HorseMD 的普通源码单换行在 DOM 中是空格 span，通过 CSS `::after` 产生视觉换行。其结构和显示与 Typora、Obsidian 一致，但直接调用 `Selection.toString()` 会得到空格：

```text
调研单位... 调研时间... 参会人员...
```

Typora 的 softbreak 节点包含真实换行文本，Obsidian Reading view 使用 `<br>`，因此没有该复制差异。0.12.47 的复制修复只在剪贴板克隆中将 HorseMD inline softbreak 转换为 `<br>`，从而：

- `text/plain` 保持一个 `\n`。
- `text/html` 保持一个 `<br>`。
- `text/markdown` 保持原始单换行。
- ProseMirror 与磁盘源码完全不变。

## 结论

用户看到“源码与富文本不同”时，首先要区分：

1. **视觉单换行**：三款编辑器本次实测一致，均可在一个段落内按多行展示。
2. **主题排版**：行高、段距和字体不同，不代表 Markdown 结构不同。
3. **磁盘源码**：HorseMD 的显示偏好不修改文件，其他编辑器读取的是最后一次明确保存的源码。
4. **剪贴板**：视觉换行必须显式进入复制副本，这是本次对照发现并补齐的真实缺口。
