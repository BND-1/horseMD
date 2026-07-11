# 新功能方案：单一工作区多根 + 飞书式斜杠菜单

> 2026-07-10 调研 + 设计。确认后用 ralph loop 实施。铁律：不影响现有功能、跨平台、单文件 <800 行。

> ✅ **已实施完成（2026-07-11）** —— 两个功能都已落地。最终工作区模型已从早期“多个可切换工作区”
> 收敛为“一个未命名工作区，里面挂多个文件夹根”：顶部固定显示「工作区」；打开文件夹 = 添加一个根；
> 右键根节点 = 从工作区移除。根节点是挂载点，不允许拖拽移动、重命名或删除真实磁盘文件夹。
> 飞书式斜杠菜单：`src/renderer/src/components/editor-slash-menu.js`（自建，绕过 Crepe label-only 过滤）。
> 工作区：`folderRoots:[absPath,...]`，多根文件树 + 旧 session 迁移（旧 `workspaces:[{folderRoots}]` 会被合并）。
> 关键决策记录在 `CLAUDE.md` 的「Slash (`/`) menu」与「Workspace / file tree」两条 convention。

> 下面的“多工作区”设计段落是早期方案记录，作为背景保留；实现和回归测试以后以上面的最终模型为准。

---

## 功能 1：多工作区（Workspace）

### 现状
- 工作区是**单一**状态：`useFileOps.js` 的 `workspace = { rootPath, rootName }`。
- `openFolder()`（`Cmd/Ctrl+Shift+O` 或 Explorer "Open with HorseMD"）→ `setWorkspace({ rootPath, rootName })`，**替换**当前工作区。
- `Sidebar.jsx`：顶部显示 `workspace.rootName`，`loadDir(workspace.rootPath)` 加载**单根**文件树。
- session 持久化**一个** workspace（`minimd.session.v1` 的 `workspace` 字段）。
- 没有「工作区列表 / 历史 / 切换 / 多根」概念。

### 目标（用户需求）
1. 可以打开**多个独立工作区**，彼此隔离、可切换。
2. 侧边栏最顶部显示「**工作区**」（不是当前文件夹名）。
3. 一个工作区下可挂**多个文件夹**（当前打开的 + 历史打开过的）；已有文件夹基础上还能再「打开另一个路径的文件夹」加进来。

> 即：工作区 = 顶级容器（可多建、可切换）；工作区下挂多个文件夹根（多根文件树）。对标 VS Code 的 multi-root workspace + 多 workspace 切换。

### 设计

**数据模型**（新，session 持久化）：
```js
workspaces: [
  { id, name, folderRoots: [absPath, absPath, ...], createdAt }
]
activeWorkspaceId: string
```
- 一个工作区 = 一组文件夹根（多根）。文件树按 `folderRoots` 渲染多个子树。
- `name` 默认取第一个文件夹名，可重命名。
- 兼容旧 session：没有 `workspaces` 字段时，把旧的单一 `workspace.rootPath` 迁移成一个工作区。

**UI（Sidebar）**：
- 顶部块改成「**工作区**」标题 + 当前工作区名 + 切换/管理入口（下拉或弹层：列出所有工作区 + 「新建工作区」）。
- 文件树：从单根 `loadDir(rootPath)` 改为**多根**——遍历 `activeWorkspace.folderRoots`，每个 root 一棵子树（根节点显示文件夹名）。
- 「打开文件夹」动作语义改变：从「替换工作区」改为「**加入当前工作区**」（新 root 追加到 `folderRoots`）。
- 新增动作：「新建工作区」「切换工作区」「从当前工作区移除某文件夹」「重命名工作区」。

**main 进程**：
- `dialog:openFolder` 已能返回目录；新增/复用 IPC 把「加入工作区」「新建工作区」落到 renderer。
- watcher（chokidar）当前 watch 单 root；多根时要 watch `folderRoots` 数组（每个 root 一个 watcher，复用现有 crash-proof 逻辑）。
- launch args 的「文件夹」(Explorer 打开) 当前 → `open-folder` 替换工作区；改为「加入当前工作区」（或新建工作区，看交互定）。

