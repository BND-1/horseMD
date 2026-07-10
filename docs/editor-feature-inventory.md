# Editor.jsx 功能关联清单

> 这份清单是 `src/renderer/src/components/Editor.jsx` 重构前的行为基线。
> 重构后必须按这里的功能面做验证，不能只看构建通过。

## 1. Crepe / ProseMirror 生命周期

- 创建和销毁 Crepe 实例。
- 注册 `markdownUpdated`，同步真实用户编辑到 App。
- 获取 ProseMirror `EditorView`。
- 暴露 `onReady` API 给 App、StatusBar、保存、查找、审阅、源码切换使用。
- 新建空文档时把首块转换成 H1，并补一个正文段落。
- DEV 模式下暴露 `window.__horsemd` 测试钩子。

验证：

- 新建文档、打开文档、切换标签、关闭标签没有白屏或 stale editor。
- 编辑正文后脏状态出现，保存后恢复干净。
- 程序性切换源码/富文本不误触发“已修改”。

## 2. 大文档加载

- 超过阈值时显示 skeleton。
- 超大文档按 chunk 渐进追加。
- 追加期间 suppress `markdownUpdated`，避免 partial doc 回写。
- 加载完成后通知大纲刷新和 loading 状态。

验证：

- 大文档打开不长时间白屏。
- chunk 加载完成后大纲完整。
- 加载期间不把文档误标 dirty。

## 3. Markdown / Remark / ProseMirror 插件装配

- HTML node view 和 inline HTML 合并。
- frontmatter node view 和 mid-doc frontmatter 修复。
- GFM autolink 非 ASCII 修复。
- table cell `<br>` 往返。
- `==highlight==` 高亮 mark。
- CriticMarkup review decorations。
- substitution marker reconstruct。
- strike guard。
- Mermaid split 和 preview renderer。
- LaTeX math 和 inline math live preview。
- CodeMirror Tab 行为。
- toolbar autohide。

验证：

- Markdown 基础语法、表格、代码块、HTML、frontmatter 可正常渲染和保存。
- Mermaid 和 LaTeX 同时存在时都能渲染。
- `==text==` 高亮、review 标记、substitution 不损坏。
- 代码块内 Tab 插入 tab，不重排整行。

## 4. 图片与资源

- 图片上传按钮走 image host / PicGo / local assets / paste folder / data URL fallback。
- 粘贴图片和拖入图片会持久化后插入 image node。
- 已保存文档中的相对图片路径解析为 `file://` 显示。
- caption 占位文案随语言变化。
- 图片双击打开 lightbox。

验证：

- 已保存文档粘贴截图 -> 保存 -> 重开图片仍在。
- 未保存草稿粘贴图片不丢。
- 配了图床命令时仍走图床；失败后有错误提示并本地兜底。
- 相对路径图片显示正常。
- 图片单击/说明输入不被双击 lightbox 破坏。

## 5. 富文本编辑交互

- Ctrl/Cmd+1..6 / 0 切换块类型。
- 右键块菜单。
- selection toolbar 注入标题、高亮、review 按钮。
- 状态栏通过 `setBlock` 改块类型。
- level badge 跟随当前块。
- slash menu 本地化。
- inline code `inclusive:false`，关闭反引号后继续输入应退出 code。

验证：

- 快捷键、右键菜单、toolbar、StatusBar 四条路径改块类型一致。
- 多标签时 toolbar 按钮作用于当前有选区的可见 editor。
- 行内代码闭合后继续输入是正文。

## 6. 复制、粘贴、链接和代码块按钮

- Ctrl/Cmd+点击链接用系统浏览器打开。
- 富文本复制写入带 inline style 的 HTML clipboard。
- CodeMirror 代码块复制按钮有反馈和 toast。
- Markdown 源码粘贴走 Milkdown parser，而不是普通纯文本。
- 粘贴/拖入图片不劫持代码块、input、textarea、caption input。

验证：

- 富文本复制到外部编辑器保留基本样式。
- 代码块复制按钮有反馈。
- Markdown 表格/标题/代码块粘贴后被解析。
- 代码块内粘贴文本不被图片/Markdown handler 误处理。

## 7. Review / CriticMarkup

