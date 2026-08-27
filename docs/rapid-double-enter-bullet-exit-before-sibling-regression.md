# RS-86：快速双 Enter 退出空 bullet 且保留后继项回归

> 修复版本：HorseMD 0.13.131  
> 首发现场：正式安装版 0.13.130，PID 258  
> Trace：`horsemd-input-trace-258.jsonl`  
> 首处失败：2026-08-27 04:02:31.385，line 332，`source-document-mismatch`

## 1. 真实操作

用户在长期编辑后的 mixed-marker bullet 区域中已有：

```md
- u高科技

- 12312

- 1\. 色粉色分
```

这些 authored 行使用 `-`。由于该区域经历过列表创建、空项填充、marker 恢复等多轮事务，live ProseMirror 树对应的 previous canonical 仍可能保留 `-`，而不是普通冷打开后统一的 `*`。

用户随后：

1. 将光标放到中间项 `12312` 末尾；
2. 快速按第一次 Enter；
3. 不等待 `markdownUpdated` / source callback 发布，再按第二次 Enter。

## 2. 两个 ProseMirror 事务

Trace 中的关键事件：

```text
line 323  keydown Enter
line 324  ProseMirror replace：创建空 bullet sibling
line 327  keydown Enter
line 328  replaceAround：把空 bullet 提升为顶层空 paragraph
line 331  markdown-sync：错误 reason=empty-list-item-removed
line 332  source-sync-integrity-failure
line 333  markdown-sync-integrity / source-document-mismatch
```

第一拍在 `12312` 与后继项之间创建空 bullet。若这一拍单独发布，中间状态近似：

```md
- u高科技

- 12312

- <br />

- 1\. 色粉色分
```

第二拍立即退出这个空 bullet。最终 live PM 结构为：

```text
bullet_list
├─ u高科技
└─ 12312

paragraph(empty)

bullet_list
└─ 1. 色粉色分
```

最终 canonical 是：

```md
- u高科技

- 12312

<br />

* 1\. 色粉色分
```

顶层 `<br />` 是 Crepe 对 live 空 paragraph 的占位；列表被拆分后，后继列表被重新序列化，marker 从 previous canonical 的 `-` 变为 `*`。后继正文并未改变。

## 3. 旧链路为什么误删后继项

旧逻辑在 raw canonical 进入专用判断前，没有识别“空 bullet 的创建与退出被合并成一个 callback”。

`commonChange(previous, next)` 同时包含：

```text
1. 插入顶层 <br />
2. 后继 marker - → *
```

通用 `preserveEmptiedParagraph()` 会尝试判断某条列表行是否被删除。由于 change 尾部还残留后继 marker 字符，它错误命中 `empty-list-item-removed`，把真正非空的后继行当作退出的空列表行。

Trace line 331 的错误 candidate 因而从：

```md
- 12312

- 1\. 色粉色分

1. 啊额法色饭
```

变成：

```md
- 12312

1. 啊额法色饭
```

严格校验检测到 live PM 中仍有 `1. 色粉色分`，因此 `semanticOk=false` 并正确阻止写回。这里不能关闭校验，也不能把 `<br />` 写进作者源码。

## 4. 正确源码为什么不需要变化

作者源码中的原 block gap 已经足够表达列表项之间的分隔。第二次 Enter 产生的顶层空 paragraph 是当前富文本编辑会话中的结构 transient；重新解析源码时，Markdown parser 会忽略这一空 paragraph，同时把相邻同类列表按语义合并。

因此正确 candidate 就是原 source：

```md
- u高科技

- 12312

- 1\. 色粉色分
```

本事务只应推进 canonical baseline，不能增加、删除或改写任何作者字节。

## 5. 专用 raw owner

新增：

```text
preserveCoalescedEmptyBulletExitBeforeSibling
```

发布 reason：

```text
coalesced-empty-bullet-exit-before-sibling
```

它在 raw previous/next 阶段运行，排在 `<br />` normalization、ordered delimiter normalization 与通用 empty-row removal 前。

只有以下条件全部成立才认领：

1. previous 中存在唯一顶层、非任务、非空的 middle bullet；
2. middle 后的最近非空行为唯一顶层、非任务、非空 successor bullet；
3. middle 与 successor 之间存在真实 block gap；
4. successor 行与真实 `commonChange` 精确相交；
5. next 中 middle 与 successor 之间恰好新增一行未缩进 `<br />`；
6. middle 的 marker、spacing、正文逐字不变；
7. successor 的 spacing 与正文逐字不变；
8. successor 只允许一个字符的 bullet token 变化；
9. next 中 middle→`<br />` 与 `<br />`→successor 的两个 gap，必须分别逐字等于 previous 的旧 gap；
10. previous/next 从文档开头到 middle 行尾完全相同；
11. previous/next 从 successor 行尾之后到文档结尾完全相同；
12. source 中同一 visible middle/successor pair 必须唯一；
13. previous、next、source 三侧目标都不得位于 fenced code 内；
14. 目标必须是顶层普通 bullet，不接受 task、ordered、nested 或缩进空段。

