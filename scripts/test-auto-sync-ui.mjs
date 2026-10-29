// Automatic sync (无感同步: Settings › Sync › 自动同步, hooks/useAutoSync.js)
// in the real app against a local S3 server. A round of every folder
// (globalThis.__hmAutoSyncTick) or what a save triggers
// (globalThis.__hmAutoSyncSaved(path)) is run directly instead of waiting:
// - on by default (5 min fallback); the status bar shows the cloud item;
// - nothing changed → "已是最新", no write request reaches the cloud;
// - edited + new files → uploaded, "上传 2"; a save → its folder syncs;
// - a local deletion runs automatically ("删除 1");
// - a mass deletion pauses: cloud untouched, a warning line + ONE toast,
//   status bar 需要确认; the user's「双向同步」confirm runs it;
// - a cloud error → "同步失败" line, ONE toast per error streak, status bar
//   同步出错;
// - the interval persists across a restart; the switch stops the timers.
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const tempBase = process.platform === 'darwin' ? homedir() : tmpdir()
const root = await realpath(await mkdtemp(join(tempBase, '.horsemd-auto-sync-ui-')))
const notes = join(root, 'notes')
const profileDir = join(root, 'profile')

let fail = false
let writes = 0
const store = new Map()
const etags = new Map()
let etagCounter = 0
const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const url = new URL(req.url, 'http://x')
    const key = decodeURIComponent(url.pathname)
    if (fail) { res.writeHead(500, { 'content-type': 'application/xml' }); return res.end('<Error><Code>InternalError</Code></Error>') }
    if (req.method === 'PUT') {
      writes += 1
      const source = req.headers['x-amz-copy-source']
      if (source) {
        const from = decodeURIComponent(source)
        if (!store.has(from)) { res.writeHead(404); return res.end('<Error><Code>NoSuchKey</Code></Error>') }
        store.set(key, store.get(from))
        etags.set(key, etags.get(from))
        res.writeHead(200, { 'content-type': 'application/xml' })
        return res.end(`<CopyObjectResult><ETag>"${etags.get(key)}"</ETag></CopyObjectResult>`)
      }
      if (req.headers['if-none-match'] === '*' && store.has(key)) { res.writeHead(412); return res.end() }
      if (req.headers['if-match'] && req.headers['if-match'] !== `"${etags.get(key)}"`) { res.writeHead(412); return res.end() }
      store.set(key, Buffer.concat(chunks))
      etags.set(key, String(++etagCounter))
      res.writeHead(200, { etag: `"${etags.get(key)}"` })
      return res.end()
    }
    if (req.method === 'GET') {
      if (url.searchParams.get('list-type') === '2') {
        res.writeHead(200, { 'content-type': 'application/xml' })
        return res.end('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>')
      }
      if (!store.has(key)) { res.writeHead(404, { 'content-type': 'application/xml' }); return res.end('<Error><Code>NoSuchKey</Code></Error>') }
      res.writeHead(200, { etag: `"${etags.get(key)}"`, 'content-type': 'application/octet-stream' })
      return res.end(store.get(key))
    }
    if (req.method === 'DELETE') { writes += 1; store.delete(key) }
    res.writeHead(204); res.end()
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const endpoint = `http://127.0.0.1:${server.address().port}`
const cloudNotes = () => [...store.keys()].filter((key) => key.endsWith('.md') && !key.includes('/.horsemd/')).map((key) => key.split('/').pop()).sort()

