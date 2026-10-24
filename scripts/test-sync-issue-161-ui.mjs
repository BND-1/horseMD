// Issue #161 (七牛云 S3): after 「开始双向同步」 in the plan preview the page
// showed 「这个文件夹正在同步」. A sync that does not finish (here: an upload
// the service never answers) kept the folder locked, the confirm button
// stayed clickable, and the refused second click cleared the page's
// "syncing" state while the first sync still ran. Now:
// - the confirm button is disabled and reads 「正在同步」 while it runs;
// - a request with no answer fails after the timeout with a readable error
//   (no "Error invoking remote method" prefix) and releases the folder;
// - a retry then completes;
// - a reloaded page still shows a sync that is running.
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const tempBase = process.platform === 'darwin' ? homedir() : tmpdir()
const root = await realpath(await mkdtemp(join(tempBase, '.horsemd-sync-161-ui-')))
const notes = join(root, 'notes')

let hang = false
let putDelay = 0
const store = new Map()
const etags = new Map()
let etagCounter = 0
const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', async () => {
    const url = new URL(req.url, 'http://x')
    const key = decodeURIComponent(url.pathname)
    if (req.method === 'PUT') {
      if (hang && /\.md$/.test(key)) return // never answers
      if (putDelay) await sleep(putDelay)
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
      if (!store.has(key)) { res.writeHead(404); return res.end('<Error><Code>NoSuchKey</Code></Error>') }
      res.writeHead(200, { etag: `"${etags.get(key)}"` })
      return res.end(store.get(key))
    }
    if (req.method === 'DELETE') store.delete(key)
    res.writeHead(204); res.end()
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

let app = null
const ui = () => app.evaluate(`(() => {
  const confirm = [...document.querySelectorAll('.sync-workspace-item .settings-action-btn')].at(-1)
  return {
    confirmText: confirm?.textContent || '',
    confirmDisabled: confirm ? confirm.disabled : null,
    syncing: !!document.querySelector('.sync-state-icon.syncing'),
    progress: document.querySelector('.sync-progress-line')?.textContent || '',
    error: document.querySelector('.settings-error, .sync-error')?.textContent || '',
    notice: document.querySelector('.settings-notice, .sync-notice')?.textContent || ''
  }
})()`)
const waitUi = async (check, message, ms = 30000) => {
  const started = Date.now()
  let state = null
  while (Date.now() - started < ms) {
    state = await ui()
    if (check(state)) return state
    await sleep(150)
  }
  throw new Error(`${message}: ${JSON.stringify(state)}`)
}
const openSync = () => app.evaluate(`(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const visible = (element) => element && element.getBoundingClientRect().width > 0
  const settings = [...document.querySelectorAll('button')].filter(visible).find((button) => /settings|设置/i.test(button.title || button.textContent || ''))
  settings.click()
  await sleep(400)
  ;[...document.querySelectorAll('.settings-nav-item')].filter(visible).find((button) => /cloud sync|云同步/i.test(button.textContent || '')).click()
  await sleep(600)
})()`)

try {
  await mkdir(notes, { recursive: true })
  for (let i = 0; i < 3; i += 1) await writeFile(join(notes, `note-${i}.md`), `# ${i}\n`)
  app = await launchBuiltElectron({
    profileDir: join(root, 'profile'),
    port: 9472,
    appArgs: [notes],
    env: { ...process.env, HORSEMD_TEST_SYNC_REQUEST_TIMEOUT_MS: '3000' }
  })
  const endpoint = `http://127.0.0.1:${server.address().port}`
  await app.evaluate(`window.api.syncAddS3Connection({ name: '七牛', endpoint: ${JSON.stringify(endpoint)}, bucket: 'b', region: 'us-east-1', accessKeyId: 'k', secretAccessKey: 's', allowInsecure: true })`)
  await openSync()
  // 开启同步 → connection → 连接并继续 → plan preview (first upload).
  await app.evaluate(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    ;[...document.querySelectorAll('.sync-folder-row button')].find((button) => /enable sync|开启同步/i.test(button.textContent || ''))?.click()
    await sleep(800)
    const select = document.querySelector('.sync-workspace-item select')
    if (select && !select.value) {
      select.value = select.options[select.options.length - 1].value
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await sleep(200)
    }
    ;[...document.querySelectorAll('.sync-workspace-item button')].find((button) => /连接并继续|Connect and continue/i.test(button.textContent || '')).click()
    for (let i = 0; i < 40 && !document.querySelector('.sync-workspace-item .settings-action-btn'); i += 1) await sleep(100)
  })()`)

  // 1. The upload never gets an answer.
  hang = true
  await app.evaluate(`[...document.querySelectorAll('.sync-workspace-item .settings-action-btn')].at(-1).click()`)
  const running = await waitUi((s) => s.syncing, 'sync did not start')
  console.log('running', running)
  assert.equal(running.confirmDisabled, true, 'confirm is disabled while the sync runs')
  assert.match(running.confirmText, /正在同步|Syncing/)
  // A second start of the same folder is refused without touching the
  // running sync's state.
  const second = await app.evaluate(`window.api.syncRun(${JSON.stringify(notes)}, 'push').then(() => 'ran', (e) => e.message)`)
  assert.match(second, /正在同步/)
  assert.equal((await ui()).syncing, true, 'still shown as syncing')

  // 2. Timeout → readable error, folder released.
  const failed = await waitUi((s) => s.error, 'no error after the timeout', 20000)
  console.log('failed', failed)
  assert.match(failed.error, /云端 \d+ 秒内没有响应（PUT .*note-\d\.md），已停止这次同步/)
  assert.ok(!/Error invoking remote method/.test(failed.error), 'no IPC prefix')
  assert.equal(failed.syncing, false)
  assert.equal(failed.confirmDisabled, false, 'can retry')

  // 3. Retry completes.
  hang = false
  await app.evaluate(`[...document.querySelectorAll('.sync-workspace-item .settings-action-btn')].at(-1).click()`)
  const done = await waitUi((s) => /同步完成|Sync completed/i.test(s.notice), 'retry did not complete')
  console.log('done', done.notice)
  assert.equal([...store.keys()].filter((key) => /note-\d\.md$/.test(key)).length, 3)

  // 4. A reloaded page shows the sync that is still running.
  for (let i = 0; i < 3; i += 1) await writeFile(join(notes, `note-${i}.md`), `# ${i} changed\n`)
  putDelay = 1500
  await app.evaluate(`[...document.querySelectorAll('.sync-icon-btn')].find((button) => /Two-way sync|双向同步/.test(button.title)).click()`)
  await waitUi((s) => s.syncing, 'second sync did not start')
  await app.send('Page.reload')
  await sleep(2500)
  await openSync()
  const restored = await waitUi((s) => s.syncing, 'reloaded page does not show the running sync', 8000)
  console.log('restored', restored)
  await waitUi((s) => !s.syncing, 'running state never cleared after the sync finished', 30000)
  assert.equal(String(store.get([...store.keys()].find((key) => key.endsWith('note-0.md')))), '# 0 changed\n')
} finally {
  if (app) await stopBuiltElectron(app)
  server.close()
  await rm(root, { recursive: true, force: true })
}
console.log('PASS sync #161: confirm disabled while syncing, no-answer request times out with a clear error, retry works, reload keeps the running state')
