# RS-52：RS-51 后继空段填充时 generated scratch 产生额外空行

## 状态

- 由 RS-51 的泛化测试发现。
- RS-51 修复归属：0.13.97。
- RS-52 修复归属：0.13.98。
- 当前状态：端到端专项通过。

## 复现

在新建文档 generated-scratch 生命周期中：

1. 建立 `- 离婚了`。
2. Enter 创建空第二项。
3. Backspace 删除/合并空第二项；RS-51 已让这一事务安全提交。
4. 单纯切源码查看再返回富文本（不修改源码，所以 generated-scratch 生命周期仍然有效）。
5. 在列表后的顶层空 paragraph 输入 `后续`。

富文本结构正确，也没有 source-sync 告警，但源码出现多余空行：

```md
# 测试

- 离婚了



后续
```

期望仍是普通块间距：

```md
# 测试

- 离婚了

后续
```

## 证据

RS-51 UI 泛化诊断中，普通 preservation 层对第 5 步已经返回：

- `reason: trailing-empty-block-filled`
- `source: # 测试\n\n- 离婚了\n\n`
- `previous canonical: # 测试\n\n* 离婚了\n\n  <br />\n\n`
- `next canonical: # 测试\n\n* 离婚了\n\n  <br />\n\n后续\n`
- `markdown: # 测试\n\n- 离婚了\n\n后续\n`

这个局部结果已经是正确作者源码；但 generated-scratch 分支仍选择整份 canonical 生成结果，因此最终 candidate 变成四个换行。Integrity 仍能通过 transition proof，因为额外空白不改变 parser 语义，所以这是 source-fidelity/格式漂移，不是安全门禁误报。

## 修复边界

不能无条件在 generated-scratch 中接受 `trailing-empty-block-filled`：generated 模式会持续到用户真正从源码模式提交修改为止，无条件改用局部 mapper 会改变大量新文档延迟 callback 的既有所有权策略。

0.13.98 实现采用一次性 source+canonical 双快照 transient token：

1. generated-scratch 成功采用 `empty-list-item-removed` 时置位。
2. token 存活期间，下一笔 rich callback 若普通 preservation 层严格返回 `trailing-empty-block-filled`，采用该结果并立即消费 token。
3. 下一笔 rich callback 若不是该 reason，则清除 token并保持原 generated canonical 路径。
4. 纯源码查看/flush 不属于 rich transaction，不消费 token。
5. 所有候选仍经过 semantic + raw list-slot integrity gate。

## 回归

复用 `scripts/test-generated-scratch-empty-bullet-backspace-ui.mjs` 后半段：Backspace → 源码查看 → 回富文本 → 填 `后续` → 源码必须只有正常一个空块分隔 → 保存 → 冷重开严格相等。

专项已确认 Backspace、纯源码查看往返、列表后正文、保存和冷重开严格相等。后续泛化仍覆盖 RS-45、RS-50、source-document-equivalence transient、new-document fidelity、source-fidelity 和 family multicycle；其中 RS-50 完整冷重开生命周期暴露的独立缺口已登记为 RS-53。
