# Issue #105 / #106：富文本保存与图片链接重复回归报告

> 状态：已验证当前实现；自动化回归已补齐。更新：2026-08-02。

## 用户现象

- **#105（Windows 0.12.47）**：在富文本中编辑后立即保存，关闭重开或切到源码时仍看到编辑前的内容。
- **#106（Windows 0.12.47）**：含两张图片的文档每保存一次，Markdown 中的两条图片链接又追加一份。

这两个现象表面不同，保存链路上却有同一个风险：ProseMirror 的编辑事务已经在屏幕上发生，而 Milkdown 的 `markdownUpdated` 回调和 React 的 `tab.content` 仍可能晚一个任务才更新。若保存此时直接写 `tab.content`，就会写入旧的 Markdown；下一次富文本/源码同步再以这份旧快照为基线，可能覆盖刚输入的文字，或把本来仍存在于 live document 的图片块再次拼回源文件。

## 当前修复边界

当前实现不等待定时器，也不信任 `crepe.getMarkdown()` 的缓存：

1. `editor-api.js` 的 `flushMarkdown({ force: true })` 直接用 `serializerCtx(view.state.doc)` 序列化当前 ProseMirror 文档；保存和导出明确走强制路径，阅读型模式切换保留非强制快照优化。
2. 序列化结果经 `preserveRichMarkdownSource()` 回写到作者 Markdown，保持未改区域的源码写法。
3. `App.jsx#getMarkdownForTab()` 在富文本页优先调用该实时 flush；源码页仍走 textarea 的 raw-source 保真入口。
4. `useFileOps.js#saveTab()` 在任何写盘前同步取得这份 Markdown，并同时更新 `tabsRef` 和 React tab state，随后才调用文件写入。

因此“立即保存”“富文本 → 源码”“关闭后重开”读取的是同一份已提交的 Markdown，而不是不同步的缓存快照。

## 防回归测试

`scripts/test-issues-105-106-save-fidelity-ui.mjs` 使用隔离 profile 的后台 Electron：

1. 打开含两条不同图片链接的 Markdown。
2. 在富文本正文逐字输入，**不等待** `markdownUpdated`，立刻保存。
3. 连续执行 8 次“逐字编辑 → 保存 → 切源码 → 切回富文本”。
4. 每轮检查磁盘和源码视图都含最新正文，且每条图片链接的出现次数严格等于 `1`。
5. 选中并删除独立正文，立刻保存、切源码，确认删除文本不在磁盘和源码中。
6. 关闭进程、以全新 profile 重开同一文件，再次检查正文、删除结果和图片链接计数。

运行：

```bash
npm run test:issues-105-106-ui
```

该测试专门覆盖 Issue #105 的“可见但未保存”竞态和 Issue #106 的“图片仍在但被重复追加”假阳性；只检查 `includes()` 不足以发现后者。

## 手工验收

准备一个有正文和两张本地/相对路径图片的文件：

1. 在富文本正文末尾输入少量文字后立刻按 `Ctrl/Cmd+S`。
2. 切源码，确认刚输入文字已出现，两个 `![](...)` 各只有一条。
3. 连续重复至少三次后关闭文件并重开。
4. 检查正文不回退，图片既没有丢失也没有重复。

涉及保存、模式切换或图片序列化时，必须同时运行上述自动化测试和 `npm run test:issue-84-ui`（图片 alt/title 保真）。
