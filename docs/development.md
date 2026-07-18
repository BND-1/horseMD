# 开发、构建与测试

## 本地开发

```bash
npm install
# 若 Electron 二进制下载被墙，先设镜像：
#   set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/   (Windows cmd)
#   $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" (PowerShell)
npm run dev
```

`npm run dev` 用 electron-vite 起开发模式：main/preload 用 esbuild 构建，renderer 用 Vite dev server（热重载）。

## 构建与打包

```bash
npm run build       # 构建到 out/（main + preload + renderer）
npm run test:core   # 运行可在 CI 中执行的确定性核心回归
npm run test:shortcuts      # 设置中心/自定义快捷键专项回归
npm run test:ui-regression  # 串行运行真实 Electron UI 回归 session
npm start           # 运行构建产物（electron-vite preview）
npm run dist        # 构建 + electron-builder 打**当前系统**的安装包 → dist/
npm run dist:dir    # 构建 + 打免安装目录版（dist/<platform>-unpacked/）
```

> `npm run dist` 按运行它的系统出包：Windows 上出 NSIS 安装包，macOS 上出
> `.dmg` + `.zip`，Linux 上出 `.deb`。安装包必须在对应平台构建和验证；尤其不要
> 把 macOS 交叉构建得到的 `.deb` 当作有效产物。

打包时若 electron-builder 的二进制下载慢，加镜像环境变量：
```
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
```

> 打包常见报错 `app-builder ... CANNOT_EXECUTE` 通常是 `dist/win-unpacked/HorseMD.exe` 被占用（有实例在跑）—— 先关掉所有 HorseMD 实例再打。

### 打包配置（package.json → build）

```jsonc
"build": {
  "appId": "com.horsemd.app",
  "productName": "HorseMD",
  "files": ["out/**/*"],
  "icon": "build/icon.ico",
  "mac": { "target": ["dmg", "zip"], "icon": "build/icon.icns", "category": "public.app-category.productivity", "fileAssociations": [/* .md/.markdown */] },
  "win": { "target": ["nsis"], "icon": "build/icon.ico", "fileAssociations": [/* .md/.markdown */] },
  "linux": { "target": [{ "target": "deb", "arch": ["x64"] }], "icon": "build/icons", "fileAssociations": [/* .md/.markdown */] },
  "nsis": { "oneClick": false, "allowToChangeInstallationDirectory": true, "allowElevation": true, "installerIcon": "build/icon.ico", "uninstallerIcon": "build/icon.ico" }
}
```

- 安装包**未签名**：Windows 首次运行 SmartScreen 提示"未知发布者"，点"更多信息 → 仍要运行"；macOS 首次打开被 Gatekeeper 拦，右键 → 打开，或 `xattr -dr com.apple.quarantine /Applications/HorseMD.app`。需要免提示得配对应平台的签名证书（macOS 还需公证）。

### macOS 打包（已支持）

Windows 与 macOS 共用一份配置，在 macOS 上 `npm run dist` 即出 `.dmg` + `.zip`（默认 arm64；要 Intel 用 `"arch": ["x64", "arm64"]`）。

- 图标 `build/icon.icns` 由 `icon.png` 生成（mac 上 `iconutil`，或跨平台 `png2icns` / `electron-icon-builder`）。
- 跨平台已处理：快捷键同时认 `Ctrl`/`Cmd`（`metaKey`），`open-file`（Finder 打开）事件，标题栏 `hiddenInset` + 固定 `trafficLightPosition`，渲染层用 `.app.is-mac` / `.app.is-win` / `.app.is-linux` 区分平台样式。**改顶栏/平台相关代码时务必三个桌面系统都别弄坏。**

> dev 模式在 macOS 上用 `osascript tell application "Electron"` 驱动时，可能误启动 `node_modules` 里的通用 Electron 壳（同名冲突，显示默认页）。验证请用打好的 **HorseMD.app**（名字与 bundle id 唯一）。

### Linux 打包与发布

Linux 目前发布 `amd64.deb`，应在 Ubuntu x64 环境执行：

```bash
npm ci
npm run test:core
npm run build
npx electron-builder --linux deb --x64 --publish never

DEB_FILE=$(ls dist/*.deb | head -1)
dpkg-deb --info "$DEB_FILE"
dpkg-deb --contents "$DEB_FILE" >/dev/null
```

验证不只看打包命令退出码：历史上 macOS 交叉构建曾返回 0，却只生成约 96 字节的
无效 `.deb`。正式包必须在 Linux 上通过 `dpkg-deb --info`，并至少验证安装、卸载、
应用菜单启动、Markdown 文件关联、窗口拖动和最小化/最大化/关闭。

`.github/workflows/release.yml` 在 `v*` tag 上运行 Windows、macOS、Ubuntu matrix。
Linux job 安装桌面构建依赖，打包后执行 `dpkg-deb --info`；由于 electron-builder 对已经
发布的 Release 可能跳过 draft publish，工作流最后使用
`gh release upload "$TAG" dist/*.deb --clobber` 明确上传经校验的 `.deb`。

主进程输出是 `out/main/index.cjs`。`dev`、`preview` 和 `start` 用 `cross-env` 把可能从
外部工具继承的 `ELECTRON_RUN_AS_NODE` 清空，避免 Electron 被当作普通 Node 进程启动。

