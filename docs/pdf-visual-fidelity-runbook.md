# PDF 视觉保真工程 Runbook

更新时间：2026-07-30  
适用范围：HorseMD 桌面端 PDF Studio、最终 PDF 文件及所有预览型 Markdown 内容

## 目标

当用户反馈“编辑器里正常，PDF 里不一样”时，用同一套可重复流程回答四个问题：

1. 差异发生在哪一层？
2. 是内容丢失、资源失败，还是布局/样式偏差？
3. 修复是否只处理了当前样例，还是保护了同类结构？
4. 最终 PDF 是否真的正确，而不只是中间 HTML 看起来正确？

本 Runbook 不以“构建成功”或“PDF 能打开”为验收标准。视觉问题必须落到最终
PDF Buffer、PDF.js 坐标或像素结果。

## 导出链路分层

```
Live ProseMirror DOM
  ↓ getPdfSource()
结构化 PDF source（HTML / headings / images）
  ↓ 主进程资源暂存与安全模板
隐藏打印文档
  ↓ webContents.printToPDF()
最终 PDF Buffer
  ↓ PDF Studio / 保存文件 / PDF.js
用户实际看到的页面
```

每层的责任不同：

| 层 | 主要责任 | 常见故障 |
| --- | --- | --- |
| Live DOM | 编辑器真实结构、当前列宽和可见预览 | 节点视图未挂载、隐藏 Tab、测到错误编辑器 |
| PDF source | 物化 Mermaid/LaTeX、表格测量、移除控件 | 清理顺序错误、丢 class/style/data、异步快照漂移 |
| 打印文档 | 资源替换、CSP、页面 CSS、页眉页脚 | 全局选择器泄漏、图片二次加载、错误页面尺寸 |
| PDF Buffer | Chromium 最终分页与字体布局 | 分页裁切、缩放、字体替代、坐标与 HTML 不一致 |
| PDF.js/阅读器 | 预览、书签、实际像素 | 只看 Canvas 没检查书签，或只看文本没检查绘制 |

## 先分类，不要先改 CSS

把反馈拆成一个或多个可量化维度：

- **内容**：元素缺失、源码泄漏、最后一行/最后一列消失。
- **资源**：图片、字体、Mermaid 或 LaTeX 未加载。
- **横向布局**：总宽度、列比例、X 坐标、溢出、换行。
- **纵向布局**：行高、margin、padding、Y 坐标、分页数量。
- **交互状态**：PDF Studio 设置未生效、旧任务覆盖新任务。
- **结构**：目录页、书签、页眉页脚、页码范围。

同一句“表格和预览不一样”可能同时包含横向列宽和纵向行距，不能在解决一个维度
后自动关闭整个问题。

## 标准复现夹具

PDF 表格至少准备四类 fixture：

1. **紧凑内容表**：短 ID、中等名称、长说明，验证自然宽度和非等分列。
2. **手动列宽表**：真实长按拖动边界，验证持久化列宽进入 PDF。
3. **多行单元格表**：验证段落 wrapper、`<br>`、行高和 padding。
4. **宽表**：10 列以上、54 行左右，验证分页、最右列和表后正文。

预览型格式还要同时包含：

- 正常与错误 Mermaid。
- 行内和行外 LaTeX。
- 普通 fenced code。
- 本地、远程、中文/空格路径图片。
- 任务列表、引用、HTML 表格。

fixture 应尽量小，但必须能单独触发目标差异。真实用户文档用于最后验收，不应该
成为唯一自动化输入。

## 标准诊断顺序

### 1. 证明编辑器基线

只选择可见编辑器：

```js
const root = [...document.querySelectorAll('.ProseMirror')]
  .find((node) => node.offsetParent)
```

记录目标元素的：

- `getBoundingClientRect()`。
- `getComputedStyle()` 中的 font-size、line-height、margin、padding。
- 表格每列宽度、每行高度和 wrapper 可用宽度。
- 是否存在用户手动宽度标记。

多 Tab 环境禁止直接使用 `document.querySelector('.ProseMirror')`。

### 2. 检查结构化 PDF source

确认：

- 目标内容存在。
- 编辑器控件不存在。
- Mermaid/LaTeX 已物化。
- 表格专用 `data-hm-pdf-*` 和 `<colgroup>` 存在。
- 图片已经变成资源占位符并附带清单。

