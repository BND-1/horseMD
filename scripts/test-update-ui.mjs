// In-app update (#164) in the real app against a local release feed
// (HORSEMD_TEST_UPDATE_FEED): the prompt offers「直接下载」(with the size) and
//「去 GitHub 查看」; a download whose bytes do not match SHA256SUMS.txt is
// rejected and deleted; progress shows and「取消下载」goes back; closing the
// prompt while downloading only hides it and it returns when the download is
// done, with「重启并安装」; the macOS zip is unpacked and its version checked;
// Settings › About offers both choices too. Install itself is refused in an
// unpackaged run (the end-to-end install is checked on a packaged app).
import assert from 'node:assert/strict'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'

if (process.platform !== 'darwin') {
  console.log('SKIP update UI: the fixture is a macOS zip (Windows / Linux paths are covered by test:update-core)')
  process.exit(0)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const VERSION = '0.13.999'
const root = await mkdtemp(join(tmpdir(), 'horsemd-update-ui-'))

// A tiny HorseMD.app with the release version, plus incompressible bytes so
// the download takes a few seconds at the throttled rate.
const appDir = join(root, 'build', 'HorseMD.app', 'Contents')
await mkdir(join(appDir, 'MacOS'), { recursive: true })
await writeFile(join(appDir, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleShortVersionString</key>\n<string>${VERSION}</string></dict></plist>\n`)
await writeFile(join(appDir, 'MacOS', 'HorseMD'), randomBytes(3 * 1024 * 1024))
const zipName = `HorseMD-${VERSION}${process.arch === 'arm64' ? '-arm64' : ''}-mac.zip`
const zipPath = join(root, zipName)
execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', join(root, 'build', 'HorseMD.app'), zipPath])
const zip = await readFile(zipPath)
const sha = createHash('sha256').update(zip).digest('hex')

let corrupt = false
let slow = true
const server = http.createServer(async (req, res) => {
  const base = `http://127.0.0.1:${server.address().port}`
  if (req.url === '/release') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({
      tag_name: `v${VERSION}`,
      html_url: `${base}/page`,
      name: `HorseMD v${VERSION}`,
      body: '## ✨ 新功能\n- 应用内更新',
      assets: [
        { name: zipName, size: zip.length, browser_download_url: `${base}/dl/${zipName}` },
        { name: `HorseMD-${VERSION}-arm64.dmg`, size: 10, browser_download_url: `${base}/dl/x.dmg` },
        { name: 'SHA256SUMS.txt', size: 100, browser_download_url: `${base}/dl/SHA256SUMS.txt` },
        { name: 'evil.zip', size: 1, browser_download_url: 'http://evil.example/evil.zip' }
      ]
    }))
  }
  if (req.url === '/dl/SHA256SUMS.txt') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    return res.end(`${sha}  ${zipName}\n`)
  }
  if (req.url === `/dl/${zipName}`) {
    const body = corrupt ? Buffer.from(zip).fill(7, 1000, 2000) : zip
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': body.length })
    for (let off = 0; off < body.length; off += 64 * 1024) {
      if (res.destroyed) return
      res.write(body.subarray(off, off + 64 * 1024))
      if (slow) await sleep(60)
    }
    return res.end()
  }
  res.writeHead(404); res.end()
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const feed = `http://127.0.0.1:${server.address().port}/release`

let app = null
const ui = () => app.evaluate(`(() => {
  const toast = document.querySelector('.update-toast')
  return toast && {
    buttons: [...toast.querySelectorAll('.update-toast-foot button')].map((b) => b.textContent.trim()),
    progress: toast.querySelector('.update-progress-text')?.textContent || '',
    percent: Number(toast.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow') ?? -1),
    done: toast.querySelector('.update-toast-done')?.textContent || '',
    error: toast.querySelector('.update-toast-error')?.textContent || '',
    notes: toast.querySelector('.update-toast-notes-body')?.textContent || '',
    close: !!toast.querySelector('.update-toast-close')
  }
})()`)
const waitFor = async (check, message, ms = 20000) => {
  const started = Date.now()
  let state = null
  while (Date.now() - started < ms) {
    state = await ui()
    if (check(state)) return state
    await sleep(100)
  }
  throw new Error(`${message}: ${JSON.stringify(state)}`)
}
const click = (text) => app.evaluate(`(() => {
  const b = [...document.querySelectorAll('.update-toast button, .settings-update-row button')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(text)}))
  b?.click(); return !!b
})()`)
const updateDir = join(tmpdir(), 'horsemd-update', VERSION)

