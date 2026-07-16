# 移动端适配方案(iOS / Android)

> 状态:**方案 + 脚手架计划**(尚未动代码)。路线 = **Capacitor**;首版 = **MVP(看 / 改 / 本地文件)**。
> 铁律:**不碰、不破坏现有 Windows / macOS 桌面功能**。桌面走 Electron 那套完全不动。

## 0. 为什么是 Capacitor

HorseMD 的渲染层(React + Vite + **Milkdown Crepe**)是纯 Web/DOM 的,桌面只是用
Electron 当壳、用 `window.api`(白名单 IPC)桥接原生能力。Capacitor 同样是"原生壳
包 WebView",于是**整个渲染层可以原样复用**,我们要做的只是给 `window.api` 这套
**契约**再写一个用 Capacitor 插件实现的版本。Milkdown 是 DOM 编辑器,RN 得塞进
WebView,得不偿失;Tauri Mobile 生态尚不成熟;PWA 进不了商店。故选 Capacitor。

## 1. 核心思路:给 `window.api` 写第二套实现(shim)

桌面端 `window.api` 由 `src/preload/index.js` 注入。移动端没有 Electron preload,
所以我们在渲染层启动时检测:**若 `window.api` 不存在**,就挂一个用 Capacitor 插件
实现同样接口的 shim。这样 `App.jsx` 等业务代码**几乎不用改**——它们只认契约。

```
桌面:  preload(Electron IPC) ──┐
                               ├──►  window.api (同一套接口)  ──► App.jsx 不变
移动:  capacitor-api.js(shim)─┘
```

新增文件(不动现有文件结构):

```
src/renderer/src/platform/
  capacitor-api.js     // 用 Capacitor 插件实现 window.api 契约 + capabilities
  index.js             // 启动时:if (!window.api) window.api = makeCapacitorApi()
capacitor.config.ts    // Capacitor 配置(appId / webDir / 插件设置)
```

`src/renderer/src/main.jsx` 顶部 `import './platform'`(在 React 挂载前装好 shim)。

## 2. 接口逐项映射(以 preload 的契约为准)

| `window.api` 方法 | 桌面(Electron) | 移动(Capacitor) |
|---|---|---|
| `readFile / writeFile` | fs | `@capacitor/filesystem` `readFile/writeFile`(UTF-8) |
| `createFile / createDir / deleteItem / rename / duplicate` | fs | Filesystem 对应方法 |
| `readDir / listFiles / openFolderTree` | fs 递归 | Filesystem `readdir`(仅 App 私有库 + SAF 授权目录) |
| `openFiles` | 系统对话框 | `@capawesome/capacitor-file-picker` 选 .md |
| `openFolder` | 系统对话框 | Android: SAF 选目录;iOS: 文档目录(无任意目录概念) |
| `saveAs` | 对话框 | Share / 另存到文档目录 |
| `uploadImage`(exec 命令) | Node `exec` | **移动端不可用** → 禁用(未来可做 HTTP 上传) |
| `themesList / themeRead / themesReveal` | userData/themes | App 私有 `themes/` 目录(reveal 无意义→禁用) |
| `watchStart/Stop/File`、`onWatch*/onFileChanged` | chokidar | **no-op**(移动端无文件监听;靠重新进入前台时刷新) |
| `window*`(最小化/最大化/关闭) | BrowserWindow | **no-op**(移动端无窗口控件) |
| `previewPDF / savePDFPreview / disposePDFPreview` | 主进程预览与保存 | **移动端禁用**(使用系统分享/打印) |
| `openExternal / showInFolder` | shell | `@capacitor/browser`;showInFolder 禁用 |
| `checkUpdate` | net.fetch GitHub | 复用 `@capacitor/app` 版本 + 同样的 GitHub 检查(可保留) |
| `confirmAppClose / cancelAppClose / onAppCloseRequest` | 关闭拦截 | **no-op**(移动端无"关窗"语义) |
| `onOpenPaths / onOpenFolderPath` | argv / 单实例转发 | `@capacitor/app` `appUrlOpen` / 文件关联 intent |
| `onMenu` | 应用菜单加速器 | **no-op**(移动端无菜单;改用顶栏/手势) |
| `platform` | `'win32'|'darwin'` | `'ios'|'android'`(由 `Capacitor.getPlatform()`) |