### 怎么做（实施步骤 / 文件）
1. **`hooks/useFileOps.js`**：`workspace` 单一状态 → `workspaces` 数组 + `activeWorkspaceId`；新增 `addFolderToWorkspace`、`createWorkspace`、`switchWorkspace`、`removeFolderFromWorkspace`、`renameWorkspace`。`openFolder` 改为「加入当前工作区」（无当前工作区则新建）。watcher 改多根。
2. **`paths.js`**：session 读写加 `workspaces` / `activeWorkspaceId` 字段 + 旧 session 迁移函数；`sanitizeWorkspace` 升级为 `sanitizeWorkspaces`（拒绝相对/受限路径，复用 `isRestrictedRoot`）。
3. **`components/Sidebar.jsx`**：顶部「工作区」标题区 + 工作区切换/管理弹层；文件树渲染多根（每根一个子树）。复用现有 `loadDir`、`useColDrag`、expanded set。
4. **`main/index.js`**：watcher 多根；launch folder arg →「加入工作区」语义（保留单实例、restricted-root 守卫）。
5. **`i18n.jsx`**：`workspace.title` / `workspace.new` / `workspace.switch` / `workspace.addFolder` / `workspace.removeFolder` / `workspace.rename`（zh + en）。
6. **`lib/menuHandlers.js` + 菜单**：「新建工作区」「打开文件夹(加入)」命令。

### 验收
- 打开文件夹 A → 侧边栏顶部「工作区」+ A 的树；再「打开文件夹」选 B → B 作为第二棵树加入（A 不消失）。
- 「新建工作区」→ 创建空工作区，可往里加文件夹；切换工作区后文件树整体换；切回仍记得各 root 的展开态。
- 关窗重开 → 工作区列表 + 当前工作区 + 各自文件夹根都恢复。
- 旧 session（单 workspace）打开后自动迁移成一个工作区，不丢。
- 单文件夹场景（只一个工作区、一个根）外观/行为不回归（文件树、打开文件、查找、保存、审阅、watcher、移动端都正常）。
- macOS + Windows 都行（路径分隔、restricted root 守卫不破）。

### 风险 / 不影响现有
- watcher 多根：必须复用现有 crash-proof 守卫（绝对路径、`isRestrictedRoot`、error handler、unhandledRejection 兜底）——别回退 #记忆 horsemd-desktop-build-mac/watcher 那套。
- 文件树多根改动较大，要保证单根场景零回归（用旧 session 跑一遍 manual-test-checklist）。
- 移动端（Capacitor）可能没有文件夹工作区概念，按 capabilities 隐藏入口。

---

## 功能 2：飞书式斜杠菜单（/ 命令增强）

### 现状
- Milkdown Crepe 7.21.2 的 `Feature.SlashCommand` + `Feature.BlockEdit`，配 `slashCommandConfig`（`editor-crepe-setup.js` L64）：分 `textGroup` / `listGroup` / `advancedGroup`，每项只给 `label`（i18n）。
- 现象：输入 `/` 弹菜单，但**继续打字菜单就消失/不过滤**（用户反馈）。
- 原因（待实施时验证）：Milkdown slash 每项可配 `keyword` 用于搜索，当前配置只给了 `label`，没给 `keyword` → 打字匹配不上 → 菜单空/关闭。

### 目标（飞书式）
- 输入 `/` 弹出**完整菜单**（所有分组项）。
- `/` 后继续打字，菜单**不消失，实时过滤**：
  - `h1` / `H1` / `标题1` / `标题 1` / `#` → 标题 1
  - `有序` / `有序列表` / `ol` / `1.` → 有序列表；`无序` / `无序列表` / `ul` / `-` → 无序列表
  - `图片` / `image` / `img` → 图片；`代码` / `code` / ` ``` ` → 代码块
  - 英文输入同样有效（heading/text/list/image/code/table/quote/divider/math…）
- 选中后插入对应块，`/` + 查询文本被消费；Esc / 退格回到 `/` 前关闭。

### 设计（两条路径，实施时先验路径 A，不够再 B）

**路径 A（最小，优先）**：给每个 slash 项配 `keyword` 数组（中英文别名 + 缩写 + markdown 符号），用 Milkdown 原生搜索。
- 关键词表（双语，放 `editor-crepe-setup.js` 或独立 `editor-slash-keywords.js`）：
  - `h1`: 标题1/标题 1/一级标题/heading 1/h1/#
  - `h2`…`h6`: 同模式
  - `text`: 文本/正文/段落/text/paragraph/p
  - `quote`: 引用/引用块/quote/blockquote/>
  - `divider`: 分割线/分隔线/divider/hr/---
  - `bulletList`: 无序列表/项目列表/bullet list/ul/-/*
  - `orderedList`: 有序列表/数字列表/ordered list/ol/1.
  - `taskList`: 任务列表/待办/task list/todo/[]
  - `image`: 图片/image/img/图/![]
  - `codeBlock`: 代码/代码块/code/codeblock/```
  - `table`: 表格/table/表格
  - `math`: 公式/数学/math/$$
