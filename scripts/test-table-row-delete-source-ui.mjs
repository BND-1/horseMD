import assert from 'node:assert/strict'
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const sourceFixture = '/Users/yangtingyi/vibe_everything/test/无序列表测试.md'
const root = `/tmp/horsemd-table-row-delete-${process.pid}`
const fixture = join(root, 'fixture.md')
const port = 10500 + (process.pid % 200)

const waitFor = async (check, message, attempts = 120) => {
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
    cells: rows.map((row) => [...row.children].map((cell) => cell.textContent.trim()))
  }
}`)

const readSource = (app) => app.evaluate(`(() => [...document.querySelectorAll('textarea.source-editor')]
  .find((node) => node.offsetParent)?.value || '')()`)

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await copyFile(sourceFixture, fixture)
  let app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [fixture] })

  try {
    await waitFor(
      () => evaluateVisible(app, `rich => Boolean(rich?.querySelector('.milkdown-table-block'))`),
      'Rich editor did not load the fixture'
    )
    await app.evaluate(`window.__hmPreserveLog = []; window.__hmTableActionTrace = []`)

    const target = await evaluateVisible(app, `rich => {
      const block = [...(rich?.querySelectorAll('.milkdown-table-block') || [])].at(-1)
      const rows = [...(block?.querySelectorAll('tr') || [])]
      const row = rows[2]
      const cell = row?.children[0]
      if (!block || !row || !cell) return null
      block.scrollIntoView({ block: 'center' })
      const rect = cell.getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, row: [...row.children].map((node) => node.textContent.trim()) }
    }`)
    assert.ok(target, 'Target table row was not found')
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y })
    await sleep(400)

    const handle = await evaluateVisible(app, `rich => {
      const block = [...(rich?.querySelectorAll('.milkdown-table-block') || [])].at(-1)
      const node = block?.querySelector('[data-role="row-drag-handle"]')
      const rect = node?.getBoundingClientRect()
      return node?.dataset.show === 'true' && rect
        ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
        : null
    }`)
    assert.ok(handle, `Row hover handle did not appear for ${JSON.stringify(target)}`)
    await click(app.send, handle)
    await sleep(300)

    const deleteButton = await evaluateVisible(app, `rich => {
      const block = [...(rich?.querySelectorAll('.milkdown-table-block') || [])].at(-1)
      const group = block?.querySelector('[data-role="row-drag-handle"] .button-group[data-show="true"]')
      const node = group?.querySelector('button')
      const rect = node?.getBoundingClientRect()
      return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
    }`)
    assert.ok(deleteButton, 'Row delete action did not appear')

    const before = await tableShape(app)
    await click(app.send, deleteButton)
    await sleep(900)
    const afterRich = await tableShape(app)
    const preserveLog = await app.evaluate('window.__hmPreserveLog || []')
    const actionTrace = await app.evaluate('window.__hmTableActionTrace || []')
    console.log('ROW_DELETE_RESULT:', JSON.stringify({ target, before, afterRich, actionTrace, preserveReasons: preserveLog.slice(-8).map(({ reason, preserved }) => ({ reason, preserved })) }))
    assert.equal(afterRich.rows, before.rows - 1, 'Rich table did not lose exactly one row')
    assert.ok(!afterRich.cells.some((row) => row.join('|') === target.row.join('|')), 'Deleted row still exists in rich table')

    const save = await waitFor(() => app.evaluate(`(() => {
      const button = document.querySelector('.hm-save-fab')
      const rect = button?.getBoundingClientRect()
      return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
    })()`), 'Save button did not appear after deleting the row')
    await click(app.send, save)
    await sleep(700)
    const saved = await readFile(fixture, 'utf8')
    assert.ok(!saved.includes(target.row[0]), 'Saved Markdown still contains the deleted row')

    await app.evaluate(`(() => {
      const button = [...document.querySelectorAll('.status-btn')]
        .find((node) => /源码模式|Source mode/.test(node.title || ''))
      button?.click()
    })()`)
    await waitFor(
      () => app.evaluate(`Boolean([...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent))`),
      'Source textarea did not open'
    )
    const source = await readSource(app)
    assert.ok(!source.includes(target.row[0]), 'Source mode still contains the deleted row')

    await stopBuiltElectron(app)
    app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port: port + 1, cleanProfile: false, appArgs: [fixture] })
    await waitFor(
      () => evaluateVisible(app, `rich => Boolean(rich?.querySelector('.milkdown-table-block'))`),
      'Reopened rich editor did not load the saved fixture'
    )
    const reopened = await tableShape(app)
    assert.equal(reopened.rows, before.rows - 1, 'Reopened table restored the deleted row')
    assert.ok(!reopened.cells.some((row) => row.join('|') === target.row.join('|')), 'Reopened rich table restored the deleted row')
    console.log('PASS table row deletion source sync')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
