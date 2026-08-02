---
title: 使用 Pandoc 导出
description: 安装并连接 Pandoc，将 Markdown 导出为 Word、LaTeX、EPUB 等格式。
---

# 使用 Pandoc 导出

<span class="version-badge">适用于 HorseMD v0.12.51</span>

HorseMD 不会在安装包中捆绑 Pandoc。你可以自行安装官方 Pandoc，然后由 HorseMD 调用本机工具完成格式转换。

## 安装和检测

1. 打开“设置 → 文件与图片 → 文档转换工具”。
2. 点击“安装指南”，按照 [Pandoc 官方安装说明](https://pandoc.org/installing.html) 完成安装。
3. 回到 HorseMD，点击“重新检测”。
4. 若系统已经安装但没有自动找到，点击“选择程序”，手动选择 `pandoc` 或 `pandoc.exe`。

检测成功后，设置页会显示 Pandoc 版本和实际程序路径。HorseMD 只保存该路径，不保存文档内容或上传到网络。

## 导出格式

在“文件 → 使用 Pandoc 导出”中选择：

- Word（`.docx`）
- EPUB（`.epub`）
- LaTeX（`.tex`）
- OpenDocument（`.odt`）
- Rich Text（`.rtf`）
- 纯文本（`.txt`）

也可以按 `Ctrl/Cmd+P` 打开命令面板并搜索对应格式。导出使用当前编辑状态；不必为了导出而先保存 Markdown。

还可以右键当前文档标签或工作区中的 Markdown 文件，打开“导出”子菜单，直接选择 Word、EPUB、LaTeX、OpenDocument、富文本或纯文本。子菜单靠近窗口边缘时会自动换向，支持方向键和 Enter 操作。

若当前文件已经保存在磁盘上，HorseMD 会把文件所在目录作为 Pandoc 的资源目录，使相对图片路径能够按原文档位置解析。转换完成后会在文件管理器中显示输出文件。

保存对话框同样默认打开当前 Markdown 所在文件夹，并按文件记住用户另选的目录；不同文档之间不会串用保存位置。

## 使用边界

Pandoc 的输出规则和 HorseMD 富文本预览并不完全相同。自定义 CSS、部分 HTML、Mermaid 和特定 Markdown 扩展是否能进入 Word 或 LaTeX，取决于 Pandoc 及目标格式；需要可视化且与 HorseMD 预览接近的结果时，优先使用 HTML 或 PDF 导出。

某些资源转换还需要 Pandoc 之外的辅助程序。例如把 SVG 图片写入部分 Word 文档时，Pandoc 可能提示缺少 `rsvg-convert`；这时需要按 Pandoc 的错误信息安装对应工具，或先把图片转换为 PNG。HorseMD 会保留完整错误信息，不会把有警告的转换伪装成完全一致的视觉导出。

HorseMD 只允许预设的目标格式，并以独立进程、固定参数和两分钟超时运行 Pandoc，不通过 shell 拼接命令。错误信息来自 Pandoc 本身，可据此检查语法、图片路径或安装环境。

::: info 移动端
Pandoc 是桌面命令行工具，因此该导出入口不在 iOS 和 Android 中显示。
:::
