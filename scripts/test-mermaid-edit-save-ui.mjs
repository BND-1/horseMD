import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

// Mermaid rendering is asynchronous while CodeMirror reports a change for each
// character. This test deliberately types through the invalid intermediate
// `B -->` state and proves its delayed error never overwrites the completed
// `B --> C` preview. It also protects the edit -> save -> source -> reopen
// persistence path reported by users.
const port = Number(process.env.CDP_PORT || 9860)
const initialSource = [
  '# Mermaid 编辑保存回归',
  '',
  '```mermaid',
  'flowchart TD',
  '  A --> B',
  '```'
].join('\n')

async function waitFor(check, message, attempts = 80) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(typeof message === 'function' ? message() : message)
}

async function visibleEditor(evaluate) {
  return evaluate(`(() => [...document.querySelectorAll('.ProseMirror')]
    .some((node) => node.offsetParent))()`)
}

async function toggleSource(evaluate) {
  const toggled = await evaluate(`(() => {
    const button = [...document.querySelectorAll('.status-btn')]
      .find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
    button?.click()
    return Boolean(button)
  })()`)
  assert.equal(toggled, true, 'Could not find the rich/source toggle')
}

async function sourceValue(evaluate) {
  return evaluate(`(() => [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null)()`)
}

async function save(evaluate) {
  const state = await waitFor(() => evaluate(`(() => {
    const button = document.querySelector('.hm-save-fab')
    if (!button || button.disabled) return { clicked: false, exists: Boolean(button), disabled: button?.disabled ?? null, text: button?.textContent || '' }
    button.click()
    return { clicked: true, exists: true, disabled: false, text: button.textContent || '' }
  })()`).then((value) => value.clicked ? value : false), 'Save control did not become available after Mermaid edit')
  assert.equal(state.clicked, true, `Save control was unavailable after Mermaid edit: ${JSON.stringify(state)}`)
}

async function placeMermaidCaretAtEnd(evaluate, send) {
  const placed = await evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const code = editor?.querySelector('.milkdown-code-block .cm-content')
    const last = code?.querySelector('.cm-line:last-child')?.firstChild
    if (!code || !last) return false
    const range = document.createRange()
    range.setStart(last, last.nodeValue.length)
    range.collapse(true)
    const selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    code.focus()
    return true
  })()`)
  assert.equal(placed, true, 'Could not place the Mermaid CodeMirror caret')
  await pressKey(send, { key: 'End', code: 'End' })
}

async function click(send, point) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
}

async function showMermaidSource(evaluate, send) {
  const point = await evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const button = editor?.querySelector('.milkdown-code-block .preview-toggle-button')
    const rect = button?.getBoundingClientRect()
    return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
  })()`)
  assert.ok(point, 'Could not reveal the Mermaid editor')
  await click(send, point)
  await waitFor(() => evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    return Boolean(editor?.querySelector('.milkdown-code-block .cm-content'))
  })()`), 'Mermaid CodeMirror block did not become visible')
}

async function previewText(evaluate) {
  return evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    return editor?.querySelector('.milkdown-code-block .preview')?.textContent || ''
  })()`)
}

async function launch(profileDir, fixture, currentPort) {
  return launchBuiltElectron({
    profileDir,
    port: currentPort,
    appArgs: [fixture],
    executable: process.env.HORSEMD_APP_PATH || undefined,
    entrypoint: process.env.HORSEMD_APP_PATH ? null : undefined
  })
}

async function main() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'horsemd-mermaid-edit-save-'))
  const fixture = path.join(dir, 'mermaid-edit.md')
  await writeFile(fixture, initialSource, 'utf8')

  let app = await launch(path.join(dir, 'profile-first'), fixture, port)
  try {
    const { evaluate, send } = app
    await waitFor(() => visibleEditor(evaluate), 'Rich editor did not become visible')
    await showMermaidSource(evaluate, send)
    await placeMermaidCaretAtEnd(evaluate, send)
    await typeTextLikeUser(send, '\n  B --> C')

    const rendered = await waitFor(async () => {
      const snapshot = await evaluate(`(() => {
        const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
        return {
          source: editor?.querySelector('.milkdown-code-block .cm-content')?.innerText || '',
          preview: editor?.querySelector('.milkdown-code-block .preview')?.textContent || ''
        }
      })()`)
      return snapshot.source.includes('B --> C') && snapshot.preview.includes('C') && !/图表错误|Parse error/i.test(snapshot.preview)
    }, 'Completed Mermaid source did not replace the stale intermediate error')
    assert.equal(rendered, true)

    await save(evaluate)
    await waitFor(async () => (await readFile(fixture, 'utf8')).includes('B --> C'), 'Mermaid edit was not saved to disk')
    await toggleSource(evaluate)
    const source = await waitFor(() => sourceValue(evaluate), 'Source mode did not open after Mermaid save')
    assert.ok(source.includes('B --> C'), 'Source mode omitted the saved Mermaid edit')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }

  app = await launch(path.join(dir, 'profile-reopen'), fixture, port + 1)
  try {
    const { evaluate } = app
    await waitFor(() => visibleEditor(evaluate), 'Reopened rich editor did not become visible')
    let reopenSnapshot = null
    const rendered = await waitFor(async () => {
      const text = await previewText(evaluate)
      reopenSnapshot = {
        source: await evaluate(`(() => [...document.querySelectorAll('.cm-content')]
          .find((node) => node.offsetParent)?.innerText || '')()`),
        preview: text
      }
      return text.includes('C') && !/图表错误|Parse error/i.test(text)
    }, () => `Reopened Mermaid did not render the saved edit: ${JSON.stringify(reopenSnapshot)}`)
    assert.equal(rendered, true)
    await toggleSource(evaluate)
    const source = await waitFor(() => sourceValue(evaluate), 'Reopened source mode did not open')
    assert.ok(source.includes('B --> C'), 'Reopened source omitted the Mermaid edit')
    console.log('PASS Mermaid UI: per-character edit refreshes preview and survives save, source mode, and reopen')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(dir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
