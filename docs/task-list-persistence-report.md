# 任务清单勾选状态保存问题报告

更新时间：2026-07-30  
对应版本：HorseMD 0.12.40

## 现象

在富文本模式点击任务清单方框后，当前界面会立即显示勾选；但保存文件并重新打开，方框又回到旧状态。磁盘中的 `[ ]` 也没有变成 `[x]`。

## 根因

这不是 Markdown parser、serializer 或文件保存 IPC 的错误。

Crepe 的任务清单节点视图在标签自身的 `pointerdown` 回调中调用
`setNodeAttribute('checked', ...)`，随后执行 `preventDefault()` 和
`stopPropagation()`。HorseMD 原先只在编辑器根节点监听 `mousedown` 来记录
“这是一笔真实用户编辑”。兼容鼠标事件被子节点阻止后，该标记没有建立。

ProseMirror 文档中的 `checked` 属性虽然已经变化，`markdownUpdated` 回调却因为
缺少用户编辑意图而按程序化事务过滤。React tab 内容仍是旧 Markdown，保存自然
把旧的 `[ ]` 写回磁盘。

## 修复

`editor-dom-interactions.js` 在编辑器根节点 capture 阶段同时监听
`pointerdown`。根节点会先于 Crepe 子节点收到事件并调用既有
`markUserEdit()`，随后 Crepe 继续完成节点属性事务。

变化继续经过原有的：

1. `markdownUpdated`
2. `preserveRichMarkdownSource`
3. React tab dirty 状态
4. 现有文件保存 IPC

没有新增任务清单专用文件写入，也没有用 canonical serializer 覆盖整篇原文。
因此目标行只会在 `[ ]` 和 `[x]` 之间变化，其他字节保持不变。

## 自动化验收

运行：

```bash
npm run build
npm run test:task-list-persistence-ui
```

`scripts/test-task-list-persistence-ui.mjs` 使用后台 Electron 和真实临时 Markdown
文件，依次验证：

1. 未勾选与已勾选任务能按源码初始状态渲染。
2. 点击未勾选任务后出现未保存状态。
3. 保存时只修改目标 `[ ]` 为 `[x]`。
4. 完全退出并重开后仍为勾选。
5. 取消勾选、保存、再次退出重开后仍为未勾选。
6. 相邻任务和其他 Markdown 内容不变。

该脚本已加入 `npm run test:ui-regression`，避免节点视图事件实现变化后静默复发。
