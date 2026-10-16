# PDF 表格列宽与行距一致性问题报告

更新时间：2026-07-30  
对应版本：HorseMD 0.12.42

## 现象

富文本中的 Markdown 表格已经按内容分配列宽，例如编号列较窄、说明列较宽；
打开 PDF Studio 或导出后，表格却被拉满页面，各列近似等宽。最终 PDF 与写作时
看到的表格布局明显不同。

列宽修复后，用户继续发现第二个视觉差异：富文本表格中的文字上下留白较少，
PDF 中每一行却明显更高。两个现象属于同一条导出链路，但根因不同，不能用一次
“表格样式已修复”的结论合并处理。

## 最小复现

使用一张同时具备短列、中等列和长说明列的表格：

```md
| ID | Project name | Detailed explanation |
| --- | --- | --- |
| 1 | Alpha | A substantially longer explanation that should receive most of the available table width. |
| 2 | Beta release | Another detailed note used to keep the final column visibly wider than the short identifier. |
```

按以下顺序验证：

1. 在富文本中记录三列表头的实际宽度和每一行高度。
2. 立即打开 PDF Studio，不能只检查导出 source HTML。
3. 从 PDF Studio 捕获本次真正生成的 PDF Buffer。
4. 用 PDF.js 读取表头文字 X 坐标和表头、首行文字 Y 坐标。
5. 把 PDF 第一页渲染成 PNG，人工检查边框、换行和留白。
6. 回到富文本，真实长按并拖宽第一列，再生成一次 PDF。
7. 最后用 10 列以上宽表验证右侧内容和表后正文没有被裁掉。

## 根因

这是编辑器与打印链路发生了策略分叉：

1. 编辑器在 0.12.39 改为内容驱动的 `table-layout: auto`，紧凑表使用自然宽度。
2. PDF 打印 CSS 仍保留旧的 `table-layout: fixed; width: 100%`，会铺满页面并按
   固定布局计算列宽。
3. `editor-pdf-content.js` 清理编辑器 DOM 时会移除所有 class、style 和 data
   属性，连用户拖动后形成的 `colgroup` 宽度也一起删除。
4. 列宽修复后还存在第二层差异：打印样式的 `.doc p { margin: 0.85em 0; }`
   会命中单元格内层 `<p>`。编辑器已经将 `th > p`、`td > p` 的边距清零，
   PDF 却在每个单元格中额外加入两份正文段落间距，导致行高明显偏大。

因此 PDF renderer 无法知道编辑器里的实际列边界，只能按旧固定规则重新布局。

更准确地说，这是两次 CSS 级联泄漏：

- **横向泄漏**：打印层的全局固定表格规则覆盖了编辑器的内容驱动列宽。
- **纵向泄漏**：打印层的全局正文段落规则进入了表格单元格内部。

只修复其中一条轴线，仍然不能声明“PDF 表格与预览一致”。

## 修复

生成结构化 PDF source 时，在清理编辑器控件之前逐表测量：

- 表格当前总宽度。
- 首行各单元格的实际宽度。
- 表格是否已经超过其滚动容器。

测量结果写入只供 PDF 使用的 `data-hm-pdf-*` 属性和 `<colgroup>` 百分比：

- 紧凑表保留实测像素总宽度，并以 `max-width: 100%` 保护页面边界。
- 宽表改为页面 `100%`，但仍保留各列实测比例，让长内容在对应列内换行。
- 用户手动拖宽后的表格走同一实测链路。
- 隐藏或无法测量的表格回退为内容自适应，不再退回等分。
- PDF 对 `th > p`、`td > p` 单独清除 margin 和 padding，并继承单元格行高；
  正文段落仍保留原来的打印间距。

PDF Studio 展示的是主进程生成的 PDF Buffer，点击导出保存的也是同一 Buffer，
因此预览与最终文件不存在第二次排版。

### 修改位置

| 文件 | 责任 |
| --- | --- |
| `src/renderer/src/components/editor-pdf-content.js` | 在清理编辑器 DOM 前测量可见表格总宽度和列边界，生成 PDF 专用 `<colgroup>` |
| `src/main/pdf-print-styles.js` | 定义紧凑表、宽表、单元格行高，以及单元格内层段落的打印规则 |
| `scripts/test-pdf-table-layout-fidelity-ui.mjs` | 对编辑器、PDF source 和最终 PDF 做横向、纵向数值比较，并生成 PNG |
| `scripts/test-pdf-wide-table-ui.mjs` | 验证多行多列表格分页后仍保留最右列和表后正文 |
| `scripts/test-pdf-document.mjs` | 保护打印 CSS 的静态合同，防止关键选择器被删除 |

