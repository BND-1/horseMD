// Automatic sync (Settings › Sync › 自动同步, hooks/useAutoSync.js) in the real
// app against a local S3 server. A tick (globalThis.__hmAutoSyncTick, the
// interval's callback) is run directly instead of waiting minutes:
// - nothing changed → "已是最新", no write request reaches the cloud;
// - edited + new files → uploaded, "上传 2";
// - a local deletion → not run: cloud untouched, a warning line + ONE toast
//   (a second tick does not repeat it); the user's「双向同步」confirm runs it;
// - a cloud error → "自动同步失败" line + toast;
// - the interval persists across a restart; 关闭 stops the timer.
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
  // Every toast fired (fireToast → 'hm:toast'); the page shows one at a time.
  toasts: (globalThis.__testToasts || []).slice(),
  tick: typeof globalThis.__hmAutoSyncTick === 'function'
})`)
const tick = () => app.evaluate('globalThis.__hmAutoSyncTick()')
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

  // Off by default: no timer.
  assert.equal((await ui()).tick, false, 'auto sync is off by default')
  assert.match((await ui()).active, /关闭|Off/)
  await app.evaluate(`[...document.querySelectorAll('.sync-auto-row .settings-segmented-option')].find((b) => /^5/.test(b.textContent)).click()`)
  const on = await waitFor((s) => s.tick, 'choosing 5 min did not start the timer')
  assert.match(on.active, /5/)
  assert.match(on.state, /每 5 分钟同步 1 个文件夹 · 下次约 \d{2}:\d{2}|Syncing 1 folder\(s\) every 5 min/, `state line: ${on.state}`)

  // 1. Nothing changed.
  const before = writes
  await tick()
  const idle = await waitFor((s) => /已是最新|up to date/.test(s.line), 'no idle line')
  assert.equal(writes, before, 'an idle automatic sync writes nothing')
  assert.equal(idle.warn, false)

  // 2. Edited + new files are uploaded.
  await writeFile(join(notes, 'note-0.md'), '# 0 edited\n')
  await writeFile(join(notes, 'new.md'), '# new\n')
  await tick()
  await waitFor((s) => /上传 2|uploaded 2/.test(s.line), 'edits were not uploaded')
  assert.equal(String(store.get([...store.keys()].find((key) => key.endsWith('/note-0.md')))), '# 0 edited\n')
  assert.ok(cloudNotes().includes('new.md'))

  // 3. A local deletion waits for confirmation.
  await rm(join(notes, 'note-1.md'))
  await tick()
  const confirm = await waitFor((s) => /需要你确认|need your confirmation/.test(s.line), 'deletion was not held back')
  assert.equal(confirm.warn, true)
  assert.ok(!/\b0 项|\b0 (deletion|conflict)/.test(confirm.line), `zero counts are not listed: ${confirm.line}`)
  assert.ok(cloudNotes().includes('note-1.md'), 'cloud file not deleted unattended')
  const confirmToasts = confirm.toasts.filter((t) => /自动同步在等你确认|is waiting/.test(t))
  assert.equal(confirmToasts.length, 1, `one toast: ${JSON.stringify(confirm.toasts)}`)
  await tick()
  await sleep(500)
  assert.equal((await ui()).toasts.filter((t) => /自动同步在等你确认|is waiting/.test(t)).length, 1, 'the same situation is not toasted again')
  // The user confirms through「双向同步」.
  await app.evaluate(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    ;[...document.querySelectorAll('.sync-icon-btn')].find((button) => /Two-way sync|双向同步/.test(button.title)).click()
    for (let i = 0; i < 40 && !document.querySelector('.sync-plan-preview .settings-action-btn'); i += 1) await sleep(100)
    document.querySelector('.sync-plan-preview .settings-action-btn').click()
    for (let i = 0; i < 80 && !/同步完成|Sync complete/.test(document.querySelector('.sync-notice')?.textContent || ''); i += 1) await sleep(100)
  })()`)
  assert.ok(!cloudNotes().includes('note-1.md'), 'confirmed deletion ran')
  await tick()
  await waitFor((s) => /已是最新|up to date/.test(s.line), 'not idle after the confirmed sync')

  // 4. A cloud error.
  fail = true
  await writeFile(join(notes, 'note-2.md'), '# 2 edited\n')
  await tick()
  const failed = await waitFor((s) => /自动同步失败|Auto sync failed/.test(s.line), 'no failure line')
  assert.equal(failed.warn, true)
  assert.ok(failed.toasts.some((t) => /自动同步失败|Auto sync of .* failed/.test(t)), 'failure toast')
  assert.ok(!/Error invoking remote method/.test(failed.line))
  fail = false
  await tick()
  await waitFor((s) => /上传 1|uploaded 1/.test(s.line), 'retry after the error did not upload')

  // 5. Persists across a restart; 关闭 stops the timer.
  await stopBuiltElectron(app, { removeProfile: false })
  app = await launch(false)
  await recordToasts()
  await sleep(1500)
  assert.ok(await openSync())
  const restarted = await waitFor((s) => s.tick, 'timer not running after restart')
  assert.match(restarted.active, /5/)
  await app.evaluate(`[...document.querySelectorAll('.sync-auto-row .settings-segmented-option')].find((b) => /关闭|Off/.test(b.textContent)).click()`)
  await waitFor((s) => !s.tick && /关闭|Off/.test(s.active), '关闭 did not stop the timer')
  const toast = (await ui()).toasts.join(' | ')
  assert.ok(!/不一致|mismatch/i.test(toast), `unexpected toast: ${toast}`)
  console.log('PASS auto sync UI: idle writes nothing, edits uploaded, deletion waits for confirmation (one toast), errors shown, setting persists')
} finally {
  if (app) await stopBuiltElectron(app)
  server.close()
  await rm(root, { recursive: true, force: true })
}
