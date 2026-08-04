# Changelog

## [0.12.67] - 2026-08-04

### Fixed
- **源码 + 预览的光标、滚动与退出** — 修复源码模式和“源码 + 预览”左侧在非空行首显示的加粗光标覆盖首字、看起来无法定位到第一个字符前的问题；光标现完整落在字符边界前。双栏左侧的尾部留白与右侧预览统一，滚动到底时不再比预览多出一大段空白。预览右上角新增明确的“关闭预览”入口，直接返回普通富文本视图。

## [0.12.66] - 2026-08-04

### Changed
- **双栏改为源码驱动预览** — “源码 + 预览”中仅左侧 Markdown 源码可编辑；右侧富文本是只读投影，可滚动、选中和复制，但不显示块柄/格式工具/右键操作，也不会因点击或选择产生未保存状态。退出双栏仍可使用底部“富文本 / 源码”切换。

## [0.12.65] - 2026-08-04

### Changed
- **双栏入口与面板宽度** — “源码 + 预览”从状态栏移至富文本编辑区右键菜单，避免占用常用状态栏空间；双栏两侧不再继承单栏阅读模式的居中最大宽度，源码和富文本均填满各自面板，仅保留一致的工作边距。

## [0.12.64] - 2026-08-04

### Added
- **源码 + 富文本双栏实时预览（桌面）** — 状态栏新增“源码 + 预览”：同一 Markdown 左侧显示原始源码、右侧显示富文本，左侧停止连续输入后实时刷新预览，右侧真实编辑同步回源码。两侧复用同一个标签与已挂载的 Crepe 实例，不会另建编辑器或改变保存语义；拖动中间分隔线可调宽度，滚动按当前可见内容联动。纯文本、未加载富文本的重文档、移动端以及双文件分屏期间会明确禁用该模式。

### Changed
- **查找作用域** — 在“源码 + 预览”中，Ctrl/Cmd+F 现在跟随最近点击的源码或富文本面板，而不会因源码 textarea 可见就始终错误地搜索源码。

## [0.12.63] - 2026-08-03

### Fixed
- **本地 Markdown 链接跳转** — 修复 `[文件](/绝对/本地/路径.md)` 这类裸绝对路径链接在富文本中 Cmd/Ctrl+点击无反应的问题。现支持 POSIX 绝对路径、Windows 盘符路径、UNC 路径、`file://` 和既有相对路径；本地链接只经文件专用 IPC 打开，普通网页链接仍走系统浏览器。
- **富文本未保存提示即时反馈** — 修复富文本刚输入、删除、粘贴或拖放内容后的约 200ms 内，标签灰点、底部状态和保存入口仍误显示“已保存”的问题。现在真实编辑事件会立即显示未保存状态，随后继续使用既有的源码保真序列化链路提交 Markdown；未按保存不会写入磁盘。若用户立刻把内容删回已保存版本，提示会在对账后自动清除。
- **正文转列表的源码保真** — 修复右键把多个普通段落依次转为有序、无序或待办列表时，前一次转换可能只在富文本显示、源码仍保留旧段落的问题；现在每次只修改被操作段落的列表前缀。

## [0.12.62] - 2026-08-02

### Fixed
- **富文本修改无法保存（[#105](https://github.com/BND-1/horseMD/issues/105)）** — 修复富文本中修改或删除内容后点击保存，源码视图、磁盘文件或关闭重开仍回到旧内容的问题。保存与导出现在强制从当前 ProseMirror 文档序列化，而非读取可能尚未被异步通知更新的 Markdown 缓存；已删除内容不会“复活”。
- **长文档 Mermaid 永久加载** — 修复打开含多张 Mermaid 图的 Markdown 时，长流程图可能永久停在“正在渲染图表…”的问题。CodeMirror 会虚拟化长代码块，旧实现错误地只读取当前可见的部分 `.cm-line`，导致图表源码被截断；现在预览与编辑刷新均从完整 ProseMirror `code_block` 取源，并统一处理 CRLF/LF。多图实际渲染改为串行队列，避免竞争 Mermaid 的模块级状态；原始 Markdown 不会被修改。

## [0.12.61] - 2026-08-02

### Fixed
- **Mermaid 手动编辑刷新与保存** — 修复在富文本中修改 Mermaid 源码后，预览停留在旧图或输入中间态的语法错误、保存或重开后又回到旧内容的问题。每个 Mermaid 代码块现在以自身最新源码为准，异步渲染的旧结果不会覆盖新图；保存、源码模式和重开均写入当前图表源码。
- **富文本删除持久化** — 保存和导出改为强制序列化当前 ProseMirror 文档，不再只依赖异步 Markdown 缓存。富文本中已删除的内容不会在源码模式、磁盘或关闭重开后重新出现。

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.12.60] - 2026-08-02

### Added
- **HTML 导出中心** — 新增独立的 HTML 预览与导出工作台，可实时选择简洁、纸张、阅读、夜间主题，调整内容宽度、字号和行高，并决定是否加入文档标题与可点击目录。最终保存复用预览生成的同一份独立 HTML；公式、Mermaid、任务列表、表格和图片使用结构化导出快照，编辑器控件与可执行脚本不会进入结果。
- **Pandoc 文档转换** — 桌面端可检测系统 Pandoc 或手动选择可执行文件，并从文件菜单、命令面板导出 Word、EPUB、LaTeX、OpenDocument、RTF 和纯文本。转换读取当前编辑状态，通过无 shell 的参数白名单子进程运行，支持相对资源目录、两分钟超时、错误反馈和安装引导。
- **AI Phase 0 工程基础** — 参考 VMark 的 Provider 与变更确认边界，新增与界面无关的 AI 请求契约、文档上下文快照、版本校验和 Review-first 变更提案核心。当前版本不开放 AI 界面，也不接收密钥；后续 Provider 接入必须沿用该边界，禁止模型绕过确认直接改写文件。
- **导出保存位置记住** — PDF / HTML / Pandoc 导出的保存对话框默认打开在当前 Markdown 文件所在目录；同一个文件一旦手动改存到别处，之后该文件会默认那个目录，不同文件互不串扰（各自回到自己的文件夹），未命名文档回退到上次保存目录。偏好按文件持久化在 `userData/export-prefs.json`。
- **PDF 紧凑导出密度** — PDF 导出中心新增「排版密度」选择（舒适 / 标准 / 紧凑）。默认「标准」与原有排版逐字一致（`standard` 密度表的每个值都等于此前硬编码的字面量，已有导出零变化）；「紧凑」收紧行高与段落、列表、引用、图片、公式、分隔线间距（实测同一文档约减少 19% 页数，搭配「窄」边距可进一步接近 Typora），「舒适」更宽松。选项按用户习惯持久化（仅记住密度选择，不持久化每篇文档的页眉/页脚/标题/页码范围）。

### Changed
- **文件右键导出子菜单** — 标签页和工作区文件的右键菜单不再随导出格式增加而不断变长；PDF、HTML、Word、EPUB、LaTeX、OpenDocument、RTF 和纯文本统一收进“导出”二级菜单。子菜单支持悬停、点击和键盘操作，靠近窗口边缘时自动向可见区域展开；对未打开文件仍会先挂载当前内容，再进入对应导出流程。
- **导出内容安全边界** — PDF 与 HTML 共用的结构化文档快照会移除脚本、内嵌网页、对象、表单、事件处理器和 `javascript:` 地址；HTML 额外使用严格 CSP 和无脚本预览沙箱。