命中后返回：

```text
markdown = source
preserved = true
reason = coalesced-empty-bullet-exit-before-sibling
nextBaseline = next
```

## 6. 为什么没有增加 semantic 例外

现有语义比较已经具备两个必要规则：

1. 忽略顶层 editor-owned 空 paragraph；
2. 合并相邻同类型 list node 的 item stream。

因此原 source 重新解析后与 live PM 语义一致，`semanticOk=true`、`listSlotsMatch=true`。RS-86 不需要新增任何语义豁免。

这也意味着：

- 不修改 `source-sync/validator.js` 的 reason allowlist；
- 不放宽 list fingerprint；
- 不把本 reason 加入 generated-scratch 特例；
- 普通 save/source-mode forced flush 直接重新调用同一 raw owner即可。

## 7. Fail-closed 边界

以下情况全部返回 `null`，继续交给其它 owner 或严格拒绝：

- successor 正文在同 callback 中变化；
- middle 正文在同 callback 中变化；
- `<br />` 带缩进；
- source 中出现重复 middle/successor visible pair；
- 文档前部或后部还有无关变化；
- marker-like 行位于 fenced code；
- previous 与 next 的 gap 数量或字节不同；
- successor marker 没有变化；
- task item、ordered item、nested item；
- source target 无法唯一定位。

普通 all-`*` canonical 的快速双 Enter 不由 RS-86 认领，仍由既有 `middle-empty-block-created` 处理。

## 8. 永久回归

### 8.1 纯函数与真实 trace

```bash
npm run test:markdown-preservation
npm run test:source-fidelity-probes
npm run test:source-transaction-sync
```

覆盖：

- PID 258 mixed-marker 正例；
- 完整长文档 line 331 三态直接回放；
- LF 与 CRLF；
- 普通 all-`*` 控制组不得被专用 owner 抢占；
- middle/successor 正文夹带编辑拒绝；
- 缩进 `<br />` 拒绝；
- 重复 source target 拒绝；
- 无关前文变化拒绝；
- fenced code 拒绝。

source-fidelity probes 当前为：

```text
39/39
```

完整 trace 回放结果：

```text
oldReason=empty-list-item-removed
fixedReason=coalesced-empty-bullet-exit-before-sibling
preserved=true
sourceUnchanged=true
successor preserved=true
```

### 8.2 真实 Electron 控制组

```bash
npm run test:rapid-double-enter-bullet-exit-before-sibling-ui
```

测试通过物理按键创建三条普通 bullet，并在中间项末尾快速连续按两次 Enter。由于干净 PM 树统一序列化为 `*`，这条 UI 是“不抢占控制组”，验收：

```text
reason=middle-empty-block-created
RS-86 reason absent
两棵顶层 bullet list
中间一个 live 空 paragraph
后继项仍存在
semanticOk=true
listSlotsMatch=true
ok=true
warning toast=0
source unchanged
save exact
cold reopen exact
```

真实 mixed-marker 专用 reason 由 PID 258 完整 trace 回放提供，不用测试注入或篡改 live PM 属性来伪造。

## 9. 相邻门禁

已通过：

```text
完整 markdown-preservation
source-fidelity probes 39/39
source transaction sync
production desktop build
普通 all-* 快速双 Enter 物理控制组
RS-51 generated scratch empty bullet Backspace
普通 authored empty bullet Backspace
RS-54 ordered 后空 bullet
RS-63 nested list 后空 bullet
RS-68 rapid nested parent Backspace 5ms / 18ms / 70ms
RS-82 non-empty bullet merge ordered
RS-83 middle thematic break
RS-84 cross-list selection delete
RS-85 empty ordered parent before nested child
source structure fingerprint
heterogeneous source-fidelity UI
```

## 10. 结论边界

RS-86 只修复一个明确事务族：

```text
非空 bullet middle
+ 非空 bullet successor
→ 快速双 Enter 合并 callback
→ 顶层 editor-only 空段
+ successor 仅 marker spelling 改写
```

它不拥有任意“列表退出”“空段插入”或“marker 改写”。无法同时证明空段位置、两侧正文、gap、完整前后字节和 source 唯一目标时，系统继续 fail closed。
