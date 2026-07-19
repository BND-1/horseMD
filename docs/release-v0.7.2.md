# HorseMD v0.7.2

本版本从 v0.6.5 继续完善桌面端写作、设置、同步和导出体验，重点新增安全的云同步文件夹、自定义快捷键、大纲拖拽重排和编辑器样式定制，同时修复 Windows 富文本滚动卡顿、长表格 PDF 打印不完整、启动打开文件偶发丢失等问题。

## 新功能

### 云同步文件夹

新增桌面端“设置 > 云同步”，可以把明确选择的本地文件夹连接到 WebDAV 或 S3 兼容存储。

- 先选择一个本地已有文件夹，再绑定云端连接，避免误把全盘或普通工作区自动上传。
- 支持 WebDAV 和 S3 兼容存储连接，并在保存前测试列举、上传和删除权限。
- 每个同步文件夹会保留在原路径，只添加隐藏的 `.horsemd/workspace.json` 身份标记。
- 支持首次上传本地到云端、从云端下载到本地、加入已有云端工作区和日常双向同步。
- 同步前展示预览清单；冲突会保留双方内容，不静默覆盖。
- 设置页新增提示，说明“云同步要先从一个本地已有文件夹开始”。

### 自定义键盘快捷键

设置中心新增“键盘”页，可以录制、清除和恢复默认快捷键。

- 支持应用菜单快捷键和常用编辑器快捷键。
- 快捷键被其他功能占用时，会显示冲突提示；当前行会标红，并明确说明“本次快捷键未保存”。
- 自定义结果保存到本机 `horsemd.keybindings.v1`，重启后继续生效。
- Electron 菜单和渲染层命令使用同一套有效快捷键。

### 大纲拖拽重排

桌面端大纲支持拖拽标题重排。

- 拖动标题旁的手柄即可移动该标题及其所有子标题和正文内容。
- 只允许在同级标题之间移动，避免把子章节意外塞进另一个父章节。
- 未触碰的 Markdown 源码尽量保持原样。

### 编辑器样式定制

设置中心拆分为更清晰的 General、Editor、Appearance、Files & Images、Keyboard、About 等模块，并新增编辑器样式能力。

- 源码模式可以跟随文档字号，并单独设置更适合阅读的偏移量。
- 新增 Custom CSS 编辑区，可在当前主题之上做轻量文档样式调整。
- 字体、行高、段落间距、源码字号和自定义 CSS 统一放到 Editor 设置中。
- 设置页预览使用和真实编辑器一致的文档选择器，调整结果更接近实际效果。

## 改进

### Markdown 源码保真

富文本编辑和智能粘贴现在更少改写未触碰的 Markdown。

- 保留空行、紧凑列表、单个波浪线等原始写法。
- 粘贴 Markdown 时尽量保留剪贴板原始源码拼写。
- 图片 alt 文本不再在切换视图或保存后被错误改成内部缩放比例。

### LaTeX 与列表体验

- 行内公式默认启用保护删除：第一次 Backspace/Delete 选中公式，第二次才删除。
- 公式编辑器新增 Clear 操作；偏好快速删除的用户仍可在设置中切换。
- 列表、嵌套列表和任务列表的行高、段落间距会跟随编辑器设置。
- 大纲、任务列表和富文本交互做了多处稳定性整理。

### PDF 导出

- 段落公式 `$$...$$` 在 PDF 中导出为渲染后的 MathML 公式，不再打印 LaTeX 源码或编辑器控件。
- 长表格会按页面宽度排版，长单词和连续文本自动折行，跨页时不再只打印表格的一部分。

## 修复

### Windows 富文本滚动卡顿

修复 Windows 上部分中等体量、中文内容较多的 Markdown 文件浏览和滑动卡顿的问题，例如 `WhatIf因果推断详细笔记.md`。

