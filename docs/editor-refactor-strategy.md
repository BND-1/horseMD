# Editor.jsx 重构策略

> 目标：在不改变用户行为的前提下，把 `src/renderer/src/components/Editor.jsx`
> 从大而全的 Crepe 包装器拆成若干职责清晰的小模块。重构必须服务于稳定性和后续开发，
> 不是为了行数好看。

## 当前结果（2026-07-12）

本策略已经完成。`Editor.jsx` 从约 1600 行降到 591 行，保留为 Crepe 生命周期编排层；
图片持久化、插件配置、DOM 绑定、公开 API、源码映射、灯箱、Review 和其他编辑器能力均已
迁入聚焦的 `editor-*.js` 模块。公开 Editor API 和用户行为保持不变。

当前高风险边界不是文件行数，而是生命周期顺序：一处顺序变动仍可能影响保存、脏状态、
光标恢复、图片、Review 或大文档性能。因此后续功能应扩展现有 helper 或新增单一职责模块，
不要把逻辑重新堆回 `Editor.jsx`。

## 重构前判断（历史记录）

`Editor.jsx` 重构前约 1600 行，同时承担：

- Crepe/Milkdown 创建、销毁、配置和事件生命周期。
- Markdown 解析、分块追加、大文档加载状态。
- 图片粘贴、拖入、上传、本地落盘、相对路径修正。
- CodeMirror 代码块、Mermaid、LaTeX、HTML、frontmatter、表格换行等插件装配。
- 审阅标记、工具栏注入、块类型控制、右键菜单、复制样式、图片灯箱。
- 对外暴露 editor API：`getMarkdown`、`replaceMarkdown`、`restoreMarkdownOffset`、
  `markdownOffsetFromSelection`、`applyReviewMarkup` 等。

它的问题不是“长”，而是生命周期密集：一处顺序变动就可能影响保存、脏状态、光标恢复、
图片、review 或大文档性能。因此重构必须小步、可回滚、每步可验证。

## 不可破坏的约束

1. `markdownUpdated` 必须只把真实用户编辑同步给 App；程序性 restore、replace、初始化不能误触发修改状态。
2. Crepe 的 `EditorView` 继续从 `editorViewCtx` 读取，不能回到 `crepe.editor.view`。
3. Milkdown node view 继续通过 `nodeViewCtx` 追加，不能覆盖 `editorViewOptionsCtx.nodeViews`。
4. 大文档分块加载期间不能触发内容回写；加载完成后再恢复结构、大纲和可编辑状态。
5. 源码/富文本切换依赖 Editor API 和 keep-mounted 策略；拆分时不能改变 API 语义。
6. 图片路径在文档模型里保持 Markdown 里的相对路径或远程 URL，DOM 显示层再解析为 `file://`。
7. 代码块、Mermaid、LaTeX、review 都是用户可见核心功能，不能为了拆分牺牲现有行为。
8. 移动端共用 renderer；新增依赖或平台能力要检查 `preload` 与 `capacitor-api` 的差异。

## 拆分原则

- 先抽“纯函数/低状态”模块，再抽生命周期模块。
- 每次只搬一类职责，不顺手改行为。
- App 和 Editor 的通信合同先固化，再搬内部实现。
- 保留 `Editor.jsx` 作为生命周期编排层，最终目标不是清空它，而是让它只负责：
  创建 Crepe、装配模块、管理 React effect、暴露稳定 API。
- 新模块优先放在 `src/renderer/src/components/editor-*.js`，沿用现有命名。
- 单个新模块尽量小于 300 行；超过 500 行说明边界还没拆清楚。

## 推荐分期（已完成的实施记录）

### Phase 0：冻结行为基线

重构前先确认当前 main 分支可用：

```bash
npm run build
node scripts/test-strike-guard.mjs
node scripts/review-markup.test.mjs
```

涉及模式切换时额外跑真实大文档 CDP 测试，至少覆盖：

- 纯滚动阅读，切源码/富文本后视口不跳。
- 可见光标编辑，切源码/富文本后光标仍在原处且可见。
- 源码模式编辑后切回富文本，内容同步且不误保存。

### Phase 1：抽图片与资源处理

候选模块：`editor-image-persistence.js`

搬出内容：

- `persistImage`
- 图床命令 / PicGo / 本地 assets / base64 兜底分支
- 粘贴、拖入图片时需要的文件名、MIME、返回 src 处理

保留在 `Editor.jsx`：

- 事件监听挂载和解绑
- 把返回的 src 插入当前 Crepe 文档

验证重点：