- 路径 A 成立的前提：Milkdown 7.21.2 的 slash ① 支持 `keyword` 字段；② 输入 `/` 后打字是「过滤」而非「关闭」。

**路径 B（A 不够时）**：自定义 slash 菜单组件。
- 关闭 Milkdown 原生 slash 的「打字关闭」，改用自绘浮动菜单（参考 `editor-dom-bindings.js` 里 selection-toolbar / slash-menu bounds 的定位方式 + `editor-math-preview.js` 的 ProseMirror 插件监听光标）。
- 自绘菜单组件：监听 `/` 后到下一个空白前的文本作为 query，对关键词表做模糊匹配（含中文拼音可选用 `pinyin` 还是先不做），实时重渲染候选。
- 这条路工作量大、回归风险高，只在 A 确认不足时走。

> 飞书参考：飞书斜杠菜单 = 全量候选 + 输入实时模糊过滤 + 中英文/别名/符号都认 + 高亮匹配位 + 键盘上下选择。我们首版做到「实时过滤 + 中英文别名 + 符号」即可，高亮/拼音可后置。

### 怎么做（实施步骤 / 文件）
1. **验证（实施第一步）**：在 `editor-crepe-setup.js` 给一项加 `keyword`，跑起来确认打字是否过滤。决定 A / B。
2. **路径 A**：
   - `editor-crepe-setup.js`：`slashCommandConfig` 每项加 `keyword` 数组（从关键词表取，i18n 提供中英文）。
   - `i18n.jsx`：每项加 `keywords` 数组字段（zh/en 各一份）。
   - 验证菜单打字过滤、选中插入、查询文本消费、Esc 关闭。
3. **路径 B（仅 A 不足）**：
   - 新增 `editor-slash-menu.js`（自绘浮动菜单 + 模糊匹配 + 键盘导航）。
   - `editor-crepe-setup.js`：关原生 slash 的打字关闭（或换 feature 配置）。
   - `editor-dom-bindings.js`：挂载菜单定位/边界（复用 slash-menu bounds 逻辑）。

### 验收
- 输入 `/` → 弹出完整菜单（标题 1-6、文本、引用、分割线、有序/无序/任务列表、图片、代码、表格、公式）。
- `/h1`、`/H1`、`/标题1`、`/标题 1`、`/#` → 都能筛出「标题 1」；回车插入 H1 并消费 `/h1`。
- `/有序`、`/有序列表`、`/ol`、`/1.` → 有序列表；`/无序`、`/ul`、`/-` → 无序列表。
- `/图片`、`/image`、`/img` → 图片；`/代码`、`/code` → 代码块；`/表格`、`/table` → 表格。
- 纯英文 `/heading 2`、`/code`、`/image` 同样有效。
- 打字时菜单不消失，候选随输入收窄；清空查询回到全量。
- Esc 关闭；退格删掉 `/` 关闭；选中项后光标在新块内、可继续编辑。
- 不回归：现有 slash 插入、selection toolbar、代码块 Tab、Mermaid/LaTeX、复制粘贴、模式切换、查找保存审阅。

### 风险 / 不影响现有
- 路径 A 风险低（只加 keyword）。路径 B 风险中（自绘菜单 + 键盘事件，容易和现有 keymap/toolbar 冲突）——优先 A。
- 关键词表要覆盖用户原话（"有序"/"无序列表"/"图片"/"代码"/"标题"），不能只给英文。
- 不破坏 Milkdown slash 的插入语义（节点类型必须和现有一致）。

---

## 实施顺序建议（ralph）
1. 先做**功能 2（slash）**：改动小、独立、易验证、用户感知直接。先验证路径 A。
2. 再做**功能 1（多工作区）**：改动大、跨 Sidebar/useFileOps/main/session，做前先把 manual-test-checklist 跑一遍留基线，做完再跑一遍保证单根场景零回归。
3. 每个功能：PRD 细化 → 实现 → build 0 → CDP/手测按验收 → architect 审 → deslop → 回归 → commit。
4. 全程不碰版本号（用户会在需求完成后统一改）。