try {
  await rm(updateDir, { recursive: true, force: true })
  app = await launchBuiltElectron({
    profileDir: join(root, 'profile'), port: 29720 + process.pid % 50,
    appArgs: ['--horsemd-input-trace'],
    env: { ...process.env, HORSEMD_TEST_UPDATE_FEED: feed }
  })

  // 1. The prompt: notes and both choices, the direct one with its size.
  const first = await waitFor((s) => s?.buttons.length === 2, 'no update prompt with two choices')
  assert.match(first.buttons[0], /去 GitHub 查看|View on GitHub/)
  assert.match(first.buttons[1], /直接下载|Download now/)
  assert.match(first.buttons[1], /MB/)
  assert.match(first.notes, /应用内更新/)
  assert.equal(first.close, true, 'the ✕ (later) shows before downloading')

  // 2. Bytes that do not match SHA256SUMS.txt are rejected and deleted.
  corrupt = true; slow = false
  assert.ok(await click('直接下载'))
  const bad = await waitFor((s) => s?.error, 'a corrupt download was not rejected')
  assert.match(bad.error, /校验不一致/)
  assert.ok(bad.buttons.some((b) => /重新下载/.test(b)), 'retry offered')
  assert.ok(!existsSync(updateDir) || readdirSync(updateDir).length === 0, `rejected file left behind: ${existsSync(updateDir) && readdirSync(updateDir)}`)

  // 3. Progress, then cancel → back to the two choices.
  corrupt = false; slow = true
  assert.ok(await click('重新下载'))
  const running = await waitFor((s) => s?.percent > 0 && s.percent < 100, 'no progress shown')
  // While downloading the buttons say what happens; no ambiguous ✕.
  assert.equal(running.close, false, 'no ✕ while downloading')
  assert.ok(running.buttons.some((b) => /后台下载/.test(b)) && running.buttons.some((b) => /取消下载/.test(b)), `buttons: ${running.buttons}`)
  assert.match(running.progress, /正在下载 \d+%.*MB \/ .*MB/)
  assert.ok(await click('取消下载'))
  await waitFor((s) => s?.buttons.some((b) => /直接下载/.test(b)), 'cancel did not go back to the choices')
  await sleep(300)
  assert.ok(!existsSync(join(updateDir, `${zipName}.part`)), 'cancelled part file left behind')

  // 4.「后台下载」hides it and keeps downloading; it returns when done.
  assert.ok(await click('直接下载'))
  await waitFor((s) => s?.percent >= 0, 'second download did not start')
  assert.ok(await click('后台下载'))
  await waitFor((s) => s === null, '「后台下载」did not hide the prompt', 3000)
  slow = false
  const ready = await waitFor((s) => s?.buttons.some((b) => /重启并安装/.test(b)), 'the prompt did not come back when the download finished', 30000)
  assert.match(ready.done, /已下载并校验通过/)
  assert.equal(ready.close, false, 'no ✕ next to「稍后」')
  const installed = join(updateDir, 'app', 'HorseMD.app', 'Contents', 'Info.plist')
  assert.ok(existsSync(installed), 'the zip was not unpacked')
  assert.match(await readFile(installed, 'utf8'), new RegExp(VERSION.replace(/\./g, '\\.')))
  assert.equal(createHash('sha256').update(await readFile(join(updateDir, zipName))).digest('hex'), sha)

  // 5. Never installs in an unpackaged run (node_modules' Electron).
  assert.equal(await app.evaluate('window.api.updateInstall()'), false)

  // 6. Settings › About: both choices.
  await app.evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const visible = (e) => e && e.getBoundingClientRect().width > 0
    ;[...document.querySelectorAll('button')].filter(visible).find((b) => /settings|设置/i.test(b.title || b.textContent || '')).click()
    await sleep(400)
    ;[...document.querySelectorAll('.settings-nav-item')].filter(visible).find((b) => /about|关于/i.test(b.textContent || '')).click()
    await sleep(400)
    ;[...document.querySelectorAll('.settings-update-row button')].find((b) => /检查更新|Check for updates/.test(b.textContent)).click()
  })()`)
  const settingsRow = await (async () => {
    for (let i = 0; i < 60; i += 1) {
      const text = await app.evaluate(`document.querySelector('.settings-update-row')?.textContent || ''`)
      if (/直接下载/.test(text)) return text
      await sleep(100)
    }
    return app.evaluate(`document.querySelector('.settings-update-row')?.textContent || ''`)
  })()
  assert.match(settingsRow, /直接下载/)
  assert.match(settingsRow, /去 GitHub 查看/)
  console.log('PASS update UI: two choices, checksum rejected + deleted, progress + cancel, hide while downloading and back when ready, zip unpacked + version checked, no install unpackaged, Settings offers both')
} finally {
  if (app) await stopBuiltElectron(app, { removeProfile: true })
  server.close()
  await rm(root, { recursive: true, force: true })
  await rm(updateDir, { recursive: true, force: true })
}
