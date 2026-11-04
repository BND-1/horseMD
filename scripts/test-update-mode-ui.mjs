// 更新方式 (#170) in the real app against a local release feed:
//   manual — no check at start-up (the feed is never asked);
//   auto   — no prompt; the release downloads in the background, the status
//            bar says it installs on quit, a click there opens the prompt
//            with「重启并安装」; a new process reuses the verified download;
//            quitting asks main to install (refused in an unpackaged run,
//            traced as auto);
//   notify — the prompt, as before (test:update-ui covers its buttons);
// and after a version change the app says「已更新到 HorseMD v…」.
import assert from 'node:assert/strict'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'

if (process.platform !== 'darwin') {
  console.log('SKIP update mode UI: the fixture is a macOS zip')
  process.exit(0)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// HM_TEST_APP_EXE = an installed (packaged) copy: quitting really installs —
// pass a throwaway copy; it is replaced by the fixture.
const PACKAGED = Boolean(process.env.HM_TEST_APP_EXE)
// Far above any real version, so it always counts as newer.
const VERSION = '99.0.1'
const root = await mkdtemp(join(tmpdir(), 'horsemd-update-mode-'))

const appDir = join(root, 'build', 'HorseMD.app', 'Contents')
await mkdir(join(appDir, 'MacOS'), { recursive: true })
await writeFile(join(appDir, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleShortVersionString</key>\n<string>${VERSION}</string></dict></plist>\n`)
await writeFile(join(appDir, 'MacOS', 'HorseMD'), randomBytes(1024 * 1024))
const zipName = `HorseMD-${VERSION}${process.arch === 'arm64' ? '-arm64' : ''}-mac.zip`
const zipPath = join(root, zipName)
execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', join(root, 'build', 'HorseMD.app'), zipPath])
const zip = await readFile(zipPath)
const sha = createHash('sha256').update(zip).digest('hex')

const hits = { release: 0, zip: 0 }
const server = http.createServer((req, res) => {
  const base = `http://127.0.0.1:${server.address().port}`
  if (req.url === '/release') {
    hits.release++
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({
      tag_name: `v${VERSION}`,
      html_url: `${base}/page`,
      name: `HorseMD v${VERSION}`,
      body: '## ✨ 新功能\n- 更新方式',
      assets: [{ name: zipName, size: zip.length, browser_download_url: `${base}/dl/${zipName}`, digest: `sha256:${sha}` }]
    }))
  }
  if (req.url === `/dl/${zipName}`) {
    if (!req.headers.range) hits.zip++
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '')
    const body = range ? zip.subarray(Number(range[1]), Number(range[2]) + 1) : zip
    res.writeHead(range ? 206 : 200, { 'content-type': 'application/zip', 'content-length': body.length })
    return res.end(body)
  }
  res.writeHead(404); res.end()
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const feed = `http://127.0.0.1:${server.address().port}/release`
const updateDir = join(tmpdir(), 'horsemd-update', VERSION)
const profileDir = join(root, 'profile')
const port = 29780 + process.pid % 50

let app = null
const launch = (cleanProfile = true) => launchBuiltElectron({
  profileDir, port, cleanProfile,
  appArgs: ['--horsemd-input-trace'],
  env: { ...process.env, HORSEMD_TEST_UPDATE_FEED: feed }
})
const state = () => app.evaluate(`(() => {
  const item = document.querySelector('.hm-update-ready')
  const toast = document.querySelector('.update-toast')
  return {
    toast: toast ? [...toast.querySelectorAll('.update-toast-foot button')].map((b) => b.textContent.trim()) : null,
    item: item ? item.textContent.trim() : '',
    toasts: [...document.querySelectorAll('.hm-toast-msg')].map((n) => n.textContent)
  }
})()`)
const waitFor = async (check, message, ms = 20000) => {
  const started = Date.now()
  let last = null
  while (Date.now() - started < ms) {
    last = await state()
    if (check(last)) return last
    await sleep(100)
  }
  throw new Error(`${message}: ${JSON.stringify(last)}`)
}
const ready = () => app.evaluate(`new Promise((resolve) => {
  const t0 = Date.now()
  const tick = () => document.querySelector('.ProseMirror, .welcome, .tabs') || Date.now() - t0 > 15000 ? resolve(true) : setTimeout(tick, 100)
  tick()
})`)
const setMode = async (mode, extra = '') => {
  const oldOrigin = await app.evaluate('performance.timeOrigin')
  await app.evaluate(`(() => {
    const s = JSON.parse(localStorage.getItem('horsemd.settings.v1') || '{}')
    s.updateMode = ${JSON.stringify(mode)}
    localStorage.setItem('horsemd.settings.v1', JSON.stringify(s))
    ${extra}
  })()`)
  await app.send('Page.reload')
  for (let i = 0; i < 150; i++) {
    try { if (await app.evaluate('performance.timeOrigin') !== oldOrigin) break } catch { /* reloading */ }
    await sleep(100)
  }
  await ready()
}
const traceLines = async () => {
  const info = await app.evaluate('window.api.getInputTraceInfo()')
  return info.path
}

try {
  await rm(updateDir, { recursive: true, force: true })
  app = await launch()
  await ready()

  // notify (default): the prompt.
  await waitFor((s) => s.toast?.length === 2, 'notify: no prompt')

  // manual: nothing asks the feed after the reload.
  const before = hits.release
  await setMode('manual')
  await sleep(3000)
  assert.equal(hits.release, before, 'manual mode still checked at start-up')
  assert.equal((await state()).toast, null, 'manual mode showed a prompt')

  // auto: no prompt, downloaded quietly, status-bar item.
  await setMode('auto')
  const quiet = await waitFor((s) => s.item, 'auto: no status-bar item', 30000)
  assert.equal(quiet.toast, null, 'auto mode showed a prompt')
  assert.match(quiet.item, new RegExp(`v${VERSION.replace(/\./g, '\\.')}`))
  assert.match(quiet.item, /退出时安装|installs on quit/)
  assert.equal(hits.zip, 1, `one full download: ${hits.zip}`)
  assert.ok(existsSync(join(updateDir, 'app', 'HorseMD.app')), 'the zip was not unpacked')
  // The item opens the prompt with「重启并安装」.
  await app.evaluate("document.querySelector('.hm-update-ready').click()")
  const opened = await waitFor((s) => s.toast?.some((b) => /重启并安装/.test(b)), 'status-bar item did not open the prompt')
  assert.ok(opened.toast.some((b) => /稍后/.test(b)))
  await app.evaluate("[...document.querySelectorAll('.update-toast button')].find((b) => /稍后/.test(b.textContent)).click()")
  await waitFor((s) => s.toast === null && s.item, '「稍后」did not hide the prompt')

  // Settings › 关于 shows the mode.
  const aboutMode = await app.evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const visible = (e) => e && e.getBoundingClientRect().width > 0
    ;[...document.querySelectorAll('button')].filter(visible).find((b) => /settings|设置/i.test(b.title || b.textContent || '')).click()
    await sleep(400)
    ;[...document.querySelectorAll('.settings-nav-item')].filter(visible).find((b) => /about|关于/i.test(b.textContent || '')).click()
    await sleep(400)
    const row = document.querySelector('.settings-update-mode')
    return { active: row?.querySelector('.settings-segmented-option.active')?.dataset.updateMode, desc: row?.querySelector('.settings-row-desc')?.textContent || '' }
  })()`)
  assert.equal(aboutMode.active, 'auto')
  assert.match(aboutMode.desc, /退出 HorseMD 时自动安装/)

  // After an update: 「已更新到 HorseMD v…」 once.
  await setMode('manual', "localStorage.setItem('horsemd.lastVersion', '0.0.1')")
  const updated = await waitFor((s) => s.toasts.some((m) => /已更新到 HorseMD v/.test(m)), 'no "updated to" toast', 8000)
  assert.ok(updated)
  await setMode('auto')
  await sleep(2500)
  assert.ok(!(await state()).toasts.some((m) => /已更新到/.test(m)), 'the "updated to" toast repeated')

  // Quit: main is asked to install quietly; an unpackaged run refuses (traced).
  const tracePath = await traceLines()
  await stopBuiltElectron(app)
  app = null
  await sleep(500)
  const trace = (await readFile(tracePath, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((e) => e.kind === 'update')
  if (PACKAGED) {
    // An installed copy really swaps (to the fixture) and is not reopened.
    assert.ok(trace.some((e) => e.step === 'install-started' && e.relaunch === false), `no quiet install on quit: ${JSON.stringify(trace.map((e) => e.step))}`)
    await sleep(4000)
    const bundle = process.env.HM_TEST_APP_EXE.replace(/\/Contents\/MacOS\/[^/]+$/, '')
    assert.match(await readFile(join(bundle, 'Contents', 'Info.plist'), 'utf8'), new RegExp(VERSION.replace(/\./g, '\\.')), 'the bundle was not replaced')
    assert.equal(execFileSync('/bin/sh', ['-c', `pgrep -f "${bundle}/Contents/MacOS" || true`]).toString().trim(), '', 'HorseMD was reopened after a quiet install')
    console.log('PASS update mode UI (installed app): manual never checks; auto downloads quietly, status bar item → prompt, Settings shows the mode, 已更新到 once, quit installs quietly (bundle replaced, not reopened)')
  } else {
    assert.ok(trace.some((e) => e.step === 'install-refused-unpackaged' && e.auto === true), `no automatic install attempt on quit: ${JSON.stringify(trace.map((e) => e.step))}`)

    // A new process reuses the verified download (no second full download).
    app = await launch(false)
    await ready()
    await waitFor((s) => s.item, 'auto (second run): no status-bar item', 30000)
    assert.equal(hits.zip, 1, `the kept download was not reused: ${hits.zip}`)
    const trace2 = (await readFile(await traceLines(), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
    assert.ok(trace2.some((e) => e.kind === 'update' && e.step === 'reuse'), 'no reuse step traced')

    console.log('PASS update mode UI: manual never checks; auto downloads quietly (no prompt), status bar item → prompt with 重启并安装, Settings shows the mode, quit asks for the automatic install (refused unpackaged), a new run reuses the verified download; 已更新到 shown once after a version change')
  }
} finally {
  if (app) await stopBuiltElectron(app, { removeProfile: true })
  server.close()
  await rm(root, { recursive: true, force: true })
  await rm(updateDir, { recursive: true, force: true })
}
