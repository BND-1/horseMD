# 富文本未保存提示即时反馈回归（0.12.63）

## 用户现象

在富文本中刚输入或删除文字时，内容已经在编辑器中发生变化，但标签页小灰点、底部“已修改”和浮动保存入口会短暂继续显示“已保存”。这容易被误解为 HorseMD 已自动保存，或修改没有被识别。

## 根因

Milkdown 的 `@milkdown/plugin-listener` 对 `markdownUpdated` 使用固定 **200ms debounce**。HorseMD 原先只在这个回调里把序列化后的 Markdown 写入 `tab.content`；而界面脏状态又只比较：

```js
tab.content !== tab.savedContent
```

因此 UI 必然等待 200ms 左右，即使 ProseMirror 已经显示了用户输入。实测修复前约为 210–230ms。

这不是自动保存：富文本变更不会调用 `window.api.writeFile`，真实写盘仍仅发生在显式保存（保存按钮、`Ctrl/Cmd+S`）时。

本次回归还暴露了一个更早的初始化竞态：Crepe 的 `.ProseMirror` DOM 已可见时，初始源码基线、编辑器 API 和 `ready` 标记仍可能尚未完成。此窗口内若收到输入，`finishInitial()` 会把已输入的文档误记成初始基线；由于 `ready` 仍为 false，那个输入又不会触发 `onChange`，随后切换源码或保存便会看到旧内容。

## 修复合同

新增独立的临时状态 `tab.pendingRichEdit`：

1. 真实富文本 DOM 输入、粘贴、剪切、拖放发生后，立即设置它；标签灰点、状态栏、保存入口和关闭/外部修改保护均立即视为未保存。
2. 原有的 Milkdown 200ms 回调继续负责源码保真、`tab.content` 更新；不在每个按键上重新序列化整篇 Markdown，避免大文档卡顿。
3. 回调完成后清除临时状态；若用户在防抖窗口内输入后又删回已保存内容，也必须清除。
4. 若 Milkdown 因“最终 ProseMirror 文档等于前一次文档”而跳过回调，`Editor.jsx` 在 260ms 后执行一次仅限该输入批次的 `flushMarkdown()` reconciliation，清除提示，不改变磁盘。
5. 保存成功、富文本→源码立即 flush、外部文件变更防护、关闭确认和草稿会话资格都使用统一的 `isTabDirty(tab)`，避免某个入口漏掉临时状态；应用关闭前还会强制结算待处理富文本，避免新建草稿的最后一个字符遗漏。
6. 编辑器创建期间将 ProseMirror 设为不可编辑；只有初始 canonical Markdown 基线建立完成后才置为可编辑，并标记 `data-horsemd-ready="true"`。这不是延后内容显示，而是阻止“可见但尚未可安全写入”的窗口。

## 文件边界

- `src/renderer/src/lib/tab-state.js`：唯一脏状态判定。
- `hooks/useFileOps.js`：维护临时标记、保存/关闭/外部修改的统一判断。
- `components/editor-dom-interactions.js`：只从真实编辑 DOM 事件发出即时提示；导航键和单纯选区不会标脏。
- `components/Editor.jsx`：保留 Milkdown 序列化链路，并处理“编辑后还原”的最终对账。
- `components/Editor.jsx`：同时拥有 `interactionReadyRef`，防止初始基线建立前的输入被吞掉。
- `Tabs.jsx`、`StatusBar.jsx`、`SaveFab`、退出确认和草稿会话：均通过 `isTabDirty` 消费状态。

## 自动化验收

```bash
npm run test:rich-dirty-indicator-ui
```

该测试必须逐字符输入，并验证：

- 灰点在 180ms 内出现；
- 变更后磁盘文件仍完全不变（没有自动保存）；
- 延迟序列化后源码包含变更；
- 显式保存后才写盘并清除灰点；
- 200ms 内输入再删除回保存内容后，灰点会自动清除。
- 应用关闭链路会在写入未保存草稿会话前结算待处理富文本。

相关联回归：

```bash
npm run test:issues-105-106-ui
npm run test:source-fidelity-ui
npm run test:mode-switch-raw-offset-ui
```
