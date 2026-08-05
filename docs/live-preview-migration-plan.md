# 源码优先 Live Preview 架构迁移计划

> 状态：方向已定（2026-08），待 Phase 1 可行性试验批准后启动。
> 目标：把 HorseMD 从「ProseMirror 文档 + 启发式源码对账」迁移到
> Obsidian/Typora 式「源码即数据模型」的 CodeMirror 6 Live Preview 架构，
> 从根本上消除 canonical/source 保真 bug 家族。

## 1. 为什么必须换

当前架构存在两个表示（ProseMirror 文档 + 原始 Markdown 源码），由
`markdown-source-preservation.js` 用启发式 diff 把 Milkdown 的 canonical
序列化反向映射回源码。canonical 不是稳定中间态：空段落变 `<br />`、
行中 `* ` 变列表、松散/紧凑列表漂移、转义变化……每个文档结构都能让某条
启发式守卫失效，静默回退到通用路径并把内部占位符写进源码。2026-08 之前
连续出现的 `<br />` 泄漏、`-` 变 `*`、标题黏连、空列表项占位，全部是
这个架构的产物——每一次都是「修一条路径，下一个文档结构又触发另一条」。

源码优先模型下，Markdown 文本是唯一事实源，渲染只是文本之上的装饰投影。
编辑直接改源码文本，不存在第二个表示需要同步，这类 bug 从架构上消失。

## 2. 目标模型

- 内核：CodeMirror 6（Obsidian 同款思路）。
- 数据模型：源码文本 = 唯一事实源。保存、导出、查找、光标、视口全部基于它。
- 渲染：通过 CM6 decorations / widgets / block decorations 在非活动行展示
  标题、粗斜体、链接、图片、列表、表格、代码块、公式、Mermaid、Review。
- 模式：源码/富文本不再是两个文档，而是「同一编辑器的渲染开关」——
  关闭 decoration 即源码，开启即所见即所得。光标/视口天然保留，漂移消失。
- 保真：CRLF、BOM、转义、紧凑/松散列表、marker 选择逐字节保留，无需对账。

## 3. 功能盘点（新模型下的实现方式评估）

### 3.1 块级

| 功能 | 现状 | Live Preview 方案 | 难度 |
| --- | --- | --- | --- |
| 标题/段落/引用/分隔线 | Crepe 块节点 | CM6 line decoration + gutter | 低 |
| 无序/有序/任务列表 | 输入规则 + 保真层 | 文本标记即事实，decoration 渲染复选框；Enter/Tab 输入处理 | 中 |
| 代码块 | CM-in-CM node view | 文本行 + decoration，活动行显示原生编辑 | 中 |
| 表格 | 专用 node view + 列宽/增删行 | 文本行 + 表格 widget；列宽拖动/悬浮按钮需自定义 widget | 高 |
| Mermaid / LaTeX display / HTML 块 | 预览 node view | block decoration + 防抖渲染 widget | 中高 |
| frontmatter | 专用编辑 | 文本 + decoration | 低 |

### 3.2 行内

| 功能 | 方案 | 难度 |
| --- | --- | --- |
| 粗体/斜体/删除线/行内代码/链接 | inline decoration（非活动位置渲染，光标处还原文本） | 中 |
| 行内公式 | inline decoration + KaTeX widget | 中 |
| 图片 | inline widget（复用现有上传/灯箱/相对路径逻辑） | 中 |
| HTML 内联 | 文本原样 | 低 |

### 3.3 交互与编辑能力

- 输入规则（`- `、`1. `、`## `、`> `、反引号、斜杠菜单）：CM6 keymap + 文本事务，直接产出用户想要的文本，无需事后对账。
- 查找替换：CM6 原生 selection + 现有 CSS Highlight 思路。
- Review 增删改批注：decoration-based（现有 `editor-review-*.js` 逻辑可迁移）。
- 复制粘贴三通道 + 网页粘贴：文本选区即源码，`text/markdown` 天然正确。
- 软换行显示、拖拽柄/块控制、任务框点击：CM6 decoration + click handler。
- 大文档（120k+、图片密集）：CM6 viewport 虚拟化；需要实测。
- 源码/富文本切换、光标/视口锚点：同一编辑器，无需映射（大幅简化）。

### 3.4 周边集成

- PDF 导出源（`getPdfSource`）：改为从源码文本渲染，语义不变。
- HTML/Pandoc 导出、大纲/滚动跟随、移动端（Capacitor 共享 renderer）、
  i18n、快捷键、设置：接口层复用，内核替换。

## 4. 迁移策略（禁止大爆炸）

### Phase 0：现状冻结
- 现有全量回归（`npm run test:*` UI 套件 + 纯函数探针）作为验收基线。
- 0.13.x 的边界硬化（`<br />` 后置条件、意图基线守卫）已把这族 bug 压到
  很低，为迁移争取时间；迁移期间继续维护现有架构。

### Phase 1：可行性试验（Spike，独立原型，不碰现有编辑器）
- 新建 CodeMirror 6 原型：源码文本 + 标题/粗体/列表/图片 decoration +
  Enter/Tab 输入 + 一个表格 widget。
- 目的：验证 CM6 在 CJK、大文档、表格、代码块上的性能与交互；确认
  Obsidian 式模型在本项目（含移动端 webview）可行。
- 产出：技术验证报告（性能数据、交互差距、风险确认）。**这是是否全量
  投入的决策依据。**

### Phase 2：并轨（新编辑器作为实验模式）
- 新编辑器以实验模式接入（设置开关），Crepe 仍是默认。
- 按 3.x 盘点逐项实现，每项用现有回归测试（改造后）验证。

### Phase 3：覆盖收敛 + 默认切换
- 新编辑器达到现有功能 95%+ 且性能达标后切换默认；Crepe 保留回退开关。

### Phase 4：退役
- 移除 Crepe 与保真层（preservation、source-map、mode-switch 状态机等），
  删除约 1 万行，架构显著简化。

## 5. 风险与关键决策

1. **表格**是新模型最大难点。需决策：Live Preview 下表格做到什么程度
   （纯文本编辑 + 渲染 vs 保留列宽拖动/增删行列/悬浮按钮）。Obsidian 也是
   纯文本表格。
2. **代码块**（CM-in-CM）与 **Mermaid/LaTeX** 预览的性能与防抖。
3. **移动端**：CM6 在 Capacitor webview 的输入法、滚动、长按菜单。
4. **Review 批注**、**任务框点击**、**图片灯箱**等交互的 decoration 迁移。
5. 大文档渲染与分块策略。
6. 迁移期间双编辑器并存：设置、快捷键、PDF、大纲、移动端都要双路适配。

## 6. 结论与建议

- 方向正确，是根治手段；但这是多阶段、跨多周的工程，不能一次完成。
- 建议先批准 **Phase 1 可行性试验**（低风险、不碰现有代码、信息量最大），
  用真实性能与交互数据决定是否全量投入。
- 现有 0.13.x 边界硬化继续维护，确保迁移期间用户可用性不倒退。
