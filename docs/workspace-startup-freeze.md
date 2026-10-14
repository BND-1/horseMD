# 大型工作区启动阻塞：原因与修复

问题反馈与修复贡献：**linyibin**。记录日期：2026-10-14。源码基线为 `v0.13.246`，本地验证版本为 `0.13.247`。

## 问题与原因

恢复包含数万个文件的大型工作区时，窗口先出现，但十几至二十多秒内无法正常操作。

`registerWatcherIpc` 原先在 Electron 主线程调用 `chokidar.watch`。递归遍历与批量创建原生 `fs.watch` 句柄占用主线程，文档读取和窗口控制 IPC 因此排队。`ignoreInitial: true` 仅抑制首次发现文件的事件，不省略初始遍历和监听器创建。

诊断工作区全量约 49,399 个文件；按旧排除规则统计，约有 47,383 个文件、10,754 个子目录。这些是目录规模，实际监听范围还受 `depth: 12` 限制。

## 对照证据

使用独立配置与隐藏窗口，对照组只禁用工作区目录监听，保留文档恢复和清单扫描。

| 指标 | 正常监听（0.13.246） | 仅禁用目录监听 |
| --- | --- | --- |
| 窗口显示 | 约 0.84 秒 | 约 0.83 秒 |
| 编辑器可编辑 | 25 秒采样结束时仍未就绪 | 约 1.74 秒 |
| 原生监听启动 CPU 采样 | 约 22.68 秒，占 89.4% | 0 秒 |
| 主进程空闲比例 | 约 3.9% | 约 97.5% |

正常组单次主循环延迟最高约 8.47 秒，小文档读取 IPC 耗时约 7.39 秒。采样期间创建 7,168 次 `fs.watch`，结束时仍在初始化。调用栈集中于 `_addToNodeFs → _handleFile / _handleDir → _watchWithNodeFs → fs.watch → FSWatcher.start`。

禁用监听后，清单扫描仍运行约 4.46 秒并找到 1,641 个文档，但不再妨碍编辑器就绪。

## 实现

- `workspace-watcher-worker.js`：每个工作区使用 Node.js Worker，在独立线程执行 Chokidar 遍历和监听初始化。
- `workspace-watcher.js`：主线程使用 EventEmitter 接收变化、错误与就绪通知；关闭时终止 Worker，取消初始化并屏蔽迟到通知。
- `workspace-watch-policy.js`：共享根目录校验与过滤规则，保留目录，只监听 `.md`、`.markdown`、`.mdx`、`.txt` 文件；没有 stat 时不提前过滤路径。
- `watchers.js`：工作区接入 Worker，停止时先移除注册记录，避免关闭与重新启动竞态；已打开文档的外部修改轮询保持原流程。
- `electron.vite.config.mjs`、`package.json`：构建 Worker 入口及共享 CJS 代码，并通过 `asarUnpack` 提供真实文件，保证打包版可加载。

保留原有排除目录、深度限制、写入稳定等待和通知合并。大型工作区仍需后台初始化，完整文件列表与自动刷新可能稍后才就绪。此次修改仅涉及桌面主进程和打包配置，未修改移动端共享渲染行为。

## 验证

在同一真实大工作区上恢复 4 个测试文档，原文档仅复制为临时样本，未用于写入测试。

| 指标 | 构建运行 | Windows x64 打包成品 |
| --- | --- | --- |
| 编辑器就绪 | 1,440 毫秒 | 1,793 毫秒 |
| 40 次窗口 IPC 最长耗时 | 60 毫秒 | 42 毫秒 |
| 工作区通知、中文逐字输入、保存、完整重启读回 | 通过 | 通过 |

监听器测试覆盖无关文件过滤、文档与目录新增/重命名/删除、初始化取消、重复关闭和停止后的通知抑制。成品回归还通过实际新建文档通知，确认 Worker 确实加载并工作，而非因监听失效才使启动变快。

主要验证命令：

```bash
npm run test:main-watchers
npm run test:workspace-watcher
npm run build
npm run test:workspace-startup-ui
node scripts/test-main-filesystem.mjs
node scripts/test-main-security.mjs
npm run test:background-ui
npm run test:save-reopen-smoke-ui
npm run guide:check
npm run dist:dir -- --win --x64 --publish never
```

启动回归默认使用临时工作区，可通过 `WORKSPACE_STARTUP_ROOT` 指定大工作区、`WORKSPACE_STARTUP_SESSION` 指定包含 `openPaths` 的会话 JSON、`HORSEMD_TEST_EXECUTABLE` 指定打包 EXE、`WORKSPACE_STARTUP_REPORT` 指定报告路径。

上述为本机后台自动化验证，不承诺所有机器固定启动秒数；未做 Windows 前台鼠标/真实 IME 人工验收，也未做 macOS/Linux 成品验证。Windows 会话设置回归在强制退出前增加 Chromium 存储提交等待后通过，原强制退出测试可能丢失尚未落盘设置。
