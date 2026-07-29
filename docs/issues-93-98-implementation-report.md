# Issues #93, #96, #97, #98 实施与验证报告

## 范围

本轮逐条处理四个独立问题，保持 Crepe 生命周期、Markdown 原文保真、源码/富文本切换、PDF 文档构建和移动端平台契约不变。

## #93 行内代码

旧版已能阻止多个反引号被输入规则吞掉，但输入插件只识别“先输入两个反引号，再输入正文”的特殊路径。用户按标准 Markdown 顺序逐字手打 `` `awdawdwa` `` 时，首尾反引号和中间正文都会留在普通文本节点中，实际没有创建 `inlineCode` mark。此前 UI 自动化也错误地多输入了一个左反引号，并一次性注入正文，没有覆盖真实键盘路径。

修复把输入状态拆为“等待首个正文字符”和“正在编辑行内代码”：第一个左反引号先原样保留，紧接着逐字输入正文时再转换为标准 `inlineCode` mark，右反引号明确退出。仅在编辑态且光标位于该 mark 内时绘制两个 ProseMirror widget；widget 不进入文档、复制结果、Markdown serializer 或 source offset 映射。光标移动、编辑器失焦或输入闭合反引号后自动清除等待/编辑状态，连续普通反引号仍按字面保留。

补充真实“闭合后继续输入”时发现，ProseMirror 已经退出 `inlineCode`，但原文保真映射在行末只能锚定最后一个可见字符，会把新增正文插到闭合反引号之前，源码因而变成未闭合代码。现在行末零宽插入会依据整篇可见字符映射跨过反引号、强调、删除线、链接和关闭 HTML 等不可见闭合语法，同时停在尾随硬换行空格之前。该规则同时覆盖代码、强调和链接，不依赖关键词或局部语法猜测。

## #96 标题间距

此前标题使用固定 `margin-top: 1.75em` 和 `margin-bottom: 0.55em`，段落间距设置无法控制它。新增独立 `headingSpacing` 偏好、范围校验、预设、CSS 变量和实时应用函数。默认值取与旧样式视觉等价且可由 0.1 步进精确表达的 `1.8em`，避免升级后明显改变既有排版；标题后的较小间距按同一变量派生。

设置同时出现在编辑器排版页和状态栏排版面板，设置页真实预览与正文读取同一 CSS 变量。

## #97 PDF

资源状态过去只暴露一个 timeout 布尔值和 failedImages 数量，UI 将两者合成“X 张图片失败”，会把仍在加载写成失败，甚至出现“0 张失败”。现在主进程分别返回总数、仍在加载数和失败数；UI 分别提示，零图片不显示警告。

PDF 预览继续采用每个 renderer 最新请求胜出。被后续设置替代的请求返回 `stale`，renderer 将其视为正常取消，不进入错误状态。真实 UI 测试在首个预览尚未完成、导出按钮禁用时连续切换页眉和页脚，最终只接受最新 PDF。

## #98 复制、撤销与会话恢复

Crepe 代码块按钮原先直接调用浏览器 Clipboard API，HorseMD 的监听器无论实际写入结果如何都会显示“已复制”。现在捕获按钮点击，从对应 ProseMirror `code_block` 读取完整文本，并通过 preload 的原生剪贴板 IPC 写入；成功后才显示反馈。

富文本 copy 的 HTML 通道仍保留内联样式，`text/plain` 改用 Milkdown serializer，避免粗体、行内代码等 Markdown 标记丢失。

Crepe 当前构建已经加载官方 history 插件，Electron 菜单也保留原生 undo/redo role。真实键盘测试证明普通富文本输入可由 `Cmd+Z` 撤销，因此未重复安装历史插件或新增第二套撤销栈。

新增默认开启的 `restoreSession` 偏好。关闭后，`useAppLifecycle` 跳过历史路径和未保存草稿的恢复；打开路径监听仍在 `appReady` 前注册，因此 Finder、资源管理器、文件关联和命令行显式打开不受影响。

## 验证结果

- `npm run test:ui-regression`：7 个共享 Electron 会话 + 11 个独立 UI 场景通过。
- `npm run test:source-map`：6 组 Markdown raw offset 映射通过。
- `npm run test:markdown-preservation`：局部文本和结构保真通过。
- `npm run test:editor-input`：行内代码、行内公式、front matter 通过；行内代码覆盖单个左反引号、正文逐字键入、单个右反引号、闭合后的普通正文和连续三个反引号。
- `npm run test:pdf-export`：保存状态和 latest-task runner 通过。
- `npm run test:security`：主进程权限和 PDF CSP/文档构建通过。
- `npm run test:settings-update`：设置状态合并通过。
- `npm run build`、`npm run build:mobile`：桌面和共享移动 renderer 构建通过。

真实大文档路径在本轮环境中不存在，UI 编排明确跳过该单项；`电脑档案.md` 的 source→rich→source→rich 与 rich→source→rich→source 在 20%、50%、80% 三处共 6 条链路全部通过。