### 修复边界

- 不把 live editor DOM 直接传给隐藏打印窗口。
- 不把编辑器 class、临时控件或用户自定义 CSS 整体复制进 PDF。
- 不修改正文 `.doc p` 的间距来迁就表格，否则整篇文档排版会回归。
- 不对所有表格统一使用固定布局；只有实测表格用固定列比例。
- 不把所有紧凑表强制铺满页面；只有超出编辑器可用宽度的表格收敛到打印宽度。
- 无法测量的隐藏表格必须安全回退为内容自适应，不能写入 `0px` 或无效比例。

## 修复过程复盘

第一次修复只处理了“列宽不一致”，自动化也只比较了最终 PDF 的文字 X 坐标。
该测试能证明列宽正确，却无法发现表格内部段落仍继承了全局 margin。用户人工
检查行距后，才暴露纵向维度缺少断言。

第二次修复没有继续微调 `td` 的 padding，而是先读取两端真实数据：

- 编辑器单行表头高度：`31.8984px`。
- 修复前最终 PDF 表头到首行文字基线：`36pt`。
- 检查导出 DOM 后发现 `th/td > p` 命中 `.doc p { margin: 0.85em 0; }`。

因此正确修法是只对表格内部段落清零 margin/padding 并继承单元格行高，而不是
降低全局正文段距或写一个与当前样例绑定的固定行高。修复后最终 PDF 表头到首行
基线降为 `19.5pt`，正文段落样式保持不变。

这次遗漏说明视觉保真测试不能只覆盖 X 轴。以后涉及预览与导出的布局修复，至少
同时检查：宽度、X 坐标、行高、Y 坐标、换行、分页和最终像素结果。

## 验证

`scripts/test-pdf-table-layout-fidelity-ui.mjs` 使用真实后台 Electron：

1. 编辑器实测三列为 `96 / 119.87 / 320px`。
2. PDF source 对应列比例为
   `17.9149% / 22.3688% / 59.7163%`。
3. PDF.js 从最终 PDF 读取三个表头的 X 坐标，列起点比例与编辑器误差约
   `0.003%`，并明确断言不能退化为等宽。
4. 通过 CDP 鼠标事件真实长按并拖动第一列边界，第一列从约 `96px` 增加到
   `168px`；编辑器列宽比为 `1.40237`，最终 PDF 列宽比为 `1.40237`。
5. 将 PDF 第一页真实渲染为 PNG，检查边框、换行、自然总宽度和页面边界。
6. 0.12.42 的 10.875pt 等效默认正文下，最终 PDF 的表头到首行基线距离从
   旧版 `36pt` 降为 `19.5pt`。0.12.43 默认正文改为明确的 11pt 后，该距离为
   `20.25pt`；测试读取编辑器真实表头行高并使用相对阈值，确保字号变化不会
   被误判为段落留白回归。

`scripts/test-pdf-wide-table-ui.mjs` 继续覆盖 54 行、10 列宽表：末行末列和表后
正文完整存在，内容不裁切。删除多余单元格段落留白后，当前输出由 13 页收紧为
11 页；页数减少来自行距恢复，不是内容丢失。

完整后台 UI 回归共通过 `7` 个隔离会话和 `22` 项独立测试，覆盖 PDF Studio、
LaTeX、Mermaid、图片、任务列表、表格滚动与拖宽、保存重开、源码保真和双向
模式切换。桌面构建、移动端共享渲染构建和教程构建也全部通过。

## 防回归命令

```bash
npm run build
node scripts/test-pdf-document.mjs
KEEP_PDF_ARTIFACTS=1 npm run test:pdf-table-layout-ui
npm run test:pdf-table-ui
npm run test:pdf-rendered-ui
npm run test:ui-regression
npm run build:mobile
npm run guide:check
git diff --check
```

设置 `KEEP_PDF_ARTIFACTS=1` 后，测试会在 `/tmp/horsemd-pdf-table-layout-*` 保留
最终 `.pdf` 和第一页 `.png`。数值断言通过后仍必须检查 PNG；仅看到 source HTML
包含正确 CSS，不能证明 Chromium 最终打印结果正确。

通用排查和停止条件见
[pdf-visual-fidelity-runbook.md](./pdf-visual-fidelity-runbook.md)。
