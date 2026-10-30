// 云空间 (SidebarPanes, docs/cloud-sync-review.md) in the real app against a
// local S3 server:
// - without sync folders: 工作区 + an empty 云空间 line (· 添加);
// - a folder in cloud sync: ☁ on its workspace row, listed in 云空间 with the
//   overall sync state; both trees show the same files, expanded folders
//   are independent, a file opens from 云空间;
// - removed from the workspace it stays in 云空间, its watcher still shows
//   new files, 加入工作区 brings it back;
// - the sections fold (title click), the line between them drags, both are
//   remembered across a restart;
// - 停止同步 asks, then the folder leaves 云空间 (files untouched).
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const tempBase = process.platform === 'darwin' ? homedir() : tmpdir()
const root = await realpath(await mkdtemp(join(tempBase, '.horsemd-cloud-space-ui-')))
const notes = join(root, '读书笔记')
const other = join(root, '草稿')
const profileDir = join(root, 'profile')

const store = new Map()
const etags = new Map()
let etagCounter = 0
const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const url = new URL(req.url, 'http://x')
    const key = decodeURIComponent(url.pathname)
    if (req.method === 'PUT') {
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
    if (req.method === 'DELETE') store.delete(key)
    res.writeHead(204); res.end()
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const endpoint = `http://127.0.0.1:${server.address().port}`

let app = null
const launch = (cleanProfile = true) => launchBuiltElectron({ profileDir, port: 9481, cleanProfile, appArgs: [notes, other, '--horsemd-input-trace'] })
const waitFor = async (check, message, ms = 15000) => {
  const started = Date.now()
  let value = null
  while (Date.now() - started < ms) {
    value = await check()
    if (value) return value
    await sleep(150)
  }
  throw new Error(`${message}: ${JSON.stringify(value)}`)
}
// Each section: its title, folded?, root rows (name + ☁), visible rows, status.
const panes = () => app.evaluate(`(() => {
  const section = (variant) => {
    const el = document.querySelector('.sidebar[data-variant=' + variant + ']')
    if (!el) return null
    const rows = [...el.querySelectorAll('.tree-row[data-path]')]
    return {
      title: el.querySelector('.sidebar-title')?.textContent.trim() || '',
      collapsed: el.classList.contains('collapsed'),
      height: Math.round(el.getBoundingClientRect().height),
      rows: rows.map((r) => r.querySelector('.tree-label')?.textContent + (r.querySelector('.tree-cloud-badge') ? ' ☁' : '')),
      empty: el.querySelector('.sidebar-cloud-empty')?.textContent || '',
      status: el.querySelector('.sidebar-cloud-status')?.textContent || ''
    }
  }
  return { workspace: section('workspace'), cloud: section('cloud'), split: !!document.querySelector('.sidebar-panes-split') }
})()`)
const rowCenter = (variant, label) => app.evaluate(`(() => {
  const row = [...document.querySelectorAll('.sidebar[data-variant=${variant}] .tree-row[data-path]')]
    .find((r) => r.querySelector('.tree-label')?.textContent === ${JSON.stringify(label)})
  if (!row) return null
  row.scrollIntoView({ block: 'nearest' })
  const b = row.getBoundingClientRect()
  return { x: b.left + Math.min(60, b.width / 2), y: b.top + b.height / 2 }
})()`)
const clickRow = async (variant, label, button = 'left') => {
  const p = await waitFor(() => rowCenter(variant, label), `row ${variant}/${label}`)
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await app.send('Input.dispatchMouseEvent', { type, button, clickCount: 1, ...p })
  await sleep(250)
}
const menuItems = () => app.evaluate(`[...document.querySelectorAll('.context-menu button')].map((b) => b.textContent.trim())`)
const clickMenu = (label) => app.evaluate(`(() => { const b = [...document.querySelectorAll('.context-menu button')].find((n) => n.textContent.trim() === ${JSON.stringify(label)}); b?.click(); return !!b })()`)
const openSync = () => app.evaluate(`(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const visible = (element) => element && element.getBoundingClientRect().width > 0
  if (!document.querySelector('.sync-auto-row')) {
    ;[...document.querySelectorAll('button')].filter(visible).find((button) => /settings|设置/i.test(button.title || button.textContent || '')).click()
    await sleep(400)
    ;[...document.querySelectorAll('.settings-nav-item')].filter(visible).find((button) => /cloud sync|云同步/i.test(button.textContent || '')).click()
  }
  for (let i = 0; i < 40 && !document.querySelector('.sync-auto-row'); i += 1) await sleep(100)
  return !!document.querySelector('.sync-auto-row')
})()`)
const shot = async (name) => {
  if (!process.env.HM_CLOUD_SPACE_SHOT) return
  await sleep(400)
  const image = await app.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(process.env.HM_CLOUD_SPACE_SHOT, `${name}.png`), Buffer.from(image.data ?? image.result?.data ?? '', 'base64'))
}
const dialogs = []

