// E2E (P7): the serializer mirrors the authored list style, so an authored
// compact `-` document keeps canonical === source and edits inside its lists
// publish through the exact/aligned paths with zero warnings. Reproduces the
// trace-62194 05:35:09 gesture (deleting the bold label chars of a `- **分类**：`
// row) and the trace-48689 join (Backspace merging a row into the one above).
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-serializer-style-${process.pid}`
const port = Number(process.env.CDP_PORT || 15975 + (process.pid % 20))

const waitFor = async (check, message, attempts = 200) => {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}
const visibleEditor = () => `(() => [...document.querySelectorAll('.ProseMirror')]
  .find((node) => node.offsetParent))()`

const fixture = [
  '# 文献汇总', '',
  '前文段落，用于制造非列表上下文。', '',
  '- **分类**：模拟藤壶甲壳素中的阳离子与疏水协同；不含藤壶蛋白。',
  '- **核心原料与来源**：壳聚糖 CTS、AA、AM，均为可采购化学试剂。',
  '- **关键制备**：水相含 30 wt% AA；微粒与硅油按 1:1 混成膏。',
  '- **用途与证据**：大鼠肝脏模型；15 s 内形成封合。', '',
  '### 下一节', '',
  '1. 第一步', '2. 第二步', '',
  '结尾段落。', ''
].join('\n')

const scrollTargetIntoView = (app, matcher) => app.evaluate(`(() => {
  const editor = ${visibleEditor()}
  const items = [...(editor?.querySelectorAll('li') || [])]
  const target = items.find((node) => ${matcher}.test(node.textContent || ''))
  target?.scrollIntoView({ block: 'center' })
  return !!target
})()`)

const clickListItemTextStart = async (app, matcher) => {
  await scrollTargetIntoView(app, matcher)
  await sleep(400)
  const point = await waitFor(() => app.evaluate(`(() => {
    const editor = ${visibleEditor()}
    const items = [...(editor?.querySelectorAll('li') || [])].filter((n) => n.offsetParent)
    const target = items.find((node) => ${matcher}.test(node.textContent || ''))
    const para = target?.querySelector('p')
    const rect = para?.getBoundingClientRect()
    if (!rect || rect.top < 0 || rect.bottom > innerHeight) return null
    return { x: rect.left + 2, y: (rect.top + rect.bottom) / 2 }
  })()`), 'list item not clickable in viewport')
  await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(200)
}

const pressBackspace = async (app, times = 1) => {
  for (let index = 0; index < times; index += 1) {
    await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace' })
    await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace' })
    await sleep(180)
  }
  await sleep(1200)
}

const collect = (app) => app.evaluate(`(() => ({
  toasts: [...document.querySelectorAll('[class*="toast"]')]
    .filter((node) => node.offsetParent).map((node) => node.textContent || ''),
  bad: (window.__hmSourceIntegrityTrace || []).filter(e => e && e.ok === false)
    .slice(-4).map(e => ({ reason: e.preservationReason, site: e.validationSite })),
  preserve: (window.__hmPreserveLog || []).slice(-5).map(e => e.reason),
  coordinator: (window.__hmSourceSyncCoordinatorTrace || []).slice(-5)
    .map(e => ({ phase: e.phase, reason: e.reason }))
}))()`)

const main = async () => {
  await rm(root, { recursive: true, force: true })
  const dir = join(root, 'd')
  const profileDir = join(dir, 'p')
  const file = join(dir, 'doc.md')
  await mkdir(profileDir, { recursive: true })
  await writeFile(file, fixture, 'utf8')

  const app = await launchBuiltElectron({ profileDir, port, appArgs: [file, '--horsemd-input-trace'] })
  try {
    await waitFor(() => app.evaluate(`Boolean(${visibleEditor()})`), 'editor did not mount')
    await sleep(1000)

    // Case 1 — row-start Backspace joins the first list row into the preceding
    // paragraph (trace-62194 family). Under the old serializer this document
    // was permanently diverged (authored `-` compact vs canonical `*` padded);
    // with the style-aware serializer it must publish warning-free.
    await clickListItemTextStart(app, /分类/)
    await app.evaluate(`(() => {
      window.__hmPreserveLog = []
      window.__hmSourceIntegrityTrace = []
      window.__hmSourceSyncCoordinatorTrace = []
      document.querySelectorAll('[class*="toast"]').forEach((n) => n.remove())
      return true
    })()`)
    await pressBackspace(app, 1)
    let dump = await collect(app)
    if ((dump.toasts || []).some((t) => String(t).includes('不一致'))) {
      throw new Error(`case1 warnings: ${JSON.stringify(dump.toasts)}`)
    }
    if ((dump.bad || []).length) throw new Error(`case1 integrity: ${JSON.stringify(dump.bad)}`)
    if (!(dump.preserve || []).length) throw new Error('case1: nothing published')

    // Case 2 — trace-48689 shape: backspace at the start of 用途与证据 merges
    // it into the 关键制备 item (two paragraphs in one item).
    await clickListItemTextStart(app, /用途与证据/)
    await pressBackspace(app, 1)
    dump = await collect(app)
    if ((dump.toasts || []).some((t) => String(t).includes('不一致'))) {
      throw new Error(`case2 warnings: ${JSON.stringify(dump.toasts)}`)
    }
    if ((dump.bad || []).length) throw new Error(`case2 integrity: ${JSON.stringify(dump.bad)}`)

    // Save via FAB; disk keeps the authored compact `-` spelling and the merged
    // item carries the blank line + indent continuation.
    await waitFor(() => app.evaluate('Boolean(document.querySelector(\'.hm-save-fab\'))'), 'save FAB missing')
    await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not complete')
    await sleep(300)
    const disk = await readFile(file, 'utf8')
    // Case 1 lifted the 分类 row out of the list (join or standalone
    // paragraph depending on the keymap's pick) — its content must survive
    // outside the list, and the remaining rows keep the authored compact `-`.
    if (!/\*\*分类\*\*：模拟藤壶甲壳素/.test(disk)) {
      throw new Error(`case1 content lost: ${JSON.stringify(disk.slice(0, 200))}`)
    }
    if (/- \*\*分类\*\*/.test(disk)) {
      throw new Error('case1: the lifted row must leave the list')
    }
    if (!/- \*\*关键制备\*\*：水相含 30 wt% AA；微粒与硅油按 1:1 混成膏。\n\n  \*\*用途与证据\*\*：大鼠肝脏模型；15 s 内形成封合。/.test(disk)) {
      throw new Error(`disk join shape wrong: ${JSON.stringify(disk)}`)
    }
    if (/^\* /m.test(disk)) throw new Error('canonical bullet * leaked into authored source')

    await rm(root, { recursive: true, force: true })
    console.log('PASS serializer style follow-doc UI: authored compact `-` document keeps canonical === source through bold-label deletes and item joins, zero warnings, disk bytes authored')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

main().catch(async (error) => {
  console.error(error.message || error)
  await rm(root, { recursive: true, force: true })
  process.exit(1)
})
