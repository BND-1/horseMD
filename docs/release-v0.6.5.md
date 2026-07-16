# HorseMD v0.6.5

本版本重点完善 PDF 导出、图片与 Mermaid 预览、表格编辑、LaTeX 输入及网页内容粘贴体验，同时修复多项编辑器交互问题。

## ✨ 新功能

### 浏览器式 PDF 导出与预览（[#60](https://github.com/BND-1/horseMD/issues/60)、[#64](https://github.com/BND-1/horseMD/issues/64)）

新增独立的 PDF 导出工作台，可以在保存前预览最终 PDF：

- 支持 A4、A3、Letter 和自定义纸张尺寸
- 支持横向、纵向排版
- 支持普通、窄、宽和自定义页边距
- 支持内容缩放、页码范围和标题分页规则
- 支持在正文前生成目录页，并设置目录标题层级
- 支持生成 PDF 书签大纲
- 支持文档标题、日期、页码、页眉和页脚
- 预览与最终保存使用同一份 PDF，避免导出结果与预览不一致
- 快速调整选项时自动取消过期任务，减少重复渲染和等待

### 图片与 Mermaid 精准预览

图片和 Mermaid 图表现在支持：

- 放大、缩小和实时缩放比例
- 适应窗口
- `1:1` 原始尺寸查看
- 保持原始宽高比

长条形或纵向图表不再被强制放进接近正方形的区域，减少大片空白和比例失真。

## 改进

### 更自然的文档末尾输入

在正文下方空白区域点击，可以直接创建或定位到最后一个空段落继续输入，不再必须先按回车。

### 更完整的微信公众号文章粘贴

从微信公众号复制文章到 HorseMD 时，现在会优先保留网页富文本结构：

- 保留标题层级、段落和列表
- 保留粗体、斜体等行内格式
- 保留微信懒加载图片
- 避免编号标题被误判为 Markdown 列表
- 避免多段内容被压缩成一整段文字

### 更安静的写作界面

移除光标旁边显示“正文、H1、H2”等层级的浮动胶囊，同时保留标题快捷键、右键段落菜单和其他块类型切换功能。

### 更自然的行内代码输入（[#58](https://github.com/BND-1/horseMD/issues/58)）

输入空反引号对后可以直接进入行内代码；点击行内代码末尾时也可以继续追加内容，不会把后续普通文字错误带入代码格式。

## 修复

### 表格显示与编辑

- 宽表格可以在编辑区域内横向滚动，不再撑开整个应用窗口
- 修复表格文字过多时列宽被过度压缩的问题
- 修复表格行、列悬浮按钮被边界遮挡的问题
- 修复添加行、添加列的加号按钮被裁切的问题
- 表格滚动后，行列菜单仍保持可见和可点击

### LaTeX 公式输入（[#57](https://github.com/BND-1/horseMD/issues/57)、[#68](https://github.com/BND-1/horseMD/issues/68)、[#69](https://github.com/BND-1/horseMD/issues/69)）

- 修复输入 `$$` 或使用 `/math` 后过早退出公式编辑的问题
- 修复在 `$…$` 中输入纯数字时不能正常生成行内公式的问题
- 修复重新编辑已有行内公式时预览不实时更新的问题
- 修复公式光标位置和确认行为不稳定的问题

### 编辑器与窗口

- 修复整个页面可以上下滑动并在底部出现空隙的问题
- 修复分屏时大纲没有跟随当前焦点编辑器的问题（[#66](https://github.com/BND-1/horseMD/issues/66)）
- 恢复 `Ctrl/Cmd+B` 标准加粗快捷键（[#67](https://github.com/BND-1/horseMD/issues/67)）
- 侧边栏快捷键调整为 `Ctrl/Cmd+Shift+B`
- 修复文件树底部右键菜单被窗口边界遮挡的问题（[#59](https://github.com/BND-1/horseMD/issues/59)）
- 修复富文本加载状态在多个标签之间相互影响的问题
- 修复图片预览关闭后临时拖动监听没有完整清理的问题
- PDF 导出增加进行中、失败和重试状态，避免重复提交

## 安装

| 平台 | 安装文件 | 架构 |
|---|---|---|
| macOS | `HorseMD-0.6.5-arm64.dmg` | Apple Silicon |
| macOS | `HorseMD-0.6.5.dmg` | Intel x64 |
| Windows | `HorseMD-Setup-0.6.5.exe` | x64 |
| Linux | `horse_0.6.5_amd64.deb` | x64 |
| Android | `HorseMD-0.6.5.apk` | Universal APK |

> 桌面安装包暂未签名。Windows 出现 SmartScreen 提示时，选择“更多信息 → 仍要运行”；macOS 可以右键应用选择“打开”，必要时执行：
>
> ```bash
> xattr -dr com.apple.quarantine /Applications/HorseMD.app
> ```

## 关联 Issues

[#57](https://github.com/BND-1/horseMD/issues/57) · [#58](https://github.com/BND-1/horseMD/issues/58) · [#59](https://github.com/BND-1/horseMD/issues/59) · [#60](https://github.com/BND-1/horseMD/issues/60) · [#64](https://github.com/BND-1/horseMD/issues/64) · [#66](https://github.com/BND-1/horseMD/issues/66) · [#67](https://github.com/BND-1/horseMD/issues/67) · [#68](https://github.com/BND-1/horseMD/issues/68) · [#69](https://github.com/BND-1/horseMD/issues/69)

---

Full changelog: [v0.6.0...v0.6.5](https://github.com/BND-1/horseMD/compare/v0.6.0...v0.6.5)
