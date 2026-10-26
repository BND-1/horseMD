// A closed tab must release its editor. Each of these kept every closed
// tab's whole editor (ProseMirror view, DOM, documents, caches) alive, so a
// day of opening and closing files doubled the app's memory on Windows:
//   - the perf-diagnostics registry (__hmIncrementalSerializeAll) never
//     dropped an editor's entry;
//   - the incremental serializer's idle work ran after destroy, Milkdown's
//     paragraph rule threw "editorView not found", and the uncaught error
//     (kept by the console) held the editor;
//   - the source-map block cache, the Mermaid preview translator and the
//     app-wide inline-math listeners held one editor's remark / getT.
// Opens five large documents (above the incremental serializer's 64-block
// threshold, so its idle bootstrap is pending when the tab closes), closes
// them, and counts live Crepe instances in a heap snapshot. Milkdown's own
// $command objects remember the most recently created editor, so one closed
// editor may remain — never more.
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = await mkdtemp(join(tmpdir(), 'horsemd-closed-tab-memory-'))
const keep = join(root, 'keep.md')
await writeFile(keep, '# 保留的文档\n\n一段正文。\n\n$$\nx^2\n$$\n\n```mermaid\ngraph TD\n  A --> B\n```\n')
const others = []
for (let k = 1; k <= 5; k += 1) {
  const lines = [`# 文档 ${k}`, '']
  for (let i = 1; i <= 120; i += 1) {
    lines.push(`第 ${i} 段，含 **加粗** 和 \`code\`。`, '')
    if (i % 30 === 0) lines.push('```js', `const v${i} = ${i}`, '```', '')
  }
  const file = join(root, `doc${k}.md`)
  await writeFile(file, lines.join('\n'))
  others.push(file)
}

const port = 29700 + process.pid % 100
const app = await launchBuiltElectron({
  profileDir: join(root, 'profile'), port, appArgs: [keep, ...others, '--horsemd-input-trace']
})
const waitFor = async (check, message, attempts = 100) => {
  for (let i = 0; i < attempts; i += 1) { const value = await check(); if (value) return value; await sleep(100) }
  throw new Error(message)
}
const tabTitles = () => app.evaluate(`[...document.querySelectorAll('.tab .tab-title')].map((t) => t.textContent)`)

async function countCrepe() {
  await app.send('HeapProfiler.enable')
  await app.send('HeapProfiler.collectGarbage')
  await sleep(500)
  await app.send('HeapProfiler.collectGarbage')
  const chunks = []
  const onMessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.method === 'HeapProfiler.addHeapSnapshotChunk') chunks.push(message.params.chunk)
  }
  app.ws.addEventListener('message', onMessage)
  await app.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false })
  await sleep(300)
  app.ws.removeEventListener('message', onMessage)
  const snap = JSON.parse(chunks.join(''))
  const fields = snap.snapshot.meta.node_fields
  const types = snap.snapshot.meta.node_types[0]
  const width = fields.length, iType = fields.indexOf('type'), iName = fields.indexOf('name')
  let count = 0
  for (let i = 0; i < snap.nodes.length; i += width) {
    if (types[snap.nodes[i + iType]] === 'object' && snap.strings[snap.nodes[i + iName]] === 'Crepe') count += 1
  }
  return count
}

try {
  await waitFor(async () => (await tabTitles()).filter((t) => /doc\d|keep/.test(t)).length >= 6, 'six tabs did not open')
  const activate = (name) => app.evaluate(`(() => {
    const tab = [...document.querySelectorAll('.tab')].find((t) => t.querySelector('.tab-title').textContent.includes(${JSON.stringify(name)}))
    tab?.click(); return !!tab
  })()`)
  const close = (name) => app.evaluate(`(() => {
    const tab = [...document.querySelectorAll('.tab')].find((t) => t.querySelector('.tab-title').textContent.includes(${JSON.stringify(name)}))
    tab?.querySelector('.tab-close')?.click(); return !!tab
  })()`)
  const visibleEditorHas = (needle) => app.evaluate(`[...document.querySelectorAll('.ProseMirror')].find((e) => e.offsetParent)?.textContent.includes(${JSON.stringify(needle)}) === true`)

  await activate('keep')
  await waitFor(() => visibleEditorHas('保留的文档'), 'keep.md did not render')
  const baseline = await countCrepe()

  // Mount every document, then close it — the last ones right after their
  // first render, while the serializer's idle bootstrap is still pending.
  for (let k = 1; k <= 5; k += 1) {
    await activate(`doc${k}`)
    await waitFor(() => visibleEditorHas(`文档 ${k}`), `doc${k} did not render`)
    await sleep(k <= 2 ? 1500 : 150)
    await close(`doc${k}`)
    await sleep(300)
  }
  await waitFor(async () => (await tabTitles()).every((t) => !/doc\d/.test(t)), 'documents did not close')
  await activate('keep')
  await sleep(2500)

  const registry = await app.evaluate('(globalThis.__hmIncrementalSerializeAll || []).length')
  // Editors still open (a fresh profile also shows the welcome document).
  const mounted = await app.evaluate(`document.querySelectorAll('.ProseMirror[data-horsemd-ready]').length`)
  assert.equal(registry, mounted, `diagnostics registry keeps closed editors: ${registry} entries for ${mounted} open editors`)
  const harnessLive = await app.evaluate(`(() => { const h = globalThis.__hmSourceReprintHarness; return !h || (typeof h.liveDoc === 'function' && !!h.liveDoc()) })()`)
  assert.ok(harnessLive, 'trace harness points at a destroyed editor')

  const after = await countCrepe()
  console.log(`Crepe instances: baseline ${baseline}, after closing 5 tabs ${after} (mounted editors ${mounted})`)
  assert.ok(after <= baseline + 1, `closed tabs keep their editors: ${after} Crepe instances (baseline ${baseline})`)

  const toast = await app.evaluate(`[...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | ')`)
  assert.ok(!/不一致|mismatch/i.test(toast), `unexpected toast: ${toast}`)
  console.log('closed-tab memory: PASS')
} finally {
  await stopBuiltElectron(app, { removeProfile: true })
}
