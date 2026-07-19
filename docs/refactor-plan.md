# 重构计划与候选

> 目标:在**不改变行为**的前提下,拆分过大的文件、理清职责。功能先写完 →
> 按本清单重构 → 按 `docs/manual-test-checklist.md` 逐功能回归测试。
> 重构阶段用 OMC 的 **ralph loop**(持久化循环 + 每步验证)驱动,每拆一块就跑
> 对应测试,绿灯才继续。

## 2026-07-12 重构完成时快照（历史记录）

| Phase | 目标 | 状态 |
|---|---|---|
| **1** | Editor 首轮拆分（chunked parse / toolbar / block controls） | ✅ 完成 |
| **2** | App 外壳首轮拆分（文件、查找、大纲、生命周期、shell） | ✅ 完成 |
| **3** | Editor 生命周期与插件、DOM、API、图片等职责拆分 | ✅ 完成（约 1600 → **591**） |
| **4** | Review 扫描、Decoration 与卡片 DOM 拆分 | ✅ 完成（核心模块 1090 → **359**） |
| **5** | Workspace、Sidebar tree 与右键菜单拆分 | ✅ 完成（Sidebar 584 → **465**） |
| **6** | 源码/富文本状态机提取为 `useSourceModeSwitch` | ✅ 完成（App 1200 → **954**） |

## 一、代码体检（2026-07-12 行数快照）

| 文件 | 行数 | 角色 | 评级 |
|---|---|---|---|
| `App.jsx` | **954** | shell 组合器与跨功能状态 | 🟡 后续只按明确合同继续拆 |
| `components/Editor.jsx` | **591** | Crepe 生命周期编排与稳定公开 API | 🟢 已达目标 |
| `components/editor-review.js` | **359** | Review 插件状态机与命令入口 | 🟢 已拆分 |
| `components/editor-review-card.js` | **371** | Review 卡片 DOM 与交互 | 🟢 单一职责 |
| `components/editor-review-decorations.js` | **328** | Review 扫描与 Decoration 构建 | 🟢 单一职责 |
| `i18n.jsx` | 578 | zh/en 字符串(数据,非逻辑) | 🟢 暂不动 |
| `components/Sidebar.jsx` | **465** | 文件树渲染、创建/重命名/拖放编排 | 🟢 已拆分 |
| `components/StatusBar.jsx` | 452 | stats + 布局 + 块切换 + 源码切换 | 🟡 中 |
| `components/editor-toolbar.js` | 225 | phase 1 抽出(工具栏注入) | ✅ |
| `components/editor-block-controls.js` | 130 | phase 1 抽出(块控制) | ✅ |
| `components/editor-chunked-parse.js` | 96 | phase 1 抽出(分块解析) | ✅ |
| `hooks/useFileOps.js` | **497** | 文件/标签操作与单文件 watcher | 🟡 保持合同稳定 |
| `hooks/useWorkspace.js` | **77** | 多根工作区、目录 watcher 与会话状态 | ✅ |
| `hooks/useSidebarTree.js` | **99** | 文件树加载、展开和当前文件跟随 | ✅ |
| `hooks/useSourceModeSwitch.js` | **259** | per-tab 模式、同步意图和锚点恢复 | ✅ |
| `components/shell/EditorArea.jsx` | 184 | phase 2 抽出(双格编辑器渲染) | ✅ |
| `lib/menuHandlers.js` | 240 | phase 2 抽出(命令分发 + 全局键 + 命令面板) | ✅ |
| `hooks/useAppLifecycle.js` | 226 | phase 2 抽出(会话 + 更新 + toast + onboarding) | ✅ |
| `hooks/useOutline.js` | 188 | phase 2 抽出(scrollspy + 标题列表) | ✅ |
| `components/shell/Topbar.jsx` | 84 | phase 2 抽出(标签条 + 顶栏按钮) | ✅ |
| `components/shell/FindBar.jsx` | 78 | phase 2 抽出(查找替换栏) | ✅ |
| `hooks/useFindReplace.js` | 177 | phase 2 抽出(查找替换逻辑) | ✅ |
| `lib/reviewActions.js` | 105 | phase 2 抽出(active-tab review 动作) | ✅ |
| `components/shell/ActivityBar.jsx` | 40 | phase 2 抽出(左侧活动条) | ✅ |
| `reviewMarkup.js` | 384 | review 解析(内聚) | 🟢 |
| `platform/capacitor-api.js` | 373 | 移动端平台层(内聚) | 🟢 |
| 其余 | <210 | 多为单一职责小模块 | 🟢 |

> 主进程 `main/index.js` 当前 804 行。继续拆分前应先明确 IPC 领域边界并补主进程合同测试。
>
> **文件体量纪律**(用户指令):新功能一律放进小而专的模块/hook,目标 < 500 行/文件(硬上限 800),超了就拆。App.jsx/Editor.jsx 不再 append 新功能。

