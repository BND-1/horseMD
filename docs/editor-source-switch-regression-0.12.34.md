# 0.12.34 编辑器源码保真与模式切换疑难问题报告

> 状态：已修复并纳入自动化回归。记录日期：2026-07-29。

## 目的

本报告记录一组表面相似、实际来自不同层级的编辑器故障。它们都可能表现为“富文本和源码不一致”，但不能用同一个关键词锚点或 serializer 兜底处理。后续如果再次出现内容消失、段落合并、光标相差一行或行内代码无法退出，应先按本文的症状索引定位，再运行对应测试。

长期的原文保真合同、模块边界和完整测试矩阵见 [Markdown 原文保真与 Live Preview 架构决策](./markdown-source-preservation.md)。

## 故障索引

| 症状 | 真实根因 | 主要修复位置 | 防回归测试 |
| --- | --- | --- | --- |
| 源码切回富文本后立即输入，后续字符跳回上一行或乱序 | 延迟选区恢复覆盖了用户的新选区 | `useSourceModeSwitch.js`、`editor-dom-interactions.js` | `test-mode-switch-raw-offset-ui.mjs` |
| 富文本中按 Enter 输入了新段，源码却拼到上一段末尾 | 非 canonical 文档的中间块插入错误降级为字符拼接 | `markdown-preservation/paragraphs.js` | `test-markdown-source-preservation.mjs`、`test-paragraph-source-preservation-ui.mjs` |
| 硬换行或行内图片之后切换，光标相差一个位置或一行 | 用 `textContent.length` 近似 ProseMirror 位置，漏算 inline atom | `editor-source-map.js` | `test-editor-source-map.mjs` |
| 新段落以行内代码开头后与上一段合并 | 临时反引号段落没有可见字符锚点 | `paragraphs.js`、`markdown-source-preservation.js` | `test-inline-code-ui.mjs`、`test-paragraph-source-preservation-ui.mjs` |
| `` `text` `` 可以渲染，但方向键无法自然退出 | mark 边界两侧共享一个 ProseMirror position，默认导航没有表达视觉侧别 | `editor-inline-code.js` | `test-editor-inline-code.mjs`、`test-inline-code-ui.mjs` |

## 问题一：延迟恢复覆盖真实输入

### 复现

1. 在源码模式把光标放到硬换行第二行末尾。
2. 切回富文本后不等待，立即按 Enter 并输入 `X`。
3. 分别等待约 140ms 后输入 `Y`、再等待约 140ms 输入 `Z`。
4. 等待一秒，再切回源码。

错误结果可能是 `Y`、`Z` 回到上一段，`XYZ` 顺序异常，或者源码光标相差一行。

### 根因

源码切回富文本后，旧实现只在 `requestAnimationFrame` 和 90、220、450、700ms 定时器中恢复选区。重试原本用于等待图片、代码块等异步布局稳定，但它没有区分“布局仍在变化”和“用户已经开始编辑”。

用户在定时器结束前输入时，后续重试仍会把选区恢复到切换前的位置。于是首个字符可能在新段落，后续字符却被拉回旧段落。这不是 Markdown parser 错误，而是选区恢复任务在编辑期间继续写状态。

旧自动化在每次切换后统一等待约 700ms 才输入，刚好避开全部重试，所以测试通过但真实快速输入失败。

### 修复

- 首次 raw-offset 恢复在 `useLayoutEffect` 中同步执行，使新视图接收输入前选区已经就位。
- 编辑器根节点记录最近一次真实键盘、`beforeinput`、输入法或指针交互时间。
- 一旦交互时间晚于本轮恢复基线，所有剩余重试永久终止，并清除旧 round-trip offset。
- 延迟重试只负责尚未发生用户交互时的布局稳定，不得再覆盖用户选择。

### 不得回退

- 不得改回“全部通过 RAF/定时器恢复”。
- 不得只缩短或增加固定延时；机器性能和图片加载时序不同，竞态仍会存在。
- UI 测试不得在切换后先等待 settle 再覆盖快速输入场景。

## 问题二：复杂原文中的新段落被合并

### 复现条件

文档前部存在 Crepe serializer 会规范化、但用户并未修改的写法，例如：

- 表格分隔行或列宽使用不同数量的对齐空格；
- 紧凑列表与 serializer 的宽松列表不同；
- 原文保留额外空行；
- 编辑点后方紧邻代码围栏。

在后部硬换行段落与代码块之间按 Enter 输入新段，富文本 DOM 正确，但切到源码后新段可能被接到上一段末尾。

### 根因

旧中间块逻辑要求整篇文档的 visible lines 与上一份 canonical 快照完全一致。前部任何无关的表格或列表序列化差异都会令该条件失败，局部结构插入随即降级为普通字符 delta。

