import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  launchBuiltElectron,
  stopBuiltElectron
} from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const port = Number(process.env.CDP_PORT || 9394)

// More lines than CodeMirror keeps in its viewport DOM. This locks the contract
// that Mermaid previews receive complete ProseMirror code_block content rather
// than the virtualized `.cm-line` subset.
const longDiagram = [
  'flowchart TD',
  '  n0[开始]'
]
for (let index = 1; index <= 96; index += 1) {
  longDiagram.push(`  n${index - 1} --> n${index}[步骤 ${index}]`)
}

const markdown = [
  '# 多 Mermaid 长文档回归',
  '',
  '第一张图使用 Windows CRLF，并且足够长，CodeMirror 会虚拟化它的行 DOM。',
  '',
  '```mermaid',
  longDiagram.join('\r\n'),
  '```',
  '',
  '```mermaid',
  'flowchart LR',
  '  A[采集] --> B[处理] --> C[完成]',
  '```',
  '',
  '```mermaid',
  'mindmap',
  '  root((计划))',
  '    编写',
  '    验证',
  '```'
].join('\r\n')

async function waitForAllPreviews(evaluate) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const snapshot = await evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')]
        .find((node) => node.offsetParent)
      const blocks = [...(editor?.querySelectorAll('.milkdown-code-block') || [])]
        .filter((block) => block.querySelector('.language-button')?.textContent?.trim().toLowerCase() === 'mermaid')
      const firstVisibleLines = blocks[0]
        ? blocks[0].querySelectorAll('.cm-line').length
        : 0
      return {
        blocks: blocks.length,
        previews: blocks.filter((block) => block.querySelector('.preview svg')).length,
        hints: blocks.filter((block) => block.querySelector('.hm-mermaid-hint')).length,
        errors: blocks.map((block) => block.querySelector('.hm-mermaid-error')?.textContent || '').filter(Boolean),
        firstVisibleLines
      }
    })()`)
    if (snapshot.blocks === 3 && snapshot.previews === 3) return snapshot
    await sleep(150)
  }
  return evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')]
      .find((node) => node.offsetParent)
    const blocks = [...(editor?.querySelectorAll('.milkdown-code-block') || [])]
      .filter((block) => block.querySelector('.language-button')?.textContent?.trim().toLowerCase() === 'mermaid')
    return {
      blocks: blocks.length,
      previews: blocks.filter((block) => block.querySelector('.preview svg')).length,
      hints: blocks.filter((block) => block.querySelector('.hm-mermaid-hint')).length,
      errors: blocks.map((block) => block.querySelector('.hm-mermaid-error')?.textContent || '').filter(Boolean),
      firstVisibleLines: blocks[0]?.querySelectorAll('.cm-line').length || 0
    }
  })()`)
}

async function main() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'horsemd-mermaid-long-document-'))
  const profileDir = path.join(dir, 'profile')
  const fixture = path.join(dir, 'many-mermaid.md')
  await writeFile(fixture, markdown)

  const installedApp = process.env.HORSEMD_APP_PATH
  const app = await launchBuiltElectron({
    profileDir,
    port,
    appArgs: [fixture],
    ...(installedApp ? { executable: installedApp, entrypoint: null } : {})
  })
  try {
    const snapshot = await waitForAllPreviews(app.evaluate)
    assert.equal(snapshot.blocks, 3, `Expected three Mermaid blocks: ${JSON.stringify(snapshot)}`)
    assert.equal(snapshot.previews, 3, `Long Mermaid document left a preview loading: ${JSON.stringify(snapshot)}`)
    assert.equal(snapshot.hints, 0, `Mermaid rendering hint never resolved: ${JSON.stringify(snapshot)}`)
    assert.deepEqual(snapshot.errors, [], `Unexpected Mermaid parse error: ${JSON.stringify(snapshot)}`)
    assert.ok(snapshot.firstVisibleLines < longDiagram.length, 'Fixture did not exercise CodeMirror virtualized line DOM')
    console.log('PASS Mermaid long document UI: CRLF long diagram and sibling diagrams all render from full source')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(dir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
