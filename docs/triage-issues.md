# 待办梳理：Issue #10 / #11 + 字号 + 粘贴图片丢失

> 历史文档：这是早期一批 issue 的根因、方案和验收记录，不是当前待办列表。新的 AI / 开发者请先读 [ai-handoff.md](./ai-handoff.md) 和 [ROADMAP.md](../ROADMAP.md)，再把本文件作为历史背景参考。

> 本批改动的目标、根因分析与实施方案。**约束:不引入 bug、不影响现有功能;
> 桌面端(Win/mac)与移动端(iOS/Android)共用 renderer,改动需保持两端可用。**

四项:

| # | 类型 | 来源 | 影响端 |
|---|------|------|--------|
| A | Bug | [Issue #10](https://github.com/BND-1/horseMD/issues/10) 行内代码渲染"停不下来" | 桌面 + 移动(共用编辑器) |
| B | 需求 | [Issue #11](https://github.com/BND-1/horseMD/issues/11) 文件树跟随当前文件 | 主要桌面(移动有抽屉文件树) |
| C | 需求 | 可调整字号大小 | 桌面 + 移动 |
| D | Bug | 粘贴的截图保存后重开丢失 | 桌面(移动后续) |

---

## A. Issue #10 — 行内代码 `` `code` `` 渲染停不下来

### 现象(用户描述)
在富文本里输入 `` `测试内容` `` 后这四个字被渲染成行内代码;**只要不换行**,继续
往后输入(如 `123`)会一直被同一个反引号样式包裹,无法"跳出"代码段。

### 根因(已确认,非猜测)
不是 stored marks 的问题——Milkdown 的 `markRule`(`@milkdown/prose`)在套用
input rule 后会 `tr.setStoredMarks(initialStoredMarks)`,正确清掉了输入规则带来的
stored mark。

真正原因:`inlineCode` mark 的 schema **没有设置 `inclusive`**
(`node_modules/@milkdown/preset-commonmark/lib/index.js` ~L222,只有 `code: true`),
ProseMirror 默认 `inclusive: true`。光标停在代码段**右边界**(`` `测试内容`|``)时,
`$cursor.marks()` 会把 `inlineCode` 继承下来,于是新输入的字继续带 code 标记。
这正是"不换行就停不下来"。

> 标准做法:行内代码 mark 应为 `inclusive: false`(prosemirror/tiptap 同此),
> 在右边界输入即跳出代码——也是 Typora 的行为。

### 方案
首选——用 Milkdown `extendSchema` 把 `inlineCode` 覆盖为 `inclusive: false`:

```js
import { inlineCodeSchema } from '@milkdown/preset-commonmark'
const inlineCodeNonInclusive = inlineCodeSchema.extendSchema((prev) => (ctx) => ({
  ...prev(ctx),
  inclusive: false
}))
// crepe.editor.use(inlineCodeNonInclusive) —— 同 id 后注册覆盖原 schema
```

风险点:Crepe 内部已注册过 commonmark 的 inlineCode,需确认"同 id 覆盖"在 Crepe
里生效(Milkdown 的 extendSchema 即为此设计,但 Crepe 包装一层,需实测验证)。

兜底——若覆盖不生效,改用一个自管的 ProseMirror 插件(走现有 `prosePluginsCtx`
注入通道),在 `appendTransaction` 里模拟 `inclusive:false`:光标为空且位于代码段
右边界(前一个字符是 code、后一个不是)时 `tr.removeStoredMark(inlineCode)`。完全
受控、不依赖 Crepe 的插件覆盖顺序。

实测验证:输入 `` `a` `` 后继续打字应为正文;在代码段中间输入仍为代码;加粗/斜体
等其它 mark 不受影响(只改 inlineCode)。

**风险:低。** 仅改 inlineCode 一个 mark 的边界行为,不动序列化/解析,Markdown 输出不变。

---

## B. Issue #11 — 文件树跟随并高亮当前文件

### 现状
`Sidebar.jsx` 已经会给 `node.path === activePath` 的行加 `.active` 高亮
(L314 `isActive`)。**缺的是:** 打开/切换文件时自动展开其所在的各级父目录,并把该
行滚动到可见区域;以及通过搜索/最近文件/内部链接打开文件时也同步定位。

### 方案
全部在 `Sidebar.jsx` 内完成,数据来源是已有的 `activePath`(任何打开途径都会更新它,
所以"搜索/最近/链接"自动覆盖,无需额外接线):

1. **自动展开父目录**:`activePath` 变化时,计算它相对 `workspace.rootPath` 的各级
   祖先目录,逐级 `loadDir` + 加入 `expanded` 集合(已有 `loadDir`/`expanded` 机制)。
   需深度上限 + 仅在 `activePath` 在当前 workspace 内时执行。
2. **滚动到可见**:活动行加 `ref`,在展开后 `scrollIntoView({ block: 'nearest' })`。
3. **设置开关(可选,按 issue 建议)**:`settings.js` 加 `followActiveFile`(默认开),
   状态栏/设置里给一个开关;关掉则只高亮不自动展开滚动。

> 边界:不要因为自动展开把用户手动折叠的目录强行展开得太多——只展开当前文件的祖先链,
> 不动其它目录的折叠状态(用 `setExpanded(s => new Set(s).add(...))` 累加,不覆盖)。

**风险:低。** 纯 UI 行为,不碰文件系统。需防止 `activePath` 频繁变化导致的反复 IPC
(用祖先链已缓存判断,已加载的目录不重复 `readDir`)。

---

## C. 字号调整

### 现状
页宽已有完整范式:`settings.js`(`pageWidth` + 预设 + `applyPageWidth` 写 CSS 变量)
+ `StatusBar.jsx` 的 `PageWidthControl`(按钮→popover→分段预设+微调滑杆)。字号完全
照搬这套即可。

### 方案
1. `settings.js`:加 `fontSize`(默认 16,范围约 12–24)、预设(小/中/大)、
   `applyFontSize(px)` 写 `--editor-font-size` CSS 变量;`loadSettings`/`DEFAULT_SETTINGS`
   /归一化同步。
2. `styles/app.css`:编辑器正文(`.editor-host`/`#write` 等内容区)`font-size` 改读
   `var(--editor-font-size, 16px)`,标题/代码等用 `em` 相对缩放跟随。**只作用于正文内容,
   不动应用 chrome(标签、侧栏、状态栏)的字号。**
3. `StatusBar.jsx`:加 `FontSizeControl`(复用 `PageWidthControl` 的结构与样式类)。
4. `App.jsx`:`applyFontSize(settings.fontSize)` 的 effect(仿 `applyPageWidth`);
   StatusBar 接 `fontSize` / `onSetFontSize` props。
5. i18n:加 `settings.fontSize` 等文案(en+zh)。

> 移动端:字号对手机也有用(默认可略大),保留控件;若状态栏空间紧张,放进已有的
> `MobileMore` popover。需确认自定义主题激活时(`hm-has-custom-theme`)字号变量不与
> 主题打架——优先级处理同页宽。

**风险:低-中。** 主要是 CSS 影响面,需回归:自定义主题、源码模式、代码块、表格、
PDF 导出(导出走主进程独立样式,不读该变量,默认不受影响——需确认)。

---

## D. 粘贴截图保存后丢失

### 现象
边写边截图粘贴进 Markdown,**保存并重新打开后图片全部丢失**。

### 根因
粘贴的图片被插入为内存中的 `blob:`/object URL。`Editor.jsx` 现有的
`onPasteImage`/`onDropImage` **只在配置了图床命令时才接管**(`imageHandlingActive`
要求 `uploadCmdRef.current` 非空);没配图床时图片走默认路径变成 `blob:` URL,
保存进 Markdown 后(`![](blob:...)`)重开即失效。注释里也写了这点:
"without one we'd insert a blob: URL that dies on reload"。

### 方案(桌面为主)
让粘贴/拖入的图片在**没有图床**时也能落地为本地文件(Typora 行为):

1. **主进程新增 IPC `image:save`**`(docPath, name, bytes)`:在 docPath 同级建
   `assets/` 子目录,以唯一文件名(如 `image-<时间戳>.png`,冲突则加序号)写入二进制
   (`fs.writeFile(file, Buffer.from(bytes))`,参考已有 `image:upload`),返回**相对路径**
   `assets/xxx.png`。
2. **preload**`src/preload/index.js` 暴露 `saveImage`;移动端 shim 暂不实现(或后续用
   Capacitor Filesystem 写 `LIB/assets/`)。
3. **`Editor.jsx`** 改粘贴/拖入分支优先级:
   - 配了图床命令 → 走图床(现状不变)。
   - 否则 docPath 存在(已保存文件)→ `window.api.saveImage(...)` 拿相对路径,插入
     `image` 节点 `src="assets/xxx.png"`。现有的相对路径 MutationObserver(`fixImg`)
     会把显示 src 解析成 `file://`,而文档模型/保存的 Markdown 保留相对路径,重开再解析
     → **不再丢失**。
   - 否则(未命名草稿,无 path)→ 无法存相对路径:**插入 base64 `data:` URL** 以确保不
     丢失(随 Markdown 持久化;代价是文件变大),或退而提示"先保存文件再粘贴图片"。
     **此处需你拍板**(data URL 永不丢 vs 提示先保存,保持文件干净)。
4. capability:不需要新开关;按 `docPath` 与平台分支即可。移动端(`!saveImage`)维持现状,
   后续单独处理。

> 注意:capture 阶段已注册(`addEventListener('paste', …, true)`),`preventDefault` 能
> 抢在 Crepe 默认行为前插入我们持久化的 src。相对路径用正斜杠(`resolveToFileUrl` 兼容
> Win 反斜杠)。

**风险:中。** 新增二进制写盘 IPC + 改粘贴主路径。需回归:配了图床仍走图床、拖入多图、
代码块内粘贴不被劫持、未命名草稿的兜底行为。

---

## 实施顺序与测试

建议顺序(由低风险到高风险,逐项验证不回归):

1. **A 行内代码**(最小、纯编辑器行为) → 富文本里手测跳出代码。
2. **B 文件树跟随** → 多级目录打开/切换/搜索打开,确认展开+高亮+滚动,不乱折叠。
3. **C 字号** → 桌面+移动调字号;回归自定义主题/源码/代码块/表格/PDF 导出。
4. **D 粘贴图片**(改动面最大) → 已保存文件粘贴→保存→重开仍在;图床路径不变;草稿兜底。

每项改完:`npm run build`(桌面)确认不破坏;涉及 renderer 的(A/B/C/D 全部)还需
`npm run build:mobile` 验证移动端打包正常。提交按项目规范——**仅在你确认后提交,不擅自
推送;密钥类文件继续忽略。**

### 已确认的决策
- **D-3**:已保存文件 → `./assets/` 相对路径(Typora 默认);**未命名草稿 → base64 data URL
  内嵌**(永不丢,文件略大;移动端同此兜底)。参考了 Typora"已保存走相对 assets、未保存走
  临时区"的模型,这里取其"永不丢失"目标、用 data URL 做最低风险的草稿兜底,不改保存流程。
- **C**:默认 16px,范围 12–24,预设 14/16/18/20。
- **B**:默认开启,不加开关。

---

## 实现状态(均已完成,desktop + mobile 构建通过)

- **A** `Editor.jsx`:导入 `inlineCodeSchema`,`crepe.editor.use(extendSchema → inclusive:false)`;
  并在 create 后对实时 schema 兜底 `marks.inlineCode.spec.inclusive = false`(双保险)。
- **B** `Sidebar.jsx`:`activePath` 变化时自动展开祖先目录链(累加,不打乱其它折叠)+
  活动行 `scrollIntoView`(每个文件只在打开时滚一次)。
- **C** `settings.js`(fontSize + 预设 + `applyFontSize` 写 `--editor-font-size`)、
  `App.jsx`(effect + props)、`StatusBar.jsx`(桌面 `FontSizeControl` + 移动 `MobileMore`
  里的 −/+ 步进)、`icons.jsx`(`text-size`)、`i18n.jsx`、`app.css`(正文+源码读变量)。
- **D** `main/index.js`(`image:save` IPC → 写 `assets/`,返回相对路径)、`preload/index.js`
  (`saveImage`)、`Editor.jsx`(`persistImage`:图床→assets→data URL;粘贴/拖入不再要求图床)。

### E2E 验证结果(已在真实 desktop Electron 上跑通,CDP 自动化)

用 `scripts/etv.mjs` 同款 CDP 手法,以启动参数打开工作区+深层文件,真实键鼠操作验证:

| 项 | 结果 |
|----|------|
| A | 输入 `` `abc` `` 后接 `xyz` → `<code>` 内容为 `abc`(非 `abcxyz`),闭合反引号后即跳出代码 ✅ |
| B | `a/`、`b/` 自动展开,`deep.md` 行 `.active` 且滚动可见 ✅ |
| C | 点 XL 预设 → `--editor-font-size:20px`、正文 computed 20px ✅ |
| D | 粘贴图片插入 `file://…/assets/pasted.png`(非 blob),保存后 md 为 `![](assets/pasted.png)`,磁盘有实体 ✅ |

### ⚠️ E2E 中发现并修复的额外严重 bug(与本批需求无关,属已合并的移动端代码)

`src/renderer/src/platform/index.js` 在桌面端执行 `window.api.capabilities = …`,但
`contextIsolation:true` 下 `contextBridge` 暴露的 `window.api` 是**冻结(不可扩展)对象**,
该赋值抛 `TypeError: object is not extensible`,**导致当前 main 的桌面构建一启动就白屏崩溃**。
移动端合并时只对桌面跑了 `npm run build`(编译)、没真正启动,所以漏掉了。
**已修复:** `capabilities` 改由 `preload/index.js` 直接暴露(冻结对象内,无需运行时赋值);
`platform/index.js` 的桌面兜底分支加 try/catch 防御。**这条必须随本批一起合并,否则桌面发版即崩。**

### 需你在真机/打包应用上验收(构建只验证编译)
1. A:富文本输入 `` `测试内容` `` 后继续打字应变正文;代码段中间输入仍是代码;加粗/斜体不受影响。
2. B:深层目录里打开/搜索/最近打开文件 → 左树自动展开+高亮+滚动到该文件;手动折叠其它目录不被强开。
3. C:状态栏调字号,正文(含标题/代码/表格)整体缩放;应用界面字号不变;源码模式跟随;
   回归自定义主题(主题自带字号时以主题为准)、PDF 导出(走主进程独立样式,不受影响)。
4. D:**已保存**的 .md 里粘贴截图 → 保存 → 重开仍在(图片落在同目录 `assets/`);
   配了图床仍走图床;未命名草稿粘贴 → 以 data URL 保留不丢。
