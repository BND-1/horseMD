# HorseMD v0.12.10

本版本集中完善日常写作、长文档阅读、表格编辑、公式显示与 PDF 输出，并补齐设置、审阅和右键操作的可发现性。

## 新功能

### 可选的选区工具栏与紧凑右键菜单

桌面端“设置 > 编辑器 > 编辑”可关闭选中文字时的浮动工具栏。

- 关闭后，选中文字并右键仍能使用格式、审阅和转换操作。
- 右键一级菜单保持简短；“文字格式”“审阅标记”“转换为/列表”按悬停或键盘焦点展开子菜单。
- 子菜单靠近窗口右边缘时自动向左展开，保留原始精确选区。

### 同层级列表转换

富文本中的普通列表可在右键菜单中转换为有序列表、无序列表或待办清单。

- 只转换当前层级，不改变父级或子级列表。
- 待办清单可转换回有序或无序列表，并移除勾选状态。
- 转换后保留光标位置和合法 Markdown 结构。

### 宽表自动换行

“设置 > 编辑器”新增宽表自动换行偏好和效果预览。开启后长内容会在正文宽度内换行；关闭时保持可横向滚动的阅读表格。

## 改进

- 自定义 CSS 支持多个具名片段，可独立启用、排序、重命名和删除；设置预览补全常见 Markdown 元素。
- 右侧悬浮章节导航支持平滑跳转、当前章节跟随和长标题截断；点击后移出即可自动收起。
- 表格根据内容保持自然宽度，表体与表头有更清晰区分；列边界长按后可实时调整列宽，宽表滚至最右侧也不会跳回开头。
- 块公式与上下正文的间距更紧凑；带 `\\tag{...}` 的公式为编号预留空间，正常宽度不再显示多余滚动控件。
- 移动端提供只读模式，阅读、选择和复制不受影响，同时避免滚动时误编辑。

## 修复

- 修复正文 `---` 分隔线后带冒号的 Q&A 标题，例如 `Q3:`、`Q4:`，被误解析成 YAML 卡片的问题。YAML front matter 现在只在标准文件头位置识别。
- 修复连续输入反引号可能吞掉已有字符的问题，并保持行内代码正常进入、退出。
- 修复反复转换列表类型后富文本标记显示与源码不同步的问题。
- 修复 PDF 将普通 C++、JavaScript 等 fenced code block 误当成公式渲染的问题。
- 修复长文档滚动到代码块附近的高度估算跳动，以及作者内联 HTML 误触发块拖拽柄的问题。
- 修复显示公式编号重叠、无需滚动的公式显示滚动控件、无图片 PDF 出现资源未加载误报等问题。

## 安装

发布将提供以下桌面安装包：

| 平台 | 安装文件 | 架构 |
| --- | --- | --- |
| macOS | `HorseMD-0.12.10-arm64.dmg` | Apple Silicon |
| macOS | `HorseMD-0.12.10.dmg` | Intel x64 |
| Windows | `HorseMD-Setup-0.12.10.exe` | x64 |
| Linux | `horse_0.12.10_amd64.deb` | x64 |

安装包暂未签名。Windows 出现 SmartScreen 提示时选择“更多信息 -> 仍要运行”；macOS 可右键应用选择“打开”，必要时执行：

```bash
xattr -dr com.apple.quarantine /Applications/HorseMD.app
```

## 验证

- `npm run build`
- `npm run build:mobile`
- `npm run guide:check`
- `npm run test:frontmatter`
- `npm run test:frontmatter-ui`
- `npm run test:selection-toolbar-ui`
- `npm run test:list-conversion-ui`
- 原始 UDP 文档的真实 Electron 验收：Q3/Q4 保持标题，未出现 YAML 卡片。

## 关联 Issues

- [#62 Windows 命令面板悬停闪屏](https://github.com/BND-1/horseMD/issues/62)
- [#63 标题显示与交互建议](https://github.com/BND-1/horseMD/issues/63)
- [#74 行内 LaTeX 删除逻辑](https://github.com/BND-1/horseMD/issues/74)
- [#75 字体设置显示完整字体名](https://github.com/BND-1/horseMD/issues/75)
- [#78 源码模式字体与排版](https://github.com/BND-1/horseMD/issues/78)
- [#79 列表间距与排版](https://github.com/BND-1/horseMD/issues/79)
- [#80 代码块上下留白](https://github.com/BND-1/horseMD/issues/80)
- [#81 自定义 CSS](https://github.com/BND-1/horseMD/issues/81)
- [#82 大纲章节拖动重排](https://github.com/BND-1/horseMD/issues/82)
- [#84 保存时图片说明文本保留](https://github.com/BND-1/horseMD/issues/84)
- [#86 表格编辑、保存与宽表格交互](https://github.com/BND-1/horseMD/issues/86)
- [#91 PDF 导出中的普通代码块误渲染](https://github.com/BND-1/horseMD/issues/91)，本版本已覆盖该修复项，等待更多实际文档反馈。

完整变更见 [CHANGELOG.md](../CHANGELOG.md)。