代码围栏本身不进入 visible stream。字符映射无法感知“这里是两个块之间的语法间隙”，最终把新段字符接到前一个可见字符后面。

### 修复

- 中间块插入只验证编辑点相邻的前后可见块，不再要求整篇文档一致。
- 对 direct block insertion，比较 previous gap 与 next gap，只提取 canonical 新增的前缀间隙。
- 将新增间隙适配到源文件原有换行风格后插入，不重写后继代码围栏、前部表格或列表。
- 无法证明局部边界安全时继续拒绝改写，不允许用整篇 canonical Markdown 兜底。

### 不得回退

- 不得用全文 visible lines 一致作为局部插入前提。
- 不得把代码围栏等 syntax-only 区域当作普通可见文字。
- 不得用相邻关键词搜索替代块序号和 raw offset；重复文本会命中错误段落。

## 问题三：硬换行和行内节点后的光标偏移

### 根因

ProseMirror 的 textblock 位置长度不等于 `node.textContent.length`：

- 普通字符占一个位置，也出现在 `textContent`；
- `hard_break` 占一个位置，但不出现在 `textContent`；
- 行内图片等 atom 占 ProseMirror 位置，但同样不出现在 `textContent`。

旧映射按文本长度计算本地位置。经过一个 hard break 或 inline atom 后，所有后续位置都会少算，表现为切换后光标偏一个字符；在块边界附近则可能看起来相差一行。

### 修复

`editor-source-map.js` 为 textblock 构建逐单元序列：

- 文本逐字符产生一个 item；
- 行内 atom 产生一个带实际 `pmStart` / `pmEnd` 的 item；
- Markdown raw offset 与 PM position 都通过 item index 双向换算。

新增 inline node 类型时，必须测试其前方、后方和段尾三种位置，不能只测节点本身。

## 问题四：行内代码边界与临时段落

### 临时反引号段落

新段落以行内代码起笔时，首个左反引号可能先被序列化成只有 `\`` 的临时段落，输入第一个正文字符后才变成真正的 `` `f` ``。这个临时段落没有稳定可见字符，旧 visible offset 会把变化锚定到上一段末尾。

当前处理分两层：

- 原始源码与 canonical 基线完全一致时，专用结构规则执行后可以确定性采用 next canonical。
- 全文不一致，但最后一个独立单行块在 source 与 previous canonical 中逐字相同时，只替换该末行，保留前文全部非 canonical 写法。

### 方向键退出

行内 mark 边界左右两侧在 ProseMirror 中是同一个位置。仅清除 `inlineCode` stored mark 虽能让下一次输入进入普通正文，但不会改变等价的 ProseMirror selection；Chromium 因而可能仍把可见 DOM 光标留在 `<code>` 文本节点里，下一次同方向键又被插件误认为再次“退出边界”。

当前在代码尾部按 `→`、首部按 `←` 时保持文档位置不动，只清除 stored mark，并使用 `view.domAtPos(pos, side)` 把 DOM selection 放到对应的正文侧；若该 DOM 光标已在正文侧，后续方向键完全交给浏览器/ProseMirror 原生导航。这样既不会插入隐藏字符、跳过相邻文本，也可以连续用左右键离开代码并继续移动。代码内部和带修饰键的导航继续交给 ProseMirror。

## 验证基线

修复完成后执行：

```bash
npm run test:source-map
npm run test:markdown-preservation
npm run test:paragraph-source-ui
npm run test:inline-code-ui
npm run test:mode-switch-raw-offset-ui
npm run test:source-text-fidelity
npm run test:source-fidelity-ui
npm run test:large-source-fidelity-ui
npm run test:core
npm run build:mobile
npm run build
```

零等待源码切换场景使用 10 个独立 Electron 进程重复验证。打包后的 `0.12.34` 应用还需再次运行模式切换、段落保存重开和行内代码三项 UI 测试，不能只验证开发构建。

## 维护规则

1. 把“源码内容错了”和“光标位置错了”分开采样：同时记录富文本 DOM、canonical Markdown、用户原始源码、PM selection 和 raw offset。
2. 先构造最小竞态，再加入表格、列表、围栏等非 canonical 前缀；小文档通过不代表真实文档通过。
3. 任何定时恢复逻辑都必须有“用户已接管”的取消条件。
4. 原文保真只能改写可证明属于本次操作的最小区域。
5. 测试必须包含零等待操作、跨定时器窗口继续输入、保存重开和双向连续切换。
6. 交付手测前必须重建并安装当前源码对应的应用，校验版本、`app.asar` 哈希和修复标记。
