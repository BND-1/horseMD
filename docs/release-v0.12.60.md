# HorseMD v0.12.60

`0.12.60` 聚焦两件事：让文档导出更实用，以及让长文档的源码 / 富文本切换更可靠、更轻。

## 新功能

### HTML 导出与 Pandoc 文档转换

- 新增 **HTML 导出中心**：导出前可在四种阅读主题、内容宽度、字号、行高、文档标题和可点击目录之间选择，并实时预览最终独立 HTML。
- 新增 **Pandoc 文档转换**（[#94](https://github.com/BND-1/horseMD/issues/94)）：安装官方 Pandoc 后，可从文件菜单、命令面板或文件右键的“导出”子菜单导出 Word、EPUB、LaTeX、OpenDocument、RTF 和纯文本。
- PDF、HTML 和 Pandoc 的保存窗口默认定位到当前 Markdown 文件夹；若为某份文件另选过目录，HorseMD 会单独记住它，不会影响其他文件。

### PDF 导出更紧凑

PDF 导出中心新增“排版密度”：舒适、标准和紧凑。标准保持既有版式；紧凑会收紧正文、列表、引用、图片和公式间距，适合希望减少页数的报告或讲义（[#103](https://github.com/BND-1/horseMD/issues/103)）。

## 修复与改进

- **长文档模式切换（[#104](https://github.com/BND-1/horseMD/issues/104)）**：修复含行内公式时，富文本切源码的光标偶尔跳到无关段落；纯阅读状态切换不再为了不可见光标解析整篇文档，400KB+ 文档的切换准备时间显著降低，阅读视口不应回到顶部。
- **PDF 多图资源（[#102](https://github.com/BND-1/horseMD/issues/102)）**：修复导出包含 10 张以上图片的文档时，后续图片可能被错误判定为未加载的问题；图片占位符不会再发生前缀碰撞。
- **列表与原文保真**：富文本中手打 `-`、`*`、`+` 建立列表、列表类型转换和紧接着继续输入时，只会更新实际改变的列表层级；不会把未触碰的列表、段落空行或 marker 改写成编辑器默认格式。
- **导出安全性**：PDF / HTML 导出移除脚本、内嵌网页、对象、表单、事件处理器与 `javascript:` 地址；Pandoc 调用使用固定参数与无 shell 子进程。

## 安装

在 GitHub Release Assets 中按平台下载：

| 平台 | 安装包 |
| --- | --- |
| Windows | `HorseMD-Setup-0.12.60.exe` |
| macOS Apple Silicon | `HorseMD-0.12.60-arm64.dmg` |
| macOS Intel | `HorseMD-0.12.60.dmg` |
| Linux x64 | `horse_0.12.60_amd64.deb` |

本次桌面包未签名：Windows 遇到 SmartScreen 时选择“更多信息 → 仍要运行”；macOS 可在“应用程序”中按住 Control 点击 HorseMD 后选择“打开”。

## 验证

- `npm run test:document-export`
- `npm run test:source-map`
- `HORSEMD_RAW_OFFSET_TARGET=inline-math npm run test:mode-switch-raw-offset-ui`
- `npm run test:markdown-preservation`
- `npm run test:issues-105-106-ui`
- `npm run build`
- `npm run guide:check`

完整内部根因与真实长文档验证记录见 [Issue #104 长文档模式切换报告](./issue-104-long-document-mode-switch.md)。
