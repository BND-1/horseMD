// E2E for workspace-wide search (issue #120). Launches the built app with a
// temp multi-file workspace, opens the search sidebar (ActivityBar button),
// and locks:
//   1. multi-keyword AND semantics (space-separated terms),
//   2. result rendering (file grouping + highlighted snippets),
//   3. click-to-jump on a plain .txt tab (source find, exact occurrence),
//   4. click-to-jump on a rich markdown tab (FindBar highlights all matches).
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-gsearch-${process.pid}`
const port = Number(process.env.CDP_PORT || 9840)

const ALPHA = '# 苹果研究\n\n这里的苹果很甜。\n\n- 苹果品种多\n- 香蕉也好吃\n'
const BETA = '只有香蕉的水果清单。\n'
const GAMMA = '苹果 plain text first line\nsecond line target\n'

async function waitFor(check, message, attempts = 120, dump = null) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  if (dump) {
    const state = await dump()
    console.error('[waitFor dump]', JSON.stringify(state, null, 2))
  }
  throw new Error(message)
}

async function click(send, point) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
}

// Click the search input and PROVE it took focus — the sidebar may still be
// settling into place right after the mode switch, so a point captured too
// early can miss (and insertText would then land on the wrong element).
async function focusSearchInput(evaluate, send) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const point = await searchInputPoint(evaluate)
    if (point) await click(send, point)
    const focused = await evaluate(
      `document.activeElement?.classList.contains('gsearch-input') ?? false`
    )
    if (focused) return
    await sleep(150)
  }
  throw new Error('could not focus the global search input')
}

const searchButtonPoint = (evaluate) => evaluate(`(() => {
  const button = [...document.querySelectorAll('.activity-item')]
    .find((node) => /全局搜索|Global Search/.test(node.title || ''))
  if (!button || !button.offsetParent) return null
  const rect = button.getBoundingClientRect()
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
})()`)

const searchInputPoint = (evaluate) => evaluate(`(() => {
  const input = document.querySelector('.gsearch-input')
  if (!input || !input.offsetParent) return null
  const rect = input.getBoundingClientRect()
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
})()`)

const resultFiles = (evaluate) => evaluate(`(() =>
  [...document.querySelectorAll('.gsearch-file-head .gsearch-fname')].map((node) => node.textContent)
)()`)

const resultMarks = (evaluate) => evaluate(`(() =>
  [...document.querySelectorAll('.gsearch-item mark')].map((node) => node.textContent)
)()`)

const activeTabTitle = (evaluate) => evaluate(`(
  [...document.querySelectorAll('.tab')]
    .find((node) => node.classList.contains('active'))?.textContent ?? null
)`)

const findState = (evaluate) => evaluate(`(() => {
  const bar = document.querySelector('.findbar')
  if (!bar || !bar.offsetParent) return null
  const input = bar.querySelector('input')
  const count = bar.querySelector('.findbar-count')?.textContent ?? ''
  return { query: input ? input.value : null, count }
})()`)

async function clickResultRow(evaluate, send, fileTitle, nth = 0) {
  const point = await evaluate(`(() => {
    const file = [...document.querySelectorAll('.gsearch-file')]
      .find((group) => group.querySelector('.gsearch-fname')?.textContent === ${JSON.stringify(fileTitle)})
    const row = file?.querySelectorAll('.gsearch-item')[${nth}]
    if (!row || !row.offsetParent) return null
    const rect = row.getBoundingClientRect()
    return { x: rect.left + Math.min(rect.width / 2, 120), y: rect.top + rect.height / 2 }
  })()`)
  assert.ok(point, `missing result row for ${fileTitle}[${nth}]`)
  await click(send, point)
}

let failure = null
try {
  await rm(root, { recursive: true, force: true })
  await mkdir(join(root, 'notes'), { recursive: true })
  await writeFile(join(root, 'alpha.md'), ALPHA, 'utf8')
  await writeFile(join(root, 'notes', 'beta.md'), BETA, 'utf8')
  await writeFile(join(root, 'notes', 'gamma.txt'), GAMMA, 'utf8')

  const app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [root] })
  try {
    const { evaluate, send } = app
    await evaluate(`(() => {
      window.__errs = []
      window.addEventListener('error', (e) => window.__errs.push(String(e.message || e.error)))
      window.addEventListener('unhandledrejection', (e) => window.__errs.push(String(e.reason)))
      return true
    })()`)

    // Workspace root loaded from the folder launch arg (sidebar files mode).
    await waitFor(
      () => evaluate(`(() => !!document.querySelector('.sidebar') || !!document.querySelector('.tree-row'))()`),
      'sidebar did not mount with the folder workspace'
    )

    // Open the global search pane from the ActivityBar.
    const button = await waitFor(() => searchButtonPoint(evaluate), 'global search activity button not found')
    await click(send, button)
    await waitFor(
      () => evaluate(`(() => !!document.querySelector('.gsearch-input'))()`),
      'search panel did not open'
    )

    // Multi-keyword AND: only alpha.md has BOTH 苹果 and 香蕉.
    await focusSearchInput(evaluate, send)
    await typeTextLikeUser(send, '苹果 香蕉')
    let files = await waitFor(async () => {
      const names = await resultFiles(evaluate)
      return names.length ? names : null
    }, 'AND search returned no results', 120, async () => ({
      inputValue: await evaluate(`document.querySelector('.gsearch-input')?.value ?? null`),
      activeElement: await evaluate(`document.activeElement?.className ?? null`),
      status: await evaluate(`document.querySelector('.gsearch-status')?.textContent ?? null`),
      treeRows: await evaluate(`document.querySelectorAll('.tree-row').length`),
      session: await evaluate(`(localStorage.getItem('minimd.session.v1') || '').slice(0, 400)`),
      ipc: await evaluate(`window.api.searchWorkspace({ roots: [${JSON.stringify(root)}], query: '苹果 香蕉' }).then((r) => ({ ok: r.ok, files: r.files.map((f) => f.name), matchTotal: r.matchTotal, scanned: r.scanned }))`)
    }))
    assert.deepEqual(files, ['alpha.md'], `expected only alpha.md, got ${JSON.stringify(files)}`)
    let marks = await resultMarks(evaluate)
    assert.ok(marks.length >= 2, 'expected highlighted terms in the result lines')
    assert.ok(marks.every((text) => text === '苹果' || text === '香蕉'), `unexpected mark ${JSON.stringify(marks)}`)

    // Single keyword: alpha.md (markdown) + gamma.txt (plain text) both match.
    await evaluate(`document.querySelector('.gsearch-clear')?.click()`)
    await sleep(150)
    await focusSearchInput(evaluate, send)
    await typeTextLikeUser(send, '苹果')
    files = await waitFor(async () => {
      const names = await resultFiles(evaluate)
      return names.length === 2 ? names : null
    }, 'expected exactly two files for the single-term query')
    assert.deepEqual(files, ['alpha.md', 'gamma.txt'], `got ${JSON.stringify(files)}`)

    // Jump into the plain .txt tab: source find lands the FindBar on the match.
    await clickResultRow(evaluate, send, 'gamma.txt', 0)
    await waitFor(
      () => evaluate(`(() => {
        const title = [...document.querySelectorAll('.tab')]
          .find((node) => node.classList.contains('active'))?.textContent || ''
        const ta = [...document.querySelectorAll('textarea.source-editor')]
          .find((node) => node.offsetParent)
        return title.includes('gamma.txt') && !!ta
      })()`),
      'gamma.txt tab with source textarea did not activate'
    )
    let find = await waitFor(() => findState(evaluate), 'findbar did not open after the txt jump', 120, async () => ({
      errors: await evaluate(`window.__errs || []`),
      findbarExists: await evaluate(`!!document.querySelector('.findbar')`),
      findbarVisible: await evaluate(`(() => { const b = document.querySelector('.findbar'); return !!b && !!b.offsetParent })()`),
      activeTab: await activeTabTitle(evaluate),
      sourceVisible: await evaluate(`[...document.querySelectorAll('textarea.source-editor')].some((el) => el.offsetParent)`),
      sourceValue: await evaluate(`[...document.querySelectorAll('textarea.source-editor')].find((el) => el.offsetParent)?.value?.slice(0, 60) ?? null`)
    }))
    assert.equal(find.query, '苹果')
    assert.match(find.count, /1\s*\/\s*1/, `unexpected txt match count: ${find.count}`)

    // Jump into the rich markdown tab: FindBar highlights every occurrence.
    await evaluate(`document.querySelector('.gsearch-clear')?.click()`)
    await sleep(150)
    await focusSearchInput(evaluate, send)
    await typeTextLikeUser(send, '苹果')
    await waitFor(async () => {
      const names = await resultFiles(evaluate)
      return names.length === 2 ? names : null
    }, 'results did not come back for the second search')
    await clickResultRow(evaluate, send, 'alpha.md', 0)
    await waitFor(
      () => evaluate(`(() => {
        const title = [...document.querySelectorAll('.tab')]
          .find((node) => node.classList.contains('active'))?.textContent || ''
        return title.includes('alpha.md') && !!document.querySelector('.ProseMirror')
      })()`),
      'alpha.md rich tab did not activate'
    )
    find = await waitFor(async () => {
      const state = await findState(evaluate)
      return state && /\d+\s*\/\s*3/.test(state.count) ? state : null
    }, 'rich findbar did not highlight all 3 matches')
    assert.equal(find.query, '苹果')

    console.log('\nglobal-search UI: all checks passed')
  } finally {
    await stopBuiltElectron(app)
  }
} catch (err) {
  failure = err
  console.error('\nglobal-search UI FAILED:')
  console.error(err)
} finally {
  await rm(root, { recursive: true, force: true })
}
process.exit(failure ? 1 : 0)
