# 0.13.47 富文本 / 源码持续分叉事故（未解决）

> 状态：**P0，仍可复现，禁止标记为已修复或发布稳定版**
> 首次确认版本：HorseMD 0.13.47（macOS 安装包）
> 现场文件：真实长文档 `123321.md`（含历史列表、引用、表格、图片、代码块、重复短文本和既有源码分叉）
> 关联总账：RS-41，见 `rich-source-fidelity-bug-family.md`

## 1. 用户看到的现象

在富文本模式继续正常写作，尤其是在文章后部新建代码块、编辑代码块内容、退出代码块后
继续输入正文，再继续修改其他内容时，富文本界面仍显示用户刚刚完成的内容，但 HorseMD
维护的作者源码快照没有完整同步：

- 切换源码模式后，源码缺少富文本刚新增的内容，或结构、换行、列表与富文本不一致；
- 点击保存可能提示“保存已暂停：当前富文本编辑暂时无法安全映射到源码”；
- 也存在保存按钮可执行、但写盘内容仍不等于富文本界面的情况；
- 关闭重开后只能按磁盘源码恢复，富文本里未被同步的编辑因此丢失；
- `/code` 专项路径通过并不代表整个长会话已经恢复一致，继续编辑仍可能再次分叉。

这不是视觉差异，也不能用“Markdown 序列化写法不同”解释。只要富文本中的真实内容没有
出现在源码和磁盘中，就是数据一致性故障。

## 2. 0.13.47 现场复现轮廓

以下是当前能稳定描述的真实用户路径。接手者应先在用户文件的**临时副本**上复现，禁止
直接修改唯一原件。

1. 使用安装后的 HorseMD 0.13.47 打开历史长文档；不要用新建的最小 fixture 代替。
2. 滚动到文章后部，在已有列表/正文之后新建一个 fenced code block。现场包含通过
   `/code` 创建代码块的路径。
3. 在代码块里逐字输入内容。
4. 退出代码块，在其后继续逐字输入普通正文。
5. 不关闭文档，继续回到附近或前面的列表/正文做新增、删除或改写。
6. 点击保存，再切换源码模式；也要覆盖“先切源码再保存”。
7. 再切回富文本继续编辑，重复保存/切换，并完整退出 HorseMD 后重开。

实际结果：某一轮以后，富文本、源码 textarea、保存快照和磁盘文件不再一致。0.13.47
新增的 `/code` 原子 source intent 解决了“空 fence 槽没有建立”的一个子路径，但没有
阻止后续事务在同一真实长会话中再次失去 source ownership。

## 3. 本次现场证据

2026-08-11 的现场中，0.13.46 进程里存在未保存的富文本内容，磁盘 `123321.md` 尚未包含
文章末尾的代码块和后续正文。为避免强退丢失，先做了三层救援：

1. 从可见 `.ProseMirror` 导出完整 `outerHTML`；
2. 从 `.ProseMirror.pmViewDesc.node.toJSON()` 导出完整 ProseMirror 文档 JSON；
3. 使用当前 HorseMD schema/serializer 把该 JSON 规范化为一份独立 Markdown 恢复副本。

恢复副本能够保住富文本里的可见内容，但它是从 ProseMirror 文档重新序列化得到的
**救援文件**，不等于作者原始源码，也不能证明原文保真链路正确。随后安装 0.13.47，
用户在恢复文件上继续测试，仍确认源码模式和富文本模式无法对应。

因此：

- “能够另存恢复文件”只是数据保护出口，不是根治；
- “专项自动化测试通过”不能覆盖真实安装包的长会话手测结论；
- “保存不再报错”也不等于源码、磁盘与富文本一致。

## 4. 为什么现有绿色测试不足以关闭问题

当前下列测试在开发环境可以通过：

- `test:family-matrix-ui`：4 个真实文件 × 5 类尾部操作；
- `test:family-multicycle-ui`：4 轮编辑/保存、5 次冷打开；
- `test:tail-fence-ui`：literal/input-rule/`/code` fence，40ms/350ms 时序；
- continuous、chaos、列表转换、反引号、空段落、空引用等专项。

但人工现场仍失败，说明测试至少存在一个覆盖缺口：

1. 脚本每轮使用确定的操作和等待时间，真实写作会在任意 pending callback 之间继续编辑；
2. fixture 虽来自真实文件，测试副本的初始 tab/session/editor 生命周期不一定等同于用户
   已经连续编辑很久的进程；
3. 当前断言多在预设 checkpoint 读取源码，可能没有覆盖“保存成功但 React/tabsRef/source
   textarea 与 live ProseMirror 分别持有不同快照”的瞬间；
4. `/code` 测试证明命令创建阶段的原子替换，但未穷尽代码块创建后再执行多轮结构编辑、
   删除、列表输入规则、保存和模式切换的所有交错顺序；
5. 测试使用 CDP 逐字输入，仍需补一条安装包上的真实 CGEvent/IME 长会话回归；
6. 过去多次把“测试绿”写成“家族已修复”，但用户手测反复否决。以后必须把用户安装包
   手测作为该家族的最终门禁。

