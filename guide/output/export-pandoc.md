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

建议使用 Pandoc 2.11 或更新版本。更早的版本（例如 Ubuntu 22.04 自带的 2.9）也能导出，但无法识别 `$…$` 和 `$$…$$` 公式，公式会按原文写入文档；这时设置页和导出结果都会提示升级。

## 导出格式

在“文件 → 使用 Pandoc 导出”中选择：

- Word（`.docx`）
- EPUB（`.epub`）
- LaTeX（`.tex`）
- OpenDocument（`.odt`）
- Rich Text（`.rtf`）
- MediaWiki（`.wiki`，维基百科等 MediaWiki 站点使用的 wiki 语法）
- 纯文本（`.txt`）

也可以按 `Ctrl/Cmd+P` 打开命令面板并搜索对应格式。导出使用当前编辑状态；不必为了导出而先保存 Markdown。

还可以右键当前文档标签或工作区中的 Markdown 文件，打开“导出”子菜单，直接选择 Word、EPUB、LaTeX、OpenDocument、富文本或纯文本。子菜单靠近窗口边缘时会自动换向，支持方向键和 Enter 操作。

若当前文件已经保存在磁盘上，HorseMD 会把文件所在目录作为 Pandoc 的资源目录，使相对图片路径能够按原文档位置解析。转换完成后会弹出“导出完成”提示，显示文件名和所在文件夹：点“打开文件”（或直接按 Enter）用系统默认程序打开，点“在文件夹中显示”在文件管理器中定位它，点“关闭”或按 Esc 什么都不打开。如果电脑上没有能打开这种格式的程序，提示框会说明原因，可以改用“在文件夹中显示”。

保存对话框同样默认打开当前 Markdown 所在文件夹，并按文件记住用户另选的目录；不同文档之间不会串用保存位置。

## 使用边界

导出 Word、OpenDocument、EPUB、RTF 和 LaTeX 时，Mermaid 图表、```` ```svg ```` 代码块、单独成段的 `<svg>` 和本地 `.svg` 图片会先由 HorseMD 画成清晰的 PNG（2 倍分辨率，显示尺寸与原图一致），再交给 Pandoc，所以这些格式里看到的是图，不是源码，也不需要另外安装 `rsvg-convert`。Word、OpenDocument、EPUB、RTF 的图片直接嵌入文件；LaTeX 的图片保存在 `.tex` 旁边的 `<文件名>-figures` 文件夹里。语法有误、画不出来的图表保留源码。MediaWiki 和纯文本是文字格式，保持原文。源文档本身不会被修改。

Pandoc 的输出规则和 HorseMD 富文本预览并不完全相同：自定义 CSS、部分 HTML 和特定 Markdown 扩展不一定能进入目标格式；RTF 不支持公式（按原文写入）；LaTeX 文件需要用 XeLaTeX 并设置中文字体才能编译中文。需要与 HorseMD 预览完全一致的版面时，优先使用 HTML 或 PDF 导出。HorseMD 会保留 Pandoc 的完整提示信息，不会把有警告的转换伪装成完全一致的导出。

HorseMD 只允许预设的目标格式，并以独立进程、固定参数和两分钟超时运行 Pandoc，不通过 shell 拼接命令。错误信息来自 Pandoc 本身，可据此检查语法、图片路径或安装环境。

::: info 移动端
Pandoc 是桌面命令行工具，因此该导出入口不在 iOS 和 Android 中显示。
:::