- `{++ ++}`、`{-- --}`、`{~~ ~> ~~}`、`{== ==}{>> <<}` 渲染为富文本装饰。
- 工具栏插入 review 标记。
- highlight comment margin widgets。
- 接受/拒绝依赖原始 markdown 解析。
- 中文 IME composition 后 substitution 不被 strike rule 破坏。

验证：

- `node scripts/test-strike-guard.mjs`。
- review 标记在富文本显示和源码往返不坏。
- 全部接受/拒绝结果正确。

## 8. Source / Rich 模式切换依赖

- `replaceMarkdown` 把源码改动同步回已挂载 Crepe。
- `restoreMarkdownOffset` 把 Markdown offset 映射到 ProseMirror selection。
- `markdownOffsetFromSelection` 把富文本 selection 映射回 Markdown offset。
- `lastMarkdownRef` 维护当前源 Markdown 供映射使用。
- `sourceModeIds` 让源码/富文本状态按 tab 独立，而不是全局开关。
- `sourceEditedIds` 区分“只是切换视图”和“源码真正编辑过”，未编辑源码切回富文本不能 dirty。
- `liveContentRef` 是 source textarea 重挂后的内容来源，避免切 tab 丢掉未提交源码编辑。

验证：

- 阅读状态切换源码/富文本视口不跳。
- 可见光标编辑状态切换后光标仍可见且位置稳定。
- 源码编辑后切回富文本内容更新，未编辑时不重建、不误 dirty。
- A 标签切源码，B 标签仍富文本；切回 A 仍源码。
- 源码模式编辑后切到其它 tab 再切回，textarea 内容仍在，保存/切富文本都正确。

## 8a. Slash command menu bounds

- `editor-dom-bindings.js` 监听 Crepe slash menu 的显示和定位。
- 菜单安全区 = 当前可见 `.editor-scroll` 与浏览器视口的交集。
- 小窗口或底部触发时压缩 `.menu-groups` 高度，防止被状态栏/窗口边界裁掉。

验证：

- 顶部段落新起一行输入 `/`，菜单完整可见。
- 文档底部新起一行输入 `/`，菜单完整可见且不盖到底部状态栏外。
- 760x460 视口下底部输入 `/`，菜单列表高度收缩且仍可滚动。

## 8b. File attachments

- Desktop: `openAttachments()` + `saveAttachment(docPath, sourcePath)` 复制普通文件到同级 `assets/`。
- Renderer: `attachFiles()` 在当前光标处插入 `[name](<assets/name.ext>)`。
- Source mode 直接写 textarea selection；rich mode 通过 Markdown offset 插入并 `replaceMarkdown`。
- Mobile capability `fileAttachments:false`，不要显示不可用入口。

验证：

- 未保存文档插入附件 → 提示先保存。
- 已保存文档插入 1 个/多个附件 → 文件复制到 `assets/`，链接插入当前位置。
- 重名附件自动加 `-1` 后缀，不覆盖已有文件。

## 9. Lightbox

- 图片 lightbox。
- Mermaid SVG lightbox。
- Esc 关闭。
- Ctrl+滚轮缩放。
- 鼠标拖拽平移，并抑制拖拽后的 click 误关闭。

验证：

- 图片和 Mermaid 点击可打开。
- 缩放、拖拽、Esc、关闭按钮正常。

## 10. Settings / i18n / Spellcheck

- `spellcheck` 属性随设置变化。
- 图片 caption / 上传文案随语言变化。
- placeholder 文案通过 CSS var 随语言变化。

验证：

- 设置里开关拼写检查，富文本正文属性变化。
- 中英文切换后图片 caption placeholder 和主要 editor UI 文案正确。

## 自动验证基线

每轮重构至少运行：

```bash
npm run build
node scripts/test-strike-guard.mjs
```

涉及共享 renderer 或平台能力时追加：

```bash
npm run build:mobile
```

涉及模式切换时追加真实大文档 CDP 验证。

## 已知测试脚本问题

`node scripts/review-markup.test.mjs` 当前在 Node 22 下会因为直接导入 `.jsx`
报 `ERR_UNKNOWN_FILE_EXTENSION`。这不是功能失败，而是脚本加载方式需要后续修正。

## 本轮重构拆分记录

