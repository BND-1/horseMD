# 移动端云同步架构

> 状态：设计已确认，尚未开放。更新：2026-07-20。

## 1. 结论

桌面端同步不能直接从 `src/main/sync/` 搬进 Capacitor shim。它依赖 Node
文件系统、Electron `safeStorage` 与主进程 `net.fetch`；在手机 WebView 中复用会造成
凭据明文存储、CORS 失败或只同步部分文件。移动端在满足下列条件前必须维持
`capabilities.cloudSync === false`。

第一期只同步 HorseMD 应用文档库 `HorseMD/`，不承诺同步 iOS 外部目录或 Android SAF
任意文件夹。这样本地根目录稳定、可递归扫描，也能与当前移动端的导入/保存模型一致。

## 2. 目标与非目标

### 目标

1. iOS/Android 可以为 HorseMD 应用文档库连接 WebDAV 或 S3 兼容存储。
2. 连接密码、WebDAV 应用密码与 S3 Secret 只保存在 iOS Keychain / Android Keystore。
3. 移动端与桌面使用相同的远端 workspace ID、manifest、三种同步策略和冲突规则。
4. 请求经 Capacitor 的原生 HTTP 通道发送，避免 WebView CORS 对 WebDAV `PROPFIND`、
   S3 条件请求和自建证书策略造成假失败。
5. 同步前仍给出文件级预览，`merge` 遇到远端被清空必须停在 `remote-reset`。

### 非目标

- 不做后台自动同步、文件系统 watcher、任意外部文件夹同步或 E2EE。
- 不让同步操作绕过用户的上传/下载/双向确认。
- 不在 WebView `localStorage` 保存任何密钥、密码或 Secret。

## 3. 分层

```text
SyncSettings / useSyncWorkspaces
  -> window.api.sync* (stable contract)
  -> desktop: IPC -> SyncService -> Node adapters
  -> mobile: Capacitor shim -> mobile sync service -> native HTTP + Filesystem
```

共享层只保留无 Node 依赖的同步计划、manifest 和冲突规则。移动端要新增：

1. `mobile-sync-local-files`：基于 `@capacitor/filesystem` 的递归扫描、读取、写入、
   回收路径和 SHA-256（Web Crypto）。
2. `mobile-sync-providers`：WebDAV、S3 的字节/条件写适配器，使用 Capacitor 8
   `CapacitorHttp` 原生请求；S3 签名继续使用浏览器兼容的 Smithy 依赖。
3. `mobile-sync-state`：只存 workspace 注册表、manifest 基线和非敏感连接字段。
4. `HorseMDSecureStore` 原生插件：iOS Keychain 与 Android Keystore 读写/删除密钥。
5. 一套与桌面相同的窄 `window.api.sync*` 合同；UI 不应知道平台的密码保存方式。

## 4. 安全规则

- 连接名、endpoint、bucket、region、用户名、可选 User-Agent 可存普通 registry。
- WebDAV 密码与 S3 Secret 必须仅写 `HorseMDSecureStore`；`accessKeyId` 是否视为敏感
  由实现统一处理，默认一并放入安全存储以减少误泄漏面。
- 拒绝含换行的 User-Agent，限制长度 256；所有 HTTPS/HTTP 策略与桌面保持一致。
- 只允许同步 `HorseMD/` 相对路径；排除 `.horsemd`、`.git`、`.obsidian`、
  `node_modules`，拒绝 `..` 和绝对路径。
- 远端 manifest 条件提交必须在文件传输成功后最后执行。本地同步状态只能在 manifest
  成功提交后推进。

## 5. 实施顺序与验收

1. 实现并在 iPhone、Android 真机验证安全凭据插件：写入、读取、更新、删除，卸载/重装
   的平台差异要明确记录。
2. 实现移动文件库 adapter，覆盖 Markdown、图片/附件、目录、回收站与哈希。
3. 复用计划纯函数，实现 WebDAV 后以真实服务做上传、下载、冲突和远端清空测试。
4. 实现 S3/MinIO，验证 SigV4、路径前缀、条件写和 `User-Agent`。
5. 接通 UI 并把 `cloudSync` 打开；连接编辑、测试、预览、上传、下载、双向同步都必须
   在两类真机完成回归。

在第 5 步之前，手机不显示同步设置。这不是功能缺失，而是避免用户误以为凭据和文件
已经被安全同步。
