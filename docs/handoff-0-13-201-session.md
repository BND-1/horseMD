# HorseMD 会话存档（0.13.193 → 0.13.201，2026-09-03 ~ 09-08）

> 给压缩后的下一个 AI 接手。长期进度账本仍是
> `docs/source-rich-consistency-completion-plan.md`（P5d/P6a/P6b/P6c/P7 条目都在）。
> 本存档覆盖：源码一致性收尾（P5d-P7）、启动性能（P8/P8b）、行号可读性、
> 自定义主题顺序、两次 GitHub 发版（v0.13.199 / v0.13.200）与发布流水线加固。

## 当前状态

- **已安装版本**：`/Applications/HorseMD.app` = **0.13.201**，pid 96610 带 `--horsemd-input-trace` 运行中
- **已发布**：v0.13.199（2026-09-07）、v0.13.200（2026-09-07，行号修复）——均 Latest、14 资产、feed 指向正确
- **未发布**：0.13.201（自定义主题 CSS 顺序修复，提交 7849015）——**用户尚未验证**，验证后说"发版"再发
- 工作区干净（仅历史 untracked 诊断脚本，勿 clean/reset）
- 分支 main，与 origin 同步

## 本会话修复链

| 版本 | 提交 | 内容 |
|---|---|---|
| 0.13.193 | 34a97a4 | P5d 代码块↔段落边界合并 owner（接线 8/29 遗留草稿 + 修 3 个 CRLF bug）|
| 0.13.194 | f204341 | P6a 行尾行内定界符插入侧恢复（`可见流往返塌缩` 通用缺陷）|
| 0.13.195 | 62671f8 | P6b Shift+Enter 未发布回调 + 多段粘贴的续行丢失 |
| 0.13.196 | efdfa08 | P6c 分歧列表项合并的段落空行（blankBefore）|
| 0.13.197 | 26378a5 | **P7 序列化风格跟随文档**（分歧家族根治，架构变更，详见账本 P7 条目）|
| 0.13.198 | 45c7566 | katex/pinyin-pro/capacitor 懒加载（主 chunk 5.7→5.2MB）|
| 0.13.199 | 6a23ad8 | **P8b shell-first**：Editor 改 React.lazy + Suspense 骨架屏，主 chunk 5.2→**1.1MB**；update:check 加 8s 超时 |
| 0.13.200 | 50f16ef | 代码块行号可读性（见下"懒加载 CSS 顺序家族"）|
| 0.13.201 | 7849015 | 自定义主题 CSS 顺序（同族第三例）|

## 懒加载 CSS 顺序家族（P8b 的伴生回归，三例已收口）

P8b 把 Editor 拆成懒 chunk 后，**Crepe 的样式表改为运行时注入 head**，
落在 app.css 与运行时注入元素之后。同 specificity 平局时后者赢，产生三连回归：

1. **行号看不清（0.13.200 修）**：Crepe `.milkdown .milkdown-code-block .cm-gutters`（0-3-0）
   浅色背景赢过我们的同权重规则 → 白底白字。修法：我们升到 0-4-0（加 `.milkdown-code-block`）
   + 行号颜色改主题变量 `--code-linenum`（0.58/0.95/0.12）。
2. **自定义主题失效（0.13.201 修）**：`#hm-custom-theme` 启动早期注入后，
   Crepe tables.css 后到覆盖了它（用户报告）。修法：customThemes.js 用 MutationObserver
   把 owned 样式（theme、user-css 按序）始终保持在 head 末尾，幂等移动。
3. **教训**：任何"编辑器相关 CSS 规则"今后都要考虑注入顺序不定——要么升 specificity，
   要么走 owned-style 垫底机制。回归测试 `test:custom-theme-style-order-ui`
   走真实链路（themes 目录 + 状态栏选择器点击 + 后注入竞争样式表）锁定。

## P7 序列化风格跟随（最重要的架构变更，摘要）

根因：remark-stringify 默认 `*`+松散、Milkdown `list_item.spread` attr 默认 true 且被命令毒化
→ canonical 与作者紧凑 `-` 拼写必然不同 → 文档永久分歧态 → 每次编辑跨分歧翻译，翻译失败=警告。
修法：`lib/serializer-style.js` 挂载时探测作者拼写 {bullet、序号定界、紧/松、hardbreak}，
包装 remark 实例 stringify：①walk mdast 把 spread 改为纯内容推导；②fence 感知行级重写
标记/定界/换行。**unified 实例首次编译后冻结、`data('settings')` 抛错——只能后处理**。
效果：紧凑作者文档 canonical 逐字节等于源码，diverged-* mapper 降级为兜底。
残留：表格对齐填充维度（table owner 兜底）、`__`/`_` 拼写维度。详见账本 P7 条目。