2026-07-10 首轮只做低风险解耦，不改变编辑器行为和外部 API：

- `editor-image-persistence.js`：图片粘贴/拖拽后的本地保存、图床上传和 data URL fallback。
- `editor-criticmarkup-plugins.js`：CriticMarkup substitution 重建、IME composition 修复和 strike guard。
- `editor-api.js`：`onReady` 暴露给 `App.jsx` 的 editor API，包括 Markdown/HTML 导出、review 应用、源码同步和 selection offset 映射。
- `editor-lightbox.js`：图片/Mermaid lightbox 的 Escape、缩放、拖拽平移控制。

拆分后 `Editor.jsx` 从 1602 行降到 1210 行。仍留在 `Editor.jsx` 的大块逻辑主要是
Crepe 初始化/销毁、Milkdown 插件装配、代码块/Mermaid/数学/前置元数据配置、toolbar
扫描和 node view wiring；这些区域相互依赖更密，后续应继续小步拆。

## 本轮验证记录

自动验证：

```bash
npm run build
npm run build:mobile
node scripts/test-strike-guard.mjs
node scripts/test-substitution-headless.mjs
```

CDP 冒烟验证：

- 临时综合文档：富文本初始化、相对图片、代码块、Mermaid、LaTeX、HTML table、review 标记、源码/富文本往返、切换不触发 dirty、图片 lightbox 打开和 Esc 关闭。
- 真实大文档 `/Users/yangtingyi/vibe_everything/置身钉内/MinerU_markdown_置身钉内_14.34.50_2064164636132720640.md`：
  - 阅读状态下 35%、65%、88% 三处源码/富文本往返，滚动比例稳定。
  - 真实鼠标点击光标样本覆盖前段、中段、后段多处，源码/富文本往返后光标仍可见，文本上下文一致。
  - 切换后仍显示已保存，没有因模式切换触发 dirty。

测试注意：

- CDP 里必须筛选可见 `.ProseMirror`，否则会命中隐藏实例。
- 大文档光标测试要用真实 `Input.dispatchMouseEvent` 点击；直接改 DOM selection
  容易绕过 ProseMirror selection 状态，产生假失败。
- 媒体密集视口可能没有可点击文本样本，不能拿来判定光标恢复。

## 第二轮重构拆分记录

2026-07-10 第二轮继续把 `Editor.jsx` 从 1210 行降到 578 行，保留在组件里的只剩：

- React refs/state 和 lightbox/block menu JSX。
- Crepe 生命周期：创建、销毁、ready、chunk append。
- `onReady` API 暴露和 DEV 测试钩子。
- 新空文档标题初始化、spellcheck/i18n 重应用。

新增模块：

- `editor-crepe-setup.js`：集中装配 Crepe featureConfigs、Milkdown ctx 配置、remark/prose 插件、HTML/frontmatter node view、Mermaid/LaTeX/代码块/review/highlight/table break 等编辑器能力。
- `editor-dom-bindings.js`：集中挂载 EditorView DOM 行为，包括快捷键、右键菜单、selection 更新、富文本复制、图片粘贴/拖拽、相对图片路径解析、图片/Mermaid lightbox 触发、caption 聚焦、代码块复制反馈、selection toolbar 扫描。

这个结构下 `Editor.jsx` 是生命周期编排层，`editor-crepe-setup.js` 是 Milkdown
配置层，`editor-dom-bindings.js` 是 ProseMirror DOM 适配层。后续继续拆时，优先从
`editor-dom-bindings.js` 内部按 media/copy/toolbar 分组拆，而不是再压缩
`Editor.jsx`。

第二轮验证：

```bash
npm run build
npm run build:mobile
node scripts/test-strike-guard.mjs
node scripts/test-substitution-headless.mjs
```

CDP 验证：

- 临时综合文档：相对图片解析为 `file://`、代码块复制按钮存在、Mermaid/LaTeX/HTML/review 渲染、源码/富文本往返、切换不 dirty、图片 lightbox 打开和 Esc 关闭。
- 真实大文档：阅读位置 35%、65%、88% 往返，滚动比例稳定；多候选真实点击光标覆盖前段和后段，源码/富文本往返后光标可见、上下文一致、已保存状态不变。