let app = null
const launch = (cleanProfile = true) => launchBuiltElectron({ profileDir, port: 9473, cleanProfile, appArgs: [notes, '--horsemd-input-trace'] })
const openSync = () => app.evaluate(`(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const visible = (element) => element && element.getBoundingClientRect().width > 0
  if (!document.querySelector('.sync-auto-row')) {
    const settings = [...document.querySelectorAll('button')].filter(visible).find((button) => /settings|设置/i.test(button.title || button.textContent || ''))
    settings.click()
    await sleep(400)
    ;[...document.querySelectorAll('.settings-nav-item')].filter(visible).find((button) => /cloud sync|云同步/i.test(button.textContent || '')).click()
  }
  for (let i = 0; i < 40 && !document.querySelector('.sync-auto-row'); i += 1) await sleep(100)
  return !!document.querySelector('.sync-auto-row')
})()`)
const ui = () => app.evaluate(`({
  line: document.querySelector('.sync-auto-line')?.textContent || '',
  warn: !!document.querySelector('.sync-auto-line.warn'),
  active: document.querySelector('.sync-auto-row .settings-segmented-option.active')?.textContent || '',
  state: document.querySelector('.sync-auto-state')?.textContent || '',
  on: document.querySelector('.sync-auto .hm-toggle')?.getAttribute('aria-checked') === 'true',
  status: document.querySelector('.hm-sync-status')?.textContent || '',
  // Every toast fired (fireToast → 'hm:toast'); the page shows one at a time.
  toasts: (globalThis.__testToasts || []).slice(),
  tick: typeof globalThis.__hmAutoSyncTick === 'function'
})`)
const tick = () => app.evaluate('globalThis.__hmAutoSyncTick()')
// HM_AUTO_SYNC_SHOT=<dir>: PNGs of the settings block and the status bar.
const shot = async (name) => {
  if (!process.env.HM_AUTO_SYNC_SHOT) return
  await new Promise((resolve) => setTimeout(resolve, 400))
  const image = await app.send('Page.captureScreenshot', { format: 'png' })
  const { writeFile } = await import('node:fs/promises')
  await writeFile(join(process.env.HM_AUTO_SYNC_SHOT, `${name}.png`), Buffer.from(image.data ?? image.result?.data ?? '', 'base64'))
}
const saved = (path) => app.evaluate(`globalThis.__hmAutoSyncSaved(${JSON.stringify(path)})`)
const twoWaySync = () => app.evaluate(`(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  ;[...document.querySelectorAll('.sync-icon-btn')].find((button) => /Two-way sync|双向同步/.test(button.title)).click()
  for (let i = 0; i < 40 && !document.querySelector('.sync-plan-preview .settings-action-btn'); i += 1) await sleep(100)
  const confirm = document.querySelector('.sync-plan-preview .settings-action-btn')
  const note = document.querySelector('.sync-plan-preview-note')?.textContent || ''
  confirm?.click()
  for (let i = 0; i < 80 && !/同步完成|Sync complete/.test(document.querySelector('.sync-notice')?.textContent || ''); i += 1) await sleep(100)
  return { confirmed: !!confirm, note }
})()`)
const toastCount = (state, re) => state.toasts.filter((t) => re.test(t)).length
const recordToasts = () => app.evaluate(`(() => {
  if (globalThis.__testToasts) return
  globalThis.__testToasts = []
  window.addEventListener('hm:toast', (e) => globalThis.__testToasts.push(typeof e.detail === 'string' ? e.detail : e.detail?.msg || ''))
})()`)
const waitFor = async (check, message, ms = 15000) => {
  const started = Date.now()
  let state = null
  while (Date.now() - started < ms) {
    state = await ui()
    if (check(state)) return state
    await sleep(150)
  }
  throw new Error(`${message}: ${JSON.stringify(state)}`)
}

