# 保存暂停、事务稳定与恢复副本合同

> 状态：0.13.125。保存/恢复仍是迁移期间的数据保护层，不是源码同步架构本身。
> 当前发布链路仍以 legacy preservation 为主；transaction-first 只在受限、明确授权的事务
> 家族中试运行/验证，无法证明的列表、代码块、表格和复杂结构继续走 fail-closed。
>
> 家族编号：RS-34
>
> 日期：2026-08-26

> 2026-08-11 更正：真实长文档仍会进入“富文本有内容、作者源码未同步”的状态。
> 恢复副本能够从 live ProseMirror 救回可见内容，但会经过 serializer 规范化，不能替代
> 作者源码，也不能作为保真问题已解决的证据。当前 P0 见
> `rich-source-divergence-incident-0.13.47.md`。

## 1. 用户症状

富文本正常显示本次修改，但用户立即保存时偶发提示：

> 保存已暂停：当前富文本编辑暂时无法安全映射到源码……

该提示是 fail-closed 数据保护，不是普通写盘错误。HorseMD 同时持有作者原始
Markdown 与 ProseMirror 文档；当系统不能证明本次结构变化应写回哪一段原始
字节时，旧行为宁可不写盘，也不使用整篇 canonical 覆盖作者源码。因此它能
阻止家族 bug 静默破坏文件，但“用户无法保存、编辑只留在内存”仍不是可接受的
最终体验。

## 2. 本次现场证据

- 运行版本：0.13.33，进程来自 `/Applications/HorseMD.app`。
- 当前文件的富文本 DOM 与磁盘源码已提取；两者在现场重新保存时一致。
- 重新初始化 `window.__hmPreserveLog` 后强制保存，没有再次产生失败记录。
- 随后同一文件可以保存，说明这次属于**特定编辑事务窗口**，不是文件一打开就
  永久无法映射。
- 已知高风险专项、27+ 家族路径与四种 chaos 节奏当场全部通过，所以不能把
  “旧测试通过”冒充为这次现场根因；本次修复针对保存边界的事务稳定差异。

## 3. 已确认的竞态

Milkdown 的可见 ProseMirror transaction 与 `markdownUpdated` 并非总在同一时刻
完成。列表输入规则、结构转换和部分 node view 编辑还会暂存 marker/source
intent。正常 `markdownUpdated` 回调会消费这些 intent 后再建立新 source/canonical
双快照；旧 `flushMarkdown()` 则在用户按保存或切源码时直接读取 live doc，并立刻
尝试映射。

因此存在这个时序：

1. 富文本 transaction 已可见；
2. intent 协调回调尚未完成；
3. 用户立即保存；
4. 强制 flush 看到一个临时、不可证明的累计 delta，返回 `null`；
5. fail-closed 提示保存暂停；
6. 稍后 `markdownUpdated` 完成，同一文档再次保存又可以成功。

保险丝没有错；错误是 durability boundary 把“暂时未稳定”和“永久无法映射”当成
同一件事。

## 4. 0.13.34 修复

### 4.1 有界 settle

`lib/editor-flush-settle.js` 在保存与富文本→源码切换时先立即 flush；若得到
`null`，只让出事件循环并按 `0 / 40 / 120 / 260ms` 有界重试。期间正常
`markdownUpdated` 可以消费 pending intent。任何一次返回字符串才允许继续保存或
显示源码。

这不是延时覆盖源码：每次仍调用同一个 fail-closed `flushMarkdown()`，没有把
canonical 当作作者原文，也没有推进失败事务的 baseline。持续歧义在所有重试后仍
返回 `null`。

### 4.2 恢复副本

若所有重试仍失败：

1. 原文件路径绝不写入；
2. 从当前 live ProseMirror doc 生成一份规范化恢复 Markdown；
3. 打开原生另存对话框，默认名为
   `<原文件名>.horsemd-recovered.md`；
4. 只有用户选择路径后才写恢复副本；
5. 原标签仍保持未保存状态，原文件保持原始字节。

恢复副本的目标是“不让可见编辑只活在 renderer 内存中”，不是假装完成了原文
保真合并。它可能采用规范化 Markdown 写法，必须与原文件分开。

## 5. 当前架构进展

截至 `0.13.125`，项目已经从“只有 canonical diff + 局部启发式”进入混合迁移阶段，但还没有完成统一架构替换：

- 已建立 ProseMirror transaction observer、完整 batch 边界、raw source range mapper、checkpoint、shadow/authority gate 和保存前 live flush；
- 普通段落的少数明确事务可以由 transaction-first 直接生成 source patch，并在发布前跳过 legacy candidate；
- 列表输入规则、Enter/Backspace、代码块、表格、引用、任务项和语法敏感编辑仍主要由 legacy preservation 的结构 owner 处理；
- `source/canonical` 双快照、语义解析、结构指纹和 fail-closed 通知仍是所有路径的共同安全门；
- 只有当某一结构族拥有完整的 transaction classifier、raw range proof、source candidate、源码切换/保存/冷重开回归后，才允许从 legacy 迁移到 authority；迁移完成后还必须删除或缩减旧 owner，避免双重提交。

本轮 `RS-80` 的列表修复属于 legacy owner 的结构所有权收紧：它解决了已发布 `\\-` marker 在 Space input rule 中被错误映射的问题，但没有把列表事务标记为 transaction-first 已接管。恢复副本、settle 和 fail-closed 仍然有效，不能被绿色专项测试解释为“架构迁移完成”。

## 6. 根治边界

当前 canonical-diff 保真层无法从数学上保证任意富文本结构编辑都能恢复原始
Markdown 拼写，因为 ProseMirror 已丢失 `-` / `*`、紧凑/松散列表、部分转义和
零宽语法行等表面信息。继续增加局部处理器可以减少可证明场景中的误报，但不能
让信息丢失本身消失。

真正的终局有两条，优先级如下：

1. **逐 ProseMirror transaction → source patch**：作者源码始终是事实源，在
   transaction 发生时利用旧 doc、旧 raw map 和用户 intent 直接更新源码；现有
   `step-source-mapper.js` 原型已跑通普通文字、Enter 与退格，仍需列表输入规则、
   inline atom、ReplaceAroundStep、撤销/重做。
2. **CodeMirror 6 Live Preview**：源码文本是唯一数据模型，富文本只是 decoration /
   widget；源码/富文本不再是两个文档。迁移面更大，但从架构上消除整个家族。

0.13.34 的 settle + recovery 是迁移期间的生产安全层：减少瞬时误报，并确保真正
无法映射时也不破坏原文件、不丢失可见编辑。它不能被描述成架构迁移已经完成。

## 7. 回归

```bash
npm run test:editor-flush-settle
npm run test:source-sync-recovery
npm run test:diverged-ordinary-save-ui
npm run test:code-fence-delete-source-ui
npm run test:mixed-rich-source-transaction-ui
npm run test:mode-switch-raw-offset-ui
npm run test:mode-switch-caret-settle-ui
npm run test:rich-source-chaos-ui
```

恢复合同单测必须证明：瞬时 `null` 会重试；持续 `null` 仍 fail closed；取消另存时
不写文件；确认另存时只写用户选择的恢复路径，绝不接收或覆盖原文件路径。
