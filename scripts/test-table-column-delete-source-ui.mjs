import assert from 'node:assert/strict'
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const sourceFixture = '/Users/yangtingyi/vibe_everything/test/无序列表测试.md'
const root = `/tmp/horsemd-table-column-delete-${process.pid}`
const fixture = join(root, 'fixture.md')
const port = 10400 + (process.pid % 200)

const waitFor = async (check, message, attempts = 100) => {
  for (let index = 0; index < attempts; index += 1) {
    const result = await check()
    if (result) return result
    await sleep(100)
  }
  throw new Error(message)
}

const click = async (send, point) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1
  })
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1
  })
}

const evaluateVisible = (app, expression) => app.evaluate(`(() => {
  const rich = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  return (${expression})(rich)
})()`)

const tableShape = (app) => evaluateVisible(app, `rich => {
  const block = [...(rich?.querySelectorAll('.milkdown-table-block') || [])].at(-1)
  const rows = [...(block?.querySelectorAll('tr') || [])]
  return {
    rows: rows.length,
    columns: rows[0]?.children.length || 0,
    headers: [...(block?.querySelectorAll('th') || [])].map((cell) => cell.textContent.trim()),
    cells: rows.map((row) => [...row.children].map((cell) => cell.textContent.trim()))
  }
}`)

