// #86 regression: adding a table row, editing multiple cells, and saving/source
// serialization must keep each cell independent and leave empty cells empty.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

// Each run owns its profile and fixture directory. Electron can take a moment
// to release a prior profile on macOS, so sharing a fixed path makes repeated
// regression runs race with cleanup rather than test the table behavior.
const root = `/tmp/horsemd-issue-86-table-save-${process.pid}`
const port = 9500 + (process.pid % 300)
const fixture = join(root, 'table-save.md')
const markdown = [
  '# Table save',
  '',
  '| First | Second | Third |',
  '| --- | --- | --- |',
  '| old-first<br>old-first-line | old-second | old-third |'
].join('\n')

const waitFor = async (check, message, attempts = 80) => {
  for (let index = 0; index < attempts; index += 1) {
    const result = await check()
    if (result) return result
    await sleep(100)
  }
  throw new Error(message)
}

const click = async (send, point) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
}

const hasVisibleTable = (app) => app.evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent !== null)
  return Boolean(editor?.querySelector('.milkdown-table-block'))
})()`)

const tableShape = (app) => app.evaluate(`(() => {
  const block = [...document.querySelectorAll('.milkdown-table-block')].find((node) => node.offsetParent !== null)
  const rows = [...(block?.querySelectorAll('tr') || [])]
  return {
    rows: rows.length,
    bodyRows: block?.querySelectorAll('tbody tr').length || 0,
    columns: rows[0]?.children.length || 0
  }
})()`)

const addAxis = async (app, axis) => {
  // This test protects serialization, not edge-positioned table controls. Use
  // the first cell's inside-left edge so a native column-resize widget at a
  // right boundary cannot turn this test into a browser hit-testing test. The
  // dedicated table UI regression covers the visible add buttons and edges.
  const target = 'tbody tr:last-child td:first-child'
  const handleRole = axis === 'row' ? 'x-line-drag-handle' : 'y-line-drag-handle'
  let diagnostics = null
  for (let attempt = 0; attempt < 3; attempt++) {
    const point = await waitFor(() => app.evaluate(`(() => {
      const block = [...document.querySelectorAll('.milkdown-table-block')].find((node) => node.offsetParent !== null)
      const cell = block?.querySelector(${JSON.stringify(target)})
      const rect = cell?.getBoundingClientRect()
      if (!rect) return null
      const point = ${JSON.stringify(axis)} === 'row'
        ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.bottom - 4) }
        : { x: Math.round(rect.left + 4), y: Math.round(rect.top + rect.height / 2) }
      const candidate = point
      return cell.contains(document.elementFromPoint(candidate.x, candidate.y)) ? point : null
    })()`), `Table cell for add-${axis} handle was not hit-testable`)
    const before = await tableShape(app)
    let button = null
    const candidates = [point]
    for (const candidate of candidates) {
      await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...candidate })
      await sleep(250)
      button = await app.evaluate(`(() => {
        const handle = [...document.querySelectorAll('.line-handle')]
          .find((node) => node.offsetParent && node.dataset.role === ${JSON.stringify(handleRole)} && node.dataset.show === 'true')
        const add = handle?.querySelector('.add-button')
        const rect = add?.getBoundingClientRect()
        return rect ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } : null
      })()`)
      if (button) break
    }
    if (!button) {
      diagnostics = await app.evaluate(`(() => {
        const block = [...document.querySelectorAll('.milkdown-table-block')]
          .find((node) => node.offsetParent !== null)
        const describe = (node) => {
          if (!node) return null
          const rect = node.getBoundingClientRect()
          return {
            className: node.className,
            role: node.dataset?.role,
            show: node.dataset?.show,
            rect: [rect.left, rect.top, rect.right, rect.bottom],
            display: getComputedStyle(node).display
          }
        }
        return {
          block: describe(block),
          target: describe(block?.querySelector(${JSON.stringify(target)})),
          handles: [...(block?.querySelectorAll('.line-handle') || [])].map(describe),
          hit: describe(document.elementFromPoint(${point.x}, ${point.y}))
        }
      })()`)
      continue
    }
    await click(app.send, button)
    for (let poll = 0; poll < 10; poll++) {
      await sleep(100)
      const after = await tableShape(app)
      if (axis === 'row' ? after.bodyRows === before.bodyRows + 1 : after.columns === before.columns + 1) return
    }
  }
  throw new Error(`Adding a ${axis} did not change the table shape after three interactions: ${JSON.stringify(diagnostics)}`)
}

const addRow = (app) => addAxis(app, 'row')
const addColumn = (app) => addAxis(app, 'column')

const cellPoint = (app, index) => app.evaluate(`((index) => {
  const block = [...document.querySelectorAll('.milkdown-table-block')].find((node) => node.offsetParent !== null)
  const cell = [...(block?.querySelectorAll('tbody tr:last-child td') || [])][index]
  const text = cell?.querySelector('p') || cell
  const rect = text?.getBoundingClientRect()
  return rect ? { x: Math.round(rect.left + Math.min(18, rect.width / 2)), y: Math.round((rect.top + rect.bottom) / 2) } : null
})(${index})`)

const tableSnapshot = (app) => app.evaluate(`(() => {
  const block = [...document.querySelectorAll('.milkdown-table-block')].find((node) => node.offsetParent !== null)
  return [...(block?.querySelectorAll('tr') || [])].map((row) =>
    [...row.children].map((cell) => ({ text: cell.textContent || '', html: cell.innerHTML || '' }))
  )
})()`)

const activeCellSnapshot = (app) => app.evaluate(`(() => {
  const block = [...document.querySelectorAll('.milkdown-table-block')].find((node) => node.offsetParent !== null)
  const selection = window.getSelection()
  const anchor = selection?.anchorNode
  const element = anchor?.nodeType === Node.ELEMENT_NODE ? anchor : anchor?.parentElement
  const cell = element?.closest?.('td, th')
  const rows = [...(block?.querySelectorAll('tbody tr') || [])]
  const row = cell?.closest('tr')
  return {
    row: rows.indexOf(row),
    column: row ? [...row.children].indexOf(cell) : -1,
    cellHtml: cell?.innerHTML || '',
    anchor: anchor?.nodeName || ''
  }
})()`)

const fillCell = async (app, index, text) => {
  const point = await cellPoint(app, index)
  assert.ok(point, `Table cell ${index} not found`)
  // Crepe uses the first table click to establish a cell selection.
  await click(app.send, point)
  await click(app.send, point)
  const active = await activeCellSnapshot(app)
  const table = await tableSnapshot(app)
  assert.deepEqual(
    { row: active.row, column: active.column },
    { row: table.length - 1, column: index },
    `Click did not place the caret in added-row cell ${index}: ${JSON.stringify({ active, table })}`
  )
  await app.send('Input.insertText', { text })
  await sleep(120)
}

const toggleSource = async (app) => {
  const alreadySource = await app.evaluate(`Boolean([...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent !== null))`)
  if (alreadySource) return
  const point = await app.evaluate(`(() => {
    const button = [...document.querySelectorAll('.status-btn')]
      .find((node) => /源码模式|Source mode/.test(node.title || ''))
    const rect = button?.getBoundingClientRect()
    return rect ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } : null
  })()`)
  if (!point) {
    const labels = await app.evaluate(`[...document.querySelectorAll('.status-btn')]
      .map((node) => ({ title: node.title || '', text: node.textContent || '' }))`)
    throw new Error(`Source toggle button not found: ${JSON.stringify(labels)}`)
  }
  await click(app.send, point)
  await waitFor(
    () => app.evaluate(`Boolean([...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent !== null))`),
    'Source textarea did not open'
  )
}

const toggleRich = async (app) => {
  const alreadyRich = await app.evaluate(`Boolean([...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent !== null))`)
  if (alreadyRich) return
  const point = await app.evaluate(`(() => {
    const button = [...document.querySelectorAll('.status-btn')]
      .find((node) => /源码模式|Source mode/.test(node.title || ''))
    const rect = button?.getBoundingClientRect()
    return rect ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } : null
  })()`)
  assert.ok(point, 'Source toggle button not found when returning to rich mode')
  await click(app.send, point)
  await waitFor(
    () => app.evaluate(`Boolean([...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent !== null))`),
    'Rich editor did not reopen'
  )
}

const tableShapeInSource = (source) => {
  const lines = source.split('\n').filter((line) => line.includes('|'))
  const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').length
  return { rows: lines.length, columns: lines[0] ? cells(lines[0]) : 0 }
}

const saveDocument = async (app) => {
  const point = await waitFor(() => app.evaluate(`(() => {
    const button = document.querySelector('.hm-save-fab')
    const rect = button?.getBoundingClientRect()
    return rect ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } : null
  })()`), 'Save button did not appear after a table edit')
  await click(app.send, point)
  await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'Save button did not clear after saving')
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(fixture, markdown, 'utf8')
  let app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [fixture] })
  try {
    await waitFor(() => hasVisibleTable(app), 'Table did not render')
    await addRow(app)
    await addRow(app)
    await addColumn(app)
    await addColumn(app)
    const afterAdd = await tableSnapshot(app)
    await fillCell(app, 0, 'new-alpha')
    await fillCell(app, 1, 'new-beta')
    await fillCell(app, 2, 'new-gamma')
    await fillCell(app, 3, 'new-delta')
    await fillCell(app, 4, 'new-epsilon')
    await sleep(700)
    await toggleSource(app)
    const source = await app.evaluate(`(() => [...document.querySelectorAll('textarea.source-editor')]
      .find((node) => node.offsetParent !== null)?.value || '')()`)
    assert.match(source, /\|\s*new-alpha\s*\|\s*new-beta\s*\|\s*new-gamma\s*\|\s*new-delta\s*\|\s*new-epsilon\s*\|/, `Edited cells were moved or merged during serialization: ${JSON.stringify({ afterAdd, source })}`)
    for (const text of ['new-alpha', 'new-beta', 'new-gamma', 'new-delta', 'new-epsilon']) {
      assert.equal((source.match(new RegExp(text, 'g')) || []).length, 1, `${text} was duplicated or merged`)
    }
    assert.match(source, /old-first<br>old-first-line/, 'A real table-cell line break was lost')
    assert.equal(/\|\s*<br\s*\/?>/i.test(source), false, `Empty table cells were serialized as line breaks: ${source}`)
    assert.deepEqual(tableShapeInSource(source), { rows: 5, columns: 5 }, `Repeated edits changed table dimensions: ${source}`)
    // Save from the rich editor, which is the user path that originally
    // reproduced the corruption. Then close the process completely rather
    // than retaining the mounted editor or its in-memory document state.
    await toggleRich(app)
    await saveDocument(app)
    const saved = await readFile(fixture, 'utf8')
    assert.deepEqual(tableShapeInSource(saved), { rows: 5, columns: 5 }, `Saving changed table dimensions: ${saved}`)
    assert.equal(/\|\s*<br\s*\/?>/i.test(saved), false, `Saved empty table cells contain <br>: ${saved}`)

    await stopBuiltElectron(app, { removeProfile: true })
    app = null
    app = await launchBuiltElectron({
      profileDir: join(root, 'reopen-profile'),
      port: port + 1,
      appArgs: [fixture]
    })
    await waitFor(() => hasVisibleTable(app), 'Saved table did not render after reopening')
    await toggleSource(app)
    const reopenedSource = await app.evaluate(`(() => [...document.querySelectorAll('textarea.source-editor')]
      .find((node) => node.offsetParent !== null)?.value || '')()`)
    assert.deepEqual(tableShapeInSource(reopenedSource), { rows: 5, columns: 5 }, `Reopened table dimensions changed: ${reopenedSource}`)
    assert.equal(/\|\s*<br\s*\/?>/i.test(reopenedSource), false, `Reopened empty table cells contain <br>: ${reopenedSource}`)
    for (const text of ['new-alpha', 'new-beta', 'new-gamma', 'new-delta', 'new-epsilon']) {
      assert.equal((reopenedSource.match(new RegExp(text, 'g')) || []).length, 1, `${text} changed after reopening`)
    }
    assert.match(reopenedSource, /old-first<br>old-first-line/, 'A real table-cell line break changed after reopening')
    console.log('PASS issue 86 UI: repeated row/column edits survive rich save and a clean file reopen without empty <br> cells or structural growth')
  } finally {
    if (app) await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