## 自动化测试：CDP 端到端验证

项目以 **Chrome DevTools Protocol** 端到端验证为主，同时为可纯函数验证的源码映射提供快速 Node 单测。CDP 连进运行中的 Electron，真实派发鼠标/键盘事件并回读 DOM，测的是"用户真实体验"。

```bash
# 无需启动 Electron：Markdown raw offset ↔ ProseMirror 映射
npm run test:source-map

# CriticMarkup 输入守卫
node scripts/test-strike-guard.mjs

# 自定义快捷键专项回归
npm run test:shortcuts

# 真实 Electron UI 回归编排，串行启动隔离 profile，避免多个 CDP 脚本抢窗口
npm run test:ui-regression
```

### 工具

- `scripts/run-ui-regression.mjs` —— 串行编排真实 UI 回归，覆盖 PDF Studio、Review、Lightbox、表格、#57-#60、#66/#67、真实大文档模式切换、源码查找和 `电脑档案.md` 双向切换链路
- `scripts/etv.mjs` —— 端到端验证：命中测试每个按钮、读计算样式、检测 `-webkit-app-region`、驱动块切换器/右键菜单/选区等
- `scripts/test-issues-57-60-ui.mjs` —— 真实验证 `$$`/`/math` 连续输入、行内代码末端追加、底部文件菜单边界和 PDF 导出中心基础控件；文件树场景通过 `ISSUE59_DIR` 指向已由第二实例加入的测试目录
- `scripts/test-pdf-studio-ui.mjs` —— 真实 Electron PDF 导出中心回归：开关命中区域、页面方向、目录页、嵌入书签、页码范围、快速设置、源码同步和快捷入口
- `scripts/test-pdf-latex-ui.mjs` —— 真实 Electron PDF 导出回归：段落 LaTeX 公式必须导出为渲染后的 MathML，不允许打印 `$$...$$` 源码或公式编辑控件
- `scripts/test-editor-style-settings-ui.mjs` —— 真实 Electron 设置页回归：自定义 CSS 位于编辑器设置并作用到预览，源码字号设置作用到源码 textarea
- `scripts/test-latest-task-runner.mjs` —— 验证同一渲染器仅运行一个 PDF 生成任务，旧任务取消且最新请求胜出
- `scripts/test-editor-api-registry.mjs` —— 验证按 Tab 的编辑器 API ready、关闭释放与超时行为
- `scripts/test-pdf-studio-ui.mjs` —— 真实验证 PDF 横纵向、目录页、书签、页码范围、PDF.js Canvas 与快速设置更新的最终一致性
- `scripts/test-editor-inline-code.mjs`、`scripts/test-menu-position.mjs` —— 不启动 Electron 的输入边界与浮层几何回归
- `scripts/inspect.mjs` —— 简易状态检查器
- `scripts/test-mode-switch-chains.mjs` —— 双向连续切换、表格和 CodeMirror 光标语义匹配
  - 普通富文本点击会确认可见选区；首次点击仅恢复编辑器焦点时自动重试一次
- `scripts/test-mode-switch-10x.mjs` —— 5 个编辑态光标 + 5 个阅读态视口，附带大纲/dirty 稳定性检查
- `scripts/test-source-find.mjs` —— 源码查找 selection、居中滚动、高亮和连续上下一个
  - 对普通 Markdown 追加 `--mode-switch`，验证保持查找栏时源码→富文本→源码缓存重建
- `scripts/test-review-ui.mjs` —— 真实源码同步后的 Review 高亮、同段批注堆叠、卡片编辑/取消/完成和 substitution DOM

### 用法

```bash
# 1) 带远程调试端口启动（注意：要先关掉别的实例，否则单实例锁会转发到旧实例）
npx electron . --remote-debugging-port=9222 "path\to\some.md"

# 2) 跑验证
node scripts/etv.mjs
```

### 关键经验（CDP 的坑）

- **响应取值路径**：`Runtime.evaluate` 的值在 `msg.result.result.value`（别写成 `msg.result.value`）
- **合成事件的局限**：
  - `Input.dispatchMouseEvent` 的合成**拖拽不驱动 ProseMirror 的 `state.selection`**（DOM 有选区但 PM 内部是空的）→ 测选区相关功能要用**键盘选区**（Shift+方向键）
  - 合成点击会**绕过 OS 级 `-webkit-app-region` 的拖拽吞噬**，所以它不能证明"真实鼠标可点"；判断拖拽区要读计算样式
  - `requestAnimationFrame` 在窗口被遮挡时被节流到几乎不触发 → 别在初始化逻辑里依赖 rAF
  - 原生监听器调 React `setState` 是异步渲染，查 DOM 前要等一拍
- `/json/new` 在新版 Chromium 被限制；要新开页面截图可直接 `Page.navigate` 现有页到目标 URL
- `System.Drawing.Icon` 读不了 PNG 内嵌的 ICO 帧（渲染噪点），验证圆角时直接渲染源 PNG

## 数据/状态约定

- 会话存于 `localStorage`，键 `minimd.session.v1`：`{workspace, theme, lang, recents, sidebarOpen, sidebarMode, openPaths, activePath}`
- 首次引导标记：`localStorage['horsemd.onboarded.v1']`
- 主题以 `body` 的 class 表达：`light|dark` 基类 + 可选 `theme-*` 覆盖类