## 3. 能力探测(capabilities)+ 平台类名

新增 `window.api.capabilities`,渲染层据此隐藏/禁用桌面专属功能,而不是到处写
`if (platform==='ios')`:

```js
capabilities = {
  folderWorkspace,  // iOS 受限;Android(SAF)可
  watch,            // false(移动)
  windowControls,   // false
  pdfExport,        // false(MVP)
  imageHostExec,    // false
  nativeMenus,      // false
  externalShell,    // true(用浏览器插件)
  revealInFolder,   // false
}
```

沿用现有 `.app.is-win/.app.is-mac` 模式,新增根类 **`.app.is-ios` / `.app.is-android`**
(还有一个 `.app.is-mobile` 便于统一写移动样式)。移动专属 CSS 只写在这些选择器下,
**绝不影响桌面**。

## 4. 路径与"本地文件"模型(MVP)

移动端没有桌面那种稳定绝对路径。约定:**`path` 字段对渲染层是不透明字符串**,移动端
存 Capacitor Filesystem 的 URI / Android SAF content URI 即可,业务逻辑大多无感。

MVP 的文件来源两类:
1. **App 私有库**(默认,零授权,永远可用):`Directory.Documents` 下的 `HorseMD/`,
   新建 / 列表 / 编辑 / 保存都在这里。首页"最近文件"复用现有 recents。
2. **导入 / 打开外部文件**:文档选择器选 .md → 读入成一个标签;保存走"另存/分享"。

文件夹工作区(侧边树):iOS 先不做(沙盒无任意目录);Android 用 SAF 授权目录,
**MVP 可先只读列出**,后续再补写操作。

## 5. 移动端 UI(MVP,尽量复用现有布局)

- 顶栏:去掉窗口控件;标签条改为可横向滑动;`+` 新建保留。
- 活动栏 / 侧边栏:窄屏改为**抽屉**(覆盖式),手势或按钮唤出。
- **安全区**:适配刘海 / 底部 Home 指示条(`env(safe-area-inset-*)`)。
- 触摸:确认 Milkdown 的选中工具条、斜杠菜单、块拖拽手柄在触摸下可用(重点验证项)。
- 源码模式、主题切换、查找、大纲:纯渲染层,基本可直接用,按窄屏微调。
- 软键盘:输入时滚动让光标可见(`visualViewport` 适配)。

> MVP 不强求和桌面像素级一致,先保证"能在手机上真正写起来"。

## 6. 构建与工程接入(不影响桌面构建)

桌面构建仍是 `electron-vite`(`npm run dev/build/dist`),**完全不动**。移动端单独加:

```bash
# 依赖(仅移动端用到)
npm i @capacitor/core @capacitor/app @capacitor/filesystem @capacitor/browser
npm i -D @capacitor/cli @capacitor/ios @capacitor/android
npm i @capawesome/capacitor-file-picker

# 一个纯 Web 构建(只打渲染层 → dist-mobile/),不走 Electron
npm run build:mobile        # 新增脚本:vite build --config vite.mobile.config.mjs

# 同步到原生工程
npx cap add ios            # 需 Xcode(macOS 已具备)
npx cap add android        # 需 Android Studio / SDK
npx cap copy
npx cap open ios|android   # 出包 / 真机调试
```

新增脚手架文件:`vite.mobile.config.mjs`(只构建渲染层、`base: './'`、输出
`dist-mobile/`)、`capacitor.config.ts`(`webDir: 'dist-mobile'`、`appId`)。
`package.json` 加 `build:mobile`、`cap:*` 脚本。`.gitignore` 忽略 `dist-mobile/`
及原生构建产物(`ios/App/Pods`、`android/.gradle` 等;平台目录是否入库后续定)。

