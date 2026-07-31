# HorseMD 开发文档

这套文档记录 **HorseMD** 的架构、功能实现方式、开发/打包流程，以及开发过程中发现并修复的关键问题与设计决策。

> HorseMD 是一款温暖、现代的 Markdown 编辑器 —— 一个 Typora 替代品，核心理念：**每个文件都在同一个窗口里作为标签页打开**，而不是新开一个程序。

## 文档目录

| 文档 | 内容 |
| --- | --- |
| [ai-handoff.md](./ai-handoff.md) | 新 AI / 新开发者接手手册：项目地图、用户习惯、风险区、测试矩阵、网站与发布规则 |
| [architecture.md](./architecture.md) | 技术栈、进程模型、目录结构、关键模块与数据流 |
| [features.md](./features.md) | 每个功能的用法 + 实现方式（对应到具体文件） |
| [implementation-notes.md](./implementation-notes.md) | 开发过程中踩的坑、关键 bug 的根因与修法、设计决策 |
| [development.md](./development.md) | 本地开发、构建、打包（Windows / macOS）、自动化测试方法 |
| [markdown-source-preservation.md](./markdown-source-preservation.md) | 富文本/源码原文保真合同、双 MIME 粘贴边界、回归矩阵与未来 Live Preview 决策 |
| [new-input-source-fidelity-report.md](./new-input-source-fidelity-report.md) | 0.12.45 新输入列表 marker 与连续空段落 `<br />` 泄漏的根因、修复和回归证据 |
| [mermaid-paste-duplicate-render-report.md](./mermaid-paste-duplicate-render-report.md) | 0.12.46 Mermaid 粘贴重复渲染的历史误判、源码模型不一致、精确粘贴修复与防回归测试 |
| [clipboard-mime-regression-0.12.46.md](./clipboard-mime-regression-0.12.46.md) | 0.12.46 外部复制增加空行/列表编号的根因、三通道剪贴板契约与防回归测试 |
| [source-fidelity-audit-2026-07.md](./source-fidelity-audit-2026-07.md) | 文件读写全链路原文保真审计、已修根因、允许变化边界与自动化证据 |
| [editor-source-switch-regression-0.12.34.md](./editor-source-switch-regression-0.12.34.md) | 段落合并、切换后即时输入、硬换行光标偏移和行内代码边界的症状索引、根因与防回归要求 |
| [soft-line-break-display-report.md](./soft-line-break-display-report.md) | 源码普通单换行在富文本中被显示为空格的根因、显示合同、禁止修法与真实 UI 回归 |
| [cross-editor-line-break-comparison.md](./cross-editor-line-break-comparison.md) | HorseMD、Typora、Obsidian 的换行、段落、列表、保存与复制行为对照 |
| [settings-page-width-preview-regression.md](./settings-page-width-preview-regression.md) | 设置页宽度预览被固定上限截断的根因、实时反馈修复与可见 UI 防回归方法 |
| [pdf-rendered-content-export-report.md](./pdf-rendered-content-export-report.md) | Mermaid 在 PDF 中退化为源码的根因、统一预览导出链路、安全降级和格式回归矩阵 |
| [issue-101-pdf-images-table-density-report.md](./issue-101-pdf-images-table-density-report.md) | PDF 图片二次加载、路径双重编码、编辑器表格密度及 0.12.42 打印行距后续修正 |
| [pdf-table-layout-fidelity-report.md](./pdf-table-layout-fidelity-report.md) | PDF 表格列宽、行距与富文本不一致的两层根因、修复过程、量化证据与防回归命令 |
| [pdf-visual-fidelity-runbook.md](./pdf-visual-fidelity-runbook.md) | “编辑器正常、PDF 不一致”问题的分层诊断、fixture、坐标/像素验证、禁止捷径和停止条件 |
| [pdf-preview-printing-race-report.md](./pdf-preview-printing-race-report.md) | 连续修改 PDF 设置触发 `Printing failed` 的 Chromium 打印取消竞态、修复模型与长文档压力测试 |
| [task-list-persistence-report.md](./task-list-persistence-report.md) | 任务清单勾选只改界面、不写入文件的事件根因、修复边界与关闭重开回归 |
| [mobile.md](./mobile.md) | 移动端（iOS / Android · Capacitor）方案、接口适配、打包发布 |
| [mobile-usage.md](./mobile-usage.md) | 移动端**使用说明**(安装、界面、保存/导出等操作) |
| [user-guide-maintenance.md](./user-guide-maintenance.md) | 面向用户的图文教程站、截图与发布维护规范 |
| [user-guide-feature-coverage.md](./user-guide-feature-coverage.md) | 用户可见功能、代码所有者、教程页面与发布前核对状态矩阵 |
| [release-v0.12.46.md](./release-v0.12.46.md) | v0.12.46 发布说明、安装产物、验证记录与关联 Issue |
| [release-v0.12.47.md](./release-v0.12.47.md) | v0.12.47 紧急修复发布说明、跨编辑器核验与安装产物 |
| [release-v0.12.10.md](./release-v0.12.10.md) | v0.12.10 发布说明、安装产物、验证记录与关联 Issue |
| [custom-shortcuts-architecture.md](./custom-shortcuts-architecture.md) | 设置中心重构、统一命令模型与自定义快捷键目标架构 |
| [custom-shortcuts-implementation-checklist.md](./custom-shortcuts-implementation-checklist.md) | 分阶段实施步骤、测试矩阵、停止条件与交付清单 |
| [custom-shortcuts-default-inventory.md](./custom-shortcuts-default-inventory.md) | 默认快捷键、菜单 accelerator、命令所有者和可配置状态清单 |
| [custom-shortcuts-verification-report.md](./custom-shortcuts-verification-report.md) | 自定义快捷键自动化验证、真实安装证据、剩余人工验收边界 |
| [ai-product-architecture.md](./ai-product-architecture.md) | AI 文档助手、工作区上下文、Provider、Review-first 改写、桌面 Agent 与插件生态的产品边界和分期架构 |
| [ai-readiness-audit.md](./ai-readiness-audit.md) | AI 开发前的技术债、阻塞项、非阻塞风险、实施门槛与验收重点 |
| [cloud-sync-prd.md](./cloud-sync-prd.md) | 文件夹级 WebDAV / S3 云同步的产品边界、数据模型、阶段计划与验收矩阵 |
| [cloud-sync-v2-prd.md](./cloud-sync-v2-prd.md) | Sync v2 的方向选择、远端清空保护和可恢复变更产品规则 |
| [cloud-sync-v2-architecture.md](./cloud-sync-v2-architecture.md) | Sync v2 的策略 API、计划层、执行顺序和兼容性设计 |

## 一句话技术概览

Electron + Vite + React 外壳，编辑器引擎用 **Milkdown Crepe**（基于 ProseMirror 的所见即所得）。外壳（标签页、文件树、命令面板、大纲、主题、i18n、首页）全部自研。

## 快速开始

```bash
npm install        # 若 Electron 二进制下载被墙，先设镜像：
                   #   ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm run dev        # 热重载开发模式
npm run build      # 打包 main + preload + renderer 到 out/
npm start          # 运行已构建的应用
npm run dist       # 打当前系统安装包（Windows NSIS / macOS dmg+zip）
```

> 新 AI 先读 [ai-handoff.md](./ai-handoff.md) 和仓库根目录的 [AGENTS.md](../AGENTS.md)，再按需进入 [CLAUDE.md](../CLAUDE.md) 与本目录各篇细节文档。
