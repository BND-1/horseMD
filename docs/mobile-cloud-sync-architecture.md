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

## 6. 共享同步引擎（Shared engine，2026-11-15）

同步逻辑已从 `src/main/sync/` 移到 `src/shared/sync/`，桌面和手机用同一份代码；平台差异只
通过注入的 adapter 进来。共享代码不 import `node:*` / `electron`，不用 `Buffer` /
`process`（环境变量经 `platform.env` 注入），只用 ES module、`Uint8Array`、
`TextEncoder/TextDecoder`、`Response/Headers`、`AbortController`；`@smithy/signature-v4`、
`@aws-crypto/sha256-js`、`fast-xml-parser`、`node-diff3` 都可在 WebView 里运行。

### 6.1 模块

| `src/shared/sync/` | 内容 |
|---|---|
| `sync-engine.js` | `SyncEngine({ platform, provider, rootPath, workspaceId, deviceName, onProgress, control, busyPaths, history })`、`massDeletion`、`readRemoteManifest` |
| `sync-service.js` | `SyncService({ platform, credentials, request \| http, traceLog, history, connectionsStore, secretAccessKeyId })`、`busyRelativePaths(paths, root, list)` |
| `sync-workspaces.js` | 同步文件夹注册表与 `.horsemd/workspace.json` 标记：`readWorkspaceRegistry / adoptSyncWorkspace / unregisterSyncWorkspace / bindSyncWorkspace / joinSyncWorkspace / listSyncWorkspaces(platform, …)` |
| `connections.js` | `ConnectionRegistry({ store, credentialStore, createWebDavProvider, createS3Provider, uuid, secretAccessKeyId })` |
| `s3-provider.js` / `webdav-provider.js` | 原 provider，新增可选 `bytes`、`uuid` |
| `local-files.js` | `scanLocalWorkspace(platform, root, { entries, cache, maxFiles })`、`scanLocalEmptyDirs`、`createHashCache` |
| `sync-state.js` / `sync-base.js` | 状态与三方合并祖先，经 `platform.store` |
| `sync-plan.js`、`sync-ignore.js`、`sync-control.js`、`request-pacer.js`、`sync-request.js`、`conflict-name.js` | 原纯逻辑（`sync-plan` 的 POSIX 路径函数是 `node:path/posix` 的逐行移植 `posix-path.js`，冲突副本名不变） |
| `bytes.js`、`http.js`、`web-adapters.js` | 字节编解码、把原始 HTTP adapter 包成 fetch 形式、WebView 用的 `webHash`（crypto.subtle）/ `webGzip`（CompressionStream）/ `createPosixPaths` |

桌面：`src/main/sync/*.js` 保留原路径和原签名（`new SyncEngine({ userDataPath, … })`、
`readSyncState(userDataPath, id)` 等），内部用 `src/main/sync/node-platform.js` 的 Node adapter
调共享代码；`src/main/sync-service.js` / `sync-workspaces.js` 保留 IPC 注册，接口不变。
`credential-store.js`（safeStorage）和 `electron-request.js`（net.request）仍是桌面专用。

### 6.2 adapter 合同（`platform` 对象）

路径一律是字符串；共享代码只拼相对路径（`/` 分隔），绝对路径由 `paths` 生成，桌面按
`node:path`（含 Windows），手机按 POSIX。fs 错误必须带 Node 风格的 `code`：
`ENOENT`、`EEXIST`、`ENOTEMPTY`。

```text
platform.fs
  scan(root) → [{ kind: 'file'|'dir', rel, abs, size?, mtimeMs?, cacheKey? }]
      递归、深度优先；不跟随符号链接；不进入 .horsemd/.git/.obsidian/node_modules；
      系统文件（.DS_Store 等）可省略。file 需要 size、mtimeMs；cacheKey 相同 = 内容未变
      （桌面：size:mtime:ctime:inode；没有可靠 key 的平台不给，每次都重算哈希）
  readBytes(abs) → Uint8Array                 缺失时抛 ENOENT
  writeAtomic(abs, bytes, { private? })        建父目录 + 临时文件 + rename
  writeNew(abs, bytes, { private? })           只新建，已存在抛 EEXIST
  mkdirp(abs, { private? })
  moveFile(from, to)                           先建 to 的父目录
  rm(abs)                                      不存在也不报错
  unlink(abs) / rmdir(abs)                     rmdir 非空抛 ENOTEMPTY
  readdir(abs) → [{ name, isFile, isDirectory }]
  exists(abs) → boolean                        ENOENT 以外的错误照抛
  stat(abs) → { isDirectory, isFile, size, mtimeMs }
platform.paths
  resolveInside(root, rel) → abs | null        严格在 root 内，否则 null
  relativeInside(root, path) → rel | null      编辑中文件 → 相对路径
  join(...parts) / basename(path)
  normalizeRoot(root) / isRootAllowed(root) / isRestrictedRoot(root)
platform.hash.sha256(bytes) → Promise<hex>
platform.bytes   fromText / toText / fromArrayBuffer / empty / base64（bytes.js）
platform.store   App 私有目录里的小文档，名字如 sync/state/<id>.json
  readText(name) → string|null    writeText(name, text, { private? })
  readBytes(name) → bytes|null    writeBytes(name, bytes)
  exists(name) → boolean          list(dir) → names      remove(name)   removeTree(dir)
platform.gzip(bytes) / gunzip(bytes) → Promise<Uint8Array>
platform.uuid() → string;  platform.deviceName() → string（冲突副本里的设备名）
platform.env                      只读，测试钩子（HORSEMD_TEST_SYNC_PACER 等）
platform.hashCache?               createHashCache()，每进程一个
```

服务另外需要：

```text
credentials   get(id) → object|null   set(id, object)   remove(id)
              桌面：safeStorage 加密文件；手机：Keychain / Keystore
request       (url, { method, headers, body, signal }) → Response（fetch 形式），或
http          request({ method, url, headers, body: Uint8Array|null, timeoutMs })
                → { status, headers: { 小写名: string }, body: Uint8Array }
              由 http.js 包成 fetch 形式；任意方法（PROPFIND / MKCOL）、不走缓存、
              非 Latin-1 头按 UTF-8 字节传（同 electron-request.js）
history       可选 { keep(absPath, bytes, reason) }；手机没有，删除/覆盖退回 .horsemd/trash
```

手机端设置：`secretAccessKeyId: true`（S3 Access Key ID 也只进安全存储），
`paths = createPosixPaths({ isRootAllowed: (p) => p === 'HorseMD' })`，`hash = webHash`，
`gzip/gunzip = webGzip/webGunzip`，`bytes = webBytes`。
