# RS-55：尾部普通段输入 `3.` 时过早丢失结构保护转义

## 状态

- 首次真实定位版本：HorseMD 0.13.100。
- 真实 trace：`horsemd-input-trace-70672.jsonl`。
- 修复归属：0.13.101。
- 当前状态：已修复；字面 `3.` 阶段已验证 candidate/canonical 均保留保护转义且 integrity 全绿。

## 真实复现

在 `1. 测试 / 2. 哪里呢` 后先删除一个空 bullet，得到普通尾部空段；随后输入 `3.`，尚未输入 Space。

Crepe canonical 正确写成 `3\.`，表示当前仍是字面段落；旧 `appended-paragraph` 通过 `canonicalFreshTextToSource()` 把它还原成 `3.`，candidate 被 Markdown parser 解释成 ordered list，触发 `source-document-mismatch`。

用户再按 Space 后才应真正触发 ordered-list input rule，变成第 3 个有序项。

## 修复边界

- 只保护“整块新追加普通段”恰好是 `N\.` 或 `N\)` 的结构保护转义；
- 行内 `abc 3\. x` 仍按 fresh punctuation 正常还原；
- 真正输入 Space 后由 list input-rule / list mapper 接管，源码应转成真正 `3. `；
- integrity gate 不放宽。

## 回归

- 纯函数：source 尾部 append `3\.` 必须保持反斜杠。
- UI：删除空 bullet → 输入 `3.` 无告警且仍是普通段 → Space 后才变 ordered 3 → 输入正文 → 源码/保存/冷重开稳定。