`appId` 建议 `net.yangsir.horsemd`;应用名 HorseMD;图标/启动屏复用 `build/icon.png`。

## 7. 文件关联("用 HorseMD 打开 .md")

- iOS:`Info.plist` 注册 `CFBundleDocumentTypes`(public.markdown / .md)。
- Android:`AndroidManifest.xml` intent-filter(`text/markdown`、`.md`)。
- 两端经 `@capacitor/app` 的 `appUrlOpen` 回调 → 映射到现有 `onOpenPaths`。

## 8. 分阶段落地(确认后按此执行)

1. **脚手架**:装 Capacitor、`vite.mobile.config.mjs`、`capacitor.config.ts`、
   `build:mobile` 脚本;`npx cap add ios/android`;先跑通"空壳 + 现有渲染层能起来"。
2. **shim 最小集**:`platform/` + capabilities + 平台类名;先实现
   `readFile/writeFile/openFiles` + App 私有库 `readDir/createFile`,其余 no-op。
   目标:**能打开、编辑、保存一个本地 .md**。
3. **能力门控**:渲染层按 capabilities 隐藏窗口控件、PDF、图床、文件夹树(iOS)、
   监听相关 UI;加移动响应式样式 + 安全区。
4. **触摸 / 键盘打磨**:Milkdown 触摸交互、软键盘滚动、抽屉式侧栏。
5. **文件关联 + 更新检查**:intent / appUrlOpen;GitHub 更新检查复用。
6. **真机验证 + 出包**:iOS 模拟器/真机、Android 模拟器/真机;图标启动屏;商店素材。

## 9. 风险与注意

- **桌面零回归**:shim 仅在 `window.api` 缺失时挂载;移动样式仅在 `.is-mobile`
  选择器下;移动依赖不进 Electron 包。每步都要回归桌面 `npm run build`。
- **iOS 沙盒 / Android 分区存储**:任意目录访问受限,故 MVP 以 App 私有库为主。
- **Milkdown 触摸交互**是最大不确定项(选中工具条 / 拖拽手柄 / 长按),需尽早真机验证。
- **包体**:KaTeX / Mermaid 较大,移动端继续保持 `import()` 懒加载。
- **图床 exec 不可用**:移动端无 Node 子进程,MVP 禁用;未来做纯 HTTP 上传版本。
- **iOS 上架**需 Apple 开发者账号($99/年)与签名;Android 需 keystore。桌面那条
  "未签名"经验不适用,移动端商店强制签名。

## 10. 打包发布(Android / iOS)

### Android —— 出可下载的签名 APK
1. **生成 keystore(一次性,务必备份;丢了就无法用同一身份更新 App)**:
   ```bash
   keytool -genkeypair -v -keystore android/app/horsemd.keystore \
     -alias horsemd -keyalg RSA -keysize 2048 -validity 10000 \
     -dname "CN=HorseMD, O=HorseMD, C=CN"
   ```
   按提示设一个口令(自己记牢)。
2. 复制 `android/key.properties.example` → `android/key.properties`,填入口令(此文件已 gitignore)。
3. 出包:
   ```bash
   JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" npm run dist:android
   ```
   产物:`android/app/build/outputs/apk/release/app-release.apk`(签名、可分发)。
4. 上 **Google Play** 用 `./gradlew bundleRelease` 出 `.aab`。

> 没有 `key.properties` 时,release 不签名、debug 不受影响(`assembleDebug` 仍照常)。
> keystore / key.properties **永不入库**。

