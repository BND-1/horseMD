# HorseMD v0.5.5 Release Notes Draft

## ✨ 新功能

- **每个标签独立记住源码 / 富文本模式**（#42）  
  A 标签切到源码后，切去 B 标签不会把 B 也切成源码；再切回 A 时仍保持源码模式。源码 textarea 的未保存编辑也会跟随标签保留。

- **可分别切换文档字体与代码字体**（#38）  
  设置 → 排版 里新增文档字体和代码字体配置。正文、标题可以使用更适合阅读的字体，代码块可以单独切到等宽字体或 Nerd Font；字体列表支持搜索、预览和恢复默认。

- **插入附件**（#49）  
  桌面端新增「文件 → 插入附件…」和命令面板入口，可选择 PDF、DOCX、ZIP、音频等普通文件。HorseMD 会把文件复制到当前 Markdown 同级的 `assets/` 文件夹，并在光标处插入普通 Markdown 链接，例如：

  ```md
  [report.pdf](<assets/report.pdf>)
  ```

- **源码可读的审阅标记**  
  Review / CriticMarkup 标记继续保留在 Markdown 源码中，方便保存到磁盘或复制给外部 AI；同时提供 Accept All / Reject All 等清理命令。

## 改进

- **大纲折叠更接近文件树体验**  
  大纲顶部的展开/折叠从两个按钮改成一个状态切换按钮。即使当前正在阅读某个子标题，也可以直接折叠它的父级；父级会显示 contained-active 提示，不再出现点击箭头无反馈的情况。

- **源码 / 富文本切换更稳**  
  源码模式下富文本编辑器保持挂载，只在源码真正编辑过时同步回富文本，减少大文档重复解析和图片重新加载带来的漂移。

## 🐛 修复

- **修复 `/` 命令菜单被窗口边界遮挡**  
  在文档顶部、底部或小窗口中输入 `/` 时，菜单会自动限制在可见编辑区内；空间不足时菜单列表会收缩并保持可滚动。

- **修复源码模式切换标签后内容丢失/同步不准**  
  源码 textarea 重挂时会从 live buffer 恢复内容；只有真正编辑过的源码 buffer 才会同步回富文本，避免单纯切换视图触发未保存状态。

## 验证

- `npm run build`
- `npm run build:mobile`
- `node scripts/test-strike-guard.mjs`
- `node scripts/test-substitution-headless.mjs`
- CDP 回归：顶部、底部、小窗口下输入 `/`，菜单均保持在编辑区内。

## 📦 下载

| 平台 | 文件 | 架构 |
|---|---|---|
| macOS（Apple Silicon） | `HorseMD-0.5.5-arm64.dmg` | arm64 |
| macOS（Intel） | `HorseMD-0.5.5.dmg` | x64 |
| Windows | `HorseMD-Setup-0.5.5.exe` | x64 |

> ⚠️ 构建未签名：Windows SmartScreen 选「更多信息 → 仍要运行」；macOS 右键 → 打开（或 `xattr -dr com.apple.quarantine /Applications/HorseMD.app`）；安卓安装 APK 允许「未知来源」。

---

**Full changelog**: https://github.com/BND-1/horseMD/compare/v0.5.2...v0.5.5
