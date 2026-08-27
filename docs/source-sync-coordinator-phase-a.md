# SourceSyncCoordinator 阶段 A：统一源码同步生命周期

> 状态：阶段 A 核心生命周期已完成；专项入口按后续 family 继续迁移<br>
> Phase A 基线：HorseMD `0.13.125`；首批后续专项迁移：`0.13.126`（inline-code、frontmatter、Slash code/math）<br>
> 日期：2026-08-26<br>
> 性质：行为保持型架构抽取，不扩大 transaction-first authority，不删除现有 fail-closed 保护。

## 1. 背景

HorseMD 同时维护作者原始 Markdown、Crepe/ProseMirror 文档、serializer canonical Markdown、App tab 镜像和磁盘文件。当前已经具备严格的 semantic/list-slot integrity gate、transaction observer、SourceRangeMap、transaction-first shadow/authority 以及大量真实 UI 回归，但生产同步仍由多条并行路径共同完成：

1. `markdownUpdated` 中的 legacy canonical preservation；
2. transaction-first checkpoint/reconcile；
3. `flushMarkdown()` 的强制同步；
4. list conversion、slash command、inline code、frontmatter、paste、generated scratch 等专项入口；
5. 多处直接更新 `lastMarkdownRef`、`canonicalMarkdownRef` 和 `onChange`。

这些路径各自可以生成 candidate、执行校验、推进 baseline 或清理 intent。RS-68、RS-79 等现场已经证明，即使最终 candidate 正确，只要同一个事务被不同路径以不同上下文先后处理，也可能先产生一次 integrity failure，再由后续 callback 自愈。最终自愈不满足 HorseMD 的 first-divergence 合同。

阶段 A 不重写列表、表格、代码块等 mapper。它先统一生命周期，让现有 legacy preservation 作为一个明确的 `LegacyOwner` 运行，并建立后续 transaction family 迁移所需的数据合同。

## 2. 目标

阶段 A 的目标是把源码同步逐步收敛为：

```text
Editor event
  -> SourceSyncCoordinator
  -> one owner result
  -> one candidate bound to one snapshot revision
  -> one validator
  -> one atomic publication
  -> next immutable snapshot
```

必须满足：

1. 同一个 candidate 的 `reason`、`integrityProof`、authored source、canonical 和 expected PM doc 作为一个对象传递，不能分散在参数和局部变量中；
2. candidate 必须绑定产生它的 source/canonical revision；
3. stale candidate 不得 publication，也不得推进 canonical baseline；
4. validation 成功与 publication 是两个独立阶段；Coordinator validation 不得提前建立 trusted checkpoint；
5. 只有 host commit 成功后，publication 才能一次性更新 source、canonical、revision、App 镜像和 trusted checkpoint；
6. legacy mapper 顺序和现有 reason 语义在阶段 A 保持不变；
7. transaction-first authority 范围仍只限已明确 allowlist 的普通段落 family；
8. 任何失败继续 fail closed，保存和源码切换不得把旧 source 当作新结果返回。

## 3. 本阶段非目标

阶段 A 明确不做：

- 不把所有列表事务改写为 transaction-first；
- 不删除 `preserveRichMarkdownSource()` 中的 RS-family mapper；
- 不改变 serializer、parser 或 list fingerprint 的比较规则；
- 不用 canonical 整篇覆盖作者源码；
- 不默认开启新的 authority family；
- 不把 source textarea 改成受控组件；
- 不重写 `useSourceModeSwitch` 或保存恢复策略；
- 不因纯架构抽取升级版本号。只有用户可感知行为变化或独立 bug 修复才消费 patch 版本。

## 4. 核心合同

### 4.1 SourceSyncSnapshot

每次成功 publication 后形成不可变快照：

```js
{
  revision: 17,
  source: 'author-authored markdown',
  canonical: 'serializer projection',
  doc: pmDoc,
  sourceDigest: '...',
  canonicalDigest: '...',
  parentRevision: 16,
  owner: 'legacy',
  family: 'legacy-preservation',
  reason: 'localized-change'
}
```

约束：

- `revision` 单调递增；
- 相同 source/canonical 的只读确认可以复用 revision；
- source 或 canonical 任一变化都必须生成新 revision；
- snapshot 中的 source/canonical 不得被后续代码原地修改；
- PM doc 仅作为 snapshot identity，不做深拷贝；ProseMirror node 本身是持久化不可变结构。

### 4.2 SourceSyncCandidate

所有 owner 返回统一 candidate：

```js
{
  owner: 'legacy',
  family: 'legacy-preservation',
  baseRevision: 17,
  markdown: 'candidate source',
  canonical: 'current canonical',
  expectedDoc: currentPmDoc,
  reason: 'rapid-nested-ordered-parent-backspace-lift',
  proof: {
    kind: 'legacy-integrity-proof',
    preservationProof: {
      kind: 'localized-list-slots',
      ...ranges
    }
  },
  preserved: true,
  validationSite: 'markdown-updated-primary'
}
```