这一层只能证明转换逻辑，不能作为最终视觉验收。

### 3. 检查打印 CSS 级联

按选择器作用域排查：

- 全局 `.doc p` 是否进入 blockquote、list item、table cell 等嵌套结构。
- 全局 `table` 是否覆盖 measured/wide/content 三类布局。
- `img/svg/math/pre` 是否仍含编辑器控件尺寸或 overflow。
- 新规则是否误伤正文，而不是只作用于目标结构。

优先修复错误作用域，不用 `!important` 掩盖级联来源，也不要为一个 fixture 写死
像素宽高。

### 4. 捕获最终 PDF

测试环境开启：

```js
window.__HORSEMD_TEST_CAPTURE_PDF__ = true
window.__HORSEMD_TEST_CAPTURE_PDF_DATA__ = true
```

从 `window.__horsemdLastPdfPreviewData` 读取 PDF Buffer。PDF Studio 展示和最终
保存使用同一份 Buffer，因此应验证这份数据，而不是重新走另一套导出路径。

### 5. 数值验证最终页面

使用 PDF.js：

- 从 `text.items[].transform[4]` 读取 X 坐标。
- 从 `text.items[].transform[5]` 读取 Y 坐标。
- 比较列起点差值比例，而不是比较绝对页面像素。
- 将 CSS px 换算为 PDF point 时使用 `0.75` 基线，再保留合理字体渲染容差。
- 明确断言不得回到等宽、不得出现额外纵向留白。
- 检查最后一行、最后一列和表后正文仍存在。

不要只断言 `printToPDF()` 返回了非空 Buffer。

### 6. 像素检查

把第一页渲染为 PNG，检查：

- 边框是否完整。
- 文本是否被裁切或重叠。
- 行高和换行是否自然。
- 紧凑表是否被强制铺满。
- 宽表是否仍位于页面内。

自动坐标检查和人工 PNG 检查互为补充，不能相互替代。

## 修改原则

1. **先修责任层**：DOM 转换问题改 `editor-pdf-content.js`，打印样式改
   `pdf-print-styles.js`，资源问题改 `pdf-images.js`，不要跨层堆补丁。
2. **公共 API 不变**：继续通过 `getPdfSource()` 返回结构化 source，不让主进程
   读取 live editor DOM。
3. **专用属性最小化**：导出专用数据使用 `data-hm-pdf-*`，只保存数值和布尔状态。
4. **用户内容不可执行**：临时打印文档保持无脚本 CSP，不关闭 Electron 默认安全策略。
5. **程序化导出不标脏**：生成 source、测量和资源暂存不能触发文档修改状态。
6. **优先相对量**：列宽用比例、padding 用 em；仅在确有页面边界时使用固定尺寸。
7. **失败可见且可恢复**：格式物化失败保留源码，资源失败报告真实数量，不阻止其余内容。

## 禁止的捷径

- 只改 PDF Studio 的 React/CSS，却不检查 `printToPDF()` 输出。
- 用截图“看起来差不多”替代坐标和内容完整性断言。
- 只验证 source HTML 包含某个选择器。
- 复制整个 live DOM 和用户 CSS 到打印窗口。
- 给所有表格写 `width: 100%; table-layout: fixed`。
- 为降低表格行高而修改全局 `.doc p`。
- 用 `querySelector('.ProseMirror')` 命中隐藏 Tab。
- 在 UI 自动化中使用旧安装包或复用用户 profile。
- 为了让测试通过放宽断言，却没有解释浏览器渲染误差来源。

## 自动化入口

```bash
# 静态页面/CSP/打印 CSS 合同
node scripts/test-pdf-document.mjs

# 编辑器 → source → 最终 PDF 的列宽、行距、真实拖宽和 PNG
KEEP_PDF_ARTIFACTS=1 npm run test:pdf-table-layout-ui

# 54 行、10 列宽表分页与内容完整性
npm run test:pdf-table-ui

# Mermaid、LaTeX、HTML、任务列表和普通代码
npm run test:pdf-rendered-ui

# 图片资源暂存
npm run test:pdf-images-ui

# PDF Studio 设置与最终预览
# 该旧脚本依赖已启动的 CDP session；通常通过完整编排运行
npm run test:ui-regression
```

