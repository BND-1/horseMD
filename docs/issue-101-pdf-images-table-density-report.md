# Issue #101：PDF 图片与表格行高根因报告

## 问题

Windows 0.12.10 用户报告两件事：

1. 表格默认行高过大，希望随文档字号变化。
2. PDF 导出中心提示多张图片失败，图片没有稳定进入 PDF。

这两个现象互不依赖，必须分别从编辑器排版和 PDF 资源管线解决。

## PDF 图片根因

旧流程把 live editor DOM 克隆为 HTML，再让新的 sandbox 隐藏窗口通过
`file://` 打开临时文档。克隆中仍是原图片地址，因此隐藏窗口必须重新加载
每张本地或网络图片。这个流程有三个不稳定点：

- 相对路径依赖原 Markdown 目录，但临时 HTML 位于系统临时目录。
- 已写成 `%20` 的 Markdown 图片地址再次经过 `encodeURI` 后变成 `%2520`，
  含空格、中文和 Windows 路径时尤其容易失败。
- 网络图片需要第二次请求，可能受缓存、认证、时序或服务器限制影响。

0.12.10 对 #97 的改动只修正了“等待中”和“失败”的提示及 latest-task
竞态，没有改变资源传输方式，所以不能视为图片问题的根治。

## PDF 图片方案

`getPdfSource()` 现在把每个非 data URL 图片的 `src` 换成唯一占位符，并返回
图片清单。主进程 `pdf-images.js` 在创建打印 HTML 前：

1. 本地图片通过受限大小的文件复制暂存。
2. HTTP(S) 图片通过 Electron `net.fetch` 下载暂存。
3. 临时 HTML 的占位符替换为同目录相对地址。
4. 只有暂存失败时才回退原地址，让打印窗口作最后一次真实加载尝试。
5. 预览结束、取消或报错均递归删除本次独立临时目录。

单张图片上限为 32 MiB，单次预览暂存总量上限为 256 MiB，避免异常文档占满
内存或磁盘。renderer 不获得文件系统权限，Electron sandbox 与 CSP 不变。

`resolveToFileUrl()` 同时改为“先解码已有 URI 转义，再统一编码一次”，保护
`%20`、中文、macOS/Linux 路径和 Windows 盘符。

## 表格行高根因与方案

旧表格单元格使用固定 `7px 10px` padding；即使用户调小文档字号，垂直留白
也不会缩小。Crepe 还给单元格内的 `<p>` 添加了独立的固定 padding 和行高，
较早的低优先级覆盖只移除了 margin，实际计算高度仍偏大。

现在单元格使用 `0.28em 0.6em` 和 `line-height: 1.4`，PDF 使用对应的
`0.28em 0.55em`。更具体的 table-block 规则清除内层段落 padding，并继承
单元格行高。12px、16px、24px 字号下，行高和 padding 都按字体等比变化。

### 0.12.42 后续修正

上述修复完整覆盖了编辑器表格，但当时对 PDF 的结论不完整。打印 DOM 中同样
存在 `th/td > p`，它仍会命中 `.doc p { margin: 0.85em 0; }`。因此即使 cell
自身已经改用 em padding，最终 PDF 每行仍会额外叠加两份正文段落 margin。

0.12.42 在 `pdf-print-styles.js` 增加表格内部 paragraph 的专用 reset，只清除
`th/td > p` 的 margin/padding 并继承 cell line-height，不修改正文段距。最终
PDF 的表头到首行基线由 `36pt` 降为 `19.5pt`。该差异由
`test-pdf-table-layout-fidelity-ui.mjs` 直接读取 PDF.js Y 坐标保护，不能再仅凭
CSS 配置相同就推断最终行高一致。完整记录见
[pdf-table-layout-fidelity-report.md](./pdf-table-layout-fidelity-report.md)。

## 回归保护

- `npm run test:pdf-export`：本地、网络、失败回退、单图和总量限制。
- `npm run test:pdf-images-ui`：真实 Electron 中打开含 `%20` 本地图片和
  本地 HTTP 图片的文档，确认编辑器加载、主进程暂存、PDF 生成、零失败提示。
- `npm run test:editor-images`：macOS/Linux、中文、Windows 和异常 `%` 路径。
- `npm run test:table-ui`：12/16/24px 等比行高、桌面/移动、浅/深主题、
  宽表滚动、加行加列、实时列宽和最右端连续 10 次拖动。
- `npm run test:pdf-table-layout-ui`：编辑器/source/最终 PDF 的列比例、真实
  拖宽和纵向基线距离，并渲染第一页 PNG。

表格变紧凑后，Crepe 的加列按钮会合理覆盖表头边界的中部。列宽自动化因此
在正文单元格边界执行长按拖动，避免把“点击加列”和“长按调宽”混成同一测试；
加行、加列按钮仍由独立的命中测试保护。