### iOS —— TestFlight / App Store(需 Apple 开发者账号 $99/年)
1. 注册 [Apple Developer Program](https://developer.apple.com/programs/)。
2. 在 [App Store Connect](https://appstoreconnect.apple.com) 新建一个 App 记录(Bundle ID = `com.horsemd.app`)。
3. Xcode:`npx cap sync ios` → 打开 `ios/App/App.xcodeproj` → 设好 Team(付费账号)、版本号/构建号 → 顶部设备选 **Any iOS Device** → **Product → Archive**。
4. Archive 完成 → **Distribute App** → **TestFlight & App Store** → 上传。之后在 App Store Connect 里发 TestFlight 测试或提交审核上架。

> iOS 无法像安卓那样发文件随便装;分发只能走 TestFlight / App Store /(Ad Hoc 限指定 UDID)。免费账号仅能装自己设备、7 天过期。

## 11. 桌面 / 移动端协作(加功能时怎么办)

桌面与移动端**共享同一套渲染层**(`App.jsx` / 组件 / 编辑器)。分开的只是**外壳**
(Electron preload vs Capacitor shim)和**构建链**(electron-vite vs
`vite.mobile.config.mjs` + Capacitor)。所以加桌面功能时,按类型处理:

| 功能类型 | 移动端表现 | 要做的事 |
|---|---|---|
| 纯前端 / 编辑器 / UI(新命令、编辑增强、面板、样式) | **自动也出现在移动端**(同一渲染层) | 一般不用重写;确认触摸下好用/不挤,不适合就用 `isMobile` / `window.api.capabilities` / `.is-mobile` CSS 隐藏(参考分屏/PDF/图床的做法) |
| 需要**新的原生能力**(调用新的 `window.api.*`) | 桌面 preload 有;移动 shim 没有 → 在手机上是 `undefined` | 在 `src/renderer/src/platform/capacitor-api.js` 里给移动端也实现,或加一个 `capabilities` 开关在移动端门控关掉。用**已有的** `window.api` 方法则两端都行 |
| 纯桌面 / Electron 专属(原生菜单、窗口控制、OS 集成) | 移动端用不上 | 用 `capabilities` 在移动端隐藏 |

**经验法则**
- 桌面新功能 = 改渲染层 → 默认移动端也带上;顺手判断"手机要不要/能不能用",不合适就 `isMobile`/`.is-mobile` 藏掉。
- 涉及**新原生能力**的,记得在 shim 里补一份或门控。
- 改完**跑一次 `npm run build:mobile`**(必要时装到设备点一下)——桌面 CI 只构建桌面,渲染层改动可能悄悄影响移动端,跑一下确认不崩。
- 门控用的能力开关定义在 `platform/index.js`(桌面)与 `platform/capacitor-api.js`(移动):
  `pdfExport / revealInFolder / splitView / imageHostExec / windowControls / nativeMenus / watch / folderWorkspace / canShare`。

## 12. CI / 发布(现状)

- **`.github/workflows/ci.yml`**:push/PR 到 `main` → 只跑桌面 `npm run build` 校验。
  不打 tag、不打包、**完全不碰安卓**。
- **`.github/workflows/release.yml`**:**仅当推 `v*` 标签时**触发,只打 **Windows +
  macOS** 安装包并发到**草稿** Release。**不构建安卓**,CI 里也没有 keystore(密钥被
  gitignore,未入库)。

→ **合并到 main 不会自动发版**;只有手动推 `vX.Y.Z` 标签才触发桌面打包。

**要随版本发安卓 APK,两条路:**
1. **手动(简单)**:本地 `npm run dist:android` 出签名包,手动传到那次 GitHub Release
   的附件(密钥只在本地)。
2. **CI 自动**:给 `release.yml` 加安卓 job——把 keystore(base64)+ 密码存成
   GitHub Actions **Secrets**,CI 里解码 + `assembleRelease` + 上传。一次性配置。

**移动端当前状态(截至合并)**:`feature/mobile` 已以合并提交并入 `main`(未发版、未打
tag)。Android 在真机(华为 Android 10)+ 平板(MatePad Android 12)验证通过;iOS 暂不
提供下载(未上架),代码在但真机未逐项复验。发版建议升到 **0.3.0**。
