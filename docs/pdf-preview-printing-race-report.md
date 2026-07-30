# PDF 连续设置触发 Printing failed 问题报告

更新时间：2026-07-30  
对应版本：HorseMD 0.12.44

## 症状

PDF 导出中心已经生成预览后，连续修改正文字号或其他会重建 PDF 的设置，偶尔会
显示：

```text
Error invoking remote method 'pdf:preview':
Error: Failed to generate PDF: Printing failed
```

单次修改并等待预览完成通常正常，因此普通的“改一次字号、等待、检查结果”测试
无法覆盖问题。文档越长、一次打印持续越久，越容易触发。

## 根因

问题不在字号 CSS，而在主进程的预览取消模型。

1. renderer 每次设置变化都会发起新的 `pdf:preview`。
2. `latest-task-runner.js` 对旧任务调用 `AbortController.abort()`。
3. `pdf-export.js` 的 abort 处理会立即销毁正在执行 `printToPDF()` 的隐藏窗口。
4. `printToPDF()` 很快以 `Printing failed` 拒绝，但此时 Chromium 原生打印后端
   尚未完全退出。
5. 下一次打印立即开始，可能撞上尚未恢复的打印后端，于是当前请求也失败。

旧单测把 abort 模拟成同步清理，因此虽然断言“最大并发为 1”，实际只证明
JavaScript Promise 已拒绝，无法证明 Chromium 打印后端已经完成清理。

## 修复

修复分两层：

1. `latest-task-runner.js` 在取消旧 worker 后，等待旧 worker 的完整
   `finally` 结束，才允许替代 worker 启动。等待中的中间请求会变成 stale，
   只有最后一次设置真正生成。
2. `pdf-export.js` 对取消阶段做区分：
   - 图片暂存、页面加载和资源等待阶段可以销毁隐藏窗口并立即取消。
   - 一旦进入 `printToPDF()`，不再强制销毁窗口；让当前打印自然结束，随后丢弃
     stale 结果，再生成最后一次设置。

不要通过吞掉 `Printing failed`、无限重试、增加固定延时或只提高 renderer 防抖
来掩盖问题。这些做法不能修复底层打印任务重叠，并会把真实打印错误隐藏掉。

## 自动化验证

`scripts/test-latest-task-runner.mjs` 使用 40ms 异步清理模拟原生资源释放，要求旧
worker 清理完成前替代 worker不得启动。

`scripts/test-pdf-preview-churn-ui.mjs` 在后台 Electron 中生成包含 24 个章节、表格
和代码块的长文档：

1. 等待初始 PDF 完成。
2. 以 190ms 间隔依次设置 `8、9、10、11、12、13、14、15、14pt`。
3. 使用 MutationObserver 记录任何瞬时错误面板。
4. 确认最终 PDF 为 8 页、最终设置为 14pt、错误记录为空。

修复前该测试稳定得到 `Printing failed`；修复后结果：

```text
PASS PDF preview churn UI:
{"errors":[],"fontSizePt":14,"pages":8,"visibleError":""}
```

运行命令：

```bash
node scripts/test-latest-task-runner.mjs
npm run test:pdf-churn-ui
npm run test:ui-regression
```

## 后续约束

- 同一 renderer 同一时间只能有一个真正运行的 PDF worker。
- 不得在 `printToPDF()` 进行中销毁其 BrowserWindow 来实现普通设置取消。
- 被替代请求是正常 stale 控制流，不得显示成用户错误。
- 最终保存的 Buffer 必须仍来自最后一次成功预览。
- 新增 PDF 设置时，除单次生效测试外，必须加入连续修改压力测试。