`reason` 仍用于兼容当前 legacy semantic transient 规则和诊断；安全放行所需的附加证据必须在 `proof` 中，并与 candidate 一同传递。

### 4.3 ValidationResult

Validator 返回结构化结果：

```js
{
  ok: true,
  reason: null,
  semantic: {
    direct: true,
    transition: false,
    committedCheckpoint: false
  },
  structure: {
    listSlots: true,
    listTransition: false,
    localizedList: false
  },
  lifecycle: {
    checkpointTrusted: true,
    baseRevisionMatched: true
  }
}
```

阶段 A 内部仍调用现有 semantic/list-slot 实现，结果形状先结构化，后续 family 才逐步停止依赖 reason-specific 例外。

### 4.4 Publication

Publication 必须绑定已通过验证的 candidate：

```js
{
  owner: candidate.owner,
  family: candidate.family,
  baseRevision: candidate.baseRevision,
  markdown: candidate.markdown,
  canonical: candidate.canonical,
  expectedDoc: candidate.expectedDoc,
  reason: candidate.reason,
  proof: candidate.proof,
  validation
}
```

Publisher 必须重新检查：

- candidate 的 `baseRevision` 是否仍等于当前 snapshot revision；
- validation 是否属于同一个 candidate；
- candidate markdown/canonical 是否与 validation digest 相同；
- publication 是否已经使用过。

任一条件不满足返回 stale/rejected，不更新任何 ref。

## 5. 模块边界

阶段 A 新增：

```text
src/renderer/src/lib/source-sync/
  snapshot.js       # revision、digest、immutable snapshot
  proof.js          # legacy proof/candidate 绑定
  checkpoints.js    # trusted source/canonical snapshot store
  validator.js      # 统一 semantic/list-slot validation
  publisher.js      # 原子 source/canonical/App publication
  legacy-owner.js   # preserveRichMarkdownSource 的 owner adapter
  coordinator.js    # candidate -> validate -> publish 生命周期
  editor-bridge.js  # Editor live refs、transaction proof 与原子 host commit 适配
  index.js          # 稳定 facade
```

原则：

- 纯模块不依赖 React；
- `Editor.jsx` 只负责提供 parser/serializer、当前 PM doc 和 UI side effects；
- `LegacyOwner` 只调用现有 mapper，不复制 mapper 逻辑；
- Validator 不直接弹 toast；
- Publisher 不做 parser 工作；
- Coordinator 不理解某个具体 RS reason，只传递 proof 和结果；
- UI warning 仍由 Editor 在 coordinator 返回 rejected 后触发。

## 6. 阶段 A 实施切片

### A1. 文档与纯合同

- 写入本文件；
- 建立 snapshot、candidate、proof、publication 的纯函数；
- 建立 revision/stale/proof-binding 单元测试；
- 不接入 Editor。

### A2. 统一 trusted checkpoint 与 validator

- 从 `Editor.jsx` 抽出 source/canonical trusted checkpoint store；
- 抽出 `validateSourceCandidate` 的主体；
- 保留原 trace 字段和 reason-specific semantic options；
- Editor 通过依赖注入提供 parser、serializer 和当前 canonical baseline。

### A3. LegacyOwner 与 publication facade

- `markdownUpdated` 和 forced flush 通过 `LegacyOwner` 创建 candidate；
- candidate 始终携带自己的 `integrityProof`；
- 成功 publication 使用统一 facade 更新 source/canonical；
- 暂时允许专项入口继续直接 publication，但逐项登记并迁移。

### A4. Coordinator 接管普通 callback

- 普通 `markdownUpdated` 走 `coordinator.evaluate(candidate)`；
- transaction-first authoritative publication 也生成同一 candidate/publication 形状；
- fallback candidate 不继承另一个 candidate 的 proof；
- failed candidate 不推进 snapshot。

### A5. 阶段 A 关闭后的专项入口迁移

阶段 A 先关闭公共生命周期；以下入口按风险从低到高在后续 family 中继续迁移：

1. list conversion immediate snapshot；
2. generated scratch；
3. paste/whole-document replacement。

这些专项入口不是阶段 A 关闭的前置条件，但必须保留显式 owner 登记。每迁移一个入口都必须删除对应的直接 source/canonical publication，而不是永久增加第二套状态。

## 7. 阶段 A 已接入的范围

阶段 A 已接入：

- trusted checkpoint store；
- legacy candidate 的统一构造；
- validator facade；
- 普通 `markdownUpdated` 成功 publication；
- `editor-api.flushMarkdown()` 成功 publication；
- transaction-first early/late authority publication；
- inline-code plugin-owned value-change publication；
- frontmatter node-view value-change publication；
- Slash code/math before/after token atomic publication；
- live source/canonical/doc stale guard；
- host commit 异常时 source/canonical ref 回滚；
- Coordinator validation 阶段不 trust 未发布 candidate，成功 commit 后统一建立 checkpoint；
- legacy 非 Coordinator 直接校验保留历史默认 trust 行为；
- 常量空间的最近 candidate 重放门禁。