普通自动化必须通过 `scripts/lib/electron-test-app.mjs` 在后台隔离 profile 中运行，
不得抢用户键鼠。需要逐字输入的编辑器场景使用 `scripts/lib/human-input.mjs`。

## 验收矩阵

| 维度 | 自动化证据 | 人工证据 |
| --- | --- | --- |
| 内容完整 | PDF.js 找到末行、末列、表后正文 | 翻到最后一页检查 |
| 列宽 | 编辑器/source/PDF X 坐标比例 | 短列和长列观感一致 |
| 行距 | 编辑器 row height 与 PDF Y 基线距离 | 单元格上下留白不膨胀 |
| 手动宽度 | CDP 真实长按拖动后重新导出 | 拖宽列在 PDF 中保持 |
| 宽表 | 10 列、54 行分页断言 | 页面内不裁切 |
| Mermaid/LaTeX | 物化结构和 PDF.js 绘制 | 不出现源码或控件 |
| 图片 | 暂存统计和真实 PDF 字节 | 本地/远程图片可见 |
| 正文字号 | PDF.js 文字高度比较 11pt/14pt | 正文易读，标题/表格/代码等比变化 |
| 设置竞态 | latest-request-only 测试 | 快速切换只显示最终设置 |

## 停止条件

只有同时满足以下条件才可以交给用户测试：

1. 最小 fixture 在修复前稳定失败、修复后稳定通过。
2. source 与最终 PDF 都有断言，不能只覆盖中间层。
3. X、Y、内容完整性和像素检查均覆盖目标问题。
4. 专项 PDF 测试通过。
5. `npm run test:ui-regression` 通过。
6. `npm run build`、`npm run build:mobile`、`npm run guide:check` 通过。
7. `git diff --check` 通过。
8. 版本号按补丁规则递增。
9. 当前源码重新打包并安装，核验 `Info.plist`、`app.asar` marker 和实际运行进程。
10. 问题报告、教程、手测清单和 AI handoff 已同步。

## 已沉淀案例

### 0.12.41：PDF 表格列宽

- 症状：编辑器短列/长列按内容分配，PDF 强制铺满并近似等宽。
- 根因：打印 CSS 仍使用全局固定布局，导出清理又删除了列宽信息。
- 修复：测量 live table，写入 PDF 专用 `<colgroup>`，紧凑表保留自然宽度。
- 证据：编辑器与最终 PDF 列起点比例误差约 `0.003%`。

### 0.12.42：PDF 表格行距

- 症状：列宽正确后，PDF 每行上下留白仍明显大于编辑器。
- 根因：`.doc p { margin: 0.85em 0; }` 命中 `th/td > p`。
- 修复：只清除表格内部 paragraph 的 margin/padding 并继承 cell line-height。
- 证据：表头到首行基线从 `36pt` 降为 `19.5pt`；54×10 宽表由 13 页收紧为
  11 页，末列和表后正文仍完整。

### 0.12.43：PDF 正文字号

- 需求：只改变打印正文的基础字号，不通过整页缩放连带改变图片和图表。
- 实现：`fontSizePt` 标准化到 8–24pt，默认 11pt，并写入
  `--hm-pdf-font-size`；原缩放设置更名为“整体缩放”。
- 证据：`scripts/test-pdf-studio-ui.mjs` 读取最终 PDF Buffer，确认正文从
  11pt 调到 14pt 后 PDF.js 文字高度增长超过 20%，并验证失焦范围归一化。

### 0.12.44：PDF 连续设置打印竞态

- 症状：长文档连续调整字号时出现 `Failed to generate PDF: Printing failed`。
- 根因：销毁正在执行 `printToPDF()` 的隐藏窗口后，Promise 已拒绝但 Chromium
  打印后端尚未恢复，替代任务启动过早。
- 修复：worker 完整串行；打印阶段自然结束并丢弃 stale 结果，不再强杀窗口。
- 证据：24 章节、8 页长文档以 190ms 间隔连续改 9 次字号，错误记录为空，最终
  只保留 14pt。详见
  [pdf-preview-printing-race-report.md](./pdf-preview-printing-race-report.md)。

详细事故记录见 [pdf-table-layout-fidelity-report.md](./pdf-table-layout-fidelity-report.md)
和 [pdf-preview-printing-race-report.md](./pdf-preview-printing-race-report.md)。
