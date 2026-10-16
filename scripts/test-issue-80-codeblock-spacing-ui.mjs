import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const dir = '/tmp/horsemd-issue-80-codeblock-spacing'
const file = join(dir, 'codeblock-spacing.md')
const port = Number(process.env.CDP_PORT || 9487)

async function waitFor(check, message, attempts = 50) {
  for (let index = 0; index < attempts; index += 1) {
    const result = await check()
    if (result) return result
    await sleep(100)
  }
  throw new Error(message)
}

async function main() {
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  await writeFile(file, [
    '# Code block spacing',
    '',
    'Text before the code block.',
    '',
    '```javascript',
    'const total = 1 + 2',
    'console.log(total)',
    '```',
    '',
    'Text after the code block.'
  ].join('\n'), 'utf8')

  const app = await launchBuiltElectron({
    profileDir: join(dir, 'profile'),
    port,
    appArgs: [file]
  })

  try {
    const result = await waitFor(() => app.evaluate(`(() => {
      const visible = (node) => Boolean(node?.offsetParent)
      const editor = [...document.querySelectorAll('.ProseMirror')].find(visible)
      const block = editor?.querySelector('.milkdown-code-block')
      const codeEditor = block?.querySelector('.cm-editor')
      const before = [...editor?.querySelectorAll('p') || []]
        .find((node) => node.textContent.includes('Text before'))
      const after = [...editor?.querySelectorAll('p') || []]
        .find((node) => node.textContent.includes('Text after'))
      if (!codeEditor || !before || !after) return null
      const style = getComputedStyle(codeEditor)
      const line = codeEditor.querySelector('.cm-line')
      return {
        marginTop: Number.parseFloat(style.marginTop),
        marginBottom: Number.parseFloat(style.marginBottom),
        fontSize: Number.parseFloat(style.fontSize),
        code: line?.textContent || '',
        hasLanguageControl: Boolean(block.querySelector('select, button')),
        ordered: before.getBoundingClientRect().bottom < codeEditor.getBoundingClientRect().top &&
          codeEditor.getBoundingClientRect().bottom < after.getBoundingClientRect().top
      }
    })()`), 'Code-block fixture did not render in rich mode')

    const expectedMargin = result.fontSize * 0.8 * 0.6
    assert.ok(Math.abs(result.marginTop - expectedMargin) < 0.2,
      `Expected compact code-block top margin ${expectedMargin}, got ${result.marginTop}`)
    assert.ok(Math.abs(result.marginBottom - expectedMargin) < 0.2,
      `Expected compact code-block bottom margin ${expectedMargin}, got ${result.marginBottom}`)
    assert.equal(result.code, 'const total = 1 + 2', 'Code content changed')
    assert.equal(result.hasLanguageControl, true, 'Code block lost its language or copy controls')
    assert.equal(result.ordered, true, 'Code block no longer sits between surrounding paragraphs')
    console.log('PASS issue 80 UI: code block keeps its controls and uses compact paragraph-sized spacing')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(dir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
