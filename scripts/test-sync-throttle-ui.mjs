// Real Electron: a cloud service that locks uploads after a quota (like
// 数据胶囊: ~200 PUTs, then 429 for ~20 min, reads unaffected). Scaled down:
// 12 PUTs, then 429 for 4 s. Settings › Sync must show the wait with the
// progress, then finish by itself with every file uploaded.
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// The sync registry stores resolved paths and refuses system locations, and
// macOS resolves the temp dir to /private/var: use a folder under home there.
const tempBase = process.platform === 'darwin' ? homedir() : tmpdir()
const root = await realpath(await mkdtemp(join(tempBase, '.horsemd-sync-throttle-ui-')))
const notes = join(root, 'notes')
const FILES = 30

let puts = 0
let quotaOn = true
let putDelay = 0
let lockedUntil = 0
let throttled = 0
const store = new Map()
const etags = new Map()
const written = new Map()
let etagCounter = 0
const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', async () => {
    if (putDelay && req.method === 'PUT') await sleep(putDelay)
    const url = new URL(req.url, 'http://x')
    const key = decodeURIComponent(url.pathname)
    if (req.method === 'PUT') {
      if (Date.now() < lockedUntil) { throttled += 1; res.writeHead(429); return res.end('<Error><Code>SlowDown</Code></Error>') }
      puts += 1
      if (quotaOn && puts % 12 === 0) lockedUntil = Date.now() + 4000
      if (req.headers['if-none-match'] === '*' && store.has(key)) { res.writeHead(412); return res.end() }
      // Like S3: a conditional write must name the current revision.
      if (req.headers['if-match'] && req.headers['if-match'] !== `"${etags.get(key)}"`) { res.writeHead(412); return res.end() }
      store.set(key, Buffer.concat(chunks))
      etags.set(key, String(++etagCounter))
      written.set(key, (written.get(key) || 0) + 1)
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
try {
  await mkdir(notes, { recursive: true })
  for (let i = 0; i < FILES; i += 1) await writeFile(join(notes, `note-${i}.md`), `# ${i}\n`)
  // An empty folder must reach the cloud as an S3 "folder/" marker.
  await mkdir(join(notes, '空文件夹', '子目录'), { recursive: true })
  app = await launchBuiltElectron({
    profileDir: join(root, 'profile'),
    port: 9471,
    appArgs: [notes],
    env: { ...process.env, HORSEMD_TEST_SYNC_PACER: JSON.stringify({ baseDelayMs: 50, maxDelayMs: 200, maxAttempts: 3, lockProbeMs: 1500, lockWaitMs: 60000, lockedWriteGapMs: 100 }) }
  })
  const endpoint = `http://127.0.0.1:${server.address().port}`
  // Uploads already locked when the connection is added (the user's case:
  // 「测试并保存」 must answer in seconds, not wait out the lock).
  lockedUntil = Date.now() + 12000
  const added = await app.evaluate(`(async () => {
    const started = Date.now()
    const connection = await window.api.syncAddS3Connection({ name: 'quota', endpoint: ${JSON.stringify(endpoint)}, bucket: 'b', region: 'us-east-1', accessKeyId: 'k', secretAccessKey: 's', allowInsecure: true })
    return { ms: Date.now() - started, uploadThrottled: connection.uploadThrottled === true }
  })()`)
  console.log('add while locked', added)
  assert.equal(added.uploadThrottled, true, 'saved with the throttled flag')
  assert.ok(added.ms < 5000, `test-and-save answered quickly: ${added.ms} ms`)
  await app.evaluate(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const visible = (element) => element && element.getBoundingClientRect().width > 0
    const settings = [...document.querySelectorAll('button')].filter(visible).find((button) => /settings|设置/i.test(button.title || button.textContent || ''))
    settings.click()
    await sleep(400)
    const nav = [...document.querySelectorAll('.settings-nav-item')].filter(visible).find((button) => /cloud sync|云同步/i.test(button.textContent || ''))
    nav.click()
    await sleep(600)
    // The user's flow: 开启同步 → pick the connection → 连接并继续 → the
    // first upload's plan → confirm.
    const enable = [...document.querySelectorAll('.sync-folder-row button')].find((button) => /enable sync|开启同步/i.test(button.textContent || ''))
    enable?.click()
    await sleep(800)
    const test = [...document.querySelectorAll('.sync-icon-btn')].find((button) => /Test connection|测试连接/.test(button.title))
    test.click()
    for (let i = 0; i < 50 && !document.querySelector('.sync-notice, .sync-error'); i += 1) await sleep(100)
    window.__testNotice = (document.querySelector('.sync-notice') || document.querySelector('.sync-error'))?.textContent || ''
    const select = document.querySelector('.sync-workspace-item select')
    if (select && !select.value) {
      select.value = select.options[select.options.length - 1].value
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await sleep(200)
    }
    const next = [...document.querySelectorAll('.sync-workspace-item button')].find((button) => /连接并继续|Connect and continue/i.test(button.textContent || ''))
    if (!next) throw new Error('missing continue: ' + document.querySelector('.sync-workspace-item')?.innerHTML.slice(0, 600))
    next.click()
    for (let i = 0; i < 40 && !document.querySelector('.sync-plan-preview, .sync-preview'); i += 1) await sleep(100)
    const confirm = [...document.querySelectorAll('.sync-workspace-item .settings-action-btn')].at(-1)
    if (!confirm) throw new Error('missing confirm: ' + (document.querySelector('.sync-error')?.textContent || document.querySelector('.sync-workspace-item')?.textContent))
    confirm.click()
  })()`)
  const testNotice = await app.evaluate('window.__testNotice')
  console.log('test notice', testNotice)
  assert.match(testNotice, /暂时限制了上传频率|limiting uploads right now/, 'the test button reports the upload limit')
  const seen = new Set()
  let pausedText = ''
  let pausingText = ''
  let pausedAt = null
  let resumed = false
  let waitingText = ''
  let notice = ''
  const started = Date.now()
  while (Date.now() - started < 180000) {
    const state = await app.evaluate(`(() => ({
      line: document.querySelector('.sync-progress-line')?.textContent || '',
      waiting: !!document.querySelector('.sync-progress-line.waiting'),
      busy: !!document.querySelector('.sync-state-icon.syncing'),
      done: !!document.querySelector('.sync-state-icon.complete'),
      error: document.querySelector('.settings-error, .sync-error')?.textContent || '',
      notice: document.querySelector('.settings-notice, .sync-notice')?.textContent || ''
    }))()`)
    if (state.line) seen.add(state.line)
    if (state.waiting) waitingText = state.line
    if (state.error) throw new Error('sync failed in UI: ' + state.error)
    if (state.done) { notice = state.notice; break }
    await sleep(250)
  }
  const uploaded = [...store.keys()].filter((key) => /\/note-\d+\.md$/.test(key)).length
  console.log({ uploaded, throttled, puts, waitingText, notice, lines: [...seen].slice(0, 6) })
  assert.equal(uploaded, FILES, 'every file uploaded through the locks')
  assert.ok(throttled > 0, 'the fake service did lock uploads')
  assert.match(waitingText, /限制了上传频率|limiting uploads/, 'the wait is shown')
  assert.match(waitingText, /\d+ \/ \d+/, 'with the progress')
  assert.ok([...seen].some((line) => /正在同步 \d+ \/ \d+|Syncing \d+ \/ \d+/.test(line)), 'normal progress shown')
  assert.ok([...store.keys()].some((key) => key.endsWith('/.horsemd/manifest.json')), 'manifest written')
  assert.match(notice, /同步完成|Sync completed/i)
  assert.ok([...store.keys()].some((key) => key.endsWith('/空文件夹/子目录/')), 'empty folder marker uploaded')

  // Stop: change every file, sync again, stop part way; the next sync
  // uploads only the rest.
  for (let i = 0; i < FILES; i += 1) await writeFile(join(notes, `note-${i}.md`), `# ${i} changed\n`)
  lockedUntil = 0
  quotaOn = false // a stop outside a lock records its progress
  putDelay = 400
  const putsBefore = puts
  written.clear()
  await app.evaluate(`(async () => {
    const run = [...document.querySelectorAll('.sync-icon-btn')].find((button) => /Two-way sync|双向同步/.test(button.title))
    run.click()
  })()`)
  let stopNotice = ''
  for (let i = 0; i < 1200; i += 1) {
    const line = await app.evaluate(`document.querySelector('.sync-progress-line')?.textContent || ''`)
    const match = line.match(/正在同步 (\d+) \/ 30/)
    if (match && !pausedAt && Number(match[1]) >= 3) {
      // 400 ms per upload: 200 ms after a file completes the next is in flight.
      await sleep(200)
      await app.evaluate(`document.querySelector('.sync-pause-btn').click()`)
      await sleep(60)
      pausingText = await app.evaluate(`document.querySelector('.sync-progress-line')?.textContent || ''`)
      await sleep(900)
      pausedAt = { puts }
      await sleep(1200)
      pausedText = await app.evaluate(`document.querySelector('.sync-progress-line')?.textContent || ''`)
      assert.equal(puts, pausedAt.puts, `nothing uploaded while paused: ${pausedAt.puts} -> ${puts}`)
      await app.evaluate(`document.querySelector('.sync-pause-btn').click()`)
      resumed = true
      continue
    }
    if (match && pausedAt && Number(match[1]) >= 8) { await app.evaluate(`document.querySelector('.sync-stop-btn').click()`); break }
    await sleep(50)
  }
  for (let i = 0; i < 100; i += 1) {
    stopNotice = await app.evaluate(`document.querySelector('.sync-notice')?.textContent || ''`)
    if (/已停止|stopped/.test(stopNotice)) break
    await sleep(100)
  }
  console.log({ pausingText, pausedText })
  assert.match(pausingText, /正在暂停：等当前这个文件传完后暂停/, 'pausing shown while the file in flight finishes')
  assert.match(pausedText, /已暂停：已完成 \d+ \/ 30/, 'paused state shown')
  assert.ok(resumed)
  const stoppedUploads = puts - putsBefore
  console.log({ stopNotice, stoppedUploads })
  assert.match(stopNotice, /同步已停止：已完成 \d+ \/ 30/)
  assert.ok(stoppedUploads < FILES, 'stopped before the end')
  await app.evaluate(`[...document.querySelectorAll('.sync-icon-btn')].find((button) => /Two-way sync|双向同步/.test(button.title)).click()`)
  let finalNotice = ''
  for (let i = 0; i < 1000; i += 1) {
    finalNotice = await app.evaluate(`document.querySelector('.sync-notice')?.textContent || ''`)
    if (/同步完成/.test(finalNotice)) break
    await sleep(150)
  }
  console.log({ finalNotice, error: await app.evaluate(`document.querySelector('.sync-error')?.textContent || ''`), line: await app.evaluate(`document.querySelector('.sync-progress-line')?.textContent || ''`), puts: puts - putsBefore })
  const changed = [...store.entries()].filter(([key, value]) => /\/note-\d+\.md$/.test(key) && /changed/.test(value.toString())).length
  assert.equal(changed, FILES, 'every changed file is in the cloud')
  // Every file written exactly once across the stopped run and the next one.
  const twice = [...written].filter(([key, count]) => /\/note-\d+\.md$/.test(key) && count > 1)
  assert.deepEqual(twice, [], 'no file uploaded twice')
  assert.match(finalNotice, /同步完成/)
  const resumedUploads = Number(finalNotice.match(/上传 (\d+)/)?.[1])
  const completedBeforeStop = Number(stopNotice.match(/已完成 (\d+)/)?.[1])
  assert.equal(resumedUploads, FILES - completedBeforeStop, 'the next sync handles only the rest')
} finally {
  if (app) await stopBuiltElectron(app)
  server.close()
  await rm(root, { recursive: true, force: true })
}
console.log('PASS sync throttle UI: upload lock waited out with progress shown, every file uploaded')
