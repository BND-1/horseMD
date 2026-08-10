# 源码优先 Live Preview 架构迁移计划

> 状态：2026-08-10 已选择“方案一”——保留 Milkdown/ProseMirror，优先完成 transaction→source 迁移；CodeMirror Live Preview 保留为长期备选，不在当前阶段大爆炸替换。
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

## 7. 备选方案验证：事务→源码映射（2026-08-05）

在决定全量重写前，先验证「不换内核、只改同步机制」的备选路线：监听
ProseMirror 原始事务（steps），把每一步直接映射成源码文本编辑，让 Milkdown
的整篇序列化彻底退出关键路径。验证用真实引擎（应用内临时探针 + 无头 CDP
驱动），结论如下。

### 已证明可行

- 每个用户编辑都产生可观察的原始事务，且携带精确信息：`ReplaceStep` 的
  from/to、插入切片文本、首个子节点类型（text / paragraph / heading …）。
- 演进式源码映射器（每步先映射、再应用到自己的源码）下，连续文字输入映射
  递增正确（`追`@18 → `加`@19），退格步骤可识别。
- Enter 分段是独立的块插入步骤（`blockType=paragraph`、空文本），其源码
  编辑形态已确定（在映射光标处插入一个分隔换行，与既有尾换行构成块边界）。

### 暴露的硬点（决定这条路是否成立的关键）

- 结构编辑之后，现有 `pmPosToMarkdownOffset` 无法把「新空段落内的位置」
  映射回演进后的源码（实测返回 14，应为 21——漂移到前一块正文开头）。
  当前映射器是为 canonical-diff 世界设计的，按可见流对齐；空段落插入后
  可见流对不上。事务→源码路线需要一个**专为结构步骤设计的位置映射层**，
  不能直接复用现有 mapper。
- 新建空文档的引导期（空源码上无法映射首屏）需要独立的引导策略。
- `ReplaceAroundStep` 等结构性步骤需要解释。

### 结论

- 原始事务**携带足够信息**（文本、块类型、位置），方向不排除。
- 但它不是零成本：需要写一个「结构步骤 → 源码编辑」的位置映射层（估计
  数百行 + 测试），比换内核小一个数量级，但不是周末补丁。
- 决策：若投入，先做这个位置映射层的独立原型（覆盖打字/Enter/输入规则/
  退格/撤销），跑通后再替换同步层；0.13.x 边界硬化在替换完成前**不撤销**，
  它是当前版本的保命网，替换后自然退役。

## 8. 位置映射层原型验证结果（2026-08-05）

已实现 `src/renderer/src/lib/step-source-mapper.js`（纯模块，无 React/PM
依赖）：维护「块表」（PM 范围 ↔ raw 范围），对每个 ReplaceStep 做块内线性
映射并应用源码编辑；Enter 创建新块、首字建立 raw 跨度、空尾段落折叠回
作者尾部换行；任何无法置信的步骤 **fail-closed**（不动源码）。

验证分两层，全部通过：

1. **纯 Node 单测**（`npm run test:step-source-mapper`）：已有文档引导、
   打字、Enter 分段、新段落输入、退格清空、列表项输入逐字节正确；未知步骤
   类型、未映射位置、引导文本不匹配全部 fail-closed 且源码不动。
2. **真实引擎**（应用内临时探针 + 无头 CDP，探针已移除）：真实 ProseMirror
   事务喂入映射器，与 App 实际保留的源码逐字节对比 —— 打字 `追加`、Enter、
   新段落 `新段`、退格 ×2 后 **FINAL_MATCH=true**，0 失败。之前「Enter 后
   新空段落内位置映射漂移（14 vs 21）」的硬点，由块表（显式块跟踪，而非
   可见流步行）解决。

### 未覆盖（真实实现前需补齐）

- 新建空文档引导（空源码 + 骨架块）——`bootstrapNew` 已留接口。
- 列表输入规则创建步骤（需接入既有 marker 意图捕获）。
- 含行内标记/atom（加粗、图片、公式）的块：线性映射失效，需内联 span 表。
- `ReplaceAroundStep`、多步事务、撤销/重做。

### 决策

路线成立：用块表 + 逐事务应用替代 canonical-diff 是可行的，且核心流程已在
真实引擎上逐字节验证。下一步是按上表补齐缺口（新文档引导、输入规则、内联
atom），每项沿用「纯单测 + 真实引擎探针对比」的验证方式；在全部缺口收敛前，
不替换现有同步层，0.13.x 边界硬化继续作为保命网。

## 9. 0.13.34 迁移期保存合同

用户再次捕获到“第一次保存暂停、稍后重试成功”，证明 canonical-diff 除了真正
歧义外，还存在可见 transaction 与延迟 `markdownUpdated` / pending intent 之间的
稳定窗口。迁移完成前：

- 保存和源码切换先有界 settle，且每次仍通过 fail-closed 保真层；
- 不能以等待超时为理由覆盖作者原文件；
- 持续歧义必须允许另存 live rich recovery copy，避免编辑只存在内存；
- recovery 是生产安全网，不是事务→源码或 Live Preview 已完成的证据。

完整合同见 [`source-sync-save-recovery.md`](./source-sync-save-recovery.md)。

## 10. 方案一正式启动（0.13.35）

已新增统一 transaction observer、原子 plain-text mapper、真实 step trace 和
显式 primary 集成测试。正文、引用、列表项普通文字可在测试模式下完全绕开
canonical diff，并通过源码切换、保存和冷重开逐字节验证。

一次默认接管尝试被完整段落回归捕获：结构 Enter 后的新空块没有 raw 可见锚点，
后续文字可能被映射到相邻段落。因此当前发布构建保持旧路径并默认关闭事务实验，
开发/测试可启用影子或显式主路径；只有每个结构分类完成全部家族门禁后才逐项放行。详细状态机、已证明范围、
失败复盘和回归矩阵见
[`transaction-source-sync-architecture.md`](./transaction-source-sync-architecture.md)。