这次排查到的根因不是“文件太大”，而是之前的 rich `content-visibility` 策略只按字符数启用。目标文件字符数不少，但实际块数量不够大，Windows Chromium 在滚动时频繁把估算高度替换为真实高度，反而产生布局抖动和滚动开销。同时，KaTeX 公式的 MathML DOM 在 Windows 富文本滚动中也会增加额外布局成本。

现在改为按文档规模和块数量综合判断，仅真正巨大的富文本文档启用 rich `content-visibility`；Windows 富文本编辑器中也减少冗余 KaTeX MathML DOM。目标文件已验证保持富文本打开，且不启用会导致卡顿的 rich content-visibility 类。

### 启动打开文件更可靠

修复首次启动时通过双击或命令行打开 Markdown 文件，偶发被欢迎页或恢复会话盖住的问题。渲染层现在会先注册打开路径监听，再通知主进程派发启动参数。

### 其他修复

- 外部程序修改已打开文件时，干净标签会自动重载；有本地未保存编辑时保留用户内容并显示清晰警告。
- 行内公式删除更安全，不再容易误删。
- PDF 导出公式、长表格和打印样式的回归测试已补齐。
- Windows 下部分 Electron UI 测试退出时的 Chromium profile 占用误报已规避，减少假失败。
- Guide 检查脚本兼容 Windows CRLF frontmatter，不再把页面误判为缺少 frontmatter。

## 下载

| 平台 | 安装文件 | 架构 |
|---|---|---|
| macOS | `HorseMD-0.7.2-arm64.dmg` | Apple Silicon |
| macOS | `HorseMD-0.7.2.dmg` | Intel x64 |
| Windows | `HorseMD-Setup-0.7.2.exe` | x64 |
| Linux | `horse_0.7.2_amd64.deb` | x64 |

> 桌面安装包暂未签名。Windows 出现 SmartScreen 提示时，选择“更多信息 -> 仍要运行”；macOS 可以右键应用选择“打开”，必要时执行：
>
> ```bash
> xattr -dr com.apple.quarantine /Applications/HorseMD.app
> ```

## 验证

本轮已完成：

- `node scripts/test-pdf-document.mjs`
- `node scripts/test-rich-cv-gating.mjs`
- `npm run test:pdf-table-ui`
- `npm run test:sync-workspaces-ui`
- `npm run test:pdf-latex-ui`
- `npm run test:shortcuts`
- `npm run build`
- `npm run build:mobile`
- `npm run guide:check`
- `npm run dist`
- 已安装 Windows 0.7.2 smoke：`G:\WhatIf因果推断详细笔记.md` 富文本打开、不开启卡顿相关策略；快捷键冲突提示和未保存行为通过。

## 关联 Issues

- [#17](https://github.com/BND-1/horseMD/issues/17) 滚轮滑动文本问题
- [#25](https://github.com/BND-1/horseMD/issues/25) 跳页问题
- [#36](https://github.com/BND-1/horseMD/issues/36) 打开文件后展示文件不是当前文件
- [#38](https://github.com/BND-1/horseMD/issues/38) 希望新增字体设置
- [#63](https://github.com/BND-1/horseMD/issues/63) 自定义快捷键相关建议
- [#74](https://github.com/BND-1/horseMD/issues/74) 行内 LaTeX 公式删除逻辑优化
- [#75](https://github.com/BND-1/horseMD/issues/75) 字体设置显示完整字体名
- [#77](https://github.com/BND-1/horseMD/issues/77) 尽量不要未经用户同意自动修改文档内容
- [#78](https://github.com/BND-1/horseMD/issues/78) 源码模式字号调整
- [#79](https://github.com/BND-1/horseMD/issues/79) 有序列表和无序列表间距调整
- [#81](https://github.com/BND-1/horseMD/issues/81) 开放 Custom CSS 主题定制
- [#82](https://github.com/BND-1/horseMD/issues/82) 拖动标题同时移动下属内容
- [#84](https://github.com/BND-1/horseMD/issues/84) 保存文件时不再替换图片说明文本

Full changelog: [v0.6.5...v0.7.2](https://github.com/BND-1/horseMD/compare/v0.6.5...v0.7.2)