## P8/P8b 启动性能

- 5.7MB → 1.1MB 主 chunk：katex/pinyin/capacitor 动态 import + `Editor` React.lazy（EditorArea.jsx）
- Capacitor 桥 `platform/index.js` 改 `installPlatformBridge()` async，main.jsx await 后渲染（桌面同步返回）
- update:check 8s AbortSignal.timeout
- 本机数字：首绘 177ms、挂载 1.1s；慢机收益来自首绘前解析量 5.2→1.1MB
- **issue #126**（490K 文件 700-800MB）实测当前构建无法复现（heavy→textarea 87MB；绕过→分片富文本
  73-117MB，多种形状），已在 issue 回复并附 v0.13.199 通知

## 发布流水线（已加固，两处）

1. **漏提交事故**：P5d 提交引用了 untracked 的 `fenced-code-source-range.js` → CI 干净 checkout
   构建失败。修复提交 4c1e16a。**教训：提交前扫 untracked 引用**
   （`git status --porcelain | grep '^??'` 逐个查 `git grep`）。
2. **draft 分裂竞态**：三个平台 job 并发时各自创建同名 draft，14 资产劈成 5+9。
   修法：release.yml 新增 `init-release` 前置 job 先建唯一 draft（`needs: init-release`），
   builders 复用既有 draft。注意 gh 命令必须显式 `-R BND-1/horseMD`（无 checkout 上下文）。
   v0.13.200 一次成功验证。
3. 发版流程：tag `vX.X.X` push → CI 三平台构建 → 单一 draft 14 资产 →
   `gh release edit --title "HorseMD vX.X.X" --notes-file ... --draft=false` 发布 →
   验证 latest*.yml 版本号。

## 用户工作方式（不变）

1. 每轮改完：自测（goal-matrix + 相关回归）→ 版本 +1 → `CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:dir`
   → 装到 `/Applications` → `/Applications/HorseMD.app/Contents/MacOS/HorseMD --horsemd-input-trace` 启动
   （注意：**不要用 `open -a`**——同 bundle-id 的 dist-0.13.169 旧副本会截胡；用完整路径）
   → 确认新 pid + trace live
2. 用户触发后说"看下"→ 从 `$TMPDIR/horsemd-input-trace-<pid>.jsonl` 归因
   （markdown-sync 事件带全量 source/previousCanonical/canonical/markdown 字节，直接提取做 Node 复现最快）
3. 直接修，改完自测再交付，不问"要不要继续"
4. 用户否决补丁式修复（P7 由此而来）——同类问题第三次出现时要找架构根因
5. 发版 = 用户明说"发个版本"；修完本地装好等用户验证

## 既有失败清单（独立于本会话，干净基线同样失败）

- `test:system-theme-ui`：body class 期望不符（`light theme-morandi` vs 期望），**非** 0.13.201 回归（已 stash 对照验证）
- `test:diverged-list-structure-ui` / `test:nested-number-list-source-ui`：source textarea 未出现的 harness 层症状
- `test-html-table-math-export-ui`：断言 live html-block cell 保留字面 `$…$`，与 bug1b 的实时渲染行为矛盾（旧期望值）
- `test:rs-41-source-sync` UI raw paste、`test:list-item-literal-marker-source-ui`

## E2E harness 踩坑（本会话新增）

- `launchBuiltElectron` **默认 `cleanProfile: true` 会擦掉预写的 themes 目录**——放主题文件必须传 `cleanProfile: false`
- 状态栏主题 popover 的自定义主题类名是 `.theme-menu .block-menu-item .theme-swatch-custom`（不是 hm-sheet-*，那是另一个 sheet）
- `location.reload()` 的 beforeunload 会用内存 session 覆盖 localStorage 写入（session.customTheme 测试因此改走 UI 激活路径）
- CDP `Page.captureScreenshot` 结果在 `response.result.data`（不是 `response.data`）
- 旧 Electron 副本 dist-0.13.169 会响应 `open -a HorseMD`——启动已装 app 用完整二进制路径

## 验证矩阵（0.13.201 当前）

goal-matrix 42/42、settings-view、custom-theme-style-order（新）、code-block scroll/spacing、
editor-input×4、P5d/P6a/P6b/P7 E2E 全绿；system-theme-ui 既有失败（见上）。
