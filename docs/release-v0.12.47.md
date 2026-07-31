# HorseMD v0.12.47

`0.12.47` 是针对 `0.12.46` 的紧急修复版本，重点恢复跨应用复制的可靠性，并补齐设置页排版宽度的即时反馈。

## 修复

- **外部纯文本复制恢复正常**
  - 从正文复制到记事本、终端或普通文本框，不再凭空增加段落空行。
  - 只复制有序列表中的文字，不再自动带出 `1. `。
  - 富文本中显示的普通源码单换行，在外部纯文本和 HTML 中保持为单个换行，不会合并成一行。
  - HorseMD 内部复制粘贴仍通过独立 Markdown 通道保留列表、加粗和行内代码结构。

- **排版宽度预览即时生效**
  - 修复“设置 → 外观 → 排版”中编辑区宽度看起来没有反应的问题。
  - 窄、中、宽、全宽会在下方预览中直观改变纸面宽度和两侧留白。
  - 拖动微调滑杆时实时更新，松手后保存并同步到实际文档。

## 跨编辑器核验

使用同一份 Markdown 在 HorseMD、Typora 和 Obsidian 中对照了普通单换行、显式硬换行、标准段落、紧凑/松散列表。三者都把段落内部的普通单换行保留为同一 Markdown 段落；HorseMD 的“保留源码单换行”只改善富文本显示，不会写入 `<br>` 或改动磁盘。

## 验证

- `npm run build`
- `npm run build:mobile`
- `npm run guide:check`
- `npm run test:issue-98-ui`
- `npm run test:settings-ui`
- `npm run test:settings-layout-ui`
- `npm run test:editor-style-settings-ui`
- `npm run test:markdown-preservation`
- `npm run test:soft-break-ui`
- `npm run test:issue-77-ui`
- `npm run test:ui-regression`：`7 sessions + 25 standalone`

真实 12 万字旧样本文档在当前路径不存在，因此完整编排明确跳过该单项；合成大文档和 `电脑档案.md` 的两条连续模式切换链均通过。

## 安装

请在 GitHub Release 的 Assets 中按平台下载：

- Windows：`.exe`
- macOS Apple Silicon：`arm64.dmg`
- macOS Intel：`.dmg`
- Linux：`amd64.deb`

`0.12.47` 发布后会成为 Latest Release，并通过更新检查替代 `0.12.46`。旧 Release 仍保留用于历史追溯。
