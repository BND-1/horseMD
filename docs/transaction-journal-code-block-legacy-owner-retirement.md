# Transaction Journal：代码块 Legacy Owner 退役审计

> 状态：HorseMD `0.13.148`
>
> 审计范围：已进入生产 structural owner registry 的四个代码块 family
>
> 目标：删除已被 Transaction Journal 完整覆盖的 canonical-diff owner，并在 journal 已识别 family 后禁止 generic legacy fallback 重新猜测同一操作

## 1. 为什么需要单独做退役审计

把一个 Transaction Journal owner 接入生产 registry，并不自动等于旧 canonical-diff 路径已经退出。

如果新 owner 因作者 source range、围栏冲突或 semantic proof 不足而拒绝，而控制流仍继续调用 `preserveRichMarkdownSource()`，generic legacy mapper 可能从 delayed canonical 的最终形状重新猜测操作。真实诊断已经证明：删除代码块正文专用 mapper 后，同一空代码块首批正文会被 generic `middle-block-inserted` 认领，并把代码写到 opening fence 外。

因此本轮采用两层退役合同：

1. 有独立 legacy mapper 的 family，先加“旧分支不得存在、不得命中”回归，再物理删除该函数、import 与 dispatcher 调用；
2. 没有独立 mapper、但可能被 generic legacy 接管的 family，在 Transaction Journal 完成 Step replay 后标记 `recognized: true`，registry 以 `legacyRetired: true` 阻断 fallback；不新增任何 canonical fence 形状特判。

## 2. 退役矩阵

| Transaction Journal family | 旧 canonical-diff 状态 | 本轮退役动作 | 保留边界 |
| --- | --- | --- | --- |
| `code-block-content-replace` | 存在 dedicated `preserveFencedCodeBlockTextChange()`，reason 为 `fenced-code-block-content-change` | 物理删除函数、import、dispatcher 调用和旧正向单测；registry 标记 `legacyRetired` | fenced range scanner继续供 Transaction Journal 做物理范围证明 |
| `code-block-info-string-change` | 没有同名 dedicated mapper，但 generic line/middle mapper可能重新猜 opening info 变化 | 完整 `AttrStep` replay 后的 source/range 证明失败标记 `recognized`，阻断 generic legacy | AttrStep分类或callback mismatch仍允许其他 owner继续检查 |
| `empty-code-block-backspace-unpack` | 没有 dedicated canonical owner，generic lifecycle mapper可能只删一侧 fence或泄漏 `<br />` | 完整 structural Step replay 后的 raw range/language/semantic失败标记 `recognized`，阻断 generic legacy | `awaiting-content` 仍 `deferred + holdJournal`，不报错、不清 journal |
| `code-block-exit` | 没有 dedicated canonical owner，generic paragraph mapper可能把退出段错误插入别处 | coalesced/staged Step replay 后的 source/range/language/semantic失败标记 `recognized`，阻断 generic legacy | classification、错误insert Step、callback mismatch仍为未识别拒绝 |

本轮没有删除 `fencedBlocks()`、`fencedCodeBlockAt()` 或 Transaction Journal 使用的 fenced source range helper。它们只负责解析作者物理围栏范围，不拥有 publication，也不属于 legacy owner。

## 3. 通用控制流合同

`legacyRetired` 不是“这个 owner 一拒绝就阻断一切”的开关。阻断必须同时满足：

```text
registry entry.legacyRetired === true
ownership.ok !== true
ownership.recognized === true
```

处理顺序为：

1. owner先用 oldDoc、expectedDoc、真实 Step、逐 Step `stepDoc` 和 journal continuity 分类 family；
2. 分类或 Step replay失败返回 `recognized: false`，registry继续尝试后续 owner，必要时仍可进入未迁移 legacy family；
3. family已被完整 Step链识别后，若作者 source range、正文、language、围栏冲突或 semantic proof失败，返回 `recognized: true`；
4. registry把该结果转换为 `legacyBlocked: true`，`markdownUpdated` 和 forced flush都直接 fail closed；
5. 不调用 legacy preservation，不发布 Coordinator candidate，不覆盖作者 source或磁盘；
6. stale revision/source/doc仍按原规则优先 reset；空块 pending hold仍按原规则保留 journal。

成功 publication 的 Coordinator validation 若失败，已退役 family 同样返回 `legacyBlocked`，防止验证失败后再落回 canonical guess。

## 4. 正向与负向产品证据

### 正向

以下真实路径均要求同名 reason 只能携带对应 transaction proof，且 Coordinator owner不得是 `legacy`：

- code content callback与立即 forced flush；
- code info picker callback与立即 forced flush；
- empty code block快速正文、pending hold与forced-empty；
- code exit快速输入、自然 staged与立即 forced-flush staged；
- source、保存、CRLF磁盘和全新 profile冷重开。

### 负向

`test:code-block-legacy-owner-retirement-ui` 使用作者 `~~~js` fence：

1. 通过真实鼠标把 CodeMirror光标放到代码末行末尾；
2. 物理输入 Enter 和独立 `~~~` 行；
3. Transaction Journal 正确识别 `code-block-content-replace`；
4. owner 因作者 tilde closing-fence collision返回 `recognized: true`；
5. registry trace必须为 `legacyBlocked: true`；
6. 富文本内冲突行继续可见，但没有 preservation/Coordinator publication；
7. 用户收到 fail-closed warning；
8. source textarea不以陈旧内容打开，原磁盘文件逐字不变。

这条回归专门防止 dedicated mapper 删除后，generic `middle-block-inserted` 或其它 canonical-diff reason重新接管。

## 5. 永久回归

纯合同：

```bash
npm run test:code-block-legacy-owner-retirement
npm run test:code-block-transaction-owner
npm run test:code-block-info-transaction-owner
npm run test:empty-code-block-unpack-transaction-owner
npm run test:code-block-exit-transaction-owner
npm run test:editor-api-transaction-flush
npm run test:markdown-preservation
```

真实 Electron：

```bash
npm run test:code-block-legacy-owner-retirement-ui
npm run test:middle-codeblock-source-ui
npm run test:code-block-info-transaction-ui
npm run test:empty-code-block-unpack-transaction-ui
npm run test:code-block-exit-transaction-ui
npm run test:code-block-exit-staged-ui
npm run test:code-block-exit-forced-flush-ui
```

相邻与全局门禁：

```bash
npm run test:code-fence-delete-source-ui
npm run test:literal-triple-backtick-source-ui
npm run test:tail-fence-ui
npm run test:source-sync-transaction-journal
npm run test:source-sync-coordinator
npm run test:source-transaction-sync
npm run test:mixed-rich-source-transaction-ui
npm run test:source-fidelity-probes
npm run test:source-fidelity-ui
npm run build
npm run build:mobile
```

## 6. 尚未退役的代码块生命周期

本轮只覆盖已经真实接线并完成 owner合同的四类 family。以下仍不能借用本轮 `legacyRetired` 标记：

- paragraph转换为code block；
- 非空code block整体转换为paragraph；
- code block与相邻paragraph的边界合并；
- 创建、删除、拆分、合并或改变完整fence结构；
- Slash创建瞬间之外的未迁移结构命令；
- nested或跨block selection。

这些 family 必须先建立真实 Step/stepDoc、bounded raw patch、callback/forced-flush、保存和冷重开证据，再独立登记退役；不能因为相邻代码块 family 已完成就阻断它们的现有安全路径。