try {
  await mkdir(notes, { recursive: true })
  for (let i = 0; i < 3; i += 1) await writeFile(join(notes, `note-${i}.md`), `# ${i}\n`)
  app = await launch()
  await recordToasts()
  await app.evaluate(`window.api.syncAddS3Connection({ name: '测试云', endpoint: ${JSON.stringify(endpoint)}, bucket: 'b', region: 'us-east-1', accessKeyId: 'k', secretAccessKey: 's', allowInsecure: true })`)
  assert.ok(await openSync(), 'sync settings did not open')
  // 开启同步 → connection → 连接并继续 → first upload confirmed.
  await app.evaluate(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    ;[...document.querySelectorAll('.sync-folder-row button')].find((button) => /enable sync|开启同步/i.test(button.textContent || ''))?.click()
    await sleep(800)
    const select = document.querySelector('.sync-workspace-item select')
    select.value = select.options[select.options.length - 1].value
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await sleep(200)
    ;[...document.querySelectorAll('.sync-workspace-item button')].find((button) => /连接并继续|Connect and continue/i.test(button.textContent || '')).click()
    for (let i = 0; i < 40 && !document.querySelector('.sync-workspace-item .settings-action-btn'); i += 1) await sleep(100)
    ;[...document.querySelectorAll('.sync-workspace-item .settings-action-btn')].at(-1).click()
    for (let i = 0; i < 80 && !/同步完成|Sync complete/.test(document.querySelector('.sync-notice')?.textContent || ''); i += 1) await sleep(100)
  })()`)
  assert.deepEqual(cloudNotes(), ['note-0.md', 'note-1.md', 'note-2.md'], 'first sync uploaded the notes')

  // On by default (5 min fallback).
  const on = await waitFor((s) => s.tick && s.on, 'auto sync is not on by default')
  assert.match(on.active, /5/)
  assert.match(on.state, /每 5 分钟检查 1 个文件夹 · 下次约 \d{2}:\d{2}|Checking 1 folder\(s\) every 5 min/, `state line: ${on.state}`)
  await waitFor((s) => /已同步 \d{2}:\d{2}|Synced \d{2}:\d{2}/.test(s.status), 'status bar shows the manual sync')
  await app.evaluate(`[...document.querySelectorAll('h2, h3, .settings-heading-row')].find((n) => /自动同步/.test(n.textContent))?.scrollIntoView({ block: 'center' })`)
  await shot('auto-sync-settings')

  // 1. Nothing changed.
  const before = writes
  await tick()
  const idle = await waitFor((s) => /已是最新|up to date/.test(s.line), 'no idle line')
  assert.equal(writes, before, 'an idle automatic sync writes nothing')
  assert.equal(idle.warn, false)

  // 2. Edited + new files are uploaded; a save syncs its folder.
  await writeFile(join(notes, 'note-0.md'), '# 0 edited\n')
  await writeFile(join(notes, 'new.md'), '# new\n')
  await tick()
  await waitFor((s) => /上传 2|uploaded 2/.test(s.line), 'edits were not uploaded')
  assert.equal(String(store.get([...store.keys()].find((key) => key.endsWith('/note-0.md')))), '# 0 edited\n')
  assert.ok(cloudNotes().includes('new.md'))
  await writeFile(join(notes, 'note-0.md'), '# 0 saved\n')
  await saved(join(notes, 'note-0.md'))
  await waitFor((s) => /上传 1|uploaded 1/.test(s.line), 'a save did not sync its folder')
  assert.equal(String(store.get([...store.keys()].find((key) => key.endsWith('/note-0.md')))), '# 0 saved\n')

  // 3. A local deletion runs on its own.
  await rm(join(notes, 'note-1.md'))
  await tick()
  await waitFor((s) => /删除 1|deleted 1/.test(s.line), 'deletion did not sync')
  assert.ok(!cloudNotes().includes('note-1.md'), 'cloud file deleted')

  // 4. A mass deletion pauses until the user confirms it.
  for (let i = 0; i < 12; i += 1) await writeFile(join(notes, `bulk-${i}.md`), `# bulk ${i}\n`)
  await tick()
  await waitFor((s) => /上传 12|uploaded 12/.test(s.line), 'bulk files not uploaded')
  for (let i = 0; i < 12; i += 1) await rm(join(notes, `bulk-${i}.md`))
  await tick()
  const paused = await waitFor((s) => /暂停：这次要删除 12 个文件|would delete 12 files/.test(s.line), 'mass deletion did not pause')
  assert.equal(paused.warn, true)
  assert.ok(cloudNotes().includes('bulk-0.md'), 'cloud files not deleted unattended')
  assert.equal(toastCount(paused, /自动同步已暂停|is paused/), 1, `one toast: ${JSON.stringify(paused.toasts)}`)
  assert.match(paused.status, /需要确认|Needs review/)
  await shot('auto-sync-paused')
  await tick()
  await sleep(500)
  assert.equal(toastCount(await ui(), /自动同步已暂停|is paused/), 1, 'the same situation is not toasted again')
  const confirmed = await twoWaySync()
  assert.ok(confirmed.confirmed, 'two-way sync asked before a mass deletion')
  assert.match(confirmed.note, /删除 12 个文件|delete 12 files/)
  assert.ok(!cloudNotes().some((name) => name.startsWith('bulk-')), 'confirmed deletion ran')
  await tick()
  await waitFor((s) => /已是最新|up to date/.test(s.line), 'not idle after the confirmed sync')

  // 5. Cloud errors: one toast per streak, the status bar shows it.
  fail = true
  await writeFile(join(notes, 'note-2.md'), '# 2 edited\n')
  await tick()
  const failed = await waitFor((s) => /同步失败|Sync failed/.test(s.line), 'no failure line')
  assert.equal(failed.warn, true)
  assert.match(failed.status, /同步出错|Sync error/)
  assert.ok(!/Error invoking remote method/.test(failed.line))
  await tick()
  await sleep(500)
  const failedToast = /自动同步失败|Auto sync of .* failed/
  assert.equal(toastCount(await ui(), failedToast), 1, 'one failure toast per streak')
  fail = false
  await tick()
  const recovered = await waitFor((s) => /上传 1|uploaded 1/.test(s.line), 'retry after the error did not upload')
  assert.match(recovered.status, /已同步|Synced/)
  fail = true
  await writeFile(join(notes, 'note-2.md'), '# 2 again\n')
  await tick()
  await waitFor((s) => toastCount(s, failedToast) === 2, 'a new error streak toasts again')
  fail = false
  await tick()
  await waitFor((s) => /上传 1|uploaded 1/.test(s.line), 'second recovery did not upload')

  // 6. The interval persists across a restart; the switch stops the timers.
  await app.evaluate(`[...document.querySelectorAll('.sync-auto-row .settings-segmented-option')].find((b) => /^15/.test(b.textContent)).click()`)
  await waitFor((s) => /15/.test(s.active), '15 min not chosen')
  // Windows: Chromium writes the safeStorage key into "Local State" 10–25 s
  // after a fresh profile starts; the test stops the app by terminating it,
  // so it waits for that write — or the restart makes a new key and the
  // saved credentials no longer decrypt (a real app quits normally).
  if (process.platform === 'win32') {
    const { readFile } = await import('node:fs/promises')
    for (let i = 0; i < 60; i += 1) {
      const state = await readFile(join(profileDir, 'Local State'), 'utf8').catch(() => '')
      if (state.includes('encrypted_key')) break
      await sleep(500)
    }
  }
  await stopBuiltElectron(app, { removeProfile: false })
  app = await launch(false)
  await recordToasts()
  await sleep(1500)
  assert.ok(await openSync())
  // Waits for the interval control to render with the saved value.
  await waitFor((s) => s.tick && s.on && /15/.test(s.active), '15 min not kept after a restart (or the timer is not running)')
  await app.evaluate(`document.querySelector('.sync-auto .hm-toggle').click()`)
  const off = await waitFor((s) => !s.tick && !s.on, 'the switch did not stop auto sync')
  assert.match(off.status, /自动同步已关闭|Auto sync off/)
  const toast = (await ui()).toasts.join(' | ')
  assert.ok(!/不一致|mismatch/i.test(toast), `unexpected toast: ${toast}`)
  console.log('PASS auto sync UI: on by default, idle writes nothing, edits / saves / deletions sync, mass deletion pauses (one toast), one toast per error streak, status bar, setting persists')
} finally {
  if (app) await stopBuiltElectron(app)
  server.close()
  await rm(root, { recursive: true, force: true })
}
