# 编辑器字体与CSS加载顺序回归（0.13.225）

## 真实复现

用户反馈原本黑体的标题变成宋体风格，而正文仍为黑体；另有“自定义样式上多了table.css”的反馈。后者尚未提供原CSS或截图，不能一概认定为同一问题。

干净配置的真实Electron构建，不启用任何自定义主题/片段：H1–H6的计算字体为`Noto Serif, Cambria, Times New Roman, Times, serif`。H1字重400、字号42px；正文变为`Noto Sans, Arial, Helvetica, sans-serif`。应用原本定义的中文无衬线字体栈、H1的700/36px均被覆盖。

修复前证据：系统临时目录`horsemd-style-cascade-04dSnw/baseline.json`。文档和配置均为自动生成的隔离样本，不涉及用户原文件。

## 根因和修复

`main.jsx`先加载`app.css`，懒加载的`Editor.jsx`随后带入Crepe的common/frame/link-tooltip/latex CSS。同优先级的reset/frame规则因此覆盖应用排版；app.css里“应用样式最后导入”的前提已不成立。

将上述四个CSS导入固定在`main.jsx`的app.css导入前，并从Editor.jsx移除。只提前CSS，不提前加载编辑器JavaScript，不修改字体设置数据、不提高选择器优先级，也不使用!important强压自定义样式。保留`customThemes.js`的用户主题/片段尾部顺序保护，防御其他后到样式。

## 验证结果

`test:editor-style-cascade-ui`修复前失败、修复后通过，证据在临时目录`horsemd-style-cascade-LGlrDC/verified.json`：六级标题和正文恢复相同文档字体，H1/H2字重700、H3–H6为600，H1默认36px；改文档字体与正文20px后H1为45px。显式自定义Georgia标题及表格背景在启动、后到同优先级样式后均有效；禁用片段后恢复文档字体。源码和磁盘全文逐字不变。

原`test:custom-theme-style-order-ui`通过，保持导入主题的覆盖语义。2026-09-23重装前已再次通过字体/主题回归，并完成桌面、mobile构建和教程检查；包含本修复与右键复制的0.13.226已本地打包安装，PID45544带trace，交给用户手测。257个包内构建文件与验证产物一致。0.13.225为修复检查点，0.13.226仅完成本机交付，尚未线上发布。

不要把检查器里的table.css文件名本身当作错误或直接删除基础样式。若特定自定义CSS仍异常，应针对原规则检查选择器优先级、属性继承和导入资源，不能以修改用户CSS或重置用户设置掩盖问题。
