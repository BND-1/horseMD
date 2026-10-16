# HorseMD v0.12.46

本版本集中解决一个基础问题：**HorseMD 不应因为用户在富文本中做了一处修改，就擅自格式化整篇 Markdown。** 同时完善逐字输入、模式切换、表格、PDF 输出、设置结构和系统主题。

## 新功能

### 原文保真的富文本编辑

HorseMD 现在同时维护原始 Markdown 与编辑器结构，只把真实修改局部写回源文件。

- 未触碰区域的空行、列表符号、紧凑/松散列表、Setext 标题、引用链接、HTML、实体、BOM、CRLF 与混合换行保持原样。
- 富文本中新建段落会写成合法的 Markdown 段落边界，不再合并到上一段，也不会泄漏编辑器内部的 `<br />` 占位。
- 逐字输入 `-`、`*`、`+` 创建列表后保留实际输入的标记；保存和切换模式不会统一改成 `*`。
- 源码中的普通单换行默认按原位置显示，也可在“设置 → 编辑器”关闭；该选项只改变显示，不改写文件。

### 更完整的外观与启动设置

- [#95](https://github.com/BND-1/horseMD/issues/95)：可跟随系统明暗模式，并分别指定日间、夜间使用的 HorseMD 主题。
- [#96](https://github.com/BND-1/horseMD/issues/96)：新增标题间距，可在设置页或底部“排版”面板调整。
- [#98](https://github.com/BND-1/horseMD/issues/98)：新增“恢复上次打开的文档”开关；关闭后仍会正常响应文件关联、Finder/资源管理器和命令行显式打开。
- 正文右键“转换为”可直接把当前段落变成有序列表、无序列表或待办清单。

### PDF 正文字号

PDF 导出中心新增 8–24pt 正文字号。标题、表格、代码和间距随正文等比变化；“整体缩放”继续控制整页文字、图片、图表和留白。

## 改进

- 未手动调整的表格会根据表头和单元格内容自动分配列宽；短列保持紧凑，长说明列获得更多空间。手动拖动后才切换到固定列宽。
- “外观”现在集中主题、字体、排版、自定义 CSS、表格和源码视觉；“编辑器”只保留校对、单换行显示、选区工具栏等编辑行为。
- 行内代码支持按人类输入节奏逐字键入，左右方向键可自然退出代码边界。
- 源码与富文本切换的 raw offset 映射覆盖硬换行、行内图片、表格、列表、代码块和大文档；用户开始输入后，延迟布局任务不会再把光标拉回旧位置。

## 修复

- [#93](https://github.com/BND-1/horseMD/issues/93)：修复逐字输入 `` `内容` `` 不渲染、右反引号后无法退出以及普通多反引号被吞字符。
- [#97](https://github.com/BND-1/horseMD/issues/97)：修复 PDF 快速修改页眉、页脚、页码等设置时的预览竞态，以及无图片文档出现资源失败误报。
- [#98](https://github.com/BND-1/horseMD/issues/98)：修复代码块复制提示成功但剪贴板为空；富文本复制的纯文本通道保留成对 Markdown 标记；撤销继续使用编辑器原生历史。
- [#101](https://github.com/BND-1/horseMD/issues/101)：修复 PDF 中本地/网络图片、中文或空格相对路径加载失败，以及表格行高不随字号变化。
- 修复 PDF 中 Mermaid 退化为源码、显示公式和表格与编辑器布局不一致的问题；打印使用物化后的 SVG/MathML 和编辑器实测列宽。
- 修复任务清单勾选只更新界面，保存重开后状态丢失的问题。
- 修复粘贴一段 Mermaid 却生成两个代码块和两份预览的问题；节点文字包含 `flowchart TD`、`sequenceDiagram` 等关键词也不会被误拆。
- 修复大文档分块加载、表格局部编辑、附件插入和源码 CRLF 编辑可能覆盖或规范化整篇文件的问题。
- 修复 macOS 关闭最后一个窗口后，再从 Dock、Finder 或文件关联启动没有新窗口的问题。

## 安装

| 平台 | 安装文件 | 架构 |
| --- | --- | --- |
| macOS | `HorseMD-0.12.46-arm64.dmg` | Apple Silicon |
| macOS | `HorseMD-0.12.46.dmg` | Intel x64 |
| Windows | `HorseMD-Setup-0.12.46.exe` | x64 |
| Linux | `horse_0.12.46_amd64.deb` | x64 |

本次桌面安装包暂未签名。Windows 出现 SmartScreen 时选择“更多信息 → 仍要运行”；macOS 可右键应用选择“打开”，必要时执行：

```bash
xattr -cr /Applications/HorseMD.app
```

Android 当前仍使用 `0.12.10` 安装包；本次 `0.12.46` 发布不提供一个内容不一致的占位 APK。

## 验证

- `npm run build`
- `npm run build:mobile`
- `npm run guide:check`
- `npm run test:ui-regression`：`7 sessions + 25 standalone`
- `npm run test:markdown-preservation`
- `npm run test:issue-77-ui`
- `npm run test:new-source-fidelity-ui`
- `npm run test:mermaid-paste-ui`：隔离 profile 连续 `10/10`
- `npm run test:pdf-churn-ui`
- 已安装 macOS `0.12.46` 应用复跑 Mermaid 粘贴专项

## 关联 Issues

- [#93 行内代码无法渲染](https://github.com/BND-1/horseMD/issues/93)
- [#95 自动切换明/暗主题](https://github.com/BND-1/horseMD/issues/95)
- [#96 增加标题间距的设置项](https://github.com/BND-1/horseMD/issues/96)
- [#97 导出 PDF bug](https://github.com/BND-1/horseMD/issues/97)
- [#98 代码块复制、撤销与会话恢复设置](https://github.com/BND-1/horseMD/issues/98)
- [#101 导出 PDF 图片与表格密度](https://github.com/BND-1/horseMD/issues/101)

完整变更见 [CHANGELOG.md](../CHANGELOG.md)。

> 已知回归：0.12.46 将块级 Markdown serializer 错误用于 `text/plain`，会使外部纯文本粘贴增加段落空行或列表编号。该问题已在 0.12.47 改为独立的纯文本、HTML、Markdown 三通道契约。