const sourceTogglePoint = (app) => app.evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => /源码模式|Source mode/.test(node.title || ''))
  const rect = button?.getBoundingClientRect()
  return rect ? {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    title: button.title || '',
    text: button.textContent || '',
    disabled: button.disabled,
    hit: document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.className || ''
  } : null
})()`)

const readSource = (app) => app.evaluate(`(() => [...document.querySelectorAll('textarea.source-editor')]
  .find((node) => node.offsetParent)?.value || '')()`)

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await copyFile(sourceFixture, fixture)
  let app = await launchBuiltElectron({
    profileDir: join(root, 'profile'),
    port,
    appArgs: [fixture]
  })

  try {
    await waitFor(
      () => evaluateVisible(app, `rich => Boolean(rich?.querySelector('.milkdown-table-block'))`),
      'Rich editor did not load the fixture'
    )

    await app.evaluate(`window.__hmPreserveLog = []; window.__hmTableActionTrace = []`)
    const target = await evaluateVisible(app, `rich => {
      const block = [...(rich?.querySelectorAll('.milkdown-table-block') || [])].at(-1)
      const wrapper = block?.querySelector('.table-wrapper')
      const header = [...(block?.querySelectorAll('th') || [])].at(-1)
      if (!block || !wrapper || !header) return null
      block.scrollIntoView({ block: 'center' })
      wrapper.scrollLeft = wrapper.scrollWidth - wrapper.clientWidth
      const rect = header.getBoundingClientRect()
      const wrapperRect = wrapper.getBoundingClientRect()
      return {
        x: Math.max(wrapperRect.left + 8, Math.min(wrapperRect.right - 8, rect.left + rect.width / 2)),
        y: rect.top + rect.height / 2,
        header: header.textContent.trim(),
        before: wrapper.scrollLeft
      }
    }`)
    assert.ok(target, 'Last table header target was not found')
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y })
    await sleep(350)

    const handle = await evaluateVisible(app, `rich => {
      const block = [...(rich?.querySelectorAll('.milkdown-table-block') || [])].at(-1)
      const node = block?.querySelector('[data-role="col-drag-handle"]')
      const rect = node?.getBoundingClientRect()
      return node?.dataset.show === 'true' && rect
        ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, role: node.dataset.role }
        : null
    }`)
    assert.ok(handle, `Column hover handle did not appear for ${JSON.stringify(target)}`)
    await click(app.send, handle)
    await sleep(350)

    const deleteButton = await evaluateVisible(app, `rich => {
      const block = [...(rich?.querySelectorAll('.milkdown-table-block') || [])].at(-1)
      const group = block?.querySelector('[data-role="col-drag-handle"] .button-group[data-show="true"]')
      const buttons = [...(group?.querySelectorAll('button') || [])]
      const node = buttons.at(-1)
      const rect = node?.getBoundingClientRect()
      return rect ? {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        count: buttons.length
      } : null
    }`)
    assert.ok(deleteButton, 'Column action menu did not appear')
    assert.equal(deleteButton.count, 4, 'Column action menu has an unexpected number of buttons')

    const before = await tableShape(app)
    await click(app.send, deleteButton)
    await sleep(900)
    const afterRich = await tableShape(app)
    assert.equal(afterRich.columns, before.columns - 1, 'Rich table did not lose exactly one column')
    assert.ok(!afterRich.headers.includes(target.header), 'Deleted header still exists in rich table')
    const preserveLog = await app.evaluate('window.__hmPreserveLog || []')
    const actionTrace = await app.evaluate('window.__hmTableActionTrace || []')
    const pendingState = await app.evaluate(`(() => ({
      saveFab: Boolean(document.querySelector('.hm-save-fab')),
      tabs: window.__horsemd?.tabs || null
    }))()`)
    console.log('COLUMN_DELETE_RICH:', JSON.stringify({ target, before, afterRich, preserveLog, actionTrace, pendingState }))

    const saveAfterDelete = await waitFor(() => app.evaluate(`(() => {
      const button = document.querySelector('.hm-save-fab')
      const rect = button?.getBoundingClientRect()
      return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
    })()`), 'Save button did not appear after deleting the column')
    await click(app.send, saveAfterDelete)
    await sleep(700)
    const savedAfterDelete = await readFile(fixture, 'utf8')
    assert.ok(!savedAfterDelete.includes(target.header), 'Saved Markdown still contains the deleted column')
    console.log('COLUMN_DELETE_SAVED_BEFORE_SOURCE:', JSON.stringify({
      hasDeletedHeader: savedAfterDelete.includes(target.header),
      source: savedAfterDelete
    }))

    const toggle = await sourceTogglePoint(app)
    if (!toggle) {
      const labels = await app.evaluate(`[...document.querySelectorAll('.status-btn')]
        .map((node) => ({ title: node.title || '', text: node.textContent || '', aria: node.getAttribute('aria-label') || '' }))`)
      throw new Error(`Source mode toggle was not found: ${JSON.stringify(labels)}`)
    }
    console.log('SOURCE_TOGGLE_POINT:', JSON.stringify(toggle))
    await click(app.send, toggle)
    await sleep(250)
    if (!await app.evaluate(`Boolean([...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent))`)) {
      await app.evaluate(`(() => {
        const button = [...document.querySelectorAll('.status-btn')]
          .find((node) => /源码模式|Source mode/.test(node.title || ''))
        button?.click()
      })()`)
    }
    await waitFor(
      () => app.evaluate(`Boolean([...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent))`),
      'Source textarea did not open'
    )
    const source = await readSource(app)
    assert.ok(!source.includes(target.header), 'Source mode still contains the deleted column')
    console.log('COLUMN_DELETE_SOURCE:', JSON.stringify({ sourceLength: source.length, hasDeletedHeader: source.includes(target.header), source }))

    const save = await app.evaluate(`(() => {
      const button = document.querySelector('.hm-save-fab')
      const rect = button?.getBoundingClientRect()
      return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
    })()`)
    if (save) {
      await click(app.send, save)
      await sleep(500)
    }
    const saved = await readFile(fixture, 'utf8')
    assert.ok(!saved.includes(target.header), 'Final saved Markdown still contains the deleted column')
    console.log('COLUMN_DELETE_SAVED:', JSON.stringify({ hasDeletedHeader: saved.includes(target.header), source: saved }))

    await stopBuiltElectron(app)
    app = await launchBuiltElectron({
      profileDir: join(root, 'profile'),
      port: port + 1,
      cleanProfile: false,
      appArgs: [fixture]
    })
    await waitFor(
      () => evaluateVisible(app, `rich => Boolean(rich?.querySelector('.milkdown-table-block'))`),
      'Reopened rich editor did not load the saved fixture'
    )
    const reopened = await tableShape(app)
    assert.equal(reopened.columns, 9, 'Reopened table restored the deleted column')
    assert.ok(!reopened.headers.includes(target.header), 'Reopened rich table restored the deleted header')
    console.log('COLUMN_DELETE_REOPENED:', JSON.stringify({ columns: reopened.columns, hasDeletedHeader: reopened.headers.includes(target.header) }))
    console.log('PASS reproduction completed')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