> 当前文件规模会随功能变化，不使用本页历史数字作重构依据。开始新拆分前先运行 `wc -l`，并以 [architecture.md](./architecture.md)、[editor-feature-inventory.md](./editor-feature-inventory.md) 和 [markdown-source-preservation.md](./markdown-source-preservation.md) 的现行职责合同为准。

## 二、历史目标拆解

以下内容保留为重构过程记录，不再代表当前文件职责。当前模块地图以
`docs/architecture.md` 和 `docs/editor-feature-inventory.md` 为准。

### `App.jsx`(1975)— god component
当前揉在一起的职责:
- **状态**:tabs / activeId / workspace / sidebar / theme / customTheme / lang / sourceMode / split / find / toast / rename / saveName / settings / outline / mountedIds / richForced …
- **文件操作**:openPaths / openFolder / newTab / closeTab / saveTab / writeTab / commitMobileSave / 监听回显
- **查找替换**:runFind / stepFind / closeFind / applyReplace(富文本 + 源码两条路)
- **大纲**:scrollspy effect + 标题扫描 + 软居中数据
- **review 处理**:applyReviewMarkupToActive / applyReviewDecisionToActive / copyReviewPrompt
- **会话**:load / flush / debounce 持久化
- **其它**:导出 PDF、更新检查、命令面板、菜单/快捷键、主题/语言应用、自定义主题扫描、布局设置应用、脏数据/关闭守卫
- **JSX**:整张 shell(activity bar / sidebar / tabs / 编辑区双格 / findbar / statusbar / 命令面板 / 各 modal / toast)

**建议拆分**(行为保持,逐块抽出):
- `hooks/useTabs.js` — tab 状态 + 开/关/保存
- `hooks/useFindReplace.js` — 查找替换逻辑(refs + runFind/stepFind/applyReplace)
- `hooks/useOutline.js` — scrollspy + 标题扫描
- `hooks/useSession.js` — 会话加载/flush/防抖
- `hooks/useFileOps.js` — openPaths/openFolder/watch 回显
- `lib/reviewActions.js` — review 的 active-tab 处理函数(纯逻辑)
- `components/shell/` — `ActivityBar.jsx`、`EditorArea.jsx`(双格渲染)、`SidebarPanel.jsx` 等拆出
- App.jsx 收窄为:**组合各 hook + 布局 JSX**,目标 < 600 行

### `Editor.jsx`(1738)— god wrapper
当前揉在一起的职责:
- Crepe 创建 + feature 配置
- **分块解析**:splitMarkdown + 后台追加(CHUNK_THRESHOLD)
- **工具栏注入**:highlight 按钮、review 按钮、tooltips
- **node view**:HTML、frontmatter
- **插件装配**:mermaid 预览/拆分、table-break、review 装饰器、substitution 重建、strikeGuard
- **块控制**:setBlock、level 徽标(refreshLevel)
- 粘贴 handler 挂载、math normalize、右键菜单、图片文本/持久化

**建议拆分**:
- `editor-chunked-parse.js` — splitMarkdown + 追加循环
- `editor-toolbar.js` — 工具栏注入通用 helper(appendToolbarItem/editorForToolbar)+ highlight/review 按钮注入
- `editor-block-controls.js` — setBlock + refreshLevel 徽标
- `editor-plugin-config.js` — 各 remark/prose 插件的装配配置
- Editor.jsx 收窄为:**建 Crepe + 装配 + 生命周期**,目标 < 800 行

## 三、重构原则(不可破)

1. **行为保持**:只搬移、不改逻辑。每一抽块后立刻跑 `docs/manual-test-checklist.md` 对应项。
2. **测试清单是安全网**:清单没覆盖到的行为,先补条目再重构。
3. **性能敏感区小心**:`useOutline`(reflow-free scrollspy)、`Editor.jsx` 的分块解析/非受控 textarea、`scheduleLevel` trailing —— 拆分时不能引入新的每帧 reflow 或打破非受控约定。
4. **小步快跑**:一次只抽一个 hook/模块 → 跑测试 → commit。绝不一次大重构。
5. **mobile 共享 renderer**:拆出的渲染层代码 iOS/Android 也走,改名/改签名要在 `platform/capacitor-api.js` 同步。

## 四、新功能开发前的执行顺序

```
1. 先确定功能属于 main/preload/platform、App hook、Editor helper 还是纯 UI，禁止直接堆进 `App.jsx` / `Editor.jsx`。
2. 写清行为合同、dirty 语义、桌面/移动能力差异和失败路径；缺测试的先补测试。
3. 按最小可验证增量实现，每步运行相关脚本与 `npm run build`。
4. 共享 renderer 或平台合同变化额外运行 `npm run build:mobile`。
5. 按 `docs/manual-test-checklist.md` 做相关回归；模式切换改动必须包含表格、代码块、双向链路和真实大文档。
```

## 五、不重构的(避免过度工程)

- `i18n.jsx`(纯数据)、`reviewMarkup.js`、`paths.js`、`find.js`、`settings.js`
  已有清晰边界，没有具体收益时不继续拆。
- 不为了"好看"引入新抽象层;只拆真实过大的文件。