- 已保存文件粘贴图片 -> `assets/` 相对路径 -> 保存重开仍在。
- 未保存草稿粘贴图片 -> data URL 不丢。
- 配置图床命令时仍走图床。
- 粘贴进代码块不被劫持。

### Phase 2：抽插件装配清单

候选模块：`editor-plugin-config.js`

搬出内容：

- remark 插件列表
- prose plugin 列表
- node view 注册 helper
- Mermaid / LaTeX / table break / review / strike guard / substitution 的装配函数

保留在 `Editor.jsx`：

- 创建 Crepe 的时机
- 调用装配函数的顺序
- 和 React props/ref 相关的闭包

验证重点：

- Markdown 基础语法、表格、代码块、Mermaid、LaTeX、frontmatter、HTML。
- review 标记显示和接受/拒绝。
- `nodeViewCtx` 没有被覆盖，图片和代码块 node view 仍正常。

### Phase 3：抽 DOM 行为绑定

候选模块：`editor-dom-bindings.js`

搬出内容：

- 右键菜单
- Ctrl/Cmd 点击链接
- 富文本复制样式
- 图片双击灯箱与 caption 聚焦
- copy button toast
- selection/scroll/focus/blur 的 DOM 监听封装

保留在 `Editor.jsx`：

- 何时绑定、何时解绑
- React state setter 和 toast 的传入

验证重点：

- 右键菜单、链接打开、复制、图片双击、caption 输入。
- 关闭 tab / 切 tab 后监听器不泄漏、不作用到隐藏编辑器。

### Phase 4：抽 Editor API 构建

候选模块：`editor-api.js`

搬出内容：

- `setBlock`
- `getPdfSource`
- `getMarkdown`
- `toggleHighlight`
- `applyReviewMarkup`
- `replaceMarkdown`
- `restoreMarkdownOffset`
- `markdownOffsetFromSelection`

保留在 `Editor.jsx`：

- `onReady(api)` 的调用
- API 生命周期和 stale guard

验证重点：

- StatusBar 块切换。
- 查找替换。
- review 工具栏。
- 模式切换源码映射。
- 保存和导出 PDF。

### Phase 5：收窄 Editor.jsx

当 Phase 1-4 都稳定后，再整理 `Editor.jsx`：

- 顶部只保留 imports、常量和少量生命周期 ref。
- `useEffect` 内只描述“创建 -> 装配 -> 绑定 -> ready -> cleanup”。
- 复杂闭包通过明确参数传入 helper，避免 helper 反向读取 React 状态。

## 每步提交规则

每个 phase 至少一个独立提交，提交前必须满足：

```bash
npm run build
```

按改动面追加：

- 审阅相关：`node scripts/review-markup.test.mjs`
- 删除线 / substitution：`node scripts/test-strike-guard.mjs`
- 模式切换：真实大文档 CDP 测试
- 移动端共享逻辑：`npm run build:mobile`

提交信息建议：

- `refactor(editor): extract image persistence`
- `refactor(editor): extract plugin configuration`
- `refactor(editor): extract dom bindings`
- `refactor(editor): extract editor api builder`

## 暂不做的事

- 不同时重写模式切换、保存流或 review 行为。
- 不引入新的富文本编辑器。
- 不把大文档虚拟化和本次结构重构混在一起。
- 不为了复用强行抽象跨 feature 的通用层。

## Source Mode Hook Contract

`useSourceModeSwitch.js` owns per-tab source view state, rich/source synchronization,
caret-versus-reading intent, round-trip raw offsets, and delayed layout restoration.
It does not render textareas or depend on Find/Outline implementations.

Inputs are stable tab/editor refs plus `commitAllLive`, `findStateRef`, and
`richLoadingRef`. Outputs are limited to `sourceMode`, `sourceRef`,
`sourceTextareas`, `sourceEditedIds`, and `toggleSource`. `EditorArea` remains the
owner of uncontrolled textarea events; App remains the owner of tabs and editor API
registration.

## 接手开发策略

后续新需求按以下顺序处理：

1. 先定位属于平台层、文件层、shell 层、编辑器层还是样式层。
2. 编辑器层需求先判断是否需要 ProseMirror doc、DOM、Markdown 字符串三者互相映射。
3. 涉及大文档、光标、滚动、图片、review 的改动默认高风险，必须加专项验证。
4. 新功能优先写成小模块或 hook，`App.jsx` 和 `Editor.jsx` 只做编排。
5. 完成后把“根因、修复、测试、剩余风险”补到对应 docs，避免下次重复踩坑。
