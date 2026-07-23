# 用户教程功能覆盖矩阵

> 用途：把用户实际看得到的能力、代码所有者、教程入口和发布前检查放在同一处。更新时间：2026-07-23。
>
> 状态说明：**已复核**表示教程步骤和当前实现边界已核对；**待发布截图**表示正文可用，但下次正式发布需用新安装包确认并重拍受影响界面；**待专项复核**表示已有教程，尚未按本轮变更逐项对照。

## 维护规则

- 教程站的公开版本和截图基线由 `guide/package.json`、`guide/public/images/vX.Y.Z/` 管理；本地测试包升级不能直接冒充正式发布。
- 新功能或行为变化先更新对应教程正文、FAQ 和必要的边界说明，再登记本表。
- 准备发布时，按“待发布截图”和“待专项复核”逐项验收，更新页面版本徽标、截图、网站下载信息和 `CHANGELOG.md`。
- 代码实现说明留在 `docs/`；用户教程只保留操作路径、结果、限制与安全提醒。

## 基础与编辑

| 功能 | 主要代码所有者 | 用户教程 | 状态 / 下次动作 |
| --- | --- | --- | --- |
| 新建、打开、保存、外部修改提醒 | `useFileOps.js`、`useAppLifecycle.js` | `guide/basics/create-open-save.md` | 待专项复核：下次发布检查外部保存冲突提示截图与文案。 |
| 多根工作区、文件树、文件操作 | `useWorkspace.js`、`useSidebarTree.js`、`Sidebar.jsx` | `guide/basics/workspace.md` | 已复核：明确工作区只管理本地文件；与同步区分。 |
| 富文本 / 源码切换、原文保真、源码查找 | `useSourceModeSwitch.js`、`scrollAnchor.js`、`markdown-source-preservation.js` | `guide/basics/rich-and-source.md` | 待发布截图：正文已覆盖光标/阅读位置、表格和大文档边界。 |
| 斜杠命令 | `editor-slash-menu.js` | `guide/editing/slash-command.md` | 待专项复核：确认所有可见别名与命令清单一致。 |
| 格式、图片、链接、附件 | `Editor.jsx`、`editor-dom-content.js`、`useAttachments.js` | `guide/editing/formatting.md`、`images.md`、`links-and-attachments.md` | 待专项复核：链接协议与附件路径应在发布前用真实文件再验。 |
| 表格、HTML 表格、单元格换行、列宽 | `editor-tablebreak.js`、`editor-dom-layout.js`、`editor-html.js` | `guide/editing/tables.md` | 已复核：自然宽度、内部横向滚动、`/表格`/`/table`/`/bg`、长按实时调列宽和不回跳均已写入。 |
| 代码块、Mermaid、LaTeX | `editor-codeblock-eager.js`、`editor-mermaid.js`、`editor-math.js` | `guide/editing/code-blocks.md`、`math-and-mermaid.md` | 待专项复核：下次发布确认公式预览、灯箱和 PDF 长公式截图。 |

## 导航、效率与外观

| 功能 | 主要代码所有者 | 用户教程 | 状态 / 下次动作 |
| --- | --- | --- | --- |
| 查找替换 | `useFindReplace.js` | `guide/productivity/find-and-replace.md` | 待专项复核：覆盖富文本、源码与模式切换后继续查找。 |
| 大纲、折叠、重排、悬浮章节导航 | `useOutline.js`、`Outline.jsx`、`FloatingOutline.jsx` | `guide/productivity/outline.md` | 待发布截图：正文已覆盖桌面悬浮导航及移动端差异。 |
| 命令面板、Review | `CommandPalette.jsx`、`editor-review*.js` | `guide/productivity/command-palette.md`、`review.md` | 待专项复核。 |
| 自定义快捷键 | `components/commands/`、`useKeybindings.js` | `guide/productivity/shortcuts.md` | 待发布截图：保持“编辑器原生命令暂不开放”的范围说明。 |
| 主题、字体、排版、自定义 CSS | `settings.js`、`settings/`、`customThemes.js` | `guide/customization/themes.md`、`fonts.md`、`settings.md` | 已复核：CSS 片段、真实选择器预览与返回设置时的片段停留已写入。 |

## 输出、同步与移动端

| 功能 | 主要代码所有者 | 用户教程 | 状态 / 下次动作 |
| --- | --- | --- | --- |
| PDF 导出中心 | `hooks/usePdfExport.js`、`components/pdf-export/`、`main/pdf-export.js` | `guide/output/export-pdf.md` | 待发布截图：按真实 PDF 验收尺寸、目录页、书签、页码范围和长公式。 |
| 富文本复制、移动分享 | `editor-copy.js`、`capacitor-api.js` | `guide/output/rich-copy.md`、`mobile-share.md` | 待专项复核。 |
| 桌面 WebDAV / S3 云同步 | `useSyncWorkspaces.js`、`SyncSettings.jsx`、`main/sync/` | `guide/basics/cloud-sync.md`、`guide/troubleshooting/faq.md` | 已复核：明确工作区不会自动同步、根目录唯一 `.horsemd/workspace.json`、WebDAV/S3、可选 User-Agent、上传/下载/双向同步、远端清空保护、冲突回收和仅桌面端。 |
| iOS / Android 只读与平台边界 | `capacitor-api.js`、`mobileReadOnly`、移动壳 | `guide/mobile/ios.md`、`android.md` | 已复核：只读模式和“移动端不提供云同步”已写明；真机发布前仍需手测。 |

## 不进入用户教程的项目

| 项目 | 原因 | 文档位置 |
| --- | --- | --- |
| AI 文档助手、Provider、Agent、插件生态 | 仍处于产品与架构阶段，尚无可交付用户入口。 | `docs/ai-product-architecture.md`、`docs/ai-readiness-audit.md`、`ROADMAP.md` |
| 云同步 v2 决策与实现细节 | 用户教程只说明安全行为；manifest、策略和恢复状态机属于开发实现。 | `docs/cloud-sync-v2-prd.md`、`docs/cloud-sync-v2-architecture.md` |
| 编辑器保真、模式切换和表格根因报告 | 用户需要知道结果与限制，不需要内部算法和故障历史。 | `docs/markdown-source-preservation.md`、`docs/issue-86-table-save-report.md` |
