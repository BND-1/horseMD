# 桌面端拖入文件 / 文件夹打开

> 基线：HorseMD 0.13.29。该能力只属于 Electron 桌面端，Capacitor 移动端 capability 为关闭状态。

## 用户合同

- 从 Finder / 文件资源管理器拖入一个或多个文件：逐个打开为标签，复用 `useFileOps.openPaths()` 的去重、最近文件和大文档判断。
- 拖入一个或多个文件夹：加入现有多根工作区，原文件夹不移动、不复制、不自动同步；界面切到文件树方便确认。
- 文件与文件夹可在同一批拖入中同时处理。
- 拖动经过窗口时显示非交互提示层，松开、取消或离开窗口后消失。
- 图片拖到富文本正文仍由编辑器插入并持久化，不得被外层打开逻辑变成图片标签。
- 图片与普通文件混合拖到正文时，图片交给编辑器，其他真实磁盘文件/目录仍打开或加入工作区。
- 标签、侧边栏和大纲内部拖拽不携带原生 `Files` 类型，不进入外部拖放链路。

## 实现边界

1. `src/preload/index.js`
   - 使用 Electron `webUtils.getPathForFile(file)` 将磁盘 backed `File` 转成原生路径。
   - 只暴露窄接口 `getPathForDroppedFile()` 和 `classifyDroppedPaths()`，不向 renderer 暴露 Node/Electron 全量能力。
2. `src/main/filesystem.js`
   - `classifyFileSystemPaths()` 通过 `fs.stat()` 区分文件与目录。
   - 每次最多处理 200 项，去重并忽略拖动后已失效、不可读或特殊的路径；一个坏项目不会阻止其余项目。
3. `src/renderer/src/hooks/useDropOpen.js`
   - 在 window capture 阶段接管外部 `Files`，避免 ProseMirror 吞掉不支持的非图片文件。
   - 图片落在 `.ProseMirror` 时不阻止原有 target-side 图片处理；混合 payload 只把非图片原生路径交给 shell。
   - 文件复用 `openPaths()`，目录复用 `useWorkspace.addFolder()`，不维护第二套 tab/workspace 状态。
4. `DropOpenOverlay.jsx` / `app.css`
   - 提示层 `pointer-events: none`，不会改变实际 drop target。
5. 平台合同
   - preload 桌面 capability：`nativeDropOpen: true`。
   - Capacitor shim：`nativeDropOpen: false`，并提供无副作用的空实现。

## 回归测试

```bash
npm run test:filesystem
npm run build
npm run test:drop-open-ui
npm run test:editor-images
npm run test:sidebar-inline-create-ui
npm run build:mobile
```

`test:drop-open-ui` 必须使用 CDP `Input.dispatchDragEvent` 的 `files` 字段验证真实磁盘 backed File；JS 手造 `File` 无法验证 `webUtils` 路径桥。图片边界可使用带 MIME 的 renderer `DataTransfer`，验证提示层不出现、图片节点插入且不生成图片标签。测试默认通过 `launchBuiltElectron()` 在后台运行，不抢键鼠和窗口焦点。

## 人工验收补充

- macOS、Windows、Linux 分别从系统文件管理器拖入文件和文件夹。
- 覆盖中文、空格、括号路径，多文件混合、重复文件和不存在/拖动后被移动的路径。
- 拖入受限系统根目录必须被工作区保护逻辑拒绝。
- 代码块、图片说明输入框等编辑器子控件不应被 shell 提示层干扰；正文图片拖入仍按原插图合同工作。
