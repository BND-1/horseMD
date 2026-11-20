// The website's account page (website/account.html) in a headless Chrome
// with a throwaway profile, against the real account service + MinIO
// (lib/account-server.mjs), the site served from this folder:
//   1. a bad address is refused in place; the code mailed → typed → logged in
//   2. no plan: 还没有订阅 and the plans show 即将开放 (Paddle not set up)
//   3. a plan granted: a reload stays logged in (refresh token) and shows
//      标准版 with its usage
//   4. phone width: no horizontal scroll
//   5. 退出登录 ends the session on the service too
// Screenshots go to HM_SITE_SHOTS (a folder) when set. Needs Google Chrome.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { extname, join, normalize } from 'node:path'
import { tmpdir } from 'node:os'
import { connectCdp, sleep } from './lib/cdp.mjs'
import { startAccountServer } from './lib/account-server.mjs'

const CHROME = process.env.HM_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const EMAIL = 'site-test@example.com'
const site = new URL('../website/', import.meta.url).pathname
const shots = process.env.HM_SITE_SHOTS || ''
const ok = (line) => console.log(`  ✓ ${line}`)
if (!existsSync(CHROME)) { console.log('SKIP website account: no Chrome'); process.exit(0) }

const root = await mkdtemp(join(tmpdir(), 'horsemd-site-account-'))
const account = await startAccountServer(join(root, 'service'))
if (!account) { console.log('SKIP website account: minio is not installed'); process.exit(0) }

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' }
const web = http.createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '')
  const file = join(site, path === '/' ? 'index.html' : path === '/account' ? 'account.html' : path)
  try {
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404)
    res.end('not found')
  }
})
await new Promise((resolve) => web.listen(0, '127.0.0.1', resolve))
const siteUrl = `http://127.0.0.1:${web.address().port}`
const port = 29840 + process.pid % 40
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${join(root, 'chrome')}`, '--no-first-run', '--no-default-browser-check', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' })
let page = null

const ev = (expression) => page.evaluate(expression)
const waitFor = async (check, message, ms = 20000) => {
  const started = Date.now()
  let last
  while (Date.now() - started < ms) {
    last = await check().catch(() => null)
    if (last) return last
    await sleep(150)
  }
  throw new Error(`${message}: ${JSON.stringify(last)}`)
}
const shot = async (name) => {
  if (!shots) return
  await mkdir(shots, { recursive: true })
  await sleep(300)
  const image = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  await writeFile(join(shots, `${name}.png`), Buffer.from(image.data ?? image.result?.data ?? '', 'base64'))
}
const visible = (id) => ev(`(() => { const e = document.getElementById(${JSON.stringify(id)}); return !!e && !e.hidden && e.getBoundingClientRect().height > 0 })()`)
const textOf = (id) => ev(`document.getElementById(${JSON.stringify(id)})?.innerText.trim() || ''`)
async function typeInto(id, text) {
  await ev(`(() => { const e = document.getElementById(${JSON.stringify(id)}); e.focus(); e.select?.(); return true })()`)
  await page.send('Input.insertText', { text })
}
const press = (id) => ev(`(() => { const e = document.getElementById(${JSON.stringify(id)}); e.click(); return true })()`)
const open = async (url) => {
  await page.send('Page.navigate', { url })
  await waitFor(() => ev(`document.readyState === 'complete' && !!document.getElementById('loginView')`), `loaded ${url}`)
}

try {
  page = await connectCdp({ port, attempts: 80, intervalMs: 250 })
  await page.send('Page.enable')
  const url = `${siteUrl}/account.html?api=${encodeURIComponent(account.url)}`
  await open(url)
  await waitFor(() => visible('loginView'), 'login view')
  assert.ok(await visible('apiBanner'), 'a non-production API shows the banner')
  await shot('1-login')

  // 1. login
  await typeInto('emailInput', 'nope')
  await press('sendBtn')
  await waitFor(async () => (await textOf('emailErr')).length > 0, 'bad address refused in place')
  const before = (await account.codes(EMAIL)).length
  await typeInto('emailInput', EMAIL)
  await press('sendBtn')
  const code = await account.nextCode(EMAIL, before)
  await waitFor(() => visible('codeForm'), 'code form')
  await typeInto('codeInput', code)
  await ev(`document.getElementById('codeInput').dispatchEvent(new Event('input', { bubbles: true }))`)
  if (await visible('codeForm')) await press('verifyBtn').catch(() => {})
  await waitFor(() => visible('accountView'), 'logged in', 20000)
  assert.equal(await textOf('meEmail'), EMAIL)
  ok('login: a bad address refused in place; the mailed code typed → logged in')

  // 2. no plan
  await waitFor(async () => /还没有|无|None|No plan/i.test(await textOf('mePlan')), 'no plan shown')
  const plans = await ev(`[...document.querySelectorAll('[data-buy]')].map((b) => ({ text: b.innerText.trim(), disabled: b.disabled }))`)
  assert.ok(plans.length === 2 && plans.every((p) => p.disabled), `plans not buyable yet: ${JSON.stringify(plans)}`)
  assert.match(await ev(`document.getElementById('plans').innerText`), /即将开放|Coming soon/)
  await shot('2-no-plan')
  ok(`no plan: ${await textOf('mePlan')}; both plans 即将开放 and not buyable (Paddle not set up)`)

  // 3. plan + reload (refresh token)
  await account.admin('grant', EMAIL, 'standard', '30')
  await open(url)
  await waitFor(() => visible('accountView'), 'still logged in after a reload', 20000)
  await waitFor(async () => /标准|Standard/.test(await textOf('mePlan')), 'standard plan shown')
  const usage = await textOf('meUsage')
  assert.match(usage, /GB/)
  await shot('3-plan')
  ok(`a reload stays logged in; the plan shows ${await textOf('mePlan')} (${usage})`)

  // 4. phone width
  await page.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true })
  await sleep(500)
  const overflow = await ev(`document.documentElement.scrollWidth - document.documentElement.clientWidth`)
  assert.ok(overflow <= 0, `no horizontal scroll at 375 px (overflow ${overflow})`)
  await shot('4-phone')
  await page.send('Emulation.clearDeviceMetricsOverride')
  ok('phone width (375 px): no horizontal scroll')

  // 5. logout
  const stored = await ev(`(() => { try { return JSON.parse(localStorage.getItem('horsemd.account.v1') || 'null') } catch { return null } })()`)
  assert.ok(stored?.refreshToken, 'refresh token kept in localStorage')
  await press('logoutBtn')
  await waitFor(() => visible('loginView'), 'back to login')
  await sleep(500)
  const refused = await fetch(`${account.url}/v1/auth/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: stored.refreshToken }) })
  assert.equal((await refused.json()).error, 'refresh-invalid', 'the session ended on the service')
  ok('退出登录: back to the login form; the session ended on the service')
  console.log('PASS website account page')
} catch (error) {
  if (page) await shot('failure').catch(() => {})
  console.error(account.log().slice(-1500))
  throw error
} finally {
  page?.close?.()
  chrome.kill('SIGTERM')
  web.close()
  await account.stop()
  await sleep(500)
  if (!process.env.HM_KEEP) await rm(root, { recursive: true, force: true })
}