## 5. 当前架构中的高风险边界

不要先假设某个 mapper 已经是根因。接手者需要同时记录以下状态，找到它们首次分叉的
那一笔事务：

| 状态 | 要采集的内容 |
| --- | --- |
| live ProseMirror | `view.state.doc` JSON 与实时 serializer 输出 |
| 作者源码 | `lastMarkdownRef.current` |
| canonical 基线 | `canonicalMarkdownRef.current` |
| App/tab 镜像 | React tab content、`tabsRef` 中对应 tab 的内容 |
| 源码模式 | uncontrolled textarea 的 live value、`liveContentRef` |
| pending 状态 | transaction source pending/quarantine、列表 input intent、slash intent、flush pending |
| durability boundary | 保存、切源码前 settle 的每次尝试、最终返回值和 reason |

最值得怀疑但尚未证明的区域：

- 一次结构事务已经由专用 intent 提交，紧接着的普通文字/列表事务仍拿旧 canonical 或旧
  authored slot 重放；
- `markdownUpdated` 与 forced live serializer 的顺序不同，某一路推进了 canonical，另一路
  没有同步推进作者源码；
- 保存读取到恢复/规范化 Markdown 后把 tab 标成已保存，但源码 textarea 或 `tabsRef`
  仍是另一份快照；
- 长文档中重复块、历史分叉列表和代码 fence 共同存在时，局部 mapper 返回了“部分成功”，
  但没有证明整个 `next canonical` 已被消费；
- 测试 checkpoint 自身触发了 flush，反而掩盖真实用户连续写作中没有 checkpoint 的路径。

## 6. 接手者的正确排查方式

1. 先复制真实 fixture 到 `/tmp`，保留原文件 SHA-256、BOM、EOL、尾换行和字节长度。
2. 启用 `__hmPreserveLog`、`__hmSourceTransactionLog`、`__hmSourceTransactionTrace`、
   `__hmListIntentTrace`，再增加一个按 transaction 序号关联上述七类状态的统一 trace。
3. 每输入一个字符或执行一次结构命令后，只记录，不主动切源码或保存，避免诊断动作改变时序。
4. 在用户指定 checkpoint 一次性抓取：live doc serializer、作者源码、tab mirror、textarea
   live value、磁盘内容和所有 pending 标志。
5. 找到**第一次**不一致的事务，而不是只修最后弹出“保存已暂停”的地方。
6. 先把这条完整操作序列写成会失败的安装包 UI 回归，再修改实现。
7. 修复后至少执行 10 轮同一长会话；每轮都验证首次源码、第二次往返、保存、磁盘和冷重开。
8. 自动化全部通过后仍需安装正式路径 `/Applications/HorseMD.app`，由真实用户手测验收。

## 7. 禁止采用的“修复”

- 禁止用最新 canonical 整篇覆盖作者源码；这会重新引入 marker、空行、转义和换行格式化。
- 禁止在保存出口用字符串替换删除 `<br />`、`&#x20;`、`\\.`、`\\-` 等症状。
- 禁止把保存暂停提示去掉后宣称解决；如果源码仍旧，静默保存比提示更危险。
- 禁止只增加等待时间或 debounce；它会改变复现概率，但不能证明状态所有权正确。
- 禁止只验证富文本 DOM；必须逐字比较源码 textarea、磁盘和冷重开。
- 禁止再次把 4×5、multicycle 或 tail-fence 单项绿色结果写成“家族已解决”。

## 8. 完成标准

只有全部满足以下条件，RS-41 才能从“未解决”改为“已验收”：

1. 真实 `123321.md` 临时副本按第 2 节连续操作至少 10 轮无分叉；
2. 任意 checkpoint 的 live ProseMirror serializer、作者源码语义、源码 textarea、tab mirror
   和磁盘目标内容一致；
3. 未编辑源码字节保持原样，不能以 canonical 全量规范化换取一致；
4. 保存不暂停，且保存后完整退出重开与保存前富文本一致；
5. `-`/`+`/`*`、CRLF/BOM、空行、前导空格、引用、表格和代码 fence 家族不回归；
6. 新增失败用例、全家族矩阵、桌面构建、移动构建全部通过；
7. 最新安装包经用户手测明确确认通过。

## 9. 相关提交与文档

- `635526d`：尾部手打 fenced code 的局部映射；
- `9f7a64b`：列表续写、段尾块边界和 canonical 实体处理；
- `a4fb2f2`：前导空格尾段误删回归；
- `bcfb6ff`：`/code` 命令级原子 source intent（0.13.47）；
- `family-root-cause-matrix.md`：历史根因与自动化矩阵；
- `rich-source-fidelity-bug-family.md`：家族总账；
- `source-sync-save-recovery.md`：保存暂停与恢复副本安全出口；
- `transaction-source-sync-architecture.md`：transaction→source 迁移方向；
- `macos-real-input-testing.md`：真实 macOS 逐键测试方法。
