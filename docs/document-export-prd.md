# HorseMD 文档导出 PRD

## 1. 目标

让用户按用途选择导出方式，而不是把所有格式塞进 PDF：

| 目标 | 入口 | 数据来源 |
| --- | --- | --- |
| 精确分页、打印、书签 | PDF Studio | 渲染后的结构化 HTML |
| 浏览器阅读、网页分享 | HTML Studio | 渲染后的结构化 HTML |
| Word、EPUB、LaTeX 等交换格式 | Pandoc | 未被 HorseMD 改写的原始 Markdown |

“导出”不得改变当前文档、dirty 状态或磁盘源文件。

## 2. Pandoc 导出

### 2.1 支持格式

第一版支持 Word `.docx`、EPUB `.epub`、LaTeX `.tex`、OpenDocument `.odt`、Rich Text `.rtf` 和 Plain Text `.txt`。

### 2.2 用户流程

1. 用户在“文件 → 通过 Pandoc 导出”选择格式。
2. HorseMD 检测 Pandoc；已安装则显示系统保存窗口。
3. 未安装时显示原因和官方安装入口，并在“设置 → 文件与图片 → 文档工具”提供重新检测与选择程序。
4. 导出期间显示进行中状态；成功后在文件管理器中定位结果；取消保存不报错。

### 2.3 安装引导

- macOS：`brew install pandoc`
- Windows：`winget install --source winget --exact --id JohnMacFarlane.Pandoc`
- Debian/Ubuntu：`sudo apt install pandoc`
- 统一提供 Pandoc 官方安装页，不在 HorseMD 内自动执行安装命令。

### 2.4 限制说明

- Pandoc 输出样式由 Pandoc 和目标格式决定，不承诺与 HorseMD 富文本或 PDF 逐像素一致。
- 自定义 CSS 不会自动转换成 Word/LaTeX 样式。
- 远程图片能否进入目标文件取决于 Pandoc 版本和网络；本地相对图片按 Markdown 文件所在目录解析。

## 3. HTML Studio

### 3.1 第一版设置

- 样式：简洁、纸张、阅读、夜间。
- 正文宽度：紧凑、标准、宽、铺满。
- 正文字号：12–24 px。
- 行距：1.4–2.4。
- 显示文档标题。
- 正文前添加目录，目录深度 H1–H6。
- 单文件导出，图片尽量内嵌。

### 3.2 预览合同

- 右侧预览使用主进程生成的最终 HTML，不在保存时重新生成另一份。
- 设置快速变化时取消或丢弃旧任务，只展示最后一次设置。
- 预览使用 sandbox iframe；导出 HTML 默认无脚本，并带收紧的 CSP。
- 图片、公式和图表失败时给出具体数量，不把无图片文档误报为资源未完成。

### 3.3 内容一致性

导出必须保留标题、段落、列表、任务列表、引用、链接、图片、表格、普通代码块、行内/段落公式和 Mermaid。编辑器控件、悬浮工具、拖拽柄、评论卡片和源码编辑器 UI 不得进入结果。

## 4. 非目标

- 第一版不支持执行导出 HTML 中的用户脚本。
- 第一版不提供站点生成、批量文档导航或发布托管。
- 第一版不把 Pandoc 打进安装包，也不后台下载安装。
- 第一版不提供 Pandoc reference-doc、模板或任意额外参数输入，避免形成命令注入面；后续以结构化选项逐项增加。

## 5. 发布验收

- Windows、macOS：Pandoc 缺失和已安装两条流程。
- 至少以 DOCX、LaTeX 各导出一次，验证中文、表格、图片、代码和公式。
- HTML 四个主题、四个宽度和目录开关均实时预览；最终文件与预览对应同一 token。
- 源码模式有未保存编辑时，Pandoc 收到当前 textarea 内容；富文本模式收到 `flushMarkdown()` 的原文保真结果。
- 导出前后 tab 内容、savedContent、dirty 标记和光标均不变化。

