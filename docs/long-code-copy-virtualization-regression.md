# 长代码块复制截断事故复盘

> 状态：已修复并加入真实 Electron 回归。记录日期：2026-08-01。对应测试版本：0.12.51。

## 1. 用户现象

用户从一个超过 100 行的 VS Code `settings.json` 中选择或复制代码时，粘贴结果可能只到第 63–65 行；不选择时也可能只得到前 64 行。短代码块无法稳定复现。

该数字不是业务限制。CodeMirror 只把当前视口附近的行渲染成 DOM，窗口高度、字体、行高和滚动位置不同，页面里可能只有约 30–65 个 `.cm-line`。因此截断点看似随机，并会随环境变化。

固定复现数据使用 120 条 JSON 设置，加首尾花括号共 122 行：

- ProseMirror 文档：122 行完整代码；
- CodeMirror 状态：122 行完整代码；
- 当时页面 DOM：仅 36 个 `.cm-line`；
- 修复前代码块右上角“复制”：只复制这 36 行。

## 2. 根因

代码块复制按钮位于 CodeMirror 的 `.milkdown-code-block` 包装节点中。旧实现通过 `view.posAtDOM()` 得到位置后，只检查：

- `doc.nodeAt(pos)`；
- `$pos.nodeAfter`；
- `$pos.nodeBefore`。

按钮对应的位置常在 `code_block` 内部，不一定正好位于节点边界。以上三种查找都可能失败，但真正的 `code_block` 仍是 `$pos` 的祖先节点。

查找失败后，旧实现读取页面中的全部 `.cm-line` 并拼接。这个回退对短代码块看似正确，对启用虚拟化的长代码块必然只得到当前渲染窗口，随后还会显示“已复制”，形成静默数据截断。

根因不是系统剪贴板、50 行上限或 VS Code JSON 格式，而是把虚拟化展示 DOM 误当成完整文档数据源。

## 3. 修复边界

代码位于 `src/renderer/src/components/editor-dom-content.js`。

当前查找顺序：

1. 从 `$pos.depth` 向根节点逐层检查 `$pos.node(depth)`；
2. 再检查 `nodeAt/nodeAfter/nodeBefore`；
3. 若 DOM 位置映射仍失败，按当前包装节点在编辑器中的代码块顺序，匹配 ProseMirror 文档里的第 N 个 `code_block`；
4. 只从完整 ProseMirror 节点的 `textContent` 写入系统剪贴板；
5. 若无法确定完整节点，停止复制且不显示成功反馈。

`.cm-line` 文本回退已经删除。不能为了“尽量复制一点”重新加入，因为部分内容复制成功比明确失败更危险。

## 4. 两条复制链路必须分开

### 4.1 代码块按钮

按钮语义是“复制整个代码块”，数据源必须是完整 ProseMirror `code_block`。它不能依赖当前滚动位置、CodeMirror 选区或可见 DOM。

### 4.2 CodeMirror 原生选区

用户在代码块内部按 `Ctrl/Cmd+A`，或按 Shift 选择若干行再复制，应该由 CodeMirror 的文档状态和原生 copy 链路处理。CodeMirror 本身能跨越虚拟化 DOM 复制完整选区。

修复按钮时不能全局拦截 CodeMirror 的原生复制，也不能把“复制整块”逻辑套到部分选区，否则用户选 65 行会错误得到整个代码块。

## 5. 自动化验收

专项脚本 `scripts/test-issue-98-copy-undo-ui.mjs` 使用真实 Electron、系统剪贴板和长代码夹具，验证：

1. DOM 行数明确少于源码行数，确保真的触发 CodeMirror 虚拟化；
2. 点击按钮后，系统剪贴板逐字等于完整 122 行；
3. 代码块内 `Cmd+A/Cmd+C` 复制完整 122 行；
4. 从第一行真实 Shift 选择 65 行，只复制前 65 行；
5. 每次复制前写入不同 sentinel，避免读取上一次剪贴板造成假通过；
6. 短代码、正文纯文本、列表纯文本、HorseMD 内部结构粘贴和撤销继续正常。

执行顺序必须是先构建、再启动 UI 测试。并行执行构建与测试会让 Electron 读取旧 `out/`，产生无效结论。

```bash
npm run build
node scripts/test-issue-98-copy-undo-ui.mjs
npm run test:issue-98-ui
npm run test:clipboard-ipc-ui
npm run guide:check
git diff --check
```

本轮上述命令全部通过。

## 6. 未来修改的停止条件

修改以下任一内容后，必须重跑本页专项：

- `editor-dom-content.js` 的复制按钮或 DOM 定位；
- CodeMirror node view、虚拟滚动或代码块包装结构；
- ProseMirror 文档到 DOM 的位置映射；
- preload 系统剪贴板 IPC；
- 富文本 copy/paste 事件优先级。

出现以下任一情况不能交付：

- 测试代码不足以触发 DOM 虚拟化；
- 只断言 toast 或按钮变绿，没有读取系统剪贴板；
- 只测整块复制，没有测部分选区；
- 复制失败后仍显示“已复制”；
- 使用 `.cm-line`、`innerText` 或可见区域文本作为完整代码来源；
- UI 测试与 `npm run build` 并行，导致测试旧产物。

## 7. 工程结论

虚拟化组件必须严格区分“展示层 DOM”和“权威文档状态”。任何承诺完整导出、复制、保存或统计的功能，都只能读取 ProseMirror/CodeMirror 的完整状态，不能从当前渲染窗口反推全文。