try {
  await mkdir(join(notes, '周报'), { recursive: true })
  await mkdir(other, { recursive: true })
  await writeFile(join(notes, '第一章.md'), '# 第一章\n')
  await writeFile(join(notes, '周报', '10-29.md'), '# 周报\n')
  await writeFile(join(other, '想法.md'), '# 想法\n')
  app = await launch()
  await app.send('Page.enable')
  app.ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.method !== 'Page.javascriptDialogOpening') return
    dialogs.push(message.params.message)
    app.send('Page.handleJavaScriptDialog', { accept: true })
  })

  // 1. No sync folder yet: 工作区 + an empty 云空间 line.
  const first = await waitFor(async () => { const p = await panes(); return p.cloud && p.workspace?.rows.length && p }, 'sections')
  assert.equal(first.workspace.title, '工作区')
  assert.equal(first.cloud.title, '云空间')
  assert.match(first.cloud.empty, /还没有同步的文件夹 · 添加/)
  assert.equal(first.split, false, 'no split line while 云空间 is empty')

  // 2. 读书笔记 joins the workspace and cloud sync (Settings › 云同步).
  await app.evaluate(`window.api.syncAddS3Connection({ name: '测试云', endpoint: ${JSON.stringify(endpoint)}, bucket: 'b', region: 'us-east-1', accessKeyId: 'k', secretAccessKey: 's', allowInsecure: true })`)
  assert.ok(await openSync(), 'sync settings did not open')
  await app.evaluate(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const row = [...document.querySelectorAll('.sync-folder-row')].find((n) => n.textContent.includes('读书笔记'))
    ;[...row.querySelectorAll('button')].find((button) => /enable sync|开启同步/i.test(button.textContent || ''))?.click()
    for (let i = 0; i < 40 && !document.querySelector('.sync-workspace-item select'); i += 1) await sleep(100)
    const item = [...document.querySelectorAll('.sync-workspace-item')].find((n) => n.textContent.includes('读书笔记'))
    const select = item.querySelector('select')
    select.value = select.options[select.options.length - 1].value
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await sleep(200)
    ;[...item.querySelectorAll('button')].find((button) => /连接并继续|Connect and continue/i.test(button.textContent || '')).click()
    for (let i = 0; i < 40 && !item.querySelector('.settings-action-btn'); i += 1) await sleep(100)
    ;[...item.querySelectorAll('.settings-action-btn')].at(-1).click()
    for (let i = 0; i < 80 && !/同步完成|Sync complete/.test(document.querySelector('.sync-notice')?.textContent || ''); i += 1) await sleep(100)
  })()`)
  assert.ok([...store.keys()].some((key) => key.endsWith('/第一章.md')), 'first sync uploaded')
  await waitFor(async () => (await panes()).workspace.rows.includes('读书笔记 ☁'), '☁ on the workspace row')
  const bound = await waitFor(async () => { const p = await panes(); return p.cloud.rows.some((r) => r === '读书笔记 ☁') && p }, '读书笔记 in 云空间')
  assert.equal(bound.split, true, 'split line once 云空间 has a folder')
  await waitFor(async () => /已同步 \d{2}:\d{2}/.test((await panes()).cloud.status), '云空间 shows the sync state')

  // 3. Same files in both trees; expanded folders are independent.
  await waitFor(async () => (await panes()).cloud.rows.includes('第一章.md'), 'cloud tree lists the files')
  await clickRow('cloud', '周报')
  await waitFor(async () => (await panes()).cloud.rows.includes('10-29.md'), '周报 expanded in 云空间')
  assert.ok(!(await panes()).workspace.rows.includes('10-29.md'), 'the workspace tree keeps its own folds')
  await clickRow('cloud', '10-29.md')
  await waitFor(() => app.evaluate(`document.querySelector('.tab.active')?.textContent.includes('10-29.md')`), 'file opened from 云空间')
  await shot('cloud-space')

  // 4. Out of the workspace, still in 云空间; its watcher still works.
  const workspaceRoot = (await panes()).workspace.rows.find((r) => r.startsWith('读书笔记'))
  if (workspaceRoot) {
    await clickRow('workspace', workspaceRoot.replace(' ☁', ''), 'right')
    assert.ok(await clickMenu('从工作区移除'), 'remove from workspace item')
    await waitFor(async () => !(await panes()).workspace.rows.some((r) => r.startsWith('读书笔记')), 'removed from the workspace')
  }
  assert.ok((await panes()).cloud.rows.includes('读书笔记 ☁'), 'still in 云空间')
  await writeFile(join(notes, '新笔记.md'), '# 新\n')
  await waitFor(async () => (await panes()).cloud.rows.includes('新笔记.md'), 'a new file shows up in 云空间 (watcher)', 20000)
  await clickRow('cloud', '读书笔记', 'right')
  const items = await menuItems()
  assert.ok(items.includes('加入工作区') && items.includes('云同步设置…') && items.includes('停止同步（从云空间移除）…'), `cloud root menu: ${items}`)
  assert.ok(!items.includes('从工作区移除'), 'no workspace removal in 云空间')
  assert.ok(await clickMenu('加入工作区'))
  await waitFor(async () => (await panes()).workspace.rows.includes('读书笔记 ☁'), 'back in the workspace with ☁')

  // 5. Fold / split, remembered across a restart.
  const before = await panes()
  await app.evaluate(`(() => {
    const line = document.querySelector('.sidebar-panes-split')
    const box = line.getBoundingClientRect()
    const fire = (type, y) => line.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, clientX: box.left + 20, clientY: y }))
    fire('pointerdown', box.top + 2); fire('pointermove', box.top - 80); fire('pointerup', box.top - 80)
  })()`)
  await sleep(200)
  const dragged = await panes()
  assert.ok(dragged.cloud.height > before.cloud.height + 40, `dragging the line grows 云空间: ${before.cloud.height} → ${dragged.cloud.height}`)
  await app.evaluate(`document.querySelector('.sidebar[data-variant=workspace] .sidebar-section-toggle').click()`)
  const folded = await waitFor(async () => { const p = await panes(); return p.workspace.collapsed && p }, 'workspace folds')
  assert.equal(folded.split, false)
  assert.ok(folded.cloud.height > dragged.cloud.height, '云空间 takes the height')
  // Chromium batches localStorage writes; on Windows the test stops the app
  // by terminating it, so wait until the fold is on disk (a normal quit
  // flushes it).
  if (process.platform === 'win32') {
    const { readdir } = await import('node:fs/promises')
    const dir = join(profileDir, 'Local Storage', 'leveldb')
    await waitFor(async () => {
      for (const name of await readdir(dir).catch(() => [])) {
        const bytes = await readFile(join(dir, name)).catch(() => Buffer.alloc(0))
        if (bytes.includes('"workspaceCollapsed":true')) return true
      }
      return false
    }, 'fold written to disk', 60000)
  }
  await stopBuiltElectron(app, { removeProfile: false })
  app = await launch(false)
  await app.send('Page.enable')
  app.ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.method !== 'Page.javascriptDialogOpening') return
    dialogs.push(message.params.message)
    app.send('Page.handleJavaScriptDialog', { accept: true })
  })
  const restarted = await waitFor(async () => { const p = await panes(); return p.cloud?.rows.length && p }, 'sections after restart')
  assert.equal(restarted.workspace.collapsed, true, 'fold remembered')
  await app.evaluate(`document.querySelector('.sidebar[data-variant=workspace] .sidebar-section-toggle').click()`)
  const reopened = await waitFor(async () => { const p = await panes(); return !p.workspace.collapsed && p.split && p }, 'workspace unfolds')
  assert.ok(Math.abs(reopened.cloud.height - dragged.cloud.height) < 12, `split remembered: ${dragged.cloud.height} vs ${reopened.cloud.height}`)

  // 6. 停止同步 asks, then the folder leaves 云空间; nothing is deleted.
  await clickRow('cloud', '读书笔记', 'right')
  assert.ok(await clickMenu('停止同步（从云空间移除）…'))
  await waitFor(async () => /本地和云端的文件都会保留/.test(dialogs.join('\n')), 'confirm asked')
  const stopped = await waitFor(async () => { const p = await panes(); return /还没有同步的文件夹/.test(p.cloud.empty) && p }, 'folder left 云空间')
  assert.ok(stopped.workspace.rows.includes('读书笔记'), 'still in the workspace, without ☁')
  assert.equal(await readFile(join(notes, '第一章.md'), 'utf8'), '# 第一章\n', 'files kept')
  const toasts = await app.evaluate(`document.body.textContent`)
  assert.ok(!/不一致/.test(toasts))
  console.log('PASS cloud space UI: empty line, ☁ on synced folders, same files / independent folds, open from 云空间, stays after leaving the workspace (watcher), 加入工作区, fold + split remembered, 停止同步 asks and keeps files')
} finally {
  if (app) await stopBuiltElectron(app)
  server.close()
  await rm(root, { recursive: true, force: true })
}