暂不接入：

- list conversion command 内部的即时 source snapshot；
- slash command 的 command-before/after token；
- frontmatter node-view callback；
- source mode `replaceMarkdown()`；
- whole-document selection replacement；
- generated scratch post-list transient token。

这些入口继续使用当前逻辑，但会在文档结尾维护剩余清单。

## 8. 测试策略

### 8.1 纯合同测试

新增 `scripts/test-source-sync-coordinator.mjs`，覆盖：

- snapshot revision 单调递增；
- 相同 source/canonical 的 trusted checkpoint 可识别；
- candidate 缺 markdown/canonical/baseRevision 时拒绝；
- proof 绑定 candidate digest；
- validation 绑定 candidate digest；
- stale base revision 禁止 publication；
- 同一 publication 不能重复提交；
- failed validation 不更新 snapshot；
- fallback candidate 不继承原 candidate proof；
- legacy owner 保留 `reason`、`preserved` 和 `integrityProof`。

### 8.2 行为保持回归

最低门禁：

```bash
npm run build
npm run test:source-sync-coordinator
npm run test:markdown-preservation
npm run test:source-transaction-sync
npm run test:source-fidelity-probes
```

Editor 接线后增加：

```bash
npm run test:source-sync-coordinator-ui
npm run test:source-fidelity-ui
npm run test:transaction-first-authority-ui
npm run test:transaction-first-authority-large-doc-ui
npm run test:rapid-nested-parent-backspace-lift-ui
npm run test:editor-flush-settle
npm run test:source-sync-recovery
```

### 8.3 First-divergence 门禁

所有相关 UI 测试必须断言：

- `window.__hmSourceIntegrityTrace` 中 `ok=false` 为 0；
- 无 source-sync warning toast；
- source textarea 与预期逐字相等；
- 磁盘与 source textarea 一致；
- cold reopen 后结构和源码保持；
- 最终自愈不能抵消中途 failure。

### 8.4 后续生成式测试入口

阶段 A 完成后再新增：

```text
scripts/test-source-sync-generative.mjs
scripts/test-source-sync-metamorphic.mjs
scripts/test-source-sync-ui-fuzz.mjs
scripts/test-source-sync-fault-injection.mjs
```

它们使用固定 seed、可重放操作序列和失败 shrinker。生成式测试不能在 Coordinator 尚未形成单一 revision/event 模型前直接驱动大规模修复，否则只能继续产出难以归类的 legacy mapper 症状。

## 9. 完成标准

阶段 A 完成状态：

- [x] 新架构文档与代码合同一致；
- [x] snapshot/candidate/proof/validation/publication 均有 revision 绑定；
- [x] trusted checkpoint store 不再由 Editor 手写数组维护；
- [x] validator 主体离开 Editor；
- [x] 普通 markdown callback 和 forced flush 使用统一 candidate 合同；
- [x] 普通 callback、forced flush、transaction early/late authority 使用统一 Publisher；
- [x] validation 不提前 trust，host commit 失败不会留下未发布 checkpoint；
- [x] transaction-first authority 范围未扩大；
- [x] legacy mapper 顺序未变化；
- [x] targeted + family regression 全绿；
- [x] 没有新增 source-sync warning 或 first-divergence；
- [x] 文档登记尚未迁移的直接 publication 入口。

## 10. 后续迁移顺序

阶段 A 完成后：

1. 正式默认启用已证明的 `plain-paragraph-inline-replace` family；
2. paragraph split/join 与顶层空段落形成独立 family；
3. blockquote/heading 正文编辑；
4. fenced code/frontmatter/inline atom；
5. list item body；
6. list split/join/lift/sink/input-rule/type conversion/task；
7. table structure；
8. 删除已被新 owner 覆盖的 legacy mapper 和 reason-specific validation 例外。

每个 family 均遵循：

```text
contract -> pure tests -> shadow differential -> UI cadence matrix
-> authoritative opt-in -> full family regression -> default enable
-> delete matching legacy owner
```

不允许只增加新 owner 而永久保留相同事务的多重 publication 权限。

## 11. 直接 publication 入口登记

阶段 A 已迁移到统一 candidate/validation/publication 生命周期：

- ordinary `markdownUpdated`；
- forced `flushMarkdown()`；
- transaction-first early authority；
- transaction-first late authority；
- inline-code value change；
- frontmatter node-view value change；
- Slash code/math atomic block command（首批 post-Phase-A 专项入口，0.13.126）。

仍保留直接 source/canonical 更新、后续必须逐项迁移的入口：

- historical transaction-primary path；
- block-to-list conversion；
- list-type conversion；
- programmatic source `replaceMarkdown()`；
- transaction-primary pending publication；
- initialization canonical checkpoint；
- generated scratch 与 paste/whole-document 的专项 token/快照维护。

这些入口继续保留现有明确 owner 和 fail-closed 规则。后续迁移必须在对应 family 完成 candidate/proof/validation/UI cadence 门禁后，删除旧直接 publication，而不是再叠加第二套写回权限。