### Fixed
- **长文档模式切换定位（[#104](https://github.com/BND-1/horseMD/issues/104)）** — 修复富文本段落含行内公式时切换源码会把光标映射到无关段落，以及在 400KB+ 文档中只滚动阅读后切源码偶发回到顶部、切换准备过慢的问题。Markdown 与 ProseMirror 现在用一致的 atom 忽略投影锁定公式所在段落，再以完整字符/atom 序列定位段内光标；无可见光标的阅读切换不再重新解析并映射整篇文档，只用可见视口锚点恢复位置。真实 489KB 长文档验证已覆盖。
- **列表转换源码丢失与内容合并** — 修复富文本中把有序列表右键转为无序列表后，切换源码可能丢失新 marker、把嵌套紧凑列表插入空行/改缩进，以及转换后立即输入的文字被合并或保存后重开结构改变的问题。转换现在在 ProseMirror dispatch 前建立确定快照，只写回当前层级真正变化的 marker；随后输入作为独立局部文字差分提交，不再用 Crepe 的整棵 canonical 列表覆盖用户原文。新增逐字符输入、源码逐字节、真实保存和全新进程重开回归。
- **长代码块复制截断** — 修复超过约 50 行的代码块点击“复制”后，只得到 CodeMirror 当前虚拟渲染的约 30–65 行、丢失后半段的问题。复制链路现在从完整 ProseMirror `code_block` 读取内容，并按文档中的代码块顺序提供完整节点兜底，不再读取虚拟 `.cm-line` DOM；新增 120 行 `settings.json` 原生系统剪贴板回归。
- **PDF 导出目录记忆链路** — 修复 PDF Studio 创建预览时遗漏源文件路径，导致 PDF 实际按“未命名文档”使用全局目录、与 HTML/Pandoc 的按文件记忆语义不一致的问题；文件树右键导出也会传递对应文件路径。导出偏好首次并发读取与连续写入改为共享加载任务和串行写队列，避免罕见的空缓存与偏好文件竞争。
- **文档导出 IPC 校验** — PDF 预览、保存和释放接口现在与 HTML/Pandoc 一样，只接受主窗口 renderer 的请求，补齐文档导出链路的统一安全边界。
- **多图导出丢图（≥10 张）** — 修复含 10 张及以上图片的文档导出 PDF / HTML 时，第 10 张之后的图片被静默丢弃、PDF 报「图片加载失败」的问题。导出快照给每张图生成 `horsemd-pdf-resource-N` 占位符，而资源暂存用子串方式替换，`-1` 是 `-10`～`-19`、`-2` 是 `-20` 的子串，处理前几张时把后续占位符一并破坏，`html.includes` 守卫随后将它们静默跳过（既不暂存也不计入未解析）。占位符改为定宽 `padStart`，互不为子串，碰撞消除；新增 20 张图的资源暂存回归。

## [0.12.47] - 2026-07-31

### Fixed
- **外部纯文本复制保真** — 修复 0.12.46 中从富文本复制正文到文本编辑器会增加段落空行、复制有序列表文字会额外带上 `1. ` 的严重回归。剪贴板现在明确分为三种用途：`text/plain` 只包含用户实际选中的可见文字，`text/html` 保留富文本样式，`text/markdown` 供 HorseMD 内部粘贴恢复 Markdown 结构；富文本中按行显示的普通源码单换行会在纯文本和 HTML 副本中物化为换行，不再粘成一行。代码块复制按钮仍输出完整原始代码。
- **排版宽度实时预览** — 修复“设置 → 外观 → 排版”中编辑区宽度预设和微调滑杆看起来没有反应的问题。旧预览被固定 `680px` 上限截断，导致 700、800、1000px 预设显示成同一宽度；现在按实际页宽比例映射预览页面，拖动期间立即改变正文和两侧留白，松手后持久化并同步到文档。

## [0.12.46] - 2026-07-30

### Added
- **PDF 正文字号** — PDF 导出中心新增 8–24pt 正文字号设置，默认 11pt、步进 0.5pt；标题、表格、代码和间距继续使用相对单位随正文等比调整。原“内容缩放”更名为“整体缩放”，用于同时缩放文字、图片、图表和页面留白，避免与正文字号混淆。
- **源码单换行显示** — 富文本默认按原位置显示 Markdown 段落内的普通单换行，适配从其他编辑器打开的紧凑报告和逐行字段，同时不插入空行、不写入 `<br>`、不修改用户源文件。“设置 → 编辑器 → 编辑”可关闭该显示偏好；Enter 仍创建标准段落，Shift+Enter 仍创建显式硬换行。
- **标题间距设置（[#96](https://github.com/BND-1/horseMD/issues/96)）** — “设置 → 外观”和底部“排版”面板新增独立标题间距控制，可在紧凑、较紧、标准和宽松档位之间切换并细调；只改变 H1–H6 周围留白，不连带修改正文、列表或代码块间距。
- **可选会话恢复（[#98](https://github.com/BND-1/horseMD/issues/98)）** — “设置 → 通用 → 启动”可关闭“恢复上次打开的文档”。关闭后不再自动恢复历史文件和未保存草稿，但 Finder、资源管理器、命令行或文件关联显式打开的文档仍会正常打开。
- **正文块转列表** — 桌面富文本中，右键正文段落并悬停“转换为”即可直接转换为有序列表、无序列表或未勾选的待办清单；操作以右键所在段落为准。
- **跟随系统主题（[#95](https://github.com/BND-1/horseMD/issues/95)）** — 可在“设置 → 外观”开启跟随系统外观，并分别指定日间和夜间使用的内置主题；默认配对为暖光与暖夜，系统切换后即时生效。

### Changed
- **表格内容自适应列宽** — 未手动调整的 Markdown 表格会综合表头和所有单元格内容分配列宽，短编号列保持紧凑、长说明列获得更多空间，不再默认等分。用户长按边界拖动后才切换为固定布局并优先使用持久化列宽；宽表滚动、自动换行设置和移动端行为保持不变。
- **设置中心分类与顺序** — 文档字体、代码字体、字号、行距、段距、标题间距、页宽、自定义 CSS、表格显示和源码字号统一归入“外观”；“编辑器”只保留校对、换行显示、选区工具栏和公式删除等编辑特性。外观页按“主题 → 排版预览 → 自定义 CSS → 表格 → 源码外观”排列，自定义 CSS 不再被表格区隔开。

### Fixed
- **Mermaid 粘贴单实例渲染** — 修复粘贴一段 Mermaid 后被误拆为两个代码块、显示两份预览的问题。历史自动拆分逻辑曾在整段源码任意位置搜索 `flowchart TD`、`sequenceDiagram` 等声明，节点标签包含同名文字时也会被当成第二张图；现在只把真正位于源码行首的声明用于旧内容兜底拆分，并在粘贴事件发生时按目标代码块精确创建第二张图。裸 Mermaid 粘贴会同步保存为一个合法的 ` ```mermaid ` 围栏块，富文本、源码、保存重开保持一一对应。
- **新输入列表与空段落源码保真** — 修复在富文本中逐字输入 `-`、`*` 或 `+` 创建无序列表后，切换源码统一变成 `*` 的问题；输入规则生效前会记录用户实际键入的符号，并只恢复刚创建的列表层级。连续按 Enter 创建空段落时，Crepe 的独立 `<br />` 仅作为编辑器内部占位，源码和磁盘改用空行表示。列表块扫描同时区分松散列表、相邻不同类型列表及 canonical 合并后的同类型列表，新增项目、层级转换和待办转换不会改写或复制相邻列表。
- **PDF 连续设置打印竞态** — 修复长文档中快速调整正文字号、页眉页脚等设置时，旧预览销毁正在打印的隐藏窗口，导致当前预览报 `Failed to generate PDF: Printing failed` 的问题。预览任务现在等待旧 worker 完整清理；进入 `printToPDF()` 后不再强杀窗口，而是自然结束并丢弃 stale 结果，只生成最后一次设置。
- **PDF 表格行距保真** — 修复 PDF 全局正文段落边距误作用于表格单元格内层 `<p>`，导致导出后的每一行比富文本预览明显更高的问题。打印样式现在与编辑器一致地清除单元格内层段落边距，只保留表格自身的字号比例、`line-height` 和单元格内边距，不改变正文段落间距。
- **PDF 表格列宽保真** — 修复富文本中已经按内容分配的短列、长列，在 PDF 预览和导出时被强制铺满页面并近似等分的问题。导出 source 现在记录当前表格的自然总宽度和每列实测比例；紧凑表保持自然宽度，超宽表才收敛到可打印区域并换行，手动调整后的列宽也沿用同一测量链路。最终 PDF 的列起点会与编辑器比例一致，不再由旧的 `table-layout: fixed; width: 100%` 覆盖。
- **任务清单勾选持久化** — 修复富文本中点击任务复选框后只更新当前界面、保存并重新打开又恢复旧状态的问题。Crepe 在 `pointerdown` 阶段更新任务节点并阻止后续兼容鼠标事件；编辑器现在于同一阶段捕获真实用户意图，使勾选和取消勾选都进入既有的原文保真、dirty 与保存链路，磁盘只改对应的 `[ ]` / `[x]` 标记。
- **Mermaid 与预览型内容 PDF 导出** — 修复 Mermaid 在富文本中正常显示、导出 PDF 却退化为源码的问题。PDF source 现在先主动把流程图、时序图、饼图、类图、状态图和 ER 图生成为经过安全清理且保留比例的 SVG，再移除编辑器预览 DOM；LaTeX、任务列表、表格、引用、HTML 和普通代码共用结构回归，语法错误或超时的图表保留源码且不阻止整篇导出。
- **PDF 图片与表格密度（[#101](https://github.com/BND-1/horseMD/issues/101)）** — PDF 生成前会把当前文档已经解析出的本地和网络图片暂存到打印文档旁边，不再要求隔离的隐藏窗口按原地址重新加载；同时修复包含空格、中文或 `%20` 的相对图片路径被二次编码而加载失败。编辑器和 PDF 中的表格内边距、行高改为随文档字号等比变化，并移除 Crepe 单元格内层段落的额外固定留白，小字号表格不再保持异常高的行。
- **模式切换后的即时输入与精确光标** — 修复源码切回富文本后，`90/220/450/700ms` 的布局稳定重试仍会覆盖用户已经开始输入的选区，导致后半段文字跳回上一行、源码段落合并以及再次切换时光标偏移的问题。首次 raw-offset 恢复现在于 layout 阶段同步完成，后续重试在任意真实键盘、输入法或鼠标交互后立即终止；硬换行和行内图片在 ProseMirror 中占用的位置也纳入逐 unit 映射，不再用 `textContent.length` 近似。
- **复杂文档中间段落保真** — 修复文档前部存在 serializer 重新对齐的表格或松散列表时，在后部硬换行段落与代码块之间按 Enter 新建正文，会因“整篇可见行必须一致”的错误前置条件而把新段直接拼到上一行并产生额外空行。结构插入现在只校验相邻两个块，并仅把 canonical 中新增的间隔写入原源码，保留代码围栏、表格和列表的原始写法。
- **行内代码方向键退出** — 输入左反引号和正文后，光标位于行内代码尾部时按 `→` 可直接退出代码格式，位于首部时按 `←` 可向前退出；方向键只跨过视觉边界，不跳过正文字符，也不会写入额外反引号或改变 Markdown 源码。输入右反引号、点击外部和失焦退出仍保持原有行为。
- **行内代码新段落边界与光标** — 修复在包含紧凑单换行、额外空行等非 canonical 写法的文档末尾按 Enter，并以行内代码作为新段首个内容时，切换源码会把整段拼到上一段末尾、光标随之偏移一行的问题。原文保真层会直接替换与 canonical 局部完全一致的最后一行，保留前文原始写法；rich→source→rich→source 均以同一 raw offset 恢复光标。
- **Markdown 字节级保真** — 修复超大文档分块加载后的首次富文本编辑可能丢失、表格单元格文字编辑连带重排整张表、源码 textarea 在 Windows CRLF 文件中只改一个字符却把整篇换行符改为 LF，以及富文本插入附件会用 Crepe serializer 结果覆盖全文的问题。新增 BOM、CRLF、混合换行、Setext 标题、引用链接、实体、HTML、硬换行、表格、代码和公式的真实写盘回归；打开、切换和编辑其他位置不得修改未触碰字节。
- **源码审阅局部写回** — 源码模式给选区添加 CriticMarkup 时只包裹当前选区，不再顺带规范化文档中已有的其他审阅标记。
- **行内代码输入（[#93](https://github.com/BND-1/horseMD/issues/93)）** — 修复按标准顺序逐字手打 `` `awdawdwa` `` 时只得到普通文本，以及输入右反引号后继续键入仍被源码吞进行内代码的问题；输入一个左反引号并继续键入正文后会进入行内代码，输入右反引号后正文可靠退出。行末增量映射现在会跨过代码、强调、链接等行内闭合语法，但保留 Markdown 硬换行空格。连续输入三个及更多普通反引号仍保持原样，编辑装饰不会进入 Markdown 源文件。
- **PDF 预览竞态与资源提示（[#97](https://github.com/BND-1/horseMD/issues/97)）** — 预览生成期间连续修改页眉、页脚、页码等设置时，被替代的旧任务按正常取消处理，不再显示导出失败；资源提示区分“图片仍在加载”和“图片加载失败”，无图片文档不会出现“0 张图片失败”。
- **代码块与富文本复制（[#98](https://github.com/BND-1/horseMD/issues/98)）** — 代码块复制按钮改用 Electron 原生剪贴板桥接并从编辑器文档节点读取完整代码，不再出现提示成功但剪贴板为空或保留旧内容；普通富文本复制的纯文本通道使用 Markdown serializer，保留粗体、行内代码等成对标记。
- **Markdown 原文保真** — 修复富文本中任意编辑后保存会把紧凑列表改成松散列表、替换列表符号，并在标题、段落和列表项之间加入空行的问题。普通文字编辑现在只写回对应字符；列表、表格和标题等结构编辑最多替换受影响的语法块或行，无法可靠映射时保留原文，禁止用 Crepe 的整篇规范化结果覆盖用户文件。源码同步回富文本时的程序化事务也不再被误判为用户编辑。
- **正文换行保存** — 修复在文档末尾按 Enter 输入新正文后，源码只写成单换行、重新解析时两个段落合并的问题。新建正文现在保存为标准 Markdown 段落边界；普通单换行正文只改文字时仍逐字符保留，不会被自动插入空行。
- **输入后立即切源码** — 修复富文本连续输入或换行后立即切换源码时，非受控源码 textarea 使用旧快照，导致刚输入内容暂时消失或落到同一段的问题。切换前现在会同步提交当前 Crepe 文档及原文保真映射，不依赖异步 `markdownUpdated` 的到达时机。
- **空文档换行同步** — 修复新建空文档从默认标题开始手打、每行停顿后按 Enter，未保存直接切源码会把正文并入标题并写入 `<br />` 的问题。仅用于起笔体验的空标题骨架不再污染源码差异基线；Crepe 为末尾空段落生成的 `<br />` 只作为 canonical 占位，不写入用户源码，输入正文后才追加真实 Markdown 段落。
- **正文中间换行同步** — 修复在已有段落与后续标题/正文之间按 Enter 新建段落，切到源码后新文字被拼到前一段、空 paragraph 泄漏为 `<br />` 的问题。现在同时覆盖“回车后立即输入”的单事务和“停顿后再输入”的两阶段事务，只按相邻块边界替换中间间隙；列表、表格、标题、引用和代码围栏仍由各自的结构映射处理。
- **源码切换后的即时输入** — 用户切到源码模式后只要移动了光标或开始输入，后续的延迟位置恢复任务立即停止，不再把光标拉回先前的富文本位置。
- **块操作条统一轨道** — 通过 Milkdown BlockProvider 的原生定位入口，把标题、正文、一级与嵌套列表的“新增段落”加号和拖拽柄统一锚定到正文左边界；不再由 HorseMD 在异步定位后用 `translate` 二次纠偏。窄、宽、全宽布局均保持横向双按钮完整可点，不遮挡文字或被侧栏裁切；滚动时旧句柄会隐藏，列表圆点仍可自然唤醒当前块。
- **块操作条误触发** — 普通文字和彩色/高亮行内 HTML 不再唤起块操作条；一级、二级、三级列表的圆点/序号只负责触发，显示位置始终是同一条编辑区轨道。
- **macOS 无窗口启动** — 关闭最后一个窗口后再次从 Dock、Finder 或关联文件启动，会重新创建窗口，并在渲染器就绪后打开传入文件。

## [0.12.10] - 2026-07-25

### Added
- **Optional selection toolbar** — Settings → Editor → Editing now lets desktop
  writers hide the floating text-selection toolbar. With it off, selecting text
  and right-clicking exposes the same common actions as labelled menu entries:
  bold, italic, strikethrough, inline code, link, highlight, and the complete
  review-markup set (addition, deletion, substitution, highlight + comment).
- **List type conversion** — In desktop rich mode, right-click an ordinary
  bullet or ordered list to convert only its current level to the other list
  type or to a task list. Task lists can also explicitly convert back to a
  bullet or ordered list, removing their checkbox state. Parent and nested list
  levels are left intact.
- **Wide-table wrap preference** — Settings → Editor now provides “Wrap wide
  tables”. It keeps Markdown table columns inside the writing area and wraps
  cell text instead of showing a horizontal scrollbar; the existing readable,
  independently scrollable layout remains the default.
- **Composable Custom CSS snippets** (#81) — Custom CSS is now a named snippet
  list. Snippets can be enabled independently, reordered, renamed, and removed;
  enabled entries layer in list order. Existing single-snippet settings migrate
  automatically. Desktop also exposes a scoped Inspect editor action for finding
  real document selectors without widening renderer privileges.
- **Floating chapter navigator** — desktop documents with headings now show a
  quiet right-edge chapter indicator. Hovering or keyboard-focusing it expands
  to a scrollable heading list; the active chapter follows reading position and
  each item jumps smoothly in both rich and source modes. Long headings truncate
  without widening the writing surface.
- **Mobile read-only mode** — iOS and Android now have a top-bar lock. When
  enabled, rich text, source text, paste, drop, CodeMirror input, block changes,
  and undo/redo cannot change the document; scrolling, selection, copying and
  opening links remain available. Desktop behavior is unchanged.
- **Optional sync User-Agent** — WebDAV and S3 connection forms can now send a
  provider-required client identifier. It is validated and stored with public
  connection settings, never with the encrypted password or S3 secret.

### Changed
- **Compact right-click hierarchy** — When the optional selection toolbar is
  hidden, the context menu now groups text formatting, review markup, and block
  or list conversion behind hover/focus submenus. This keeps the root menu short
  without removing any existing action; submenus reverse direction near the
  right window edge.
- **Editor-style preview coverage** — the Settings preview now contains the
  common inline and block selectors that custom CSS authors actually target:
  headings, emphasis, deletion, links, inline code, keyboard keys, quotes,
  ordered and task lists, tables, and code blocks. Returning from another tab
  keeps the CSS snippet that was being edited selected.

### Fixed
- **YAML front matter boundary** — YAML metadata is now recognized only in the
  standard document-header position. Body separators followed by headings such
  as `Q3:` and `Q4:` remain normal Markdown instead of being misrendered as a
  YAML card.
- **Display-formula writing rhythm** — rendered `$$...$$` blocks no longer
  inherit the generous padding of editable code blocks, so they sit closer to
  the surrounding prose without changing code-block spacing, formula editing,
  equation tags, overflow behavior, or PDF output.
- **Repeated list conversion rendering** — converting the same list back from
  ordered to bullet form now updates Crepe's cached list-item marker state as
  well as its Markdown structure, so rich text and source mode stay in sync.
- **Literal backticks and YAML front matter editing** — Multiple manually typed
  backticks no longer delete earlier delimiters. YAML metadata cards now have an
  explicit rich-mode editor whose changes stay synchronized with source mode
  and saves.
- **PDF code blocks** (#91) — PDF export now converts only blocks explicitly
  marked as LaTeX to MathML. C++, JavaScript, and other fenced code remain
  literal code even when their text resembles a formula.
- **Display-formula scroll controls** — fitting LaTeX blocks no longer expose
  Windows scrollbar arrows. Only formulas whose rendered width actually exceeds
  the preview enable a single horizontal scroll surface; PDF output remains
  editor-control-free.
- **Tagged display formulas** — a block formula containing KaTeX `\tag{...}`
  no longer lets its equation number overlap the formula in rich-text preview.
  The formula now occupies the full LaTeX preview width with a reserved number
  column; PDF export remains unchanged.
- **Windows Command Palette compositing** (#62) — the full-window blur layer is
  now disabled only on Windows, avoiding a GPU/driver-sensitive re-composite
  while hovering or scrolling command results. The dimmed backdrop, keyboard
  navigation, search, and command execution are unchanged; Windows real-device
  confirmation remains tracked in the Issue.
- **Heading letter case** (#63) — H5/H6 no longer force English text to uppercase;
  authored casing is preserved in rich text.
- **Floating outline dismissal** — clicking a right-side chapter item no longer
  leaves its panel pinned open; moving the pointer away collapses it immediately,
  while keyboard focus navigation remains available.
- **PDF resource warning** — a document without images no longer reports that
  resources may be incomplete merely because font readiness took longer than the
  preview wait.
- **Very long display formulas in PDF** — exported block MathML is fitted to the
  printable width by splitting at top-level operators during PDF generation,
  instead of being clipped or proportionally shrunk to an unreadable size.
- **Large-document code-block scroll jump** — code blocks are excluded from
  `content-visibility` height estimation, so scrolling to and selecting a code
  block no longer exposes an estimate-to-real layout jump.
- **Source/rich caret regression coverage** — exact Markdown raw-offset UI
  tests now protect table cells, paragraphs, lists, and code blocks across both
  continuous switch chains.
- **Table row/column editing and save** (#86) — repeated row and column inserts
  no longer splice text into adjacent cells, add phantom rows/columns, or leave
  `<br />` in untouched cells after source switching, saving, or reopening the
  file. Deliberate in-cell line breaks still round-trip as `<br>`.
- **Wide table interaction** (#86) — compact tables retain their natural content
  width and a subtle theme-aware surface, wide tables only scroll when needed,
  and right-clicking a far-right column control no longer snaps the table back
  to its left edge. Hovering an edge keeps the add-row/add-column action clear;
  holding a column boundary enters a thin, real-time resize preview, and release
  persists the final width without affecting ordinary clicks.
- **Inline HTML no longer triggers a block drag handle** — hovering authored
  inline `<font>` or `<span>` formatting, or ordinary paragraph text, no longer
  opens Milkdown's unrelated block handle. The left block-operation gutter
  retains drag and block actions.

## [0.7.4] - 2026-07-20

### Fixed
- **Compact rich-text code blocks** (#80) — fenced code blocks now use the
  document paragraph spacing instead of the larger callout spacing. Syntax
  highlighting, language selection, and copy controls are unchanged.

## [0.7.3] - 2026-07-20

### Fixed
- **Font picker search accepts typing** (#85) — opening either the document-font
  or code-font picker no longer clears a query as the local font list finishes
  loading. The search field keeps focus and filters normally.

## [0.7.2] - 2026-07-19

### Added
- **Cloud sync folders** — desktop Settings now includes a Cloud Sync workflow
  for explicit local-folder registration, WebDAV and S3-compatible connections,
  hidden workspace identity markers, sync previews, directional upload/download,
  bidirectional sync, and conflict-preserving behavior.
- **Outline section reordering** (#82) — on desktop, drag a heading's grip in
  the outline to reorder it together with all of its descendant headings and
  body content. Reordering is limited to siblings, so a subsection cannot be
  silently moved under another parent; untouched Markdown source travels as-is.
- **Editor style customization** (#78, #81) — source mode can now follow the document
  font size with a separate readable offset, and Settings includes a Custom CSS
  editor for small document-style tweaks layered on top of the active theme.
- **Custom keyboard shortcuts** — Settings now includes a Keyboard section with
  shortcut recording, clearing, restore-default actions, conflict warnings, and
  persisted `horsemd.keybindings.v1` overrides. Application shortcuts sync to
  the Electron menu through a restricted IPC path, while renderer shortcuts such
  as tab switching, sidebar toggling, find/replace, and heading level changes
  read the same effective keybinding map.
- **Safer inline LaTeX deletion** (#74) — inline formulas now default to a
  protected delete mode: the first Backspace/Delete selects the formula, and
  the second key press removes it. Settings keeps a fast-delete option for users
  who prefer the previous behavior, and the inline formula editor now includes a
  Clear action.

### Changed
- **Modular Settings center** — the previous monolithic Settings page is split
  into focused General, Editor, Appearance, Files & Images, Keyboard, and About
  modules, keeping existing preferences and defaults intact.
- **Cloud sync local-folder tip** — the Sync folders section now explains that
  cloud sync starts from an existing local folder before choosing or joining a
  cloud workspace.
- **Clearer shortcut conflict feedback** — when a recorded shortcut is already
  used by another command, Settings now marks the edited row and says the
  shortcut was not saved instead of relying only on a page-level warning.
- **Unified editor styling controls** — typography, source font size, and Custom
  CSS now live together under Editor settings, with a small HorseMD-style preview
  that uses the same `.milkdown .ProseMirror` document selectors as the real
  editor.
- **Readable font picker names** (#75) — font dropdown rows now prioritize the
  complete family name instead of a decorative sample; very long names expose
  the full text through the native tooltip while hover preview remains available
  in the typography preview.

### Fixed
- **Windows rich-editor scrolling regression** — medium CJK-heavy documents no
  longer enable rich `content-visibility` only because of raw character count,
  and Windows trims redundant KaTeX MathML DOM in the live editor. This fixes
  scroll and browsing jank in files such as `WhatIf因果推断详细笔记.md` while
  keeping truly huge rich documents on the fast path.
- **Long table PDF printing** — PDF table styles now constrain wide tables to
  the page, wrap long cell content, and allow rows/cells to paginate so long
  tables are not clipped to only part of their content.
- **Launch-file race** — the renderer registers the open-path listener before
  signaling app readiness, so first-launch file arguments do not get lost behind
  the restored welcome/session tabs.
- **External-save conflict warning** — when an open file is saved by another
  application, a clean HorseMD tab still reloads automatically. A tab with
  unsaved local edits now keeps those edits and shows one clear native warning
  instead of silently remaining out of sync.
- **Image descriptions survive rich-text saves** (#84) — standard Markdown image
  alt text such as `![测试图片](image/test.png)` is no longer overwritten with
  the internal default resize ratio `1.00` after switching views or saving.
  Existing resized images written by earlier HorseMD versions remain compatible.
- **List typography follows editor settings** (#79) — line height and paragraph
  spacing now apply consistently to unordered, ordered, and nested lists in
  both the editor and the Settings preview.
- **Preserved untouched Markdown spelling** (#77) — switching to rich text and
  making a local edit no longer rewrites unrelated source formatting such as
  blank lines, tight-list `-` markers, or literal single tildes. Smart Markdown
  paste in rich text now retains the clipboard's original source spelling too.
- **Rendered display LaTeX in PDF export** — paragraph formulas written with
  `$$...$$` are converted from the editor preview into printable MathML before
  PDF generation, so exported PDFs show the formula instead of the LaTeX source
  or editor code-block controls.

## [0.6.5] - 2026-07-16

### Added
- **Precise image and Mermaid lightbox controls** — previews now include
  standard zoom-out/zoom-in buttons, a live scale readout, fit-to-window, and
  1:1 actual-size viewing.
- **Configurable PDF export** (#60, #64) — desktop export now offers A4, A3, Letter,
  and validated custom page dimensions, portrait/landscape orientation, margin
  presets, content scaling, preserved print backgrounds, heading pagination, a printable table
  of contents, PDF bookmarks, headers/footers, dates, page numbers, and ranges.
- **Browser-style PDF preview** — a dedicated export studio renders the actual
  generated PDF with lazy PDF.js pages, zoom controls, live option updates, and
  saves the exact preview buffer instead of rendering a second copy.

### Changed
- **Natural inline-code editing** (#58) — typing an empty backtick pair enters
  inline code immediately, and clicking the rendered trailing edge allows text
  to be appended without making the mark inherit into following prose.
- **Quieter writing surface** — removed the floating paragraph/heading-level
  badge beside the caret while preserving every block conversion path. Its
  selection, mousemove, scroll and layout-measurement listeners were removed too.

### Fixed
- Fixed rich WeChat article paste being flattened when numbered headings were mistaken for Markdown lists; heading levels, inline formatting, paragraphs, and lazy-loaded images are now preserved.
- **Reliable long-running editor actions** — PDF export now prevents duplicate
  submissions, reports failures in-place, and preserves options for retry;
  rich-document loading state is isolated per tab, and Lightbox drag listeners
  are fully removed when the preview closes.
- **Stable PDF preview scheduling** — rapid setting changes now cancel stale
  hidden-window generation and keep only the latest request. File-tree export
  waits for the target tab's explicit editor-ready signal instead of a fixed
  polling window, and temporary preview windows retain Electron's default web
  security policy.
- **Aspect-correct diagram previews** — long or tall Mermaid diagrams and
  images keep their intrinsic proportions in the lightbox instead of being
  placed in a fixed near-square canvas with large empty areas.
- **Natural end-of-document input and web paste paragraphs** — clicking anywhere
  in the visible writing area below rich content, including below the centered
  page container, now opens a new trailing paragraph (or reuses an existing
  empty one) so writing can continue without pressing Enter. Content copied from
  WeChat-style web editors keeps separate visual
  paragraphs instead of collapsing nested `section`/`div` blocks into one.
- **Focused split-pane outline** (#66) — the outline now switches to whichever
  left or right document pane has focus, and outline jumps scroll that pane in
  both rich and source editing paths.
- **Standard bold shortcut** (#67) — `Ctrl/Cmd+B` once again toggles bold in the
  editor. The sidebar shortcut moves to `Ctrl/Cmd+Shift+B` to avoid intercepting
  ProseMirror's standard binding.
- **Stable app viewport and readable wide tables** — the application shell no
  longer rubber-bands into a blank gap, while wide Markdown and raw-HTML tables
  scroll horizontally inside the editor instead of crushing text into narrow
  columns. Markdown table row/column handles and their action menus also remain
  visible and clickable when a tall table is vertically or horizontally scrolled;
  boundary add-row/add-column buttons are no longer clipped in half.
- **Reliable inline LaTeX editing** (#68, #69) — content inserted between a
  pre-typed `$…$` pair, including pure digits, previews live and becomes inline
  math after editing. Reopening an existing inline formula now updates a KaTeX
  preview continuously before confirmation.
- **Block LaTeX focus** (#57) — `$$` and `/math` blocks no longer leave edit mode
  after the first renderable character. `/math` converts the current paragraph
  so the caret starts inside the formula instead of on the following line.
- **File-tree context menu bounds** (#59) — menus near the bottom edge are
  positioned from their measured layout size, keeping Export and Delete visible
  even during the scale-in animation or in a short window.

## [0.6.0] - 2026-07-12

### Added
- **Linux desktop package** — Ubuntu, Debian, and compatible x64 distributions
  can install the official `amd64.deb`. Linux gets its own `.is-linux` styling,
  GTK-style minimize/maximize/close controls, Markdown file association, and
  PNG application icons. The tag workflow builds on Ubuntu, validates the
  package with `dpkg-deb --info`, and uploads the verified artifact to GitHub
  Releases.
- **Feishu-style slash command search** — the `/` menu now filters by Chinese,
  English, aliases, full pinyin, and pinyin initials. Language queries such as
  `/java`, `/python`, or `/mermaid` create a code block with that language
  selected, while short prefixes rank matching languages without flooding the
  menu with unrelated results.
- **Multi-root workspace** — the single unnamed workspace can contain multiple
  folder roots. Opening a folder adds it instead of replacing the current root;
  each root can be removed independently and is protected from accidental
  rename, delete, or drag operations.

### Changed
- **Native mobile text selection** — iOS and Android now use only the system
  selection menu for copy, paste, select-all, lookup, and accessibility actions;
  HorseMD's desktop formatting toolbar no longer overlaps it after a double-tap
  or long-press.
- **Outline starts at a useful depth** — the first two actual hierarchy tiers
  remain visible by default. Documents made entirely of top-level headings stay
  fully expanded, while deeper branches start compact.
- **Workspace controls and empty state** — Add Folder is visually distinct from
  New Folder, the empty state is reduced to one clear action, and the blank tree
  area exposes workspace actions through right-click or double-click.
- **Editor architecture** — source switching, workspace state, Sidebar tree
  state, Review decorations/cards, and main-process IPC domains now live in
  focused modules with their existing public contracts preserved.

### Fixed
- **Source-mode find navigation** — `Ctrl/Cmd+F` now centers the active textarea
  match, keeps a high-contrast highlight visible, and repaints reliably when
  Electron throttles animation frames. Keeping Find open across rich/source
  switches now rebuilds the correct Range/offset backend without losing the
  active result.
- **Rich/source caret and viewport drift** — block-aware raw Markdown offsets,
  dedicated table/CodeMirror selection handling, and keep-mounted rich editors
  preserve both editing carets and reading positions across repeated two-way
  switches, including large image-heavy documents.
- **Source caret visibility** — the source-mode caret is taller, thicker, theme
  aware, and measured against the textarea's final client width so it no longer
  covers text or appears in unrelated blank space.
- **Workspace path safety** — only valid absolute, unrestricted roots are
  restored or watched; root mount points cannot be moved as ordinary folders.
- **Desktop security boundaries** — external navigation accepts only approved
  URL protocols, and local-font permission is restricted to the intended font
  enumeration flow.

### Internal
- Split main-process document, filesystem, watcher, PDF, and security concerns
  into focused modules without changing the preload contract.
- Added source-map, source-find, mode-switch, Review UI, filesystem, watcher,
  PDF, and security regression scripts; CI now runs the core suite before build.

## [0.5.5] - 2026-07-10

### Added
- **Per-tab source/rich view state** (#42) — each document tab now remembers
  whether it is in rich-text or source mode while you switch between tabs. Source
  buffers are tracked separately so switching tabs no longer drops an edited
  source textarea.
- **Attach files from Markdown** (#49) — desktop builds can pick arbitrary
  files, copy them into a sibling `assets/` folder, and insert normal Markdown
  links such as `[report.pdf](<assets/report.pdf>)`. Unsupported platforms hide
  the command through capabilities.
- **Source-readable review markup** — keeps review annotations visible in
  Markdown source, copies AI handoff prompts with the annotated full document,
  and provides Accept All / Reject All cleanup commands.

### Changed
- **Outline folding behaves more like a file tree** — one compact expand/collapse
  control replaces the separate buttons, and folding a parent while reading a
  child heading now collapses the section instead of doing nothing. If the
  active heading is hidden inside a collapsed parent, the visible parent shows a
  contained-active state.

### Fixed
- **Slash command menu clipping** — the `/` menu is clamped into the visible
  editor area and its list height shrinks on small windows, so it no longer gets
  hidden by the app frame or bottom status bar.
- **Source-mode edits after tab switches** — source textarea content is restored
  from the live buffer when remounted, and only genuinely edited source buffers
  are synced back into the rich editor.

## [0.3.1] - 2026-06-28

A big editor polish release: syntax highlighting, smart paste, YAML front
matter, outline improvements, and a batch of community-reported bug fixes.

### Added
- **`==highlight==` syntax** with a **3-color picker** (yellow / red / blue) in
  the selection toolbar. Round-trips as `==text==` (yellow) or
  `<mark class="hm-hl-…">` (red/blue) (#14).
- **Inline HTML rendering** — `<span style>`, `<sub>`, `<kbd>`, `<mark>`, etc.
  render as real DOM instead of escaped text. A remark plugin coalesces fragmented
  open/text/close html nodes into renderable fragments.
- **YAML front matter** — the `---` block at the top of a document renders as a
  structured key/value card instead of a horizontal rule + headings.
  Round-trips cleanly (#8, #15).
- **Smart Markdown paste** — pasting a Markdown document (headings, tables, math,
  code blocks, front matter, mermaid) into the editor now parses and renders it
  with full fidelity, instead of landing as flat text.
- **Adjustable font size, line height, and paragraph spacing** — in the status
  bar's "排版" (Layout) popover, alongside the existing page-width control. Sliders
  apply live (no lag) via direct CSS-variable writes.
- **Collapsible Mermaid source** — Mermaid blocks now use the built-in code-block
  preview mechanism (like LaTeX): the diagram shows by default with a Hide/Edit
  toggle in the toolbar (next to Copy). "Mermaid" is also selectable in the
  language picker.
- **Floating Save button** — appears at the bottom-right only when the active tab
  has unsaved changes; expands on hover to reveal the label.
- **Document stats popover** — word / character / character-without-spaces /
  reading-time in one status-bar button.
- **Outline follows rendered headings** — the outline now lists every heading the
  editor renders (ATX `#`, Setext, HTML `<h1>`), not just ATX, and highlights the
  one you're currently viewing.
- **Removable recent files** — hover a recent-file row on the welcome screen and
  click ✕ to remove it.
- **Slash (`/`) menu localized** — follows the app language (中文 / English),
  including all item labels and group headers.
- **`remark-frontmatter`** dependency for YAML front-matter parsing.

### Changed
- **Code blocks have a dark surface** so syntax-highlighted code reads clearly
  (~6.9:1 contrast, WCAG AAA). Plain tinted code blocks are unchanged.
- **Status bar redesigned** — block-type switcher removed (still via badge /
  toolbar / right-click / shortcuts); font + width merged into one "排版" button;
  word/char/read merged into a stats button.
- **Welcome document** rewritten to showcase highlights, code, Mermaid, and math.
- **Xiaomi / MIUI status bar** — switched Android to overlay:true + real
  StatusBar height inset, fixing the clock/battery overlap on Xiaomi (and
  unifying the approach with iOS).
- **Toolbar injection deduplicated** — shared `editorForToolbar` +
  `appendToolbarItem` helpers; `usePopover` extracted to a shared hook.

### Fixed
- **Inline code "wouldn't stop"** (#10) — text after a closing backtick kept the
  inline-code style; the mark is now non-inclusive.
- **File tree follows the open file** (#11) — auto-expands parent folders and
  highlights / scrolls to the current file.
- **Outline escaped backslashes** (#12) — heading text with `_` no longer shows
  a stray `\`.
- **Desktop white-screen crash** — `capabilities` exposed from preload, not
  assigned onto the frozen contextBridge `window.api`.
- **Mermaid multi-paste** — pasting a second diagram into a mermaid block
  auto-splits into separate blocks; flaky first-render retried once.
- **Pasted images persist** — saved docs write images to `./assets/`; unsaved
  drafts use a global paste folder, relocated on first save.
- **Save slider jank** — layout sliders write CSS variables directly during drag.
- **Slash menu scroll** — `overscroll-behavior: contain` prevents body scroll.
- **Layout popover** — closes on outside click / Escape (shared `usePopover`).

## [0.3.0] - 2026-06-19

HorseMD goes mobile, plus a batch of editor & UI improvements and an important
desktop crash fix.

### Added
- **Mobile apps — iOS & Android.** HorseMD now runs on phones and tablets
  (Capacitor): open / edit / save local Markdown, share & export files out, with
  themes, i18n, outline, and the command palette all working. Android ships as an
  APK on the release page; iOS is built from source (free Apple ID signing).
- **Adjustable font size.** A status-bar control sets the editor body font size
  (presets + fine-tune slider) — combined with the page-width control into one
  **Layout** button.
- **Document stats popover.** The word / character / reading-time counts now live
  in one status-bar button; open it for the full breakdown (words, characters,
  characters without spaces, reading time).
- **Outline follows the cursor.** The outline highlights — and scrolls to — the
  heading you're currently viewing (scrollspy), the way the file tree marks the
  open file.
- **File tree follows the open file** (#11). Opening or switching to a file
  auto-expands its parent folders and highlights / scrolls to it.

### Changed
- **Pasted images become real files, never lost** — pasting or dropping a
  screenshot into a saved document writes it into a sibling `./assets/` folder and
  inserts a short relative link; in an unsaved draft it's parked as a real file
  and moved into `./assets/` on first save (Typora-style). No more giant base64
  blobs in the Markdown, and no more screenshots vanishing after save & reopen.
- **Tidier status bar** — font-size + width merged into one **Layout** button;
  the counts merged into a **stats** button; the block-type switcher was removed
  (block type is still changeable via the floating badge, the selection toolbar,
  right-click, the slash menu, and Ctrl/Cmd+1–6 / Ctrl/Cmd+0).
- **Mobile:** the command palette no longer auto-opens the on-screen keyboard.

### Fixed
- **Inline code "wouldn't stop"** (#10) — text typed after a closing backtick kept
  inheriting the inline-code style; the mark is now non-inclusive, so the caret
  leaves code on the next character (matching Typora).
- **Desktop white-screen crash** — a frozen `window.api` (contextBridge) made the
  desktop build crash on launch; feature capabilities are now exposed from the
  preload instead of assigned at runtime.

## [0.2.0] - 2026-06-14

A big feature release: image hosting, custom themes, diagrams & math, adjustable
page width, in-cell line breaks, an Intel macOS build, and a nicer update prompt.

### Added
- **Configurable image host** — a Typora-style custom upload command. Pasting,
  dropping, or uploading an image runs your command (e.g. `picgo upload`) and
  inserts the returned URL. Configured from a top-bar button (a dot marks it as
  active). Leave it empty to keep images local.
- **Custom themes** — drop a `.css` file (or a whole downloaded theme folder) into
  the themes folder and pick it from the status-bar theme menu, under a **Custom**
  section with **Open themes folder** / **Get more themes** (theme.typora.io). The
  editor exposes Typora's `#write` / `markdown-body` hooks so **Typora themes work
  directly**; subfolders are scanned, and relative `url(...)` assets (fonts/images)
  resolve correctly.
- **Mermaid diagrams** — ` ```mermaid ` code blocks render live as diagrams below
  the editable source (Mermaid is lazy-loaded only when a diagram is present).
- **LaTeX math** — inline `$…$` and block `$$…$$` render via KaTeX.
- **Adjustable editor width** — a status-bar control with preset segments
  (Narrow / Medium / Wide / Full) plus a fine-tune slider.
- **Line breaks inside table cells** — press Enter / Shift+Enter in a cell; it
  round-trips cleanly as `<br>` (GFM tables stay single-line, never corrupted).
- **Update prompt shows what's new** — the "new version available" toast now
  displays the GitHub release notes (auto-loaded), with a slim scrollbar for long
  notes.
- **Intel macOS build** — the macOS target now ships both Apple Silicon (arm64)
  and Intel (x64).
- A project [ROADMAP.md](./ROADMAP.md) (incl. planned Android & iOS).

### Changed
- **Denser tables** — much tighter rows (cell paragraph margins removed, smaller
  padding/line-height) so a Markdown table no longer wastes vertical space.
- Redesigned the update toast (gradient icon, version pills, sectioned release
  notes).
- Website + README document the Intel download alongside Apple Silicon.

### Fixed
- **Table text overflow** — long content / inline code in a cell now wraps instead
  of overlapping the neighbouring column.
- **Long formulas no longer overlap** — display math scrolls within the column.
- **Clicking an image no longer draws a selection frame** — the tint overlay and
  the inline-image outline are removed (resize handle + caption remain the cue).
- **Switching theme no longer drops the page-width / custom-theme setting** —
  `applyTheme` preserves app-managed `hm-*` body classes.

### Internal
- New modules: `settings.js`, `customThemes.js`,
  `components/{ImageHostButton.jsx, editor-mermaid.js, editor-tablebreak.js}`.
- Editor exposes a `getMarkdown` API; theme injection scoped so a custom theme
  owns the writing area while the app chrome keeps its own styling.

## [0.1.7] - 2026-06-10

### Added
- **Split view** — two documents side by side, both fully editable. Open a tab
  into the right pane from its (or a file-tree row's) right-click menu, or toggle
  with the split button in the top bar. **Drag the divider** to resize; **click a
  pane, then a tab** to switch that pane's file (the focused pane is shown by its
  tab underline). The two panes are independent editors that never re-mount, and
  Save / Export act on whichever pane you're editing.
- **Unified right-click menus** — the tab menu and the sidebar file-tree menu now
  offer the same file actions: Copy Path, Copy Name, Reveal in Finder/Explorer,
  Open in Split, Rename, Duplicate, Export as PDF, Delete (plus Close / Close
  Others on tabs; New File / New Folder in the tree).
- **Copy feedback** — the code-block "Copy" button flashes a green ✓ and shows a
  brief "Copied" toast; its label is localized.
- **Heavy documents open instantly** — a Markdown file that would freeze the rich
  editor (a huge run of lines with no blank-line breaks, or > ~400 KB) opens in
  the fast plain-text editor, with a one-click **"Render as rich text"** to load
  the WYSIWYG view on demand.

### Changed
- **Windows installer: the install location is now selectable**, and uninstalling
  *or updating* only removes the files HorseMD shipped — any files you saved
  inside the install folder are left untouched.
- **Cleaner split UI** — a 1px hairline divider, a single faint ✕ (hover-tooltip)
  to close the split, and the focused pane marked by its tab's accent underline
  (the other pane's tab stays subtly underlined).

### Fixed
- **Crash on launch from the recursive file watcher.** A saved workspace that was
  a relative path (e.g. `"."`) or the filesystem root made the watcher recurse the
  whole filesystem — under Finder/launchd the CWD is `/`, so `"."` meant watching
  `/dev`, `/System/Volumes`, … — a flood of `EACCES`/`EAGAIN`/`EBUSY` that aborted
  the app on startup (often seen as an instant crash / black window). The watcher
  now only watches absolute paths, skips the root and system/device trees, doesn't
  follow symlinks, and swallows per-path errors; the renderer ignores a
  non-absolute restored workspace; launch args resolve to absolute (the app's own
  directory is never opened); and a process-level guard catches stray async errors.
- **Tab-menu "Rename" did nothing** — it used `window.prompt`, which Electron
  doesn't support; it now opens a small inline rename dialog.
- **Unsaved scratch / new tabs survive a restart** — untitled tabs with edits were
  silently lost on close; they're now persisted and restored (saved files are
  still reopened from disk).
- **Light-theme code-block selection was unreadable** (near-black-on-black); it now
  uses the soft accent highlight with legible syntax colors.
- **Code blocks no longer highlight the "active line"** on entry/first line — the
  caret alone marks the position.
- **The floating block badge (H1/H2/Text) no longer overlaps the block drag-handle**
  — it tucks to the handle's left so both stay visible.
- **Clicking a table cell no longer shows an out-of-place selection wireframe** — the
  hard blue node/cell outline is removed for tables (the soft cell-range fill stays);
  elsewhere the selected-node ring is a subtle theme accent.
- **Loading skeleton no longer overlaps already-rendered content** (it's cleared
  synchronously the moment content renders, before the heavy post-processing).
- **Typing lag in large / unsaved documents** — session state is no longer
  re-serialized to disk on every keystroke (debounced, flushed on close).
- Main-process update check uses Electron's `net.fetch` (Chromium stack) instead of
  Node's `fetch`, avoiding a c-ares abort on some unsigned-app launches.

### Internal
- Refactored `App.jsx` (1598 → ~1300) and `Editor.jsx` (992 → ~836): extracted pure
  helpers and leaf components (`find.js`, `paths.js`, `ui.js`,
  `components/{Welcome,WindowControls,UpdateToast,RenameModal}.jsx`,
  `components/editor-{html,images,copy}.js`) and deduplicated shared helpers. No
  behavior change.

## [0.1.6] - 2026-06-09

### Changed
- New/empty documents now start as an empty **Heading 1 plus an empty body
  paragraph** below it. The title is there if you want it, but you can skip it
  and start writing body text straight away (click the line below or press ↓).
  Previously the doc was *only* a forced H1, so you couldn't write body without
  first typing a title and pressing Enter.

### Fixed
- Creating / renaming / moving / duplicating to a name that already exists now
  shows a clear "name already exists" message instead of a raw `EEXIST` error,
  and never overwrites the existing file.

### Added
- **Loading skeleton** for large documents — pulsing gray placeholder bars while
  the editor parses/renders, so opening *or switching to* a big file isn't a
  frozen/blank pause. (Creation is deferred one paint so the skeleton actually
  shows before the parse blocks the main thread.) Small files never show it.
- **Double-click an image to view it enlarged** in a lightbox (click the backdrop,
  the ✕, or press Esc to close). Display-only — it never changes the document,
  and a single click still selects the image / edits its caption.
- **Home button** at the top of the activity bar (the app icon) — returns to the
  welcome/landing page while keeping open tabs mounted (clicking a tab goes back).
- **Version number** shown next to "HorseMD" on the welcome page, so you can tell
  which build you're running.
- **Raw HTML tables now render as tables** (like Typora). An HTML `<table>…</table>`
  written in the Markdown is shown as a real, theme-styled table instead of
  escaped source. The Markdown source is unchanged — it round-trips and saves as
  the original HTML (rendering is display-only; `<script>`/inline event handlers
  are stripped).

### Performance
- **Faster startup / session restore.** Restored tabs now mount their rich
  editor lazily — only the active document spins up an editor on launch instead
  of every restored tab parsing its whole document at once. Editors stay mounted
  after first activation, so tab switches remain instant.
- **Smoother typing in large documents.** The floating block-level badge now
  coalesces its layout measurements to one per animation frame (it previously
  forced a synchronous reflow on every caret move / keystroke), and the
  selection-toolbar observer only re-scans when DOM nodes are actually added
  (debounced per frame) instead of on every edit.

### Fixed
- **Closing the window now warns about unsaved changes** (macOS traffic light,
  the Windows close button, Cmd/Ctrl+Q) — previously only closing a tab did.
- Image **caption** text ("Write image caption") is now localized and follows
  the zh/en switch.

## [0.1.5] - 2026-06-08

### Added
- File tree: **drag and drop** files/folders into another folder to move them.
- File tree: the collapse-all button now **toggles** between collapse-all and
  expand-all (recursively expands every subfolder), with a matching icon.
- Selection toolbar buttons now show **tooltips** (Bold, Italic, Strikethrough,
  Inline code, Link).
- Always-visible **collapse / expand sidebar** toggle in the activity bar (the
  icon flips to an "expand" affordance when collapsed).

### Changed
- File-tree typography: larger, non-uppercase folder-name header and slightly
  larger row text for better legibility (especially CJK names).

### Fixed
- **Find (Ctrl+F) rewritten** to search only the editor content via the CSS
  Custom Highlight API: it no longer matches the text typed in the find box, and
  next/previous are instant (no IPC round-trip). Shows a live `x/total` count.
- **Uninstall no longer deletes user files.** The uninstaller now removes only
  the files HorseMD installed, so a document saved inside the install folder
  (e.g. a Markdown note next to the app) is preserved instead of being wiped by
  a blanket recursive delete. The install location is also fixed to a dedicated
  per-user folder so the app can't be installed into a folder of your own files.
- The title bar always keeps a draggable area to move the window, even when many
  open tabs fill the whole tab strip.

## [0.1.4] - 2026-06-08

### Added
- Floating **block-level badge** that tracks the caret, naming the current block
  (H1…H6 / 正文) beside the text.
- Sidebar right-click: **Duplicate** a file, and **Export as PDF**.
- Custom Windows caption buttons (minimize / maximize / close) with hover states
  (close turns red), replacing the native overlay.
- Explorer **"Open with HorseMD"** entry on folders — opens a directory as a
  workspace; the app now accepts a folder path on launch.
- **Notify-only update check**: on launch, looks up the latest GitHub release and
  shows a dismissible "new version available" toast.
- Inline **confirm (✓) / cancel (✗)** buttons on the create & rename fields, and
  an "empty folder" hint when an expanded directory has nothing to list.

### Changed
- Source/rich toggle now **keeps the scroll position** and no longer rebuilds the
  background editors, so switching is much faster.
- Shorter executable description ("HorseMD Markdown Editor") so the Explorer
  "Open with" name isn't a long sentence.

### Fixed
- New file/folder creation now commits on blur (clicking away no longer loses the
  typed name).
- The unsaved-close confirm dialog and a couple of error messages are now
  localized (zh/en).

## [0.1.3] - 2026-06-07

### Fixed
- Open files now reliably auto-refresh when changed by another program: the
  single-file watcher polls (surviving "atomic replace" saves used by many
  editors/tools), and the editor remounts on reload so the new content actually
  shows.

## [0.1.2] - 2026-06-06

### Added
- Export the current document to **PDF** (File → Export as PDF…, `Ctrl/Cmd+Shift+E`,
  or the command palette). Renders a clean, print-styled copy without editor
  chrome (code-block toolbar, table handles, etc.).

### Changed
- Writing font in the editor now matches the website — a sans-serif stack
  (Helvetica Neue / PingFang SC …) instead of the previous serif.
- Status bar now keeps the right-side controls (block/source toggles, theme,
  language, GitHub) fixed and visible when the window narrows — the file path
  collapses (ellipsis) instead of the buttons being hidden or pushed off-screen.

### Fixed
- New-file naming overwrote the input when typing digits (the name was reselected
  on every keystroke) — the name is now preselected once.
- Editor placeholder now follows a language switch live (was baked in at create).
- Opening a moved/deleted file no longer dumps a raw IPC error — the dead entry
  is removed from Recent with a friendly message; session restore skips missing
  files silently.

## [0.1.1] - 2026-06-05

### Added
- Top-bar `+` button to create a new file, and a GitHub link in the status bar.
- Plain-text files (`.txt`) open in a fast plain-text editor instead of the
  Markdown WYSIWYG.
- macOS packaging (dmg + zip) and a native macOS title-bar layout.
- Bilingual README (English + 简体中文) with screenshots and a theme gallery; `CLAUDE.md`.
- MIT `LICENSE`, CI build check + tag-triggered release packaging, `CONTRIBUTING.md`,
  `SECURITY.md`, and issue templates.
- Explicit Electron security flags (`contextIsolation`, `nodeIntegration`) and a navigation guard.

### Fixed
- Status-bar theme/language menus were clipped by `overflow:hidden` and looked
  unclickable — they now open correctly.
- Large `.txt` files no longer hang the editor (they bypass Markdown parsing).
- Rename now preselects the filename without its extension, like new-file.

## [0.1.0] - 2026-06-05

### Added
- Initial release: tabbed, Typora-style WYSIWYG Markdown editor.
- Folder workspace with file-tree sidebar, command palette, outline panel.
- Dark/light themes, session restore, single-instance file association.
- Windows NSIS installer and macOS dmg/zip packaging.

[Unreleased]: https://github.com/BND-1/horseMD/compare/v0.12.46...HEAD
[0.12.46]: https://github.com/BND-1/horseMD/compare/v0.12.10...v0.12.46
[0.12.10]: https://github.com/BND-1/horseMD/compare/v0.10.4...v0.12.10
[0.7.2]: https://github.com/BND-1/horseMD/compare/v0.6.5...v0.7.2
[0.6.5]: https://github.com/BND-1/horseMD/compare/v0.6.0...v0.6.5
[0.6.0]: https://github.com/BND-1/horseMD/compare/v0.5.5...v0.6.0
[0.5.5]: https://github.com/BND-1/horseMD/compare/v0.5.2...v0.5.5
[0.2.0]: https://github.com/BND-1/horseMD/compare/v0.1.7...v0.2.0
[0.1.7]: https://github.com/BND-1/horseMD/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/BND-1/horseMD/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/BND-1/horseMD/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/BND-1/horseMD/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/BND-1/horseMD/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/BND-1/horseMD/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/BND-1/horseMD/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/BND-1/horseMD/releases/tag/v0.1.0
