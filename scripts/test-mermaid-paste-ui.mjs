import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  launchBuiltElectron,
  stopBuiltElectron
} from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const port = Number(process.env.CDP_PORT || 9392)
const rawMermaid = [
  'flowchart TD',
  '  A[开始] --> B{检查}',
  '  B -->|通过| C[完成]',
  '  B -->|失败| D[重试]',
  '  C --> E["sequenceDiagram 只是标签"]'
].join('\n')

async function selectAll(send, evaluate) {
  const focused = await evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')]
      .find((node) => node.offsetParent)
    editor?.focus()
    return document.activeElement === editor
  })()`)
  assert.equal(focused, true, 'Could not focus the visible rich editor')
  await send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'a',
    code: 'KeyA',
    modifiers: 4,
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65
  })
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'a',
    code: 'KeyA',
    modifiers: 4,
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65
  })
}

async function pastePlain(evaluate, text) {
  const prevented = await evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')]
      .find((node) => node.offsetParent)
    if (!editor) return false
    const data = new DataTransfer()
    data.setData('text/plain', ${JSON.stringify(text)})
    const event = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: data
    })
    editor.dispatchEvent(event)
    return event.defaultPrevented
  })()`)
  assert.equal(prevented, true, 'HorseMD did not handle the Mermaid paste')
  await sleep(1200)
}

async function pasteIntoFirstMermaid(evaluate, text) {
  const result = await evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')]
      .find((node) => node.offsetParent)
    const codeMirror = editor?.querySelector('.milkdown-code-block .cm-content')
    if (!codeMirror) return false
    const data = new DataTransfer()
    data.setData('text/plain', ${JSON.stringify(text)})
    const event = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: data
    })
    codeMirror.dispatchEvent(event)
    return {
      prevented: event.defaultPrevented,
      codeBlocks: editor.querySelectorAll('.milkdown-code-block').length
    }
  })()`)
  assert.equal(result.prevented, true, 'Second Mermaid paste was not handled at the code-block boundary')
  assert.equal(result.codeBlocks, 2, 'Second Mermaid block was not inserted synchronously')
  await sleep(1200)
}

async function richSnapshot(evaluate) {
  return evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')]
      .find((node) => node.offsetParent)
    const blocks = [...(editor?.querySelectorAll('.milkdown-code-block') || [])]
    return {
      codeBlocks: blocks.length,
      mermaidBlocks: blocks.filter((block) =>
        block.querySelector('.language-button')?.textContent?.trim().toLowerCase() === 'mermaid'
      ).length,
      previews: blocks.reduce(
        (count, block) => count + block.querySelectorAll('.preview svg').length,
        0
      ),
      sourceOccurrences: (editor?.textContent.match(/flowchart TD/g) || []).length
    }
  })()`)
}

async function toggleSource(evaluate) {
  return evaluate(`(() => {
    const button = [...document.querySelectorAll('.status-btn')]
      .find((node) => /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
    if (!button) return false
    button.click()
    return true
  })()`)
}

async function visibleSource(evaluate) {
  return evaluate(`(() => {
    const textarea = [...document.querySelectorAll('textarea.source-editor')]
      .find((node) => node.offsetParent)
    return textarea?.value ?? null
  })()`)
}

async function waitForSource(evaluate) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const source = await visibleSource(evaluate)
    if (source !== null) return source
    await sleep(100)
  }
  throw new Error('Source editor did not become visible')
}

function assertSingleDiagram(snapshot, label) {
  assert.deepEqual(
    snapshot,
    {
      codeBlocks: 1,
      mermaidBlocks: 1,
      previews: 1,
      sourceOccurrences: 1
    },
    `${label} rendered more than one Mermaid diagram`
  )
}

async function main() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'horsemd-mermaid-paste-'))
  const profileDir = path.join(dir, 'profile')
  const fixture = path.join(dir, 'mermaid-paste.md')
  await writeFile(fixture, '# Mermaid paste regression\n\nReplace this text.\n')

  const installedApp = process.env.HORSEMD_APP_PATH
  const app = await launchBuiltElectron({
    profileDir,
    port,
    appArgs: [fixture],
    ...(installedApp
      ? { executable: installedApp, entrypoint: null }
      : {})
  })
  try {
    const { send, evaluate } = app
    await sleep(1000)

    await selectAll(send, evaluate)
    await pastePlain(evaluate, rawMermaid)
    assertSingleDiagram(await richSnapshot(evaluate), 'Raw Mermaid paste')

    assert.equal(await toggleSource(evaluate), true, 'Could not open source mode')
    const rawSource = await waitForSource(evaluate)
    assert.equal((rawSource.match(/```mermaid/g) || []).length, 1, 'Raw Mermaid paste did not produce one fenced block')
    assert.equal((rawSource.match(/flowchart TD/g) || []).length, 1, 'Raw Mermaid source was duplicated')

    assert.equal(await toggleSource(evaluate), true, 'Could not return to rich mode')
    await sleep(300)
    await selectAll(send, evaluate)
    const fenced = `\`\`\`mermaid\n${rawMermaid}\n\`\`\``
    await pastePlain(evaluate, fenced)
    assertSingleDiagram(await richSnapshot(evaluate), 'Fenced Mermaid paste')

    assert.equal(await toggleSource(evaluate), true, 'Could not inspect fenced Mermaid source')
    const fencedSource = await waitForSource(evaluate)
    assert.equal((fencedSource.match(/```mermaid/g) || []).length, 1, 'Fenced Mermaid paste duplicated its code block')
    assert.equal((fencedSource.match(/flowchart TD/g) || []).length, 1, 'Fenced Mermaid content was duplicated')

    assert.equal(await toggleSource(evaluate), true, 'Could not return to rich mode for second-paste check')
    await sleep(300)
    const secondMermaid = rawMermaid.replace('flowchart TD', 'flowchart LR')
    await pasteIntoFirstMermaid(evaluate, secondMermaid)
    assert.deepEqual(
      await richSnapshot(evaluate),
      {
        codeBlocks: 2,
        mermaidBlocks: 2,
        previews: 2,
        sourceOccurrences: 1
      },
      'Pasting a second diagram into Mermaid did not create exactly one sibling block'
    )
    assert.equal(await toggleSource(evaluate), true, 'Could not inspect second Mermaid paste')
    const doubleSource = await waitForSource(evaluate)
    assert.equal(
      (doubleSource.match(/```mermaid/g) || []).length,
      2,
      `Second Mermaid paste did not produce two fenced blocks: ${JSON.stringify(doubleSource)}`
    )
    assert.equal(
      (doubleSource.match(/flowchart (?:TD|LR)/g) || []).length,
      2,
      'Second Mermaid source was lost or duplicated'
    )

    console.log('PASS Mermaid paste UI: raw, fenced, header-like labels, and second-block paste stay one-for-one')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(dir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
