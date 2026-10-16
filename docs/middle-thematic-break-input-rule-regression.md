# RS-83：中间独立 thematic break 输入规则回归

> 修复版本：HorseMD 0.13.128  
> 首发现场：正式安装版 0.13.127，PID 85614  
> 首发时间：2026-08-26 15:17:23.243  
> Trace：`horsemd-input-trace-85614.jsonl` line 630  
> 首发类型：`source-sync-integrity-failure`  
> 首发 reason：`source-document-mismatch`

## 1. 用户操作与首发结构

用户在真实、长期编辑且 source/canonical 已存在合法 marker、空行和 U+200B 拼写分叉的文档中完成以下操作：

1. 在有序列表空项内输入 `3fresh`；
2. 连续按两次 Enter，退出该有序列表；
3. 在它与后续另一棵有序列表之间的空段输入第一个 `-`；
4. 等待该中间帧同步；
5. 快速输入第二、第三个 `-`，触发 ProseMirror thematic-break input rule。

第一键之后，链路是正确的：

```md
3. 3fresh

\-

1. 是干嘛的了；吗
```

`middle-empty-block-filled` 将第一个单独 `-` 作为普通段落保护性写成独立 `\-`，strict integrity 为绿色。

第二、第三键在下一次 source callback 前到达。第三键触发 ProseMirror `hr` 结构事务，Crepe 将它序列化为：

```md
3. 3fresh

***

1. 是干嘛的了；吗
```

## 2. 旧链路为什么失败

Thematic break 节点不贡献普通可见字符。previous 的 `\-` 与 next 的 `***` 在 visible mapping 中都接近零宽结构边界；旧 `locally-aligned-change` 将该零宽 canonical 变化向前一块吸附，生成错误 candidate：

```md
3. 3fresh***

1. 是干嘛的了；吗
```

富文本中的 `<hr>` 是独立 block，但 candidate 把 `***` 变成上一条 ordered item 正文的后缀。严格 semantic gate 因此在 trace line 630 正确报 `source-document-mismatch` 并拒绝提交。

这不是列表编号、RS-82、保存 settle 或 integrity comparator 的问题。首发 callback 的 preservation reason 是 `locally-aligned-change`，错误发生在零可见结构变化被通用 mapper 锚到上一块。

## 3. 0.13.128 的专用 owner

新增：

```text
preserveEscapedStandaloneThematicBreakInputRule
```

发布 reason：

```text
escaped-standalone-thematic-break-input-rule
```

它位于 escaped paragraph / structural paragraph 层，排在 generic visible mapper 之前。只有以下证明全部成立才认领：

1. previous changed row 是独立、0–3 空格缩进的 `\-`；
2. next 同一 row 原位变成独立 thematic break，允许 `***`、`---`、`___`；
3. previous/next 除该物理行之外字节完全相同；
4. 该行上下均存在非空稳定块，并由至少一个真实 blank block gap 分隔；
5. authored source 中存在 exact `\-` 行；
6. authored target 的上下可见邻居与 canonical previous 完全一致；
7. 同一 source target 必须唯一；
8. target 不能位于成对 fenced code 内；
9. 同 callback 夹带任何其它正文、列表、标题或结构变化时拒绝；
10. 普通标点扩写，如 `\-` → `--x`，不得由本 owner 认领。

证明失败时返回 `null`，继续原有 dispatcher 或最终 fail closed；没有按 reason 放宽 semantic/list integrity。

## 4. 为什么 source 输出 `---`，而不是 canonical 的 `***`

用户实际按下的是三个连字符。Crepe 选择 `***` 只是 serializer 的 canonical 拼写，不是作者输入风格。

因此 owner 只把 authored `\-` 行替换为：

```md
---
```

它不复制 canonical `***`，也不对整篇文档做 parse/stringify。LF、CRLF、该行原 EOL、前后空行、列表 marker、U+200B、fence 与其它作者字节全部保留。

正确 candidate：

```md
3. 3fresh

---

1. 是干嘛的了；吗
```

错误 candidate `3. 3fresh***` 被永久反例禁止。

## 5. 永久回归

### 5.1 纯函数与完整真实 trace

```bash
npm run test:markdown-preservation
npm run test:source-fidelity-probes
```

覆盖：

- 正常 `\-` → thematic break；
- exact owner reason；
- authored `---` 输出；
- CRLF 保持；
- 同 callback 无关正文编辑拒绝；
- 重复 source target 拒绝；
- 普通 `--x` 扩写拒绝；
- source probes 增至 36/36；
- PID 85614 约 5.5 MB trace line 633 的完整 source / previousCanonical / canonical 三态直接回放。

完整现场回放必须得到：

```text
preserved=true
reason=escaped-standalone-thematic-break-input-rule
glued=false
hasTypedBreak=true
```

### 5.2 真实 Electron

```bash
npm run test:middle-thematic-break-input-rule-ui
```

fixture 故意保留与用户现场相同的全局分叉尾结构：混合 bullet marker、`-   1.` 嵌套表示、U+200B 和两棵相邻 ordered lists。测试执行真实键盘链：

1. 填写空 ordered item；
2. 两次 Enter 退出；
3. 第一个 `-` 单独发布为 `\-`；
4. 快速输入第二、第三键；
5. 检查 `<hr>`、owner、integrity；
6. 切源码；
7. 保存；
8. 完整停止进程并冷重开。

验收：

```text
semanticOk=true
listSlotsMatch=true
ok=true
integrity false=0
warning toast=0
source 精确
save 精确
cold reopen 精确
```

## 6. 相邻 family 门禁

修复后已通过：

```text
RS-59 escaped standalone paragraph expansion
dash + Space bullet input rule
RS-82 non-empty bullet Backspace merge
source transaction sync
heterogeneous source-fidelity UI
RS-68 5ms / 18ms / 70ms
完整 build
```

该 owner 不处理 Space 触发 bullet list、不处理普通 `-【】`/`--x` 文本、不处理 fence 内的 `---`，也不承担任意 thematic-break 编辑。它只拥有“已安全发布的独立 `\-` 中间帧，被同一位置的第三个连字符转换为独立 hr”这一条事务 family。
