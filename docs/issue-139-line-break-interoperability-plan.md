# Issue #139 换行互操作修复方案

日期：2026-09-23。起点：本地/安装版0.13.226。状态：方案已建立，以下修复与验收尚待执行。

## 证据与范围

反馈：Windows、0.13.205，“不认别的软件中的换行，自已的换行也只有软件自已认”。未取得反馈人的原始文档及另一款软件名称，不将本次Mac隔离复现冒充Windows原生联测，不自动关闭Issue。

实际安装版0.13.226的两轮隔离诊断记录位于系统临时目录 `horsemd-139-matrix-eODlJ6/result.json` 与 `horsemd-139-verified-GI6lsj/result.json`。已确认：

1. 全选含列表的混合文档，`copiedPlainText`进入`listAwarePlainText`后用`textContent`拼接，列表内的软/硬换行以及列表外正文的换行消失；单独选中文字可能不走这个分支，因此不能用单段测试代表全选。
2. `flattenListItemContents`拆除列表项内所有块包装，把`<p>甲</p><p>乙</p>`直接拼接，HTML副本也丢段落边界。
3. 外部HTML依赖`white-space: pre-wrap/pre-line`表达的实际换行在粘贴解析时折叠为空格，粗体保留而换行丢失；随后源码/磁盘/冷重开一致地保存已经损失的内容，所以不会触发同步完整性警告。

上述复制/粘贴相关四个文件与v0.13.205相同。对照通过：普通LF/CRLF单换行文件、单段复制、纯文本两行粘贴、HTML的br/p/div边界、Enter/Shift+Enter保存与冷重开。

## 设计约束

只转换剪贴板副本，不改活编辑器DOM、PM文档、既有源码和保存协调器。只处理已选内容，禁止为复制进行全文重新解析。text/plain只含所选可见内容，只有包含列表结构的选区才提供列表标记；单选列表文字不增标记。text/html保留段落、硬换行、内联marks、列表层级；text/markdown维持现有结构通道。

输入端只将明确的内联white-space声明（及其可证明继承）里的换行实体化为br；normal/nowrap或后代显式重置不得实体化。原生pre/code、已有br、PM内部slice、普通HTML源码缩进、脚本/style内容不作为新增换行来源。不把所有HTML降级为纯文本，不加载不可信远程CSS，不执行剪贴板脚本。若class或外部样式不足以确定含义，保持既有路径并记录限制。

不批量转换作者LF/CRLF，不给文件补空格、br或空段；不以跳过semantic/list-slot/revision检查获得PASS。连续纯文本空行数量、关闭软换行显示后的复制偏好不在这次补丁里改变。

## 实施顺序

先对上轮已验证/已装机的0.13.225–226改动建立明确本地检查点，只逐项暂存本轮相关文件，不带入历史34条untracked；再提交本方案。

A（0.13.227）：复制纯文本的列表路径保留br、块边界、非列表正文、嵌套顺序和选区两端文字；无列表路径和Markdown通道保持。

B（0.13.228）：HTML列表副本仅将首段移到marker同一行，保留后继段落和其他语义块，不再无差别拆掉所有块；避免恢复“编号单独占一行”的旧回归。

C（0.13.229）：聚焦HTML剪贴板的white-space换行转换，并保持marks/链接/表格/代码/图片路径。

每步先有失败断言，再改代码和针对性回归，独立patch版本、更新日志、guide及本地commit。整轮补充集成矩阵后重新构建、安装/Applications/HorseMD.app并带--horsemd-input-trace启动。用户已授权本地安装和退出测试进程；备份旧app，保留配置、原文、旧trace及未跟踪文件。不push、不发布GitHub Release。

## 验收矩阵

- 复制：普通段落、列表文本/整个列表、全选混合文档、反向和跨块选区、软换行/硬换行/连续br、列表多段落、嵌套列表/有序起始值、表格、选区首尾文字、原始代码空行；同时检查plain/html/markdown。
- 粘贴：LF/CRLF、span/p/div的pre-wrap/pre-line、继承、normal/nowrap重置、粗体/链接、已有br、结构化p/div、pre/code、列表/表格、Markdown文本路由及普通HTML缩进负例。
- 用户路径：真实全选与右键复制、原有复制/撤销和122行全量/65行部分代码；粘贴后富文本→源码→保存→fresh-profile冷重开，原文周边字节和换行风格不变，零first divergence。
- 构建/交付：desktop/mobile、guide:check、源码保真合同；核验新包版本/构建文件/asar哈希、当前PID argv和新trace实际落盘。
- Windows：本机没有Windows原生桌面验收结果；测试需可跨平台运行，交付报告明确Mac验证与Windows未验收的边界。

## 规范依据

- W3C CSS Text：https://www.w3.org/TR/css-text-3/#white-space-property （pre/pre-wrap/pre-line/break-spaces保留segment break，normal/nowrap折叠；此处只转换换行，不尝试复刻完整CSS排版。）
- CommonMark 0.31.2：https://spec.commonmark.org/0.31.2/#soft-line-breaks （软换行显示差异不是擅自改写作者源码的理由。）
- 实际依赖：node_modules/prosemirror-view/src/clipboard.ts；外部HTML的parseSlice默认不保留普通文本换行，转换必须在HTML入模之前完成。

## 扩展回归发现：D（0.13.230）必要编号转义

C的完整应用矩阵新增`css-numbered-LF`后严格失败：`1\\. LEFT`原本是合法段落canonical，exact-canonical-baseline调用fresh标点恢复时删除反斜杠，候选重解析为ordered_list，而PM仍为paragraph。证据：临时目录`horsemd-139-ui-c4FMuU/css-numbered-LF-before.json`。这不是CSS输入转换错误，也没有绕过现有校验。

新增独立D：仅在source===previous的精确基线分支，向转换器传递可证明的物理行前缀，保护1至9位数字后的点/右括号+空白。默认fresh转换行为不变；初版全局保护曾被既有“列表中2.文字不加多余转义”测试阻止，已收窄并重跑完整保真通过。新增6类保护、普通行内/小数/未完成输入/代码HTML负例和full-candidate重放，39/39探针通过。局部词法保护修改不涉及Coordinator、保存算法或校验放宽。

## 实施与验收记录

待执行，完成后逐项记录真实commit、版本、测试结果和装机证据。全局P0/P7c、Redis长同步任务不因本次剪贴板修复关闭。
