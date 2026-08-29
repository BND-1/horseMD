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
| [rich-source-fidelity-bug-family.md](./rich-source-fidelity-bug-family.md) | 富文本编辑、模式切换、保存重开、列表、空段落与转义问题的家族总账和发布前回归合同 |
| [family-root-cause-matrix.md](./family-root-cause-matrix.md) | 真实文件 4×5 家族矩阵、多轮保存重开根因、CRLF/尾换行/列表原子提交证据 |
| [rich-source-divergence-incident-0.13.47.md](./rich-source-divergence-incident-0.13.47.md) | **P0 未解决**：0.13.47 自动化全绿但安装包真实长会话仍发生富文本/源码/磁盘分叉；含现场证据、测试缺口、统一 trace 要求与接手完成标准 |
| [transaction-source-sync-architecture.md](./transaction-source-sync-architecture.md) | **当前架构状态（0.13.146）**：revision-bound transaction journal、stable descendant path、structural owner registry、共享 list/code/quote/table/plain 生命周期与剩余结构族迁移门槛 |
| [transaction-journal-code-block-content-family.md](./transaction-journal-code-block-content-family.md) | 0.13.133 已有 fenced code block 正文迁移：逐 Step 所有权、BOM 物理坐标、作者围栏/CRLF 保真、callback/forced-flush 与冷重开证据 |
| [transaction-journal-code-block-info-family.md](./transaction-journal-code-block-info-family.md) | 0.13.134 已有 fenced code block 语言 info string 迁移：AttrStep 所有权、opening info 物理范围、作者 padding/BOM/CRLF 保真与真实语言选择器双路径证据 |
| [transaction-journal-empty-code-block-backspace.md](./transaction-journal-empty-code-block-backspace.md) | 0.13.146 空 fenced code block Backspace 解包迁移：完整 node ReplaceStep、同 journal 快速正文、forced-empty、作者围栏/BOM/CRLF 保真与冷重开证据 |
| [transaction-journal-blockquote-paragraph-family.md](./transaction-journal-blockquote-paragraph-family.md) | 0.13.135–0.13.136 已有 blockquote 同一直接子段落纯文字迁移：stable descendant path、作者 quote 前缀/BOM/CRLF 保真、callback/forced-flush、保存与冷重开证据 |
| [transaction-journal-blockquote-split-family.md](./transaction-journal-blockquote-split-family.md) | 0.13.136 blockquote 中间 Enter 拆段迁移：nested-list PM nodePath、结构 Step 链、单行 bounded raw patch、歧义拒绝与真实双边界持久化证据 |
| [transaction-journal-blockquote-join-family.md](./transaction-journal-blockquote-join-family.md) | 0.13.137 blockquote 段首 Backspace join 迁移：真实 structure true/false ReplaceStep、quote separator bounded patch、nested path 与 callback/forced-flush 持久化证据 |
| [transaction-journal-blockquote-exit-family.md](./transaction-journal-blockquote-exit-family.md) | 0.13.138 blockquote 末尾双 Enter exit 迁移：pending/coalesced/staged journal、ReplaceAroundStep、parent/quote/inserted paths、bounded raw insertion 与三种真实持久化路径 |
| [transaction-journal-table-cell-family.md](./transaction-journal-table-cell-family.md) | 0.13.139 GFM table 单一 cell 纯文字迁移：stable cell path、重复 occurrence、bounded source-map patch、callback/forced-flush 与持久化证据 |
| [transaction-journal-table-row-delete-family.md](./transaction-journal-table-row-delete-family.md) | 0.13.140 GFM table 单 body-row 删除迁移：real deleteRow Step、exact row range、重复 row occurrence、raw physical-line deletion 与真实控件持久化证据 |
| [transaction-journal-table-row-insert-family.md](./transaction-journal-table-row-insert-family.md) | 0.13.141 GFM table 单空 body-row 新增迁移：real addRowAfter Step、exact insertion boundary、作者行模板、三种 EOL/EOF 与真实控件持久化证据 |
| [transaction-journal-table-column-delete-family.md](./transaction-journal-table-column-delete-family.md) | 0.13.142 GFM simple-grid 单列删除迁移：real deleteColumn 多 Step/stepDoc、唯一 column ordinal、header/delimiter/body bounded edits 与双路径持久化证据 |
| [transaction-journal-table-column-insert-family.md](./transaction-journal-table-column-insert-family.md) | 0.13.143 GFM simple-grid 空列新增迁移：real addColumn 多 Step/stepDoc、唯一 column ordinal、alignment attrs、header/delimiter/body bounded insertions 与双路径持久化证据 |
| [transaction-journal-table-column-alignment-family.md](./transaction-journal-table-column-alignment-family.md) | 0.13.144 GFM simple-grid 整列对齐迁移：real CellSelection + ReplaceAroundStep/stepDoc、delimiter-only raw patch、left/center/right 双边界持久化证据 |
| [transaction-journal-table-column-width-family.md](./transaction-journal-table-column-width-family.md) | 0.13.145 表格物理列宽元数据迁移：真实拖拽逐 row ReplaceAroundStep、exact path-bound semantic proof、source/canonical 不变、callback/forced-flush 与冷重开边界 |
| [transaction-first-source-sync-phase1-plain-paragraph-plan.md](./transaction-first-source-sync-phase1-plain-paragraph-plan.md) | Phase 1 普通段落 authority 的分类器、shadow/authority 合同、当前未完成门禁与回归证据 |
| [slash-code-source-sync-regression.md](./slash-code-source-sync-regression.md) | `/code` 两阶段结构命令缺失 fence 的根因、命令级原子 source intent 与连续编辑回归 |
| [canonical-escape-audit.md](./canonical-escape-audit.md) | canonical Markdown 中实体、反斜杠、列表标记与 `<br />` 的完整泄漏面审计 |
| [nested-list-sync-bug-handoff.md](./nested-list-sync-bug-handoff.md) | `- 1. 内容`、多列表批次、marker 保留与列表结构分歧的根因和回归矩阵 |
| [generated-scratch-empty-ordered-indent-regression.md](./generated-scratch-empty-ordered-indent-regression.md) | RS-45：新建文档空 `2.` 按 Tab 后，generated scratch 误删空嵌套项重解析所需空行，导致合法结构被 integrity gate 拒绝 |
| [diverged-nested-number-enter-split-regression.md](./diverged-nested-number-enter-split-regression.md) | RS-46：`- 1. 文本` 行内嵌套 ordered item 经 Enter 拆项后，新 sibling 被错误写成新的外层 bullet |
| [empty-blockquote-ime-fill-regression.md](./empty-blockquote-ime-fill-regression.md) | RS-48：空 blockquote 中 IME 提交正文时，尾部空块 mapper 把 quoted text 错写成引用块外普通段落；0.13.94 原位填充 quote slot |
| [generated-scratch-literal-ordered-ime-regression.md](./generated-scratch-literal-ordered-ime-regression.md) | RS-49：新文档 bullet 正文开头 `1\\.` 被 generated scratch 去转义后重解析成 nested ordered list；0.13.95 保留结构保护 escape |
| [appended-literal-ordered-marker-regression.md](./appended-literal-ordered-marker-regression.md) | RS-55：尾部普通段输入字面 `3.` 时，appended paragraph 过早去掉结构保护反斜杠；0.13.101 仅保护整块 `N\\.` / `N\\)` |
| [generated-scratch-nested-empty-backspace-regression.md](./generated-scratch-nested-empty-backspace-regression.md) | RS-56：三级 nested bullet 最深项快速双 Backspace 时 raw `<br />` 缩进证据被 normalize 抹掉；0.13.102 以 raw canonical 窄证明 nested list-item removal |
| [generated-scratch-blockquote-empty-paragraph-regression.md](./generated-scratch-blockquote-empty-paragraph-regression.md) | RS-57：引用正文末尾 Enter 产生无法直接用 Markdown 持久化的空第二段；0.13.103 用专用 transient proof 保持源码不变直到该段收到正文 |
| [generated-scratch-task-continuation-empty-regression.md](./generated-scratch-task-continuation-empty-regression.md) | RS-58：checked task/list item 内尾随 continuation paragraph 删空时，raw `<br />` 缩进 ownership 被 normalize 丢失；0.13.104 用专用 list transient proof 保持源码、保存和冷重开一致 |
| [escaped-standalone-paragraph-expand-regression.md](./escaped-standalone-paragraph-expand-regression.md) | RS-59：已有 source/canonical 拼写分歧时，中间空段的字面 `\\-` 扩写为 `-【】` 会因 visible-offset 零宽边界粘到上一段；0.13.105 用 mapped source line identity fail-closed 到行级 mapper |
| [backtick-source-sync-lock-regression.md](./backtick-source-sync-lock-regression.md) | 反引号输入/删除、行内代码闭合、代码围栏退出、保存暂停与源码锁死的联合回归 |
| [list-item-literal-marker-escape-regression.md](./list-item-literal-marker-escape-regression.md) | 列表正文中 `1.`、`1)`、`-`、`+`、`*` 字面文本被错误转义的根因与修复 |
| [desktop-drop-open.md](./desktop-drop-open.md) | 桌面端从 Finder / 文件资源管理器拖入文件或文件夹的产品边界、IPC 与测试合同 |
| [source-rich-split-view-prd.md](./source-rich-split-view-prd.md) | 桌面端左源码、右富文本双栏实时预览：产品范围、交互、性能策略与验收标准 |
| [source-rich-split-view-architecture.md](./source-rich-split-view-architecture.md) | 双栏同步协调器、滚动联动、内容保真、现有接口复用与分阶段实施架构 |
| [new-input-source-fidelity-report.md](./new-input-source-fidelity-report.md) | 0.12.45 新输入列表 marker 与连续空段落 `<br />` 泄漏的根因、修复和回归证据 |
| [list-conversion-source-race-regression.md](./list-conversion-source-race-regression.md) | 0.12.52 列表转换、立即输入、源码 flush 时序竞争和嵌套列表整块规范化的根因、修复与保存重开回归 |
| [mermaid-paste-duplicate-render-report.md](./mermaid-paste-duplicate-render-report.md) | 0.12.46 Mermaid 粘贴重复渲染的历史误判、源码模型不一致、精确粘贴修复与防回归测试 |
| [clipboard-mime-regression-0.12.46.md](./clipboard-mime-regression-0.12.46.md) | 0.12.46 外部复制增加空行/列表编号的根因、三通道剪贴板契约与防回归测试 |
| [long-code-copy-virtualization-regression.md](./long-code-copy-virtualization-regression.md) | 长 CodeMirror 代码块只复制可见 30–65 行的虚拟化根因、完整节点修复与系统剪贴板回归 |
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
| [document-export-prd.md](./document-export-prd.md) | HTML 预览导出、Pandoc 安装引导与多格式转换的产品范围、用户流程和验收标准 |
| [document-export-architecture.md](./document-export-architecture.md) | 结构化导出快照、HTML 预览会话、Pandoc 子进程隔离与模块边界 |
| [task-list-persistence-report.md](./task-list-persistence-report.md) | 任务清单勾选只改界面、不写入文件的事件根因、修复边界与关闭重开回归 |
| [mobile.md](./mobile.md) | 移动端（iOS / Android · Capacitor）方案、接口适配、打包发布 |
| [mobile-usage.md](./mobile-usage.md) | 移动端**使用说明**(安装、界面、保存/导出等操作) |
| [user-guide-maintenance.md](./user-guide-maintenance.md) | 面向用户的图文教程站、截图与发布维护规范 |
| [user-guide-feature-coverage.md](./user-guide-feature-coverage.md) | 用户可见功能、代码所有者、教程页面与发布前核对状态矩阵 |
| [release-v0.13.29.md](./release-v0.13.29.md) | v0.13.29 发布说明、安装产物、完整原文保真验证与关联 Issue |
| [release-v0.12.46.md](./release-v0.12.46.md) | v0.12.46 发布说明、安装产物、验证记录与关联 Issue |
| [release-v0.12.47.md](./release-v0.12.47.md) | v0.12.47 紧急修复发布说明、跨编辑器核验与安装产物 |
| [release-v0.12.10.md](./release-v0.12.10.md) | v0.12.10 发布说明、安装产物、验证记录与关联 Issue |
| [custom-shortcuts-architecture.md](./custom-shortcuts-architecture.md) | 设置中心重构、统一命令模型与自定义快捷键目标架构 |
| [custom-shortcuts-implementation-checklist.md](./custom-shortcuts-implementation-checklist.md) | 分阶段实施步骤、测试矩阵、停止条件与交付清单 |
| [custom-shortcuts-default-inventory.md](./custom-shortcuts-default-inventory.md) | 默认快捷键、菜单 accelerator、命令所有者和可配置状态清单 |
| [custom-shortcuts-verification-report.md](./custom-shortcuts-verification-report.md) | 自定义快捷键自动化验证、真实安装证据、剩余人工验收边界 |
| [ai-product-architecture.md](./ai-product-architecture.md) | AI 文档助手、工作区上下文、Provider、Review-first 改写、桌面 Agent 与插件生态的产品边界和分期架构 |
| [ai-readiness-audit.md](./ai-readiness-audit.md) | AI 开发前的技术债、阻塞项、非阻塞风险、实施门槛与验收重点 |
| [vmark-reference-review.md](./vmark-reference-review.md) | VMark 的 AI Provider、MCP、Pandoc 与 HTML 导出实现对 HorseMD 的可借鉴边界 |
| [ai-vmark-phase-plan.md](./ai-vmark-phase-plan.md) | 参考 VMark 后确定的 HorseMD AI 分阶段路线、Phase 0 契约和停止条件 |
| [cloud-sync-prd.md](./cloud-sync-prd.md) | 文件夹级 WebDAV / S3 云同步的产品边界、数据模型、阶段计划与验收矩阵 |
| [cloud-sync-v2-prd.md](./cloud-sync-v2-prd.md) | Sync v2 的方向选择、远端清空保护和可恢复变更产品规则 |
| [cloud-sync-v2-architecture.md](./cloud-sync-v2-architecture.md) | Sync v2 的策略 API、计划层、执行顺序和兼容性设计 |
| [mobile-cloud-sync-architecture.md](./mobile-cloud-sync-architecture.md) | 移动端云同步的原生安全凭据、文件 adapter 与网络桥接方案（桌面端先行，移动端未开放） |
| [empty-paragraph-contract.md](./empty-paragraph-contract.md) | 空段落 `<br />` 占位与可见流分叉合同；0.13.x 原文保真硬不变式 |
| [issues-105-106-save-fidelity-regression.md](./issues-105-106-save-fidelity-regression.md) | 0.12.63 保存/原文保真回归（与删除回退同族） |
| [issue-104-long-document-mode-switch.md](./issue-104-long-document-mode-switch.md) | 长文档模式切换光标偏移（行内公式 atom）根因与真实文档验证 |
| [issue-86-table-save-report.md](./issue-86-table-save-report.md) | 表格增删行列后的单元格归属、空单元格与保存重开回归 |
| [issues-93-98-implementation-report.md](./issues-93-98-implementation-report.md) | issue 93/96/97/98 的实现与验收记录 |
| [codeblock-fence-investigation.md](./codeblock-fence-investigation.md) | **进行中**：代码块围栏「吞正文」排查留底（解析机制已确认，正常路径未复现，待用户提供步骤） |
| [live-preview-migration-plan.md](./live-preview-migration-plan.md) | 长期「源码即数据模型」Live Preview 终局方案；当前先执行 transaction-first 分类型迁移，不启动全量替换 |
| [macos-real-input-testing.md](./macos-real-input-testing.md) | macOS CGEvent 前台逐键输入的真实测试方法（疑难编辑问题的补充手段） |
| [list-conversion-prd.md](./list-conversion-prd.md) | 有序/无序/待办列表相互转换的产品范围与验收标准 |
| [floating-outline-design.md](./floating-outline-design.md) | 右侧悬浮大纲（Scroll Spy 圆点导航）设计与实现边界 |
| [editor-feature-inventory.md](./editor-feature-inventory.md) | 编辑器功能清单（与 features.md 对应） |
| [release-v0.12.60.md](./release-v0.12.60.md) | v0.12.60 发布说明与验证记录 |

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
