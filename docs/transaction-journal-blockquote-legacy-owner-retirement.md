# Transaction Journal：Blockquote legacy owner 退役

> 状态：HorseMD `0.13.149`
>
> 审计范围：`blockquote-paragraph-text-replace`、`blockquote-paragraph-split`、`blockquote-paragraph-join`、`blockquote-paragraph-exit`

## 1. 目标

四个 Blockquote family 在 `0.13.135`–`0.13.138` 已具备真实 ProseMirror Step、逐 Step `stepDoc`、稳定 descendant path、bounded raw patch、callback/forced-flush、保存与冷重开证据。但生产 structural registry 原先没有声明这些 family 的 legacy ownership 已退役，owner 拒绝后仍可能继续进入 `paragraph-emptied`、`middle-block-*`、`diverged-tail-block-append` 或行级 generic mapper。

这会形成双重所有权：Transaction Journal 已经根据 PM 事务证明“这是引用正文、拆分、合并或退出”，但 canonical-diff 层仍可根据最终 Markdown 形状重新猜测并发布同一变化。

`0.13.149` 完成控制流收口：一旦 PM Step 链已经完整识别 family，后续 raw source range、作者前缀、正文一致性或 semantic proof 失败只能 fail closed，不能再回退 legacy。

## 2. Recognition 边界

四个 owner 的拒绝现在显式分成两类。

### 未识别：`recognized=false`

以下仍允许继续遍历后续 focused owner，或进入尚未迁移的兼容路径：

- old/final document 不是唯一稳定 Blockquote path 变化；
- marks、atoms、跨段、跨块或多引用同批变化；
- Step 类型、范围、parent path 或 replay chain 不符合该 family；
- callback 尚未与 live expected document 对齐；
- journal、revision、source、canonical 或 provenance 已陈旧。

这些拒绝不能标记 `legacyBlocked`，否则会误伤空引用删除、IME 填充、generated scratch transient 和其它尚未迁移结构。

### 已识别：`recognized=true`

PM Step/stepDoc 已证明 family 后，以下失败必须阻断 generic fallback：

- PM→Markdown raw range 无法唯一映射；
- 作者源码正文与旧 PM 节点不一致；
- quote prefix、separator、indent 或单行边界不属于该事务；
- plain-text mapper 检测到 Markdown-sensitive 插入；
- bounded candidate 不能重新解析为 live expected document；
- semantic validator 抛错或拒绝。

生产 registry 为四个 entry 设置 `legacyRetired: true`。共享控制流仅在 `ownership.ok === false && ownership.recognized === true` 时产生 `legacyBlocked`，从而保留未识别 family 的兼容路径。

## 3. 负向真实产品证据

永久 Electron 回归 `test:blockquote-legacy-owner-retirement-ui` 打开带 BOM、CRLF 和作者前导空格的引用：

```md
before

 > quoted alpha

after
```

测试在可见引用正文末尾物理输入 `*`。PM transaction 被 `blockquote-paragraph-text-replace` 精确识别，但 plain-text raw mapper 返回 `syntax-sensitive-insert`。正确结果为：

- 富文本仍显示 `quoted alpha*`，用户编辑不会凭空消失；
- owner trace 为 `recognized:true / legacyBlocked:true`；
- `diverged-tail-block-append`、`structural-line-change` 等 generic mapper不得发布；
- `SourceSyncCoordinator` 不产生 transaction 或 legacy publication；
- 显示 fail-closed 警告；
- 不展示陈旧源码 textarea；
- 作者文件逐字保持原样。

这证明 retirement 不是把危险字符静默转义或交给旧 mapper，而是保护原文件并保留可恢复的富文本编辑状态。

## 4. 未退役兼容路径

本阶段只退役四个已经有完整 transaction owner 的 family，不删除下列独立合同：

- syntax-only 空引用删除；
- 空引用 IME 正文填充；
- generated scratch 引用尾随空 paragraph；
- 文档中间引用尾随空 paragraph 与后续填充；
- `blockquote-exit` 第一拍 pending 与 provenance-bound staged continuation；
- marks、多引用批次和其它未迁移结构的 fail-closed/compatibility 行为。

对应真实 Electron 门禁继续通过，说明 `legacyRetired` 没有扩大到未识别操作。

## 5. 永久门禁

纯合同：

```bash
npm run test:blockquote-legacy-owner-retirement
npm run test:blockquote-paragraph-transaction-owner
npm run test:blockquote-split-transaction-owner
npm run test:blockquote-join-transaction-owner
npm run test:blockquote-exit-transaction-owner
```

真实正反 Electron：

```bash
npm run test:blockquote-legacy-owner-retirement-ui
npm run test:blockquote-paragraph-transaction-ui
npm run test:blockquote-split-transaction-ui
npm run test:blockquote-join-transaction-ui
npm run test:blockquote-exit-transaction-ui
```

未迁移兼容路径：

```bash
npm run test:empty-blockquote-removal-ui
npm run test:empty-blockquote-ime-fill-ui
npm run test:generated-scratch-blockquote-empty-paragraph-ui
npm run test:middle-blockquote-empty-paragraph-ui
```

共享门禁：

```bash
npm run test:source-sync-transaction-journal
npm run test:source-sync-coordinator
npm run test:source-transaction-sync
npm run test:editor-api-transaction-flush
npm run test:markdown-preservation
npm run test:source-fidelity-probes
npm run test:source-fidelity-ui
npm run test:mixed-rich-source-transaction-ui
npm run build
npm run build:mobile
```

上述矩阵在 `0.13.149` 工作树全部 exit 0；source fidelity probes 为 `39/39`。本阶段未生成、安装或发布手测包，正式安装包长会话资格仍属于最终阶段 I。
