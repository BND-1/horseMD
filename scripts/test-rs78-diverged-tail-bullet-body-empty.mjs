import assert from 'node:assert/strict'
import { preserveRichMarkdownSource } from '../src/renderer/src/markdown-source-preservation.js'

const source = `# 检解放军


>


>

## 目123

- ，吧，管理层（总经理）
- 综合行政部
- x/信息       人力资源部
- 4. 技术/研发部
- 5. 采购部
- 6. 生产部
- 7. 品质部
- 8. 销售部/市场部

## 使用说明

- 适用标准：**ISO 9001:2015**（覆盖主要章节：组织环境、领导作用、策划、支持、运行、绩效评价、改进）。
- 每张检查表按部门 / 过程编制，用于内部审核 / 自查；「判定标准」列供审核员勾选符合 / 不符合。
- 「依据条款」列标注该检查项对应的标准条款号，可追溯至标准原文。
- 本表为 AI 生成草稿，正式发布前需经体系企鹅
负责人 / 质量部门复核。
- 而为
`

const previous = `# 检解放军

> <br />

> <br />

## 目123

* ，吧，管理层（总经理）

* 综合行政部

* x/信息       人力资源部

* <br />

  4. 技术/研发部

* <br />

  5. 采购部

* <br />

  6. 生产部

* <br />

  7. 品质部

* <br />

  8. 销售部/市场部

## 使用说明

* 适用标准：**ISO 9001:2015**（覆盖主要章节：组织环境、领导作用、策划、支持、运行、绩效评价、改进）。

* 每张检查表按部门 / 过程编制，用于内部审核 / 自查；「判定标准」列供审核员勾选符合 / 不符合。

* 「依据条款」列标注该检查项对应的标准条款号，可追溯至标准原文。

* 本表为 AI 生成草稿，正式发布前需经体系企鹅
  负责人 / 质量部门复核。

* 而为

`

const next = previous.replace('* 而为\n\n', '* <br />\n\n')
const expected = source.replace('- 而为\n', '- \n')

const result = preserveRichMarkdownSource(source, previous, next)
assert.equal(result.preserved, true)
assert.equal(result.reason, 'diverged-tail-bullet-body-emptied')
assert.equal(result.markdown, expected)

// Fail closed if anything before the final canonical row changes in the same callback.
const batched = preserveRichMarkdownSource(
  source,
  previous,
  next.replace('## 使用说明', '## 使用说明改')
)
assert.notEqual(batched.reason, 'diverged-tail-bullet-body-emptied')

// Fail closed if the authored tail is not the same uniquely anchored bullet body.
const wrongSource = preserveRichMarkdownSource(
  source.replace('- 而为\n', '- 其它\n'),
  previous,
  next
)
assert.notEqual(wrongSource.reason, 'diverged-tail-bullet-body-emptied')

console.log('PASS RS-78: globally-diverged tail bullet body can empty without deleting its authored slot')
