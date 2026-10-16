import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { launchBuiltElectron, stopBuiltElectron } from './electron-test-app.mjs'
import { sleep } from './cdp.mjs'
import { pressKey, typeTextLikeUser } from './human-input.mjs'

export const CODE_BLOCK_EXIT_WARNING = /检测到富文本与源码不一致|源码.*不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/i

export const waitFor = async (check, message, attempts = 180) => {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

const visibleEditor = () => `(() => [...document.querySelectorAll('.ProseMirror')]
  .find((node) => node.offsetParent))()`

export async function openCodeBlockExitApp({
  file,
  profileDir,
  port,
  packagedAppPath = ''
}) {
  const app = await launchBuiltElectron({
    profileDir,
    port,
    appArgs: [file, '--horsemd-input-trace'],
    executable: packagedAppPath || undefined,
    entrypoint: packagedAppPath ? null : undefined
  })
  try {
    await waitFor(() => app.evaluate(`(() => {
      const editor = ${visibleEditor()}
      const content = editor?.querySelector('.milkdown-code-block .cm-content')
      return Boolean(content && (content.innerText || content.textContent || '').includes('console.log(1)'))
    })()`), 'code-block exit editor did not mount the authored code block')
    await sleep(450)
    return app
  } catch (error) {
    await stopBuiltElectron(app, { removeProfile: true })
    throw error
  }
}

export const clearCodeBlockExitDiagnostics = (app) => app.evaluate(`(() => {
  window.__hmPreserveLog = []
  window.__hmSourceIntegrityTrace = []
  window.__hmSourceIntegrityDiffTrace = []
  window.__hmSourceSyncCoordinatorTrace = []
  window.__hmSourceSyncTransactionJournalTrace = []
  window.__hmCodeBlockTransactionTrace = []
  window.__hmFlushTrace = []
})()`)

export const focusCodeBlockEnd = (app) => app.evaluate(`(() => {
  const editor = ${visibleEditor()}
  const content = editor?.querySelector('.milkdown-code-block .cm-content')
  const line = content?.querySelector('.cm-line:last-child') || content
  if (!editor || !content || !line) return null
  content.focus()
  const range = document.createRange()
  range.selectNodeContents(line)
  range.collapse(false)
  const selection = getSelection()
  selection.removeAllRanges()
  selection.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
  return {
    text: content.innerText || content.textContent || '',
    activeClass: document.activeElement?.className || ''
  }
})()`)

export const focusExitParagraph = (app) => app.evaluate(`(() => {
  const editor = ${visibleEditor()}
  const code = [...(editor?.children || [])].find((node) =>
    node.classList?.contains('milkdown-code-block')
  )
  const paragraph = code?.nextElementSibling
  if (!editor || !code || paragraph?.tagName !== 'P') return null
  editor.focus()
  const range = document.createRange()
  range.selectNodeContents(paragraph)
  range.collapse(false)
  const selection = getSelection()
  selection.removeAllRanges()
  selection.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
  return {
    text: (paragraph.innerText || paragraph.textContent || '').replace(/\u200B/g, '').trim(),
    tag: paragraph.tagName
  }
})()`)

export async function pressCodeBlockExit(app, delayMs = 15) {
  await pressKey(app.send, {
    key: 'Enter',
    code: 'Enter',
    modifiers: 4,
    delayMs
  })
}

export async function typeCodeExitText(app, value, delayMs = 25) {
  await typeTextLikeUser(app.send, value, { delayMs })
}

export const waitForExitParagraph = (app, expectedText) => waitFor(
  () => app.evaluate(`(() => {
    const editor = ${visibleEditor()}
    const code = [...(editor?.children || [])].find((node) =>
      node.classList?.contains('milkdown-code-block')
    )
    const paragraph = code?.nextElementSibling
    if (paragraph?.tagName !== 'P') return false
    return (paragraph.innerText || paragraph.textContent || '')
      .replace(/\u200B/g, '').trim() === ${JSON.stringify(expectedText)}
  })()`),
  `code-block exit paragraph did not reach ${JSON.stringify(expectedText)}`
)

export const readCodeBlockExitStructure = (app) => app.evaluate(`(() => {
  const editor = ${visibleEditor()}
  const children = [...(editor?.children || [])].map((node) => {
    if (node.classList?.contains('milkdown-code-block')) {
      return {
        type: 'code_block',
        text: (node.querySelector('.cm-content')?.innerText ||
          node.querySelector('.cm-content')?.textContent || '').replace(/\u200B/g, '').trim()
      }
    }
    return {
      type: node.tagName === 'P' ? 'paragraph' : String(node.tagName || '').toLowerCase(),
      text: (node.innerText || node.textContent || '').replace(/\u200B/g, '').trim()
    }
  })
  return {
    types: children.map((entry) => entry.type),
    texts: children.map((entry) => entry.text)
  }
})()`)

export const readCodeBlockExitDiagnostics = (app) => app.evaluate(`(() => ({
  preserve: (window.__hmPreserveLog || []).slice(-100)
    .map(({ source, previous, next, markdown, ...entry }) => entry),
  integrity: (window.__hmSourceIntegrityTrace || []).slice(-100).map((entry) => ({
    ok: entry.ok,
    semanticOk: entry.semanticOk,
    listSlotsMatch: entry.listSlotsMatch,
    preservationReason: entry.preservationReason,
    validationSite: entry.validationSite
  })),
  semanticDiff: (window.__hmSourceIntegrityDiffTrace || []).slice(-40),
  coordinator: (window.__hmSourceSyncCoordinatorTrace || []).slice(-100),
  journal: (window.__hmSourceSyncTransactionJournalTrace || []).slice(-180),
  owner: (window.__hmCodeBlockTransactionTrace || []).slice(-180),
  flush: (window.__hmFlushTrace || []).slice(-100),
  toasts: [...document.querySelectorAll('[class*="toast"]')]
    .filter((node) => node.offsetParent)
    .map((node) => node.textContent || '')
}))()`)

export function assertHealthyCodeBlockExit(state, label) {
  assert.equal(state.integrity.some((entry) => entry.ok === false), false,
    `${label} integrity failure: ${JSON.stringify(state.integrity)}`)
  assert.equal(state.preserve.some((entry) =>
    entry.reason === 'code-block-exit' &&
    entry.integrityProof?.kind !== 'transaction-code-block-exit-proof'
  ), false, `${label} allowed a legacy code-block-exit publication`)
  assert.equal(state.coordinator.some((entry) =>
    entry.phase === 'published' &&
    entry.owner === 'legacy' &&
    entry.reason === 'code-block-exit'
  ), false, `${label} published code-block exit through legacy`)
  assert.equal(state.semanticDiff.length, 0,
    `${label} semantic diff: ${JSON.stringify(state.semanticDiff)}`)
  assert.equal(state.toasts.some((text) => CODE_BLOCK_EXIT_WARNING.test(text)), false,
    `${label} warning toast: ${JSON.stringify(state.toasts)}`)
}

export const toggleSource = (app) => app.evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
  button?.click()
  return Boolean(button)
})()`)

export const visibleSource = (app) => app.evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)

export async function saveCodeBlockExitFile(app, file, expectedDisk, label) {
  await waitFor(() => app.evaluate(`Boolean(document.querySelector('.hm-save-fab'))`),
    `${label} save button missing`)
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`),
    `${label} save did not complete`)
  assert.equal(await readFile(file, 'utf8'), expectedDisk, `${label} disk mismatch`)
}
