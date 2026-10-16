# 云同步 v2 架构设计

## 1. 保持的边界

```text
SyncSettings -> useSyncWorkspaces -> window.api -> IPC -> SyncService -> SyncEngine -> Provider
```

Renderer 只传递 `strategy`，不接触凭据、远端前缀或任意网络请求。Provider 继续只负责 WebDAV/S3 的读、写、列举、条件写和删除。

## 2. 同步策略 API

`strategy` 取值：

- `merge`：日常双向同步。
- `push`：本地为权威来源，写入云端。
- `pull`：云端为权威来源，写入本地。

接口保持向后兼容：

```js
syncPreview(rootPath, strategy = 'merge')
syncRun(rootPath, strategy = 'merge')
```

旧调用仍是 `merge`。方向化调用在执行前始终要求确认。

## 3. 计划层

`sync-plan.js` 新增方向化计划：

- `push` 遍历本地和远端并集：本地存在则 `upload`，仅远端存在则 `deleteRemote`。
- `pull` 遍历并集：远端存在则 `download`，仅本地存在则 `deleteLocal`。
- 方向化的 `upload` 标记 `preserveRemote`；`download` 标记 `preserveLocal`。执行层先归档目标端旧文件，再替换。

`merge` 保持现有基于上次成功哈希的三方判断。

## 4. 远端重置识别

`SyncEngine.preview('merge')` 在以下任一条件返回 `status: 'remote-reset'`：

1. 本机有成功同步状态而远端 manifest 不存在。
2. 本机有成功同步状态，远端 manifest 文件列表为空，且不存在任何删除墓碑。

此结果不含可执行删除操作。`execute` 拒绝执行 `remote-reset` 的 merge preview。`push` 和 `pull` 仍可生成显式的恢复计划。

## 5. 执行和提交顺序

1. 扫描、读取 manifest、生成计划。
2. 对有破坏性的方向化操作归档被替代版本。
3. 传输文件并校验预览时的 revision/hash。
4. 条件写入 manifest。
5. 只有 manifest 提交成功后，写入本机同步状态。

这样网络中断、权限失败或并发改动最多留下可恢复的归档，不会把未完成的计划记为已同步。

## 6. 兼容性

- 保留 `HorseMD/<workspace-id>` 和旧 `HorseMD/v1/workspaces/<workspace-id>` 查找逻辑。
- 本机 state 仍为版本 1；策略不写入永久状态，因此不需要迁移。
- 远端 manifest 继续为版本 1；新增保护仅依赖已有 `files` 和 `tombstones`。

## 7. 测试层次

1. 纯函数：策略计划、远端重置检测、冲突/删除矩阵。
2. SyncEngine：归档覆盖、远端清空保护、push/pull 后的基线。
3. Electron IPC：真实 MinIO 和内置 WebDAV 服务，验证策略参数穿过 preload。
4. UI：方向按钮、远端重置提示、确认流程、连接编辑不泄露密钥。
